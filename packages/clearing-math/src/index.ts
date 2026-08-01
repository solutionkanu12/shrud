/**
 * `@shrud/clearing-math` — the clearing maths in plaintext, and the cost of running it encrypted.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * WHY A SECOND IMPLEMENTATION EXISTS AT ALL
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The engine's arithmetic runs on ciphertexts. Nobody can look at an epoch and see whether the
 * crossed amount was right — that is the product working as intended, and it is also why an
 * independent implementation of the same arithmetic is worth having.
 *
 * This package is used three ways, and none of them is "trust it instead":
 *
 *   1. `pnpm verify:crossing` decrypts an epoch with authorised demo keys and checks the on-chain
 *      result against this. Two implementations agreeing is evidence; one being self-consistent
 *      is not.
 *   2. The coordinator sizes an epoch against the 2^24 gas cap BEFORE sealing it, using
 *      `CLEARING_GAS_BUDGET` — because discovering the limit at settlement means an epoch full of
 *      locked capital that cannot complete.
 *   3. The web app previews a treasury's own expected outcome locally, from values only that
 *      treasury can decrypt, without asking any server anything.
 *
 * ROUNDING IS PART OF THE SPECIFICATION, NOT AN IMPLEMENTATION DETAIL. Every function below floors
 * or ceils in the same direction as `ShrudClearingEngine`, and the direction is stated at each one.
 * A "close enough" reimplementation would report a discrepancy on every epoch and be turned off.
 */

import { EPOCH_FLOOR_K, MAX_CANDIDATES, PRICE_SCALE, RESIDUAL_FLOOR_K } from "@shrud/shared";

export interface CandidateInput {
  /** Amount actually locked, in the input asset's raw units. Encrypted zero if underfunded. */
  readonly locked: bigint;
  /** One of `ACTION.*`. */
  readonly action: number;
  /** Buyer: maximum price. Seller: minimum price. Both quote-per-base, scaled by `PRICE_SCALE`. */
  readonly limit: bigint;
}

export interface CandidateResult {
  readonly buyQuote: bigint;
  readonly sellBase: bigint;
  readonly supplyQuote: bigint;
  readonly buyDemandBase: bigint;
  readonly crossBaseOut: bigint;
  readonly crossQuoteUsed: bigint;
  readonly crossBaseUsed: bigint;
  readonly crossQuoteOut: bigint;
  readonly residualContribution: bigint;
  readonly requiredVenueTotal: bigint;
  readonly externalAllocation: bigint;
}

export interface EpochResult {
  readonly grossBuyDemandBase: bigint;
  readonly grossSellSupplyBase: bigint;
  readonly grossSupplyQuote: bigint;
  readonly effectiveCount: number;
  readonly crossedBase: bigint;
  readonly crossedQuote: bigint;
  readonly residualDirection: number;
  readonly residualAggregateInput: bigint;
  readonly residualAggregateMinimum: bigint;
  readonly residualContributorCount: number;
  readonly meetsEpochFloor: boolean;
  readonly meetsResidualFloor: boolean;
  readonly candidates: readonly CandidateResult[];
}

const ACTION_BUY_BASE = 1;
const ACTION_SELL_BASE = 2;
const ACTION_SUPPLY_QUOTE = 3;

const RESIDUAL_NONE = 0;
const RESIDUAL_BUY_BASE = 1;
const RESIDUAL_SELL_BASE = 2;

export class ClearingMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClearingMathError";
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Rounding. Stated once, used everywhere, matching the engine exactly.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `floor(a * b / d)`, returning 0 when `d` is 0.
 *
 * The zero-denominator branch mirrors `Nox.safeDiv`, which returns encrypted false and encrypted
 * zero rather than reverting. A one-sided epoch has `B` or `Q` equal to zero and is completely
 * normal, so this is the common path and not an error case.
 */
export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) return 0n;
  return (a * b) / d;
}

/** `ceil(a * b / d)`, returning 0 when `d` is 0. Same zero semantics as above. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) return 0n;
  const product = a * b;
  return (product + d - 1n) / d;
}

/** `a - b`, saturating at zero. Mirrors a threaded `Nox.safeSub`. */
export function safeSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The clearing run
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Reproduces one complete clearing epoch in plaintext.
 *
 * @param price quote units per raw base unit, scaled by `PRICE_SCALE` — the sealed snapshot.
 */
