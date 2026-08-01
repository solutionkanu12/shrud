import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PRICE_SCALE } from "@shrud/shared";

import {
  allocateExternalOutput,
  type CandidateInput,
  checkConservation,
  clearEpoch,
  estimateEpochGas,
  planClearing,
  TRANSACTION_GAS_CAP,
} from "../dist/index.js";

/**
 * The clearing maths, checked on the cases that matter.
 *
 * This package exists to disagree with the on-chain engine when the engine is wrong. That only works
 * if it is right, and "right" here means the same rounding, the same zero-denominator behaviour and
 * the same gating order — not merely a plausible number.
 */

const BUY = 1;
const SELL = 2;
const SUPPLY = 3;
const HOLD = 5;

/** 2,000 quote units per whole base unit, in the engine's fixed-point form. */
const PRICE = 2_000n * PRICE_SCALE;

const buy = (locked: bigint, limit: bigint): CandidateInput => ({ locked, action: BUY, limit });
const sell = (locked: bigint, limit: bigint): CandidateInput => ({ locked, action: SELL, limit });

describe("clearEpoch", () => {
  it("crosses two opposing orders and leaves no residual when they balance", () => {
    // A buys with 2,000 quote at a limit of 2,000 -> demands 1 base.
    // B sells 1 base at a minimum of 2,000 -> supplies 1 base.
    const result = clearEpoch(
      [buy(2_000n * PRICE_SCALE, PRICE), sell(PRICE_SCALE, PRICE), { locked: 0n, action: HOLD, limit: 0n }],
      PRICE,
    );

    assert.equal(result.crossedBase, PRICE_SCALE, "one whole base unit crosses");
    assert.equal(result.residualAggregateInput, 0n, "a balanced epoch reaches no public venue");
    assert.equal(result.residualDirection, 0, "and has no direction");
  });

  /**
   * THE CENTRAL BEHAVIOUR. A limit that the epoch price does not satisfy contributes ZERO — without
   * a branch, without an error, and indistinguishably from an order that was never eligible.
   */
  it("zeroes an order whose private limit the epoch price does not meet", () => {
    // This buyer will pay at most 1,500. The epoch cleared at 2,000.
    const withFailingLimit = clearEpoch(
      [buy(2_000n * PRICE_SCALE, 1_500n * PRICE_SCALE), sell(PRICE_SCALE, PRICE)],
      PRICE,
    );

    assert.equal(withFailingLimit.candidates[0]?.buyQuote, 0n, "the ineligible buyer contributes zero");
    assert.equal(withFailingLimit.crossedBase, 0n, "so nothing crosses");
    assert.equal(withFailingLimit.effectiveCount, 1, "and only the seller counts as effective");
  });

  it("produces a net-buy residual when demand exceeds supply", () => {
    const result = clearEpoch(
      [
        buy(2_000n * PRICE_SCALE, PRICE),
        buy(2_000n * PRICE_SCALE, PRICE),
        sell(PRICE_SCALE, PRICE),
      ],
      PRICE,
    );

    assert.equal(result.residualDirection, 1, "net buy");
    assert.ok(result.residualAggregateInput > 0n, "unmatched quote reaches the venue");
    assert.equal(result.residualContributorCount, 2, "both buyers contribute");
  });

  /**
   * A one-sided epoch is NORMAL, not exceptional — and it is the case where `safeDiv` by zero would
   * bite. `mulDivFloor` returns zero for a zero denominator, exactly as a threaded `Nox.safeDiv`
   * does, so nothing here is a special case in the engine either.
   */
  it("handles a one-sided epoch without dividing by zero", () => {
    const result = clearEpoch([buy(2_000n * PRICE_SCALE, PRICE), buy(1_000n * PRICE_SCALE, PRICE)], PRICE);

    assert.equal(result.grossSellSupplyBase, 0n);
    assert.equal(result.crossedBase, 0n, "nothing to cross against");
    assert.equal(result.residualDirection, 1, "everything becomes residual");
    for (const c of result.candidates) {
      assert.equal(c.crossBaseOut, 0n, "no allocation from a zero denominator");
    }
  });

  /**
   * The aggregate minimum is set by the STRICTEST surviving limit and by nothing about size.
   *
   * This is the check that `residualInput_i` really does cancel out of PRD §10.7 — see the engine's
   * header. A large contributor with a loose limit must not be able to drag the minimum down.
   */
  it("sets the aggregate minimum from the strictest surviving limit, not the largest contributor", () => {
    const loose = 3_000n * PRICE_SCALE;
    const strict = 2_100n * PRICE_SCALE;

    const result = clearEpoch(
      [
        buy(100_000n * PRICE_SCALE, loose), // large, permissive
        buy(1_000n * PRICE_SCALE, strict), // small, demanding
      ],
      PRICE,
    );

    // The strict buyer's requirement is aggregate * SCALE / strictLimit, and it is the larger one.
    const strictRequirement = result.candidates[1]?.requiredVenueTotal ?? 0n;
    const looseRequirement = result.candidates[0]?.requiredVenueTotal ?? 0n;

    assert.ok(strictRequirement > looseRequirement, "a tighter limit demands more output");
    assert.equal(
      result.residualAggregateMinimum,
      strictRequirement,
      "the aggregate minimum is the maximum over contributors",
    );
  });

  it("refuses an oversized candidate set rather than truncating it", () => {
    const many = Array.from({ length: 17 }, () => buy(1n, PRICE));
    assert.throws(() => clearEpoch(many, PRICE), /exceeds the bound/);
  });

  it("refuses a zero price rather than producing a plausible number", () => {
    assert.throws(() => clearEpoch([buy(1n, PRICE)], 0n), /zero reference price/);
  });

  it("counts a supply order as effective without giving it a side", () => {
    const result = clearEpoch(
      [{ locked: 5_000n, action: SUPPLY, limit: 0n }, sell(PRICE_SCALE, PRICE)],
      PRICE,
    );
    assert.equal(result.grossSupplyQuote, 5_000n);
    assert.equal(result.effectiveCount, 2);
    assert.equal(result.grossBuyDemandBase, 0n, "a supply order is not a buy");
  });
});

