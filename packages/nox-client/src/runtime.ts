/**
 * Handle readiness, and the polling policy shrud actually uses.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * TWO FACTS DRIVE THIS FILE
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **1 · There is no callback into your contract.** An on-chain Nox call returns a result handle
 * immediately; the computation happens off chain, asynchronously, in the TDX runner. Nothing tells
 * a contract or a client when it is done. Readiness is discovered ONLY by polling
 * `POST {gateway}/v0/public/handles/status` — an endpoint the Hardhat plugin uses and that appears
 * in neither the SDK nor the documentation. It is treated as unstable and wrapped here, so a
 * breaking change is a one-file fix rather than a search through the codebase.
 *
 * **2 · The SDK's own retry gives up after about seven seconds.** Three attempts at 1s, 2s, 4s.
 * That is not a policy a keeper can adopt: the runner's latency on a hosted testnet is not a number
 * this project has enough samples to bound, and a settlement that abandons a ready epoch because it
 * waited seven seconds is a settlement that strands capital.
 *
 * The response shape is the other trap. The endpoint is undocumented, so the obvious guesses —
 * `{state}`, `{status}`, `{ready}` — all look plausible and none of them is what a live gateway
 * returns. {parseHandleState} puts the MEASURED shape first and keeps the guesses as fallbacks,
 * because a parser that silently falls through to "unknown" makes every wait run to timeout while
 * looking like a latency problem.
 */

import type { Handle } from "@shrud/shared";

export type HandleState = "unknown" | "pending" | "ready" | "failed";

export interface HandleStatus {
  readonly handle: Handle;
  readonly state: HandleState;
  readonly reason?: string;
}

export class NoxGatewayError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
    this.name = "NoxGatewayError";
  }
}

/**
 * Splits failures into retryable and terminal.
 *
 * This matters beyond tidiness. A caller that retries a terminal failure burns its whole retry
 * budget before the real error surfaces, and the operator sees a timeout instead of the 400 that
 * actually happened.
 *
 * A 404 is RETRYABLE and that is deliberate: immediately after a submission the ingestor may not
 * have seen the handle yet, so "unknown handle" is the normal first answer rather than an error.
 */
export function classifyFailure(status: number, body: string): NoxGatewayError {
  if (status === 429 || status >= 500) {
    return new NoxGatewayError(`gateway ${status}: ${body}`, true);
  }
  if (status === 404) {
    return new NoxGatewayError(`gateway 404 (handle not yet indexed): ${body}`, true);
  }
  return new NoxGatewayError(`gateway ${status} (terminal): ${body}`, false);
}

/**
 * Parses whatever the undocumented status endpoint returns.
 *
 * THE MEASURED SHAPE, first:
 *
 *     { "payload": { "statuses": [ { "handle": "0x…", "resolved": true } ] } }
 *
 * The guessed shapes are kept behind it because the endpoint is absent from both the SDK and the
 * documentation and may change again — but they are second, and the measured one is what is tested.
 */
export function parseHandleState(raw: unknown, handle?: Handle): HandleState {
  if (typeof raw === "string") return normalise(raw);
  if (raw === null || typeof raw !== "object") return "unknown";

  const record = raw as Record<string, unknown>;
  const payload = record["payload"];
  const container = (payload !== null && typeof payload === "object" ? payload : record) as Record<
    string,
    unknown
  >;

  const statuses = container["statuses"];
  if (Array.isArray(statuses)) {
    const entries = statuses.filter(
      (e): e is Record<string, unknown> => e !== null && typeof e === "object",
    );
    const match =
      handle === undefined
        ? entries[0]
        : entries.find(
            (e) =>
              typeof e["handle"] === "string" &&
              (e["handle"] as string).toLowerCase() === handle.toLowerCase(),
          );
    if (match === undefined) return "unknown";
    if (match["resolved"] === true) return "ready";
    if (match["resolved"] === false) return "pending";
    const state = match["state"] ?? match["status"];
    return typeof state === "string" ? normalise(state) : "unknown";
  }

  for (const key of ["state", "status", "handleStatus"]) {
    const value = record[key];
    if (typeof value === "string") return normalise(value);
  }
  if (record["ready"] === true) return "ready";
  if (record["ready"] === false) return "pending";
  return "unknown";
}

