/**
 * `@shrud/verification` — the checks, as data, so the web verifier and the CLI cannot disagree.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * A VERDICT HAS FOUR VALUES, NOT TWO
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `pass` / `fail` is not enough, and collapsing to it hides two different things.
 *
 *   `warning` — the check ran and found something that is not wrong but is worth saying. A privacy
 *   floor that passed with exactly the minimum. A price snapshot near its staleness bound.
 *
 *   `reported-not-verified` — something a record ASSERTS and this run did not check. A compiler
 *   version from a manifest. A contract-verification status from a block explorer's API. Reporting
 *   those as `pass` misstates who checked; dropping them hides a claim the product is making.
 *
 * PRD §22.4 asks for pass, warning or fail. The fourth exists because the third's absence is how a
 * verifier ends up claiming to have checked things it read.
 */

import type { Hex } from "@shrud/shared";

export type Verdict = "pass" | "warning" | "fail" | "reported-not-verified";

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly verdict: Verdict;
  /** One sentence. What was checked and what was found — never a status word on its own. */
  readonly detail: string;
  /** Raw evidence: a transaction hash, an address, a handle, a decoded value. */
  readonly evidence?: Readonly<Record<string, string>>;
  /** The command that reproduces this check independently. */
  readonly reproduce?: string;
}

export interface VerificationReport {
  readonly subject: string;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly checks: readonly CheckResult[];
  readonly passed: number;
  readonly warnings: number;
  readonly failed: number;
  readonly reportedNotVerified: number;
}

export function summarise(
  subject: string,
  chainId: number,
  blockNumber: bigint,
  checks: readonly CheckResult[],
): VerificationReport {
  return {
    subject,
    chainId,
    blockNumber,
    checks,
    passed: checks.filter((c) => c.verdict === "pass").length,
    warnings: checks.filter((c) => c.verdict === "warning").length,
    failed: checks.filter((c) => c.verdict === "fail").length,
    reportedNotVerified: checks.filter((c) => c.verdict === "reported-not-verified").length,
  };
}

/**
 * The twenty claims `pnpm verify:live` makes — PRD §22.4, as a manifest.
 *
 * A manifest rather than a list of function calls, so the web verifier renders the same set the CLI
 * runs and a check cannot be silently dropped from one surface. `implemented: false` is visible in
 * both, which is the point: a check that has not been written yet is a gap in the evidence, and a
 * verifier that quietly omits it is a verifier that overstates what it proved.
 */
export interface CheckDefinition {
  readonly id: string;
  readonly title: string;
  readonly prdSection: string;
  readonly implemented: boolean;
  /** What a FAIL would mean, in one sentence. Renders beside the result. */
  readonly consequence: string;
}

export const LIVE_CHECKS: readonly CheckDefinition[] = [
  {
    id: "chain-and-manifest",
    title: "Chain id and deployment manifest agree",
    prdSection: "22.4.1",
    implemented: true,
    consequence: "Every subsequent check would be reading a different deployment.",
  },
  {
    id: "runtime-bytecode",
    title: "Every runtime bytecode matches a build of this repository",
    prdSection: "22.4.2",
    implemented: true,
    consequence: "The deployed code is not the code that was reviewed.",
  },
  {
    id: "module-safe-binding",
    title: "Each module is bound to exactly one Safe, at its CREATE2 address",
    prdSection: "22.4.3",
    implemented: true,
    consequence: "A module could act for a Safe that never reviewed it.",
  },
  {
    id: "owners-and-threshold",
    title: "Current owners and threshold read live from each Safe",
    prdSection: "22.4.4",
    implemented: true,
    consequence: "Authority would be measured against a stale copy.",
  },
  {
    id: "module-and-guard-state",
    title: "Module enabled AND the shrud guard installed",
    prdSection: "22.4.5",
    implemented: true,
    consequence: "A module without its guard has unlimited authority over the Safe.",
  },
  {
    id: "wrapper-reserves",
    title: "Public reserves cover confidential supply plus pending unwraps",
    prdSection: "22.4.6",
    implemented: true,
    consequence: "A confidential balance would be backed by less than it claims.",
  },
  {
    id: "operator-expiry",
    title: "Every operator grant is bounded and unexpired",
    prdSection: "22.4.6",
    implemented: true,
    consequence: "An unbounded operator on a wrapper can unwrap an entire balance to any address.",
  },
  {
    id: "intent-commitments",
    title: "Every intent commitment and nonce is consistent and unrepeated",
    prdSection: "22.4.7",
    implemented: true,
    consequence: "A signature collected for one order could authorise another.",
  },
  {
    id: "safe-signatures",
    title: "Packed signatures satisfy each Safe's threshold at activation",
    prdSection: "22.4.8",
    implemented: true,
    consequence: "An order could be activated without the treasury's authority.",
  },
  {
    id: "nox-handles-and-acl",
    title: "Handles and ACL entries match the operation graph",
    prdSection: "22.4.9",
    implemented: true,
    consequence: "A Safe could hold a grant on another Safe's value.",
  },
  {
    id: "price-snapshot",
    title: "The epoch's price came from the registered pool, window and block",
    prdSection: "22.4.10",
    implemented: true,
    consequence: "Internal crossing would move value at a price nobody can audit.",
  },
  {
    id: "floor-and-residual-proofs",
    title: "Both privacy floors and all three residual values verify against the sealed epoch",
    prdSection: "22.4.11",
    implemented: true,
    consequence: "A proof from one epoch could settle another.",
  },
  {
    id: "venue-call-trace",
    title: "The public Uniswap or Aave call is traced end to end",
    prdSection: "22.4.12",
    implemented: true,
    consequence: "The settlement receipt would not correspond to a real venue call.",
  },
  {
    id: "measured-output",
    title: "Actual output is the recipient's balance delta, not the adapter's report",
    prdSection: "22.4.13",
    implemented: true,
    consequence: "Allocations would be made against a number the adapter chose.",
  },
  {
    id: "demo-outcomes",
    title: "Authorised demo keys decrypt their own private outcomes",
    prdSection: "22.4.14",
    implemented: true,
    consequence: "The confidentiality claim would be untested from the inside.",
  },
  {
    id: "crossing-conservation",
    title: "Internal cross conserves value for the demo keys",
    prdSection: "22.4.15",
    implemented: true,
    consequence: "Crossing could move the wrong amount, invisibly, between two treasuries.",
  },
  {
    id: "residual-equals-imbalance",
    title: "Residual input equals the unmatched demo flow",
    prdSection: "22.4.16",
    implemented: true,
    consequence: "More would reach the public venue than the imbalance required.",
  },
  {
    id: "external-allocation-sum",
    title: "External allocations plus dust equal the measured public output",
    prdSection: "22.4.17",
    implemented: true,
    consequence: "The vault could owe more than it received.",
  },
  {
    id: "final-reconciliation",
    title: "Final confidential balances reconcile with internal plus external settlement",
    prdSection: "22.4.18",
    implemented: true,
    consequence: "A treasury's balance would not equal what it was owed.",
  },
  {
    id: "no-replay",
    title: "No intent, epoch, proof or unwrap request was consumed twice",
    prdSection: "22.4.19",
    implemented: true,
    consequence: "The same escrow could be paid out twice.",
  },
] as const;

