/**
 * Waiting out a governance delay, correctly.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A SHELL LOOP
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The first version of this was bash: run the apply script, grep the output for "not yet
 * executable", sleep, retry. It failed twice in one session and both failures were silent.
 *
 *   1. The apply script ran through a pipe to `tee`, so `$?` was tee's exit status. Every failure
 *      looked like a success.
 *   2. One script says "not yet executable" and another says "not executable for another". The grep
 *      matched the first and not the second, so the loop returned on its first iteration and
 *      reported DONE while nothing had been applied.
 *
 * Both are the same mistake: inferring a program's state by pattern-matching its prose. This module
 * asks the chain instead. `executableAfter` is a number in contract storage, and `block.timestamp`
 * is a number in the latest block — so the wait is a comparison between two values that the thing
 * enforcing the delay also compares, rather than a guess about English.
 *
 * It polls BLOCK time, not the local clock. The delay is enforced against `block.timestamp`, so a
 * local clock running a few seconds fast would send a transaction that reverts.
 */

import type { PublicClient } from "viem";

import { say } from "./env.js";

/** How often to re-read the head. Sepolia blocks are ~12s; 15 avoids polling between blocks. */
const POLL_INTERVAL_MS = 15_000;

export interface WaitOptions {
  /** Unix seconds after which the action becomes executable, from contract storage. */
  readonly executableAfter: bigint;
  /** What is being waited for, for the progress line. */
  readonly label: string;
  /** Give up after this long. A delay longer than this is a misconfiguration, not a wait. */
  readonly timeoutMs?: number;
}

/**
 * Blocks until the chain's own clock has passed `executableAfter`.
 *
 * @returns when the delay has elapsed according to the latest block.
 * @throws if the timeout elapses first — which means the configured delay is longer than this
 *         process is willing to wait, and the caller should re-run the script later rather than
 *         hold a terminal open.
 */
export async function waitForTimelock(
  client: PublicClient,
  { executableAfter, label, timeoutMs = 45 * 60 * 1000 }: WaitOptions,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;

  for (;;) {
    const block = await client.getBlock({ blockTag: "latest" });
    if (block.timestamp >= executableAfter) {
      if (announced) say(`  ${label}: delay elapsed at block time ${block.timestamp}`);
      return;
    }

    const remaining = Number(executableAfter - block.timestamp);
    if (!announced) {
      say(`  ${label}: waiting ${remaining}s for the governance delay (chain time, not local).`);
      announced = true;
    } else {
      say(`  ${label}: ${remaining}s remaining`);
    }

    if (Date.now() > deadline) {
      throw new Error(
        `gave up waiting for ${label} after ${Math.round(timeoutMs / 60000)} minutes, with ` +
          `${remaining}s still to run. The delay is not skippable — re-run this script once it has ` +
          "elapsed rather than holding a terminal open.",
      );
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