function normalise(value: string): HandleState {
  const lower = value.toLowerCase();
  if (["ready", "resolved", "available", "computed", "done"].includes(lower)) return "ready";
  if (["pending", "processing", "queued", "unresolved", "computing"].includes(lower))
    return "pending";
  if (["failed", "error", "rejected"].includes(lower)) return "failed";
  return "unknown";
}

export interface PollPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly timeoutMs: number;
}

/**
 * Real backoff, bounded by a stage timeout.
 *
 * Five minutes is a shrud policy choice and is stated as one. The runner's hosted-testnet latency is
 * not a number this project has enough samples to bound, and the cost of the two errors is not
 * symmetric: waiting too long delays a settlement, giving up too early strands one.
 */
export const DEFAULT_POLL_POLICY: PollPolicy = {
  initialDelayMs: 250,
  maxDelayMs: 4_000,
  multiplier: 2,
  timeoutMs: 300_000,
};

/** The exact delay sequence a policy produces, so backoff is testable without waiting. */
export function backoffSchedule(policy: PollPolicy = DEFAULT_POLL_POLICY): number[] {
  const delays: number[] = [];
  let delay = policy.initialDelayMs;
  let elapsed = 0;
  while (elapsed + delay <= policy.timeoutMs) {
    delays.push(delay);
    elapsed += delay;
    delay = Math.min(Math.round(delay * policy.multiplier), policy.maxDelayMs);
  }
  return delays;
}

export type StatusTransport = (
  url: string,
  handles: readonly Handle[],
) => Promise<{ status: number; body: string }>;

/** The default transport, isolated so tests never need a live gateway and neither does the SDK. */
export const fetchTransport: StatusTransport = async (url, handles) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handles }),
  });
  return { status: response.status, body: await response.text() };
};

export function statusUrl(gatewayUrl: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}/v0/public/handles/status`;
}

export interface WaitOptions {
  readonly policy?: PollPolicy;
  readonly transport?: StatusTransport;
  /** Injected so tests do not sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class HandleNotReadyError extends Error {
  constructor(handle: Handle, elapsedMs: number, attempts: number) {
    super(
      `handle ${handle} was still not ready after ${elapsedMs}ms across ${attempts} polls. Nox ` +
        "provides no callback, so polling is the only way readiness is discovered — raise the " +
        "timeout for a hosted testnet, where runner latency is not bounded by anything shrud knows.",
    );
    this.name = "HandleNotReadyError";
  }
}

/** Polls one handle to readiness. Throws on terminal failure or timeout. */
export async function waitForHandle(
  gatewayUrl: string,
  handle: Handle,
  options: WaitOptions = {},
): Promise<HandleStatus> {
  const policy = options.policy ?? DEFAULT_POLL_POLICY;
  const transport = options.transport ?? fetchTransport;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const delays = backoffSchedule(policy);
  const url = statusUrl(gatewayUrl);
  let elapsed = 0;

  for (const [attempt, delay] of delays.entries()) {
    const { status, body } = await transport(url, [handle]);

    if (status >= 400) {
      const error = classifyFailure(status, body);
      if (!error.retryable) throw error;
    } else {
      const state = parseHandleState(safeParse(body), handle);
      if (state === "ready") return { handle, state };
      if (state === "failed") {
        return { handle, state, reason: "the gateway reported a terminal computation failure" };
      }
    }

    await sleep(delay);
    elapsed += delay;
    if (attempt === delays.length - 1)
      throw new HandleNotReadyError(handle, elapsed, delays.length);
  }

  throw new HandleNotReadyError(handle, elapsed, delays.length);
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
