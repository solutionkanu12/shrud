/**
 * The shrud indexer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND THE MUCH LONGER LIST OF WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A read-only follower of the public event stream, exposed over HTTP so the web application can ask
 * "what has happened" without every visitor paginating logs from their own browser.
 *
 * It holds no keys, signs nothing, and writes nothing to any chain. It cannot submit an order,
 * cannot authorise one, and cannot influence a clearing epoch. If this process disappears the
 * protocol is unaffected and the web application degrades to reading contract state directly, which
 * is what it does for every number it shows today.
 *
 * IT ALSO CANNOT SEE ANYTHING PRIVATE, and that is worth stating because an indexer is exactly the
 * component someone would expect to be the leak. Every event it reads carries Nox handles rather
 * than values. A handle is a pointer into encrypted state, and decrypting one requires an ACL entry
 * this process does not have and cannot be granted, because grants are made to Safes rather than to
 * services. An indexer that has been fully compromised learns which Safes submitted orders for which
 * pairs and when, which is precisely the public record anyone can already read from the chain.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY IT NARROWS ITS OWN WINDOW AND STORES ONLY IN MEMORY
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `eth_getLogs` limits differ by orders of magnitude between providers and are not discoverable in
 * advance. The Alchemy free tier this was first run against caps the window at TEN blocks; paid
 * tiers serve thousands. A fixed page size is therefore wrong somewhere, so `indexRange` halves its
 * window on a range rejection and retries until the provider accepts it.
 *
 * State is in memory and rebuilt from the chain on every start. A database would be a second source
 * of truth for facts the chain already holds, and the first time the two disagreed the wrong one
 * would be believed. Restarting re-reads from the deployment block, which for this deployment is
 * seconds of work.
 */

import { createServer } from "node:http";

import { createPublicClient, http, parseAbiItem, type Address, type PublicClient } from "viem";
import { sepolia } from "viem/chains";

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Configuration
// ══════════════════════════════════════════════════════════════════════════════════════════════

function rpcUrl(): string {
  const direct = process.env["SEPOLIA_RPC_URL"];
  if (direct !== undefined && direct !== "") return direct;

  const base = process.env["ALCHEMY_API_URL"];
  const key = process.env["ALCHEMY_API_KEY"];
  if (base !== undefined && base !== "" && key !== undefined && key !== "") return `${base}${key}`;

  throw new Error(
    "No RPC configured. Set ALCHEMY_API_URL and ALCHEMY_API_KEY, or SEPOLIA_RPC_URL. The indexer " +
      "refuses to fall back to a default, because eth_getLogs behaviour differs silently between " +
      "providers and a partial history would look like a complete one.",
  );
}

/**
 * Blocks per `eth_getLogs` page, and the STARTING value rather than a fixed one.
 *
 * Provider limits vary by orders of magnitude and are not discoverable in advance. The Alchemy free
 * tier caps this at TEN blocks and says so in an error; paid tiers serve thousands. Hard-coding
 * either number means the indexer is broken on the other, so `indexRange` halves the window on a
 * range rejection and retries, converging on whatever the provider actually allows.
 *
 * Set `SEPOLIA_LOG_RANGE` to skip the convergence when the limit is already known.
 */
let logRange = Number(process.env["SEPOLIA_LOG_RANGE"] ?? "500");

/** Errors that mean "your window was too wide" rather than "your request was wrong". */
function isRangeTooWide(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("block range") ||
    text.includes("range is too large") ||
    text.includes("query returned more than") ||
    text.includes("limit exceeded") ||
    text.includes("too many results")
  );
}

const PORT = Number(process.env["PORT"] ?? "8080");
/** How often to look for new blocks. Sepolia produces one roughly every twelve seconds. */
const POLL_MS = 15_000;

const INTENT_BOOK = process.env["SHRUD_INTENT_BOOK"] as Address | undefined;
const MODULE_FACTORY = process.env["SHRUD_MODULE_FACTORY"] as Address | undefined;
const START_BLOCK = BigInt(process.env["SHRUD_START_BLOCK"] ?? "0");

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The events this follows
//
// Every one is a PUBLIC fact. There is no event in this protocol that carries a plaintext amount,
// side or limit, so there is nothing here to filter out.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const EVENTS = {
  intentSubmitted: parseAbiItem(
    "event IntentSubmitted(bytes32 indexed intentId, address indexed safe, bytes32 indexed orderFamily, bytes32 epochId, uint64 expiry)",
  ),
  intentStatusChanged: parseAbiItem(
    "event IntentStatusChanged(bytes32 indexed intentId, uint8 previous, uint8 current)",
  ),
  epochOpened: parseAbiItem(
    "event EpochOpened(bytes32 indexed epochId, bytes32 indexed orderFamily, address baseAsset, address quoteAsset)",
  ),
  epochSealed: parseAbiItem(
    "event EpochSealed(bytes32 indexed epochId, uint16 candidateCount, uint64 sealedAtBlock)",
  ),
} as const;

interface IndexedEvent {
  readonly kind: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly args: Record<string, string>;
}

interface State {
  chainId: number;
  startedAt: string;
  lastIndexedBlock: string;
  headBlock: string;
  caughtUp: boolean;
  events: IndexedEvent[];
  errors: string[];
}

