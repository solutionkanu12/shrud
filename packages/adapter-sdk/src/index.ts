/**
 * `@shrud/adapter-sdk` — what a new venue or account adapter must satisfy before it is registered.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THIS PACKAGE IS A GATE, NOT A CONVENIENCE
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PRD §5.9 — "no fake universality". shrud supports a finite registry of reviewed adapters, and new
 * ones arrive through explicit code, fork tests and policy review. The shape below is what that
 * review checks against.
 *
 * An adapter is called by a contract holding the aggregate residual of several treasuries, in the
 * one moment of the whole lifecycle where a plaintext amount exists. So the checklist is not about
 * ergonomics — every item is something that, if wrong, sends other people's money somewhere else.
 */

import type { Address, Hex } from "@shrud/shared";

export interface SettlementAdapterManifest {
  readonly adapter: Address;
  /** The runtime code hash at registration. Re-checked on EVERY settlement, not just at registry time. */
  readonly codeHash: Hex;
  readonly protocolId: Hex;
  readonly routeId: Hex;
  /** The ONE contract this adapter ever calls. */
  readonly venue: Address;
  readonly inputToken: Address;
  readonly outputToken: Address;
  /** The ONE address it will ever send output to. Never a parameter. */
  readonly fixedRecipient: Address;
  readonly maxDeadlineWindowSeconds: number;
  /** Always zero at launch. See {SLIPPAGE_MUST_BE_ZERO}. */
  readonly slippageToleranceBps: number;
}

/**
 * Why the slippage tolerance is zero and not "small".
 *
 * The aggregate minimum is not a tolerance — it is derived from the real private limits of the
 * treasuries in the epoch, as the maximum over their individual requirements. A tolerance below it
 * would settle at a price at least one participant explicitly refused, and that participant could
 * never find out: their limit is a ciphertext and so is their allocation.
 *
 * "A few basis points of slippage" is a reasonable default in a system where the person bearing it
 * can see it. Here they cannot.
 */
export const SLIPPAGE_MUST_BE_ZERO: string =
  "The aggregate minimum is composed from real private limits, not from a tolerance. Any tolerance " +
  "would settle below a limit some treasury set, and that treasury could never observe it.";

export interface AdapterReviewItem {
  readonly id: string;
  readonly requirement: string;
  readonly why: string;
  /** How a reviewer checks it. A test path, a call to make, or a property to fuzz. */
  readonly evidence: string;
}

/**
 * The registration gate. Every item is a failure that has happened to somebody.
 */