/**
 * The privacy claims a verifier must be able to REFUTE, not merely assert — PRD §22.2.
 *
 * Each is an attack. A verifier that only confirms good behaviour proves nothing about an adversary,
 * so these are run as attempts and a `pass` means the attempt was refused.
 */
export const ADVERSARIAL_CHECKS: readonly CheckDefinition[] = [
  {
    id: "balance-oracle-via-oversized-orders",
    title: "Repeated oversized orders do not reveal a confidential balance",
    prdSection: "22.2",
    implemented: true,
    consequence: "A binary search over a treasury's balance, one transaction per bit.",
  },
  {
    id: "side-via-public-revert",
    title: "No public revert distinguishes a buy from a sell or a passed limit from a failed one",
    prdSection: "22.2",
    implemented: true,
    consequence: "The product's central claim would be false.",
  },
  {
    id: "cross-participation-via-events",
    title: "No event fires on one private outcome and not another",
    prdSection: "22.2",
    implemented: true,
    consequence: "Internal-cross participation would be readable from a log.",
  },
  {
    id: "contributors-via-candidate-ordering",
    title: "Candidate ordering carries no information about the private classification",
    prdSection: "22.2",
    implemented: true,
    consequence: "A coordinator could signal which orders crossed by how it ordered them.",
  },
  {
    id: "stale-or-manipulated-price",
    title: "A stale or manipulated price snapshot fails the epoch closed before redistribution",
    prdSection: "22.2",
    implemented: true,
    consequence: "Value would move between crossed treasuries at a price an attacker chose.",
  },
  {
    id: "proof-through-wrong-caller",
    title: "A valid proof minted for another caller or contract is refused",
    prdSection: "22.2",
    implemented: true,
    consequence: "One owner could spend another's encrypted input.",
  },
  {
    id: "handle-and-epoch-replay",
    title: "A handle, intent, epoch, residual or unwrap request cannot be reused",
    prdSection: "22.2",
    implemented: true,
    consequence: "The same escrow could settle twice.",
  },
  {
    id: "stale-safe-signatures",
    title: "Signatures from a removed owner or an old threshold are refused",
    prdSection: "22.2",
    implemented: true,
    consequence: "A removed owner could still authorise orders.",
  },
  {
    id: "capsule-viewer-reaches-live-state",
    title: "A capsule viewer holds no grant on any live handle",
    prdSection: "22.2",
    implemented: true,
    consequence: "An auditor's dated snapshot would be a permanent key to the treasury.",
  },
  {
    id: "solo-epoch-labelled-as-clearing",
    title: "A failed privacy floor is never displayed or settled as multi-party clearing",
    prdSection: "22.2",
    implemented: true,
    consequence: "A single order would be presented as a private multi-party aggregate.",
  },
  {
    id: "lens-commitment-tamper",
    title: "Altered canonical order bytes block signing rather than warning",
    prdSection: "22.2",
    implemented: true,
    consequence: "A compromised frontend could swap the order under a signer.",
  },
] as const;

/** Every claim, in the order a report renders them. */
export function allChecks(): readonly CheckDefinition[] {
  return [...LIVE_CHECKS, ...ADVERSARIAL_CHECKS];
}

export function checkById(id: string): CheckDefinition | undefined {
  return allChecks().find((c) => c.id === id);
}

export interface HandleBinding {
  readonly role: string;
  readonly expected: Hex;
  readonly actual: Hex;
}

/**
 * Compares a proof's handle against the one the sealed epoch committed to — delta D-7.
 *
 * A decryption proof is a pure signature check with no epoch binding. This comparison is the entire
 * reason a valid proof means anything about a particular epoch, so it is a named function rather
 * than an inline `===`: it is cited from the settlement engine, the keeper and the web verifier, and
 * all three must be doing the same thing.
 */
export function bindingHolds(binding: HandleBinding): boolean {
  return binding.expected.toLowerCase() === binding.actual.toLowerCase();
}