const state: State = {
  chainId: sepolia.id,
  startedAt: new Date().toISOString(),
  lastIndexedBlock: START_BLOCK.toString(),
  headBlock: "0",
  caughtUp: false,
  events: [],
  errors: [],
};

/**
 * Serialises anything viem returns from a log.
 *
 * `bigint` throws in `JSON.stringify` rather than coercing, and log arguments are full of them.
 * Doing this at the point of capture means the HTTP layer never has to think about it.
 */
function stringifyArgs(args: unknown): Record<string, string> {
  if (args === null || typeof args !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    out[key] = typeof value === "bigint" ? value.toString() : String(value);
  }
  return out;
}

/**
 * Reads one window, narrowing it until the provider accepts it.
 *
 * A rejected window is retried at half the width, down to a single block. Anything narrower than
 * that is not a range problem, so the error is re-thrown rather than swallowed: silently returning
 * nothing is the exact failure this whole file exists to avoid.
 */
async function indexRange(client: PublicClient, from: bigint, to: bigint): Promise<void> {
  if (INTENT_BOOK === undefined) return;

  for (const [kind, event] of Object.entries(EVENTS)) {
    let logs;
    for (;;) {
      try {
        logs = await client.getLogs({ address: INTENT_BOOK, event, fromBlock: from, toBlock: to });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const width = Number(to - from) + 1;
        if (!isRangeTooWide(message) || width <= 1) throw error;

        logRange = Math.max(1, Math.floor(width / 2));
        console.warn(`provider rejected a ${width} block window; narrowing to ${logRange}`);
        to = from + BigInt(logRange) - 1n;
      }
    }

    for (const log of logs) {
      state.events.push({
        kind,
        blockNumber: log.blockNumber.toString(),
        transactionHash: log.transactionHash,
        args: stringifyArgs((log as { args?: unknown }).args),
      });
    }
  }

  // Newest first, and bounded. An unbounded array in a long-running process is a memory leak with
  // a slow fuse; a demo deployment will never approach this, and a busy one should not fall over.
  state.events.sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)));
  if (state.events.length > 5_000) state.events.length = 5_000;
}

async function follow(client: PublicClient): Promise<void> {
  const head = await client.getBlockNumber();
  state.headBlock = head.toString();

  // Backfill starts at the DEPLOYMENT BLOCK rather than an arbitrary offset from the head. On a
  // provider that serves ten blocks per call, "head minus ten thousand" is a thousand requests
  // covering mostly empty history; the deployment block is where this protocol's history begins and
  // there is nothing before it to find.
  let cursor = BigInt(state.lastIndexedBlock);
  if (cursor === 0n) cursor = START_BLOCK > 0n ? START_BLOCK - 1n : head - 1n;

  while (cursor < head) {
    const to = cursor + BigInt(logRange) > head ? head : cursor + BigInt(logRange);
    await indexRange(client, cursor + 1n, to);
    cursor = to;
    state.lastIndexedBlock = cursor.toString();
  }

  state.caughtUp = true;
}

function json(body: unknown, status = 200): [number, string, string] {
  return [status, "application/json", JSON.stringify(body, null, 2)];
}

async function main(): Promise<void> {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl()) });

  if (INTENT_BOOK === undefined) {
    console.warn(
      "SHRUD_INTENT_BOOK is not set, so the indexer will serve health and status but index nothing. " +
        "Set it to the deployed intent book address from deployments/11155111.json.",
    );
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    // The web application is served from a different origin, and every response here is public
    // chain data. There is nothing to protect with a same-origin policy.
    response.setHeader("access-control-allow-origin", "*");

    const [status, type, body] = (() => {
      switch (url.pathname) {
        case "/health":
          return json({ ok: true, caughtUp: state.caughtUp });

        case "/status":
          return json({
            chainId: state.chainId,
            startedAt: state.startedAt,
            headBlock: state.headBlock,
            lastIndexedBlock: state.lastIndexedBlock,
            caughtUp: state.caughtUp,
            eventCount: state.events.length,
            logRange,
            startBlock: START_BLOCK.toString(),
            intentBook: INTENT_BOOK ?? null,
            moduleFactory: MODULE_FACTORY ?? null,
            recentErrors: state.errors.slice(-5),
            note:
              "Read-only. Holds no keys and writes nothing. Every event below carries Nox handles " +
              "rather than values, so this process cannot see any order's side, amount or limit.",
          });

        case "/events": {
          const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 500);
          const kind = url.searchParams.get("kind");
          const filtered =
            kind === null ? state.events : state.events.filter((e) => e.kind === kind);
          return json({ count: filtered.length, events: filtered.slice(0, limit) });
        }

        default:
          return json(
            { error: "not found", routes: ["/health", "/status", "/events"] },
            404,
          );
      }
    })();

    response.writeHead(status, { "content-type": type });
    response.end(body);
  });

  server.listen(PORT, () => {
    console.log(`shrud indexer listening on ${PORT}`);
    console.log("read-only: no keys, no writes, no access to any encrypted value");
  });

  const tick = async (): Promise<void> => {
    try {
      await follow(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.errors.push(`${new Date().toISOString()} ${message}`);
      if (state.errors.length > 50) state.errors.shift();
      console.error("index failed:", message);
    }
  };

  await tick();
  setInterval(() => void tick(), POLL_MS);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