describe("conservation", () => {
  /**
   * PRD §21.2 and §21.3, computed rather than asserted.
   *
   * Every quantity involved is a ciphertext on chain, so a violation produces no revert, no event
   * and no anomaly an observer could see. That is exactly why it is checked here.
   */
  it("holds for a partially crossed epoch, and reports the dust", () => {
    const result = clearEpoch(
      [
        buy(3_333n * PRICE_SCALE, PRICE),
        buy(1_111n * PRICE_SCALE, PRICE),
        sell(PRICE_SCALE, PRICE),
        sell(PRICE_SCALE / 3n, PRICE),
      ],
      PRICE,
    );

    const report = checkConservation(result);
    assert.equal(report.holds, true, report.failures.join("; "));
    assert.ok(report.baseDust >= 0n, "dust is non-negative — allocations never exceed the cross");
    assert.ok(report.quoteDust >= 0n);
  });

  it("never lets a participant spend more than it locked", () => {
    const result = clearEpoch(
      [buy(7n * PRICE_SCALE, PRICE), sell(PRICE_SCALE, PRICE), sell(PRICE_SCALE, PRICE)],
      PRICE,
    );

    for (const c of result.candidates) {
      assert.ok(c.crossQuoteUsed <= c.buyQuote, "a buyer never spends more quote than it locked");
      assert.ok(c.crossBaseUsed <= c.sellBase, "a seller never gives more base than it locked");
    }
  });
});

describe("allocateExternalOutput", () => {
  /**
   * FLOOR, ALWAYS. The sum of floors is at most the measured output, so the vault can never owe more
   * than the venue delivered. A rounding rule that could over-allocate would be a solvency bug that
   * only appears at specific participant counts.
   */
  it("never allocates more than the measured output", () => {
    const result = clearEpoch(
      [buy(1_000n * PRICE_SCALE, PRICE), buy(3_000n * PRICE_SCALE, PRICE), buy(7n * PRICE_SCALE, PRICE)],
      PRICE,
    );

    const measured = 999_999_999_999n;
    const { allocations, dust } = allocateExternalOutput(result, measured);
    const total = allocations.reduce((a, b) => a + b, 0n);

    assert.ok(total <= measured, "allocations never exceed what arrived");
    assert.equal(total + dust, measured, "and dust accounts for the remainder exactly");
    assert.ok(dust >= 0n);
  });
});

describe("gas planning", () => {
  /**
   * EIP-7825 caps one transaction at 2^24 gas, and the LOCAL NOX NODE HAS NO SUCH CAP. An epoch that
   * cannot be cleared within the cap must never be sealed, because sealing locks capital.
   */
  it("keeps every stage transaction under the EIP-7825 cap", () => {
    for (let n = 1; n <= 16; n++) {
      for (const stage of planClearing(n)) {
        assert.ok(
          stage.estimatedGasPerTransaction < TRANSACTION_GAS_CAP,
          `${stage.stage} at ${n} candidates estimates ${stage.estimatedGasPerTransaction}, over the cap`,
        );
        assert.ok(stage.candidatesPerTransaction >= 1, "a stage must always make progress");
        assert.ok(
          stage.transactions * stage.candidatesPerTransaction >= n,
          "the plan must cover every candidate",
        );
      }
    }
  });

  it("shows a full 16-candidate epoch exceeds one transaction, which is why staging exists", () => {
    const total = estimateEpochGas(16);
    assert.ok(
      total > TRANSACTION_GAS_CAP,
      `a 16-candidate epoch estimates ${total} gas, which must exceed ${TRANSACTION_GAS_CAP} — if it ` +
        "ever fits in one transaction, the staging machinery is no longer load-bearing and should be " +
        "reconsidered rather than left in place",
    );
  });

  it("refuses to plan an epoch outside the candidate bound", () => {
    assert.throws(() => planClearing(0), /between 1 and 16/);
    assert.throws(() => planClearing(17), /between 1 and 16/);
  });
});
