/**
 * Takes a reference-price snapshot for the launch route.
 *
 * WHY THIS IS AN OPERATIONAL SCRIPT AND NOT A DEPLOY STEP: the snapshot expires. `maxStaleness` is
 * one hour, and the clearing engine checks staleness at USE rather than at capture, so a snapshot
 * taken at deploy time is worthless by the time anyone clears an epoch. It has to be taken shortly
 * before it is needed, every time.
 *
 * `fixPrice` is permissionless by design — it only reads the pool and writes a snapshot, and every
 * bound that matters (TWAP window, tick deviation, observation history) is enforced by the route
 * configuration rather than by who is calling. It still broadcasts, so it is gated behind the same
 * explicit opt-in as every other write path in this repository.
 *
 *   DEPLOY_SEPOLIA=true pnpm tsx scripts/ops/fix-price.ts
 */

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeEventLog, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { assertBroadcastAllowed, deployerPrivateKey, loadEnv, rpcUrl, say } from "../lib/env.js";

const MANIFEST = "deployments/11155111.json";
const ARTIFACT =
  "artifacts/contracts/clearing/ShrudReferencePriceRegistry.sol/ShrudReferencePriceRegistry.json";

async function main(): Promise<void> {
  loadEnv();
  assertBroadcastAllowed();

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const abi = JSON.parse(readFileSync(ARTIFACT, "utf8")).abi;
  const registry = manifest.contracts.ShrudReferencePriceRegistry.address as `0x${string}`;
  const routeId = manifest.route.routeId as `0x${string}`;

  const account = privateKeyToAccount(deployerPrivateKey());
  const transport = http(rpcUrl());
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const wallet = createWalletClient({ account, chain: sepolia, transport });

  say(`registry  ${registry}`);
  say(`route     ${routeId}`);

  // Simulate first. A snapshot that would revert on a stale pool should fail here, where it costs
  // nothing, rather than after the gas is spent.
  const { request, result } = await publicClient.simulateContract({
    address: registry,
    abi,
    functionName: "fixPrice",
    args: [routeId],
    account,
  });
  const [predictedId, predictedPrice] = result as [`0x${string}`, bigint];
  say(`simulated snapshot ${predictedId}`);
  say(`simulated price    ${predictedPrice} raw USDC per raw WETH x1e18`);

  const hash = await wallet.writeContract(request);
  say(`sent ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  say(`mined in block ${receipt.blockNumber}, status ${receipt.status}`);

  /**
   * THE SIMULATED ID IS NOT THE REAL ID.
   *
   * A snapshot's id commits to the block it was captured in, so the id returned by `simulateContract`
   * belongs to the block the simulation ran against and not to the block the transaction landed in.
   * Reading the simulated id back reverts `SnapshotUnknown` even though the write succeeded, which
   * looks like a failed snapshot and is not one. The `PriceFixed` event carries the id that exists.
   */
  const emitted = receipt.logs
    .filter((log) => log.address.toLowerCase() === registry.toLowerCase())
    .flatMap((log) => {
      try {
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
        return decoded.eventName === "PriceFixed"
          ? [(decoded.args as { snapshotId: `0x${string}` }).snapshotId]
          : [];
      } catch {
        return [];
      }
    });

  const snapshotId = emitted[0];
  if (snapshotId === undefined) {
    throw new Error("fixPrice mined but emitted no PriceFixed event. Nothing was captured.");
  }
  if (snapshotId !== predictedId) {
    say(`note: simulated ${predictedId} but captured ${snapshotId} — the block moved.`);
  }

  // Confirm from chain rather than from the receipt. A receipt says the transaction succeeded; it
  // does not say the snapshot is readable and fresh, which is the thing that matters.
  const snapshot = (await publicClient.readContract({
    address: registry,
    abi,
    functionName: "requireFresh",
    args: [snapshotId],
  })) as { capturedAtTimestamp: bigint; price: bigint };

  const expiresAt = Number(snapshot.capturedAtTimestamp) + manifest.route.maxStaleness;
  say("");
  say(`snapshot id  ${snapshotId}`);
  say(`price        ${snapshot.price}`);
  say(`captured     ${new Date(Number(snapshot.capturedAtTimestamp) * 1000).toISOString()}`);
  say(`STALE AFTER  ${new Date(expiresAt * 1000).toISOString()}`);
  say(`             ${manifest.route.maxStaleness}s from capture — re-run this before clearing.`);
  say(`explorer     https://sepolia.etherscan.io/tx/${hash}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