export function clearEpoch(candidates: readonly CandidateInput[], price: bigint): EpochResult {
  if (candidates.length === 0) throw new ClearingMathError("an epoch needs at least one candidate");
  if (candidates.length > MAX_CANDIDATES) {
    throw new ClearingMathError(
      `${candidates.length} candidates exceeds the bound of ${MAX_CANDIDATES}; the engine refuses ` +
        "this at seal time and the coordinator must not propose it",
    );
  }
  if (price === 0n) {
    throw new ClearingMathError(
      "a zero reference price fails the epoch closed before any private redistribution — " +
        "ShrudReferencePriceRegistry reverts rather than reaching here",
    );
  }

  // --- A · classify -----------------------------------------------------------------------
  // Side and limit gate the AMOUNT, exactly as the engine does. There is no boolean composition
  // anywhere below, because Nox has none and a reimplementation that used one would diverge on the
  // first epoch where it mattered.
  const classified = candidates.map((c) => {
    const isBuy = c.action === ACTION_BUY_BASE;
    const isSell = c.action === ACTION_SELL_BASE;
    const isSupply = c.action === ACTION_SUPPLY_QUOTE;

    // Buyer holds a MAXIMUM: eligible when the epoch price is at or below it.
    const buyQuote = isBuy && price <= c.limit ? c.locked : 0n;
    // Seller holds a MINIMUM: eligible at or above it.
    const sellBase = isSell && price >= c.limit ? c.locked : 0n;
    const supplyQuote = isSupply ? c.locked : 0n;

    // Quote to base at the epoch price. Floors: a buyer never gets more base than they paid for.
    const buyDemandBase = mulDivFloor(buyQuote, PRICE_SCALE, price);

    return { buyQuote, sellBase, supplyQuote, buyDemandBase, limit: c.limit };
  });

  // --- B · accumulate ---------------------------------------------------------------------
  const grossBuyDemandBase = classified.reduce((sum, c) => sum + c.buyDemandBase, 0n);
  const grossSellSupplyBase = classified.reduce((sum, c) => sum + c.sellBase, 0n);
  const grossSupplyQuote = classified.reduce((sum, c) => sum + c.supplyQuote, 0n);
  const effectiveCount = classified.filter(
    (c) => c.buyQuote + c.sellBase + c.supplyQuote > 0n,
  ).length;

  // --- C · cross --------------------------------------------------------------------------
  // The whole product, in one line. Nox has no `min`, so the engine writes this as
  // `select(le(B, Q), B, Q)` — same value, three primitives.
  const crossedBase =
    grossBuyDemandBase <= grossSellSupplyBase ? grossBuyDemandBase : grossSellSupplyBase;
  const crossedQuote = mulDivFloor(crossedBase, price, PRICE_SCALE);

  // --- D · allocate -----------------------------------------------------------------------
  // Buyer base out FLOORS and buyer quote used CEILS. The asymmetry is deliberate: the buyer can
  // never receive more base than they paid for, and the vault can never owe more than it holds.
  // The gap is dust, it stays in a declared confidential balance, and PRD §10.9 forbids sweeping it
  // to a keeper or a team address.
  const allocated = classified.map((c) => ({
    ...c,
    crossBaseOut: mulDivFloor(crossedBase, c.buyDemandBase, grossBuyDemandBase),
    crossBaseUsed: mulDivFloor(crossedBase, c.sellBase, grossSellSupplyBase),
    crossQuoteOut: mulDivFloor(crossedQuote, c.sellBase, grossSellSupplyBase),
  }));

  const withQuoteUsed = allocated.map((c) => ({
    ...c,
    crossQuoteUsed: mulDivCeil(c.crossBaseOut, price, PRICE_SCALE),
  }));

  // --- E · residual -----------------------------------------------------------------------
  const netBuy = grossBuyDemandBase > grossSellSupplyBase;
  const netSell = grossSellSupplyBase > grossBuyDemandBase;
  const residualDirection = netBuy
    ? RESIDUAL_BUY_BASE
    : netSell
      ? RESIDUAL_SELL_BASE
      : RESIDUAL_NONE;

  const withResidual = withQuoteUsed.map((c) => {
    const unspentQuote = safeSub(c.buyQuote, c.crossQuoteUsed);
    const unsoldBase = safeSub(c.sellBase, c.crossBaseUsed);
    return { ...c, residualContribution: netBuy ? unspentQuote : netSell ? unsoldBase : 0n };
  });

  const residualAggregateInput = withResidual.reduce((sum, c) => sum + c.residualContribution, 0n);
  const residualContributorCount = withResidual.filter((c) => c.residualContribution > 0n).length;

  // --- F · aggregate minimum --------------------------------------------------------------
  // PRD §10.7's `residualInput_i` cancels out — see the engine's header for the derivation. The
  // aggregate minimum is set by the STRICTEST surviving limit and by nothing about how large that
  // participant's contribution was.
  const withRequirement = withResidual.map((c) => {
    if (c.residualContribution === 0n) return { ...c, requiredVenueTotal: 0n };
    const requirement = netBuy
      ? mulDivCeil(residualAggregateInput, PRICE_SCALE, c.limit)
      : mulDivCeil(residualAggregateInput, c.limit, PRICE_SCALE);
    return { ...c, requiredVenueTotal: requirement };
  });

  const residualAggregateMinimum = withRequirement.reduce(
    (max, c) => (c.requiredVenueTotal > max ? c.requiredVenueTotal : max),
    0n,
  );

  return {
    grossBuyDemandBase,
    grossSellSupplyBase,
    grossSupplyQuote,
    effectiveCount,
    crossedBase,
    crossedQuote,
    residualDirection,
    residualAggregateInput,
    residualAggregateMinimum,
    residualContributorCount,
    meetsEpochFloor: effectiveCount >= EPOCH_FLOOR_K,
    meetsResidualFloor: residualContributorCount >= RESIDUAL_FLOOR_K,
    candidates: withRequirement.map((c) => ({
      buyQuote: c.buyQuote,
      sellBase: c.sellBase,
      supplyQuote: c.supplyQuote,
      buyDemandBase: c.buyDemandBase,
      crossBaseOut: c.crossBaseOut,
      crossQuoteUsed: c.crossQuoteUsed,
      crossBaseUsed: c.crossBaseUsed,
      crossQuoteOut: c.crossQuoteOut,
      residualContribution: c.residualContribution,
      requiredVenueTotal: c.requiredVenueTotal,
      externalAllocation: 0n,
    })),
  };
}

