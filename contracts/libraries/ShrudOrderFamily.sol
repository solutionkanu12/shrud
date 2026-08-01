// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

/**
 * @title ShrudOrderFamily
 * @notice The finite registry of order families and the encrypted action ids inside them.
 *
 * PRD section 5.9 — "no fake universality". shrud supports a finite set of reviewed order families.
 * A family is the PUBLIC unit of disclosure: entering `USDC_WETH_ALLOCATION_V1` says only "this
 * Safe submitted something in the USDC/WETH family this epoch". Which of the four actions inside
 * it, at what size, with what limit, stays encrypted through settlement and after it.
 *
 * WHY THE ACTION ID IS `euint16` AND ITS VALUES ARE SMALL AND CONTIGUOUS. `euint16` is one of the
 * five encrypted types Nox supports, and it is the narrowest that fits. The values are contiguous
 * from 1 so the "belongs to this family" check is two comparisons rather than four equalities:
 * `ge(action, MIN) AND le(action, MAX)`, arithmetised per delta D-3. Zero is reserved and is what a
 * malformed or out-of-family action collapses to, which is why nothing maps to it.
 */
library ShrudOrderFamily {
    // -------------------------------------------------------------------------------------------
    // Families
    // -------------------------------------------------------------------------------------------

    /**
     * @notice The launch family: confidential USDC and WETH, crossing on Uniswap V3, supplying to
     *         Aave V3.
     *
     * The asset pair is not a free choice — delta D-8 records the measurement. On Sepolia, the ONLY
     * combination where a Uniswap V3 pool has both real liquidity and a non-zero observation
     * cardinality (so `observe()` returns a TWAP) AND whose quote token Aave actually lists as a
     * reserve is WETH9 `0xfff99767…6b14` / USDC `0x94a9D9AC…` at fee 500. Every alternative fails
     * one of the two tests and the rejected candidates are recorded with their numbers.
     */
    bytes32 internal constant USDC_WETH_ALLOCATION_V1 = keccak256("shrud.family.USDC_WETH_ALLOCATION_V1");

    // -------------------------------------------------------------------------------------------
    // Actions inside USDC_WETH_ALLOCATION_V1. Encrypted. Never public, before or after settlement.
    // -------------------------------------------------------------------------------------------

    /// @dev Reserved. Nothing maps to it, so a malformed action collapses here and contributes zero.
    uint16 internal constant ACTION_NONE = 0;

    /// @dev Spend confidential quote (USDC) to receive base (WETH).
    uint16 internal constant ACTION_BUY_BASE = 1;

    /// @dev Spend confidential base (WETH) to receive quote (USDC).
    uint16 internal constant ACTION_SELL_BASE = 2;

    /// @dev Supply confidential quote (USDC) into the aggregate Aave position.
    uint16 internal constant ACTION_SUPPLY_QUOTE = 3;

    /// @dev Withdraw from the aggregate Aave position against confidential shares.
    uint16 internal constant ACTION_WITHDRAW_QUOTE = 4;

    /// @dev Do nothing this epoch. A real, useful action: it makes "submitted" uninformative.
    uint16 internal constant ACTION_HOLD = 5;

    uint16 internal constant ACTION_MIN = ACTION_BUY_BASE;
    uint16 internal constant ACTION_MAX = ACTION_HOLD;

    // -------------------------------------------------------------------------------------------
    // Private outcome codes. Decryptable ONLY by the owning Safe's current owners.
    // -------------------------------------------------------------------------------------------
    //
    // PRD section 12.1 lists ten. Every public candidate reaches `Processed` regardless of which of
    // these its private handle records, which is the whole point: the public lifecycle is uniform
    // and carries no information, and the real result lives in a handle only the owner can read.

    uint16 internal constant OUTCOME_PENDING = 0;
    uint16 internal constant OUTCOME_CROSSED_INTERNALLY = 1;
    uint16 internal constant OUTCOME_CROSSED_PLUS_RESIDUAL = 2;
    uint16 internal constant OUTCOME_RESIDUAL_ONLY = 3;
    uint16 internal constant OUTCOME_AAVE_SUPPLIED = 4;
    uint16 internal constant OUTCOME_HELD = 5;
    uint16 internal constant OUTCOME_ZERO_INSUFFICIENT_BALANCE = 6;
    uint16 internal constant OUTCOME_ZERO_LIMIT_FAILED = 7;
    uint16 internal constant OUTCOME_ZERO_POLICY_FAILED = 8;
    uint16 internal constant OUTCOME_DEFERRED_PRIVACY_FLOOR = 9;
    uint16 internal constant OUTCOME_REFUNDED_VENUE_FAILURE = 10;

    // -------------------------------------------------------------------------------------------
    // Residual direction. Published, so it is a plain uint8 and never a handle after decryption.
    // -------------------------------------------------------------------------------------------

    uint8 internal constant RESIDUAL_NONE = 0;
    /// @dev Net buy: unmatched quote goes to the venue and comes back as base.
    uint8 internal constant RESIDUAL_BUY_BASE = 1;
    /// @dev Net sell: unmatched base goes to the venue and comes back as quote.
    uint8 internal constant RESIDUAL_SELL_BASE = 2;
    /// @dev Aggregate supply into the pooled position. Not an imbalance; a one-sided route.
    uint8 internal constant RESIDUAL_SUPPLY_QUOTE = 3;
    /// @dev Aggregate withdrawal from the pooled position.
    uint8 internal constant RESIDUAL_WITHDRAW_QUOTE = 4;

    /**
     * @notice Fixed-point scale for every price in the clearing maths.
     *
     * @dev `P` is quote units per ONE WHOLE base unit, scaled by `PRICE_SCALE`. Keeping the price
     *      per whole token rather than per raw unit means the 6-vs-18 decimal gap between USDC and
     *      WETH is absorbed once, in `ShrudReferencePriceRegistry`, instead of leaking into every
     *      `safeMul`/`safeDiv` pair in the engine where a misplaced factor would be an encrypted,
     *      unobservable value transfer between crossed participants.
     */
    uint256 internal constant PRICE_SCALE = 1e18;

    /**
     * @notice Maximum candidate orders in one clearing epoch.
     *
     * @dev PRD section 9.7 sets 16. It is a hard bound, not a target: Nox has no batch entry point,
     *      so the operation graph grows linearly in candidates, and EIP-7825 caps one transaction at
     *      2^24 gas. `packages/clearing-math` carries the measured per-stage budget and
     *      `ShrudClearingEngine` splits the graph across staged transactions accordingly — delta D-9.
     */
    uint256 internal constant MAX_CANDIDATES = 16;
}