export const SETTLEMENT_ADAPTER_REVIEW: readonly AdapterReviewItem[] = [
  {
    id: "no-arbitrary-calldata",
    requirement: "`settle` takes no `bytes` parameter and no target address.",
    why: "A calldata parameter on a function called by a vault holding an aggregate residual is a general-purpose call from a vault.",
    evidence:
      "Read the ABI. `IShrudSettlementAdapter.SettleParams` has no such field, so an adapter that added one would not implement the interface.",
  },
  {
    id: "fixed-recipient",
    requirement:
      "The recipient is a constructor immutable, and `settle` reverts on any other value.",
    why: "A caller-chosen recipient is the whole exploit: a correctly priced, correctly bounded swap whose output goes elsewhere.",
    evidence:
      "A test that calls `settle` with a third-party recipient and asserts the named revert.",
  },
  {
    id: "no-delegatecall",
    requirement: "The adapter never delegatecalls, and the module guard refuses it upstream.",
    why: "Delegatecall from the settlement path runs arbitrary code in a contract holding pooled funds.",
    evidence:
      "`grep -n delegatecall` returns nothing, and `test/unit/ShrudModuleGuard.t.sol` asserts the guard's refusal.",
  },
  {
    id: "zero-amount-refused",
    requirement: "`amountIn == 0` reverts.",
    why: "SwapRouter02 documents that a zero `amountIn` makes it look up and swap the contract's OWN balance. A zero-input settlement would be a sweep, not a no-op.",
    evidence:
      "A test asserting the revert, plus a check that the adapter never holds a balance between calls.",
  },
  {
    id: "no-standing-approval",
    requirement: "Approvals are set to the exact amount and reset to zero in the same call.",
    why: "A standing allowance on a venue outlives the settlement that needed it.",
    evidence: "Read the settle path; assert `allowance == 0` after a fork-test settlement.",
  },
  {
    id: "output-measured-not-reported",
    requirement:
      "The engine measures the recipient's balance delta and ignores the adapter's return value.",
    why: "A returned number is a claim; a balance delta is a fact. They differ for fee-on-transfer tokens, partial fills, rebasing tokens and adapter defects.",
    evidence:
      "`ShrudSettlementEngine.settleResidual` discards the return value. A fork test with a fee-on-transfer token confirms the delta is what allocates.",
  },
  {
    id: "code-hash-rechecked",
    requirement: "The registry re-checks the runtime code hash on every settlement.",
    why: "A registered address can be a proxy that gets upgraded, or a self-destructed address recreated with different code.",
    evidence:
      "`ShrudAdapterRegistry.requireEnabledAdapter` compares `adapter.codehash` every call, not at registration.",
  },
  {
    id: "manifest-agrees-with-adapter",
    requirement:
      "The registry reads `routeId`, `venue`, `fixedRecipient`, `inputToken` and `outputToken` from the adapter and compares them with the manifest.",
    why: "A manifest describing an adapter the adapter does not agree with is the failure a review process cannot catch, because the reviewer read the manifest.",
    evidence:
      "`_assertManifestMatchesAdapter`, run at both queue and apply — seven days is long enough for a proxy to be upgraded in between.",
  },
  {
    id: "delayed-registration",
    requirement: "Registration waits `ADAPTER_DELAY`; disabling is immediate.",
    why: "The delay is the window in which a treasury that disagrees can withdraw. Stopping a venue that has gone wrong must never wait for a timer.",
    evidence: "`queueAdapter` then `applyAdapter`, with the delay asserted in a unit test.",
  },
  {
    id: "fork-tested-against-the-real-venue",
    requirement: "A fork test settles a real amount through the real venue at a real address.",
    why: "A mocked venue proves the adapter compiles against an interface, not that the interface matches the deployed contract.",
    evidence: "`test/fork/` with `--fork-url`, asserting the measured delta.",
  },
] as const;

/**
 * The account-adapter gate. Safe is the first; there is no reason it must be the only one.
 *
 * PRD §29 measures success partly by this: removing Safe should break order AUTHORITY and leave a
 * reusable clearing core. These items are what a second account adapter has to satisfy for that to
 * be true rather than aspirational.
 */
export const ACCOUNT_ADAPTER_REVIEW: readonly AdapterReviewItem[] = [
  {
    id: "native-authority-preserved",
    requirement: "The adapter calls the account's OWN authority check, live, at activation.",
    why: "A copied owner list is a second, silently stale authority. An owner removed between submission and activation must not be able to authorise.",
    evidence:
      "The adapter holds no owner list of its own; the check is an external call each time.",
  },
  {
    id: "direct-caller-for-encrypted-input",
    requirement: "The account holder calls the adapter DIRECTLY to submit an encrypted input.",
    why: "`Nox.fromExternal` binds the proof to the calling address. No relayer, paymaster, batch router or server signer can sit in between — the proof is refused, not merely discouraged.",
    evidence:
      "A test that routes a valid proof through an intermediary and asserts NoxCompute's refusal.",
  },
  {
    id: "one-shot-handles-and-nonces",
    requirement:
      "Every input handle is consumed once, and every submission carries a strictly increasing per-owner nonce.",
    why: "Nox input proofs carry no nonce and no consumption marker. Replay protection is entirely the application's job.",
    evidence:
      "`ShrudConfidentialBase`, and a test that spends one proof twice and asserts the second is refused.",
  },
  {
    id: "guarded-execution-surface",
    requirement:
      "Every account-triggered call passes a guard that checks target, selector AND argument shape.",
    why: "A target allowlist alone permits `wrap(attacker, amount)` on a properly registered wrapper.",
    evidence:
      "`test/unit/ShrudModuleGuard.t.sol`, particularly the third-party wrap recipient case.",
  },
  {
    id: "recovery-does-not-route-through-shrud",
    requirement:
      "Removing the adapter is a native account transaction that touches no shrud contract.",
    why: "If the way to remove shrud goes through shrud, the escape hatch depends on the thing being escaped.",
    evidence: "The runbook's two transactions, executed in a fork test against a real account.",
  },
] as const;