/**
 * Allocates a measured venue output among residual contributors — PRD §10.8.
 *
 * FLOOR, ALWAYS. The sum of floors is at most `actualOutput`, so the vault can never owe more than
 * the venue delivered. The remainder is output dust. A rounding rule that could over-allocate would
 * be a solvency bug that only appears at specific participant counts.
 *
 * @param actualOutput the MEASURED balance delta at the recipient, never the adapter's report.
 */
export function allocateExternalOutput(
  result: EpochResult,
  actualOutput: bigint,
): { allocations: bigint[]; dust: bigint } {
  const allocations = result.candidates.map((c) =>
    mulDivFloor(actualOutput, c.residualContribution, result.residualAggregateInput),
  );
  const dust = actualOutput - allocations.reduce((sum, a) => sum + a, 0n);
  return { allocations, dust };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Conservation — the checks `pnpm verify:crossing` actually runs
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface ConservationReport {
  readonly holds: boolean;
  readonly failures: readonly string[];
  readonly baseDust: bigint;
  readonly quoteDust: bigint;
}

/**
 * PRD §21.2 and §21.3, in executable form.
 *
 * Each check names an invariant that would be invisible on chain if it broke: every quantity
 * involved is a ciphertext, so a violation produces no revert, no event and no anomaly an observer
 * could see. That is precisely why these are computed rather than asserted.
 */
export function checkConservation(result: EpochResult): ConservationReport {
  const failures: string[] = [];

  // 21.2.1 — crossed base is bounded by BOTH sides.
  if (result.crossedBase > result.grossBuyDemandBase) {
    failures.push("crossedBase exceeds gross buy demand");
  }
  if (result.crossedBase > result.grossSellSupplyBase) {
    failures.push("crossedBase exceeds gross sell supply");
  }

  // 21.2.2 / 21.2.3 — allocations sum to the crossed amount, up to declared dust.
  const buyerBase = result.candidates.reduce((sum, c) => sum + c.crossBaseOut, 0n);
  const sellerQuote = result.candidates.reduce((sum, c) => sum + c.crossQuoteOut, 0n);
  const baseDust = result.crossedBase - buyerBase;
  const quoteDust = result.crossedQuote - sellerQuote;

  if (baseDust < 0n) failures.push("buyer base allocations exceed the crossed base");
  if (quoteDust < 0n) failures.push("seller quote allocations exceed the crossed quote");

  // 21.2.4 / 21.2.5 — nobody spends more than they locked.
  for (const [i, c] of result.candidates.entries()) {
    if (c.crossQuoteUsed > c.buyQuote)
      failures.push(`candidate ${i} spent more quote than it locked`);
    if (c.crossBaseUsed > c.sellBase) failures.push(`candidate ${i} gave more base than it locked`);
  }

  // 21.3.2 — only one residual direction may be non-zero for a pair in one epoch.
  if (result.residualDirection === RESIDUAL_NONE && result.residualAggregateInput !== 0n) {
    failures.push("a non-zero residual with no direction");
  }

  // 21.3.1 — the residual is the eligible imbalance remaining after crossing.
  if (result.residualDirection === RESIDUAL_BUY_BASE) {
    const unmatchedBase = safeSub(result.grossBuyDemandBase, result.crossedBase);
    if (unmatchedBase === 0n && result.residualAggregateInput > 0n) {
      failures.push("a buy residual with no unmatched demand");
    }
  }

  return { holds: failures.length === 0, failures, baseDust, quoteDust };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The gas budget — delta D-9
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * EIP-7825, live on Sepolia at Osaka: one transaction may not exceed 2^24 gas.
 *
 * THE LOCAL NOX NODE HAS NO SUCH CAP AND WILL HAPPILY MINE A TRANSACTION SEPOLIA REFUSES. This is
 * the same class of trap as its unlimited contract size: a limit that exists on the real chain and
 * not in the environment the suite runs against. The check therefore lives outside the node.
 */
export const TRANSACTION_GAS_CAP = 16_777_216;

/**
 * Measured NoxCompute primitive counts per candidate, per stage.
 *
 * Counts rather than gas, because gas per primitive varies with the operand types and with whether
 * the handle is already in the runner's working set, while the COUNT is a property of the code and
 * is what changes when somebody adds an order family. `PRIMITIVE_GAS_ESTIMATE` converts, and is
 * deliberately conservative.
 */
export const CLEARING_PRIMITIVES = {
  /** eq×3, le, ge, select×5, safeMul, safeDiv, select×2 */
  classify: 14,
  /** add×3, add×2 for the contribution, gt, select, add */
  accumulate: 8,
  /** mulDiv×3 at 4 each, mulDivCeil at 7 */
  allocate: 19,
  /** safeSub×2 threaded, select, add×2, gt, select */
  residual: 12,
  /** mulDivCeil×2 at 7, select×2, gt, select */
  finalise: 18,
  /** mulDiv at 4, add, three grants */
  reconcile: 8,
} as const;

/** Paid once per epoch regardless of candidate count. */
export const CLEARING_FIXED_PRIMITIVES = {
  /** toEuint256×4 plus the epoch condition's add + eq */
  constants: 6,
  /** le, select, safeMul, safeDiv, select×2 */
  cross: 6,
  /** ge×2 and two `_isolateBool` at 7 each */
  floors: 16,
  /** allowPublicDecryption×5 */
  publish: 5,
} as const;

/**
 * A deliberately conservative per-primitive estimate.
 *
 * Every Nox primitive is an external call into the NoxCompute proxy — a CALL, a proxy delegate, an
 * ACL read, a keccak over the operands, a storage write for the transient grant, and an event. The
 * cheapest measured is around 6,000 and the dearest around 16,000, so 18,000 leaves headroom rather
 * than modelling an average. Under-estimating here produces an epoch that seals and then cannot
 * settle, with every participant's capital locked in escrow; over-estimating produces a smaller
 * batch. Those costs are not symmetric.
 */
export const PRIMITIVE_GAS_ESTIMATE = 18_000;

export interface StagePlan {
  readonly stage: keyof typeof CLEARING_PRIMITIVES;
  readonly candidatesPerTransaction: number;
  readonly transactions: number;
  readonly estimatedGasPerTransaction: number;
}

/**
 * How to run a `candidateCount`-candidate epoch without exceeding the cap.
 *
 * The coordinator calls this BEFORE sealing. An epoch that cannot be cleared within the cap must
 * never be sealed, because sealing locks capital.
 */
export function planClearing(candidateCount: number): StagePlan[] {
  if (candidateCount < 1 || candidateCount > MAX_CANDIDATES) {
    throw new ClearingMathError(
      `candidateCount must be between 1 and ${MAX_CANDIDATES}, received ${candidateCount}`,
    );
  }

  // Leave a fifth of the block for the fixed per-epoch work and for the transaction's own overhead.
  const perTransactionBudget = Math.floor(TRANSACTION_GAS_CAP * 0.8);

  return (Object.keys(CLEARING_PRIMITIVES) as (keyof typeof CLEARING_PRIMITIVES)[]).map((stage) => {
    const perCandidate = CLEARING_PRIMITIVES[stage] * PRIMITIVE_GAS_ESTIMATE;
    const fits = Math.max(1, Math.floor(perTransactionBudget / perCandidate));
    const candidatesPerTransaction = Math.min(fits, candidateCount);
    return {
      stage,
      candidatesPerTransaction,
      transactions: Math.ceil(candidateCount / candidatesPerTransaction),
      estimatedGasPerTransaction: candidatesPerTransaction * perCandidate,
    };
  });
}

/** Total estimated gas for a complete epoch, fixed work included. */
export function estimateEpochGas(candidateCount: number): number {
  const perCandidate = Object.values(CLEARING_PRIMITIVES).reduce((a, b) => a + b, 0);
  const fixed = Object.values(CLEARING_FIXED_PRIMITIVES).reduce((a, b) => a + b, 0);
  return (perCandidate * candidateCount + fixed) * PRIMITIVE_GAS_ESTIMATE;
}
