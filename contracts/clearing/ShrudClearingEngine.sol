// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {
    Nox,
    ebool,
    euint16,
    euint256
} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

import {ShrudHandleIsolation} from "../base/ShrudHandleIsolation.sol";
import {ShrudIntentBook} from "../intents/ShrudIntentBook.sol";
import {ShrudOrderFamily} from "../libraries/ShrudOrderFamily.sol";
import {ShrudPauseController} from "../recovery/ShrudPauseController.sol";
import {ShrudClearingVault} from "./ShrudClearingVault.sol";
import {ShrudReferencePriceRegistry} from "./ShrudReferencePriceRegistry.sol";

/**
 * @title ShrudClearingEngine
 * @notice Confidential net clearing: classify, cross, and compute the residual — without a single
 *         public branch on a private value.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS RUNS IN STAGES INSTEAD OF ONE CALL
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two hard limits, and they point the same way. Nox has **no batch entry point** — every primitive
 * is a separate external call into NoxCompute, so cost is linear in the number of operations and
 * there is no amortisation to find. EIP-7825, live on Sepolia at Osaka, caps a single transaction
 * at 2^24 = 16,777,216 gas. A sixteen-candidate epoch is roughly 800 primitives; it does not fit,
 * and the local Nox node would never say so because it has no such cap.
 *
 * So the graph is staged, each stage is resumable through a cursor, and each stage takes a
 * `maxCandidates` bound the caller sizes. Delta D-9. The staging is exposed rather than hidden: the
 * interface shows which stage an epoch is in and what remains, because an asynchronous confidential
 * computation that pretends to be instantaneous is a worse product than one that says where it is.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THERE IS NO BOOLEAN ALGEBRA IN NOX, SO THERE IS NONE HERE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PRD section 10.2 writes `eligibleBuy_i = v_i AND isBuy_i AND buyLimitPass_i`. Nox has no `and`,
 * `or`, `not` or `xor`, and `select` has no `ebool` overload (delta D-3), so that line cannot be
 * written as it stands.
 *
 * shrud does not simulate boolean algebra. It gates the AMOUNT, chaining `select` against an
 * encrypted zero:
 *
 *     amount = select(isBuy,     amount, ZERO)
 *     amount = select(limitPass, amount, ZERO)
 *
 * Arithmetically identical, two operations instead of the four an arithmetised `AND` would cost,
 * and — the part that matters — there is no point at which a combined boolean exists that could be
 * granted, published or accidentally decrypted.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY SAFE-OP SUCCESS FLAG IS THREADED. NONE IS IGNORED.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `safeMul`, `safeDiv`, `safeAdd` and `safeSub` return `(ebool success, T result)`, and on failure
 * `success` is encrypted false **and `result` is encrypted zero**, while the transaction succeeds
 * normally. Unsafe `div` by zero does not revert either — it saturates to the type maximum. The
 * flag is a ciphertext, so Solidity cannot branch on it (delta D-4).
 *
 * `_mulDiv` below threads both flags through `select` before the result can become anything. A
 * silent encrypted zero never reaches an allocation, and a saturated maximum never reaches a
 * transfer. It is one helper used everywhere rather than a pattern repeated and eventually missed.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE AGGREGATE MINIMUM SIMPLIFIES, AND THE SIMPLIFICATION IS EXACT
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PRD section 10.7 gives
 *
 *     requiredVenueTotal_i = ceil(remainingMinimum_i * residualAggregateInput / residualInput_i)
 *
 * For a buy contributor with private max price `l_i`, the minimum base its own residual quote must
 * buy is `residualInput_i * S / l_i`. Substituting:
 *
 *     ceil( (residualInput_i * S / l_i) * aggregate / residualInput_i )  ==  ceil(aggregate * S / l_i)
 *
 * `residualInput_i` cancels. That is worth stating plainly because it changes the cost from four
 * primitives per candidate plus a division by a per-candidate denominator, to three — and because
 * it makes the meaning obvious: the aggregate minimum is set by the STRICTEST surviving limit, and
 * by nothing about how large that participant's contribution was. The mirror case for a sell
 * contributor is `ceil(aggregate * l_i / S)`.
 *
 * `M` is then the encrypted maximum over contributors, composed from `gt` and `select` exactly as
 * PRD section 10.7 requires. Only `M` is ever published.
 */
contract ShrudClearingEngine is ShrudHandleIsolation {
    // -------------------------------------------------------------------------------------------
    // Stages
    // -------------------------------------------------------------------------------------------

    enum Stage {
        None,
        /// Sealed and price-fixed. Ready to classify.
        Sealed,
        /// Per-candidate side, limit and eligibility resolved.
        Classified,
        /// Gross demand, gross supply and the effective count summed.
        Accumulated,
        /// Internal crossing computed.
        Crossed,
        /// Per-candidate internal allocations computed.
        Allocated,
        /// Residual direction, aggregate input, aggregate minimum and both floors computed.
        ResidualComputed,
        /// The five handles marked publicly decryptable and committed to the intent book.
        Published
    }

    /// @notice PRD section 6.3: at least three effective treasuries across the epoch.
    uint256 public constant EPOCH_FLOOR_K = 3;

    /// @notice PRD section 6.3: at least two effective contributors to any public residual route.
    uint256 public constant RESIDUAL_FLOOR_K = 2;

    struct EpochCompute {
        Stage stage;
        uint16 count;
        uint16 cursor;
        address baseWrapper;
        address quoteWrapper;
        uint256 price;
        // Cached public handles. Deterministic in their plaintext, so caching costs nothing in
        // correctness and saves four NoxCompute calls per candidate per stage.
        bytes32 zero;
        bytes32 one;
        bytes32 scale;
        bytes32 priceHandle;
        bytes32 epochCondition;
        // Aggregates. All encrypted, none published.
        bytes32 grossBuyDemandBase;
        bytes32 grossSellSupplyBase;
        bytes32 grossSupplyQuote;
        bytes32 effectiveCount;
        bytes32 crossedBase;
        bytes32 crossedQuote;
        // The five that may become public, after the floors pass.
        bytes32 residualDirection;
        bytes32 residualAggregateInput;
        bytes32 residualAggregateMinimum;
        bytes32 meetsEpochFloor;
        bytes32 meetsResidualFloor;
        // Encrypted and never published: the exact contributor count.
        bytes32 residualContributorCount;
        // The pooled-position route. Its own aggregate, its own contributor count, its own floor.
        bytes32 supplyContributorCount;
        bytes32 meetsSupplyFloor;
    }

    struct Candidate {
        bytes32 intentId;
        /// Eligible quote a buyer is spending, after side and limit gating. Encrypted zero if not.
        bytes32 buyQuote;
        /// Eligible base a seller is supplying. Encrypted zero if not.
        bytes32 sellBase;
        /// Eligible quote heading for the pooled Aave position.
        bytes32 supplyQuote;
        /// `buyQuote` expressed in base units at the epoch price.
        bytes32 buyDemandBase;
        /// Base a buyer receives from the internal cross.
        bytes32 crossBaseOut;
        /// Quote a buyer spends on the internal cross.
        bytes32 crossQuoteUsed;
        /// Base a seller gives to the internal cross.
        bytes32 crossBaseUsed;
        /// Quote a seller receives from the internal cross.
        bytes32 crossQuoteOut;
        /// What this candidate contributes to the public residual, in the residual's input asset.
        bytes32 residualContribution;
        /// The venue output this candidate's own private limit demands, or zero.
        bytes32 requiredVenueTotal;
    }

    ShrudIntentBook public immutable intentBook;
    ShrudClearingVault public immutable clearingVault;
    ShrudReferencePriceRegistry public immutable priceRegistry;
    address public immutable settlementEngine;

    mapping(bytes32 epochId => EpochCompute) private _epochs;
    mapping(bytes32 epochId => Candidate[]) private _candidates;

    event EpochOpened(bytes32 indexed epochId, bytes32 routeId);
    event EpochSealed(bytes32 indexed epochId, uint16 candidateCount, uint256 price, bytes32 snapshotId);
    event StageAdvanced(bytes32 indexed epochId, Stage from, Stage to);
    event StageProgress(bytes32 indexed epochId, Stage stage, uint16 cursor, uint16 count);
    event ResidualPublished(bytes32 indexed epochId);

    error WrongStage(bytes32 epochId, Stage expected, Stage actual);
    error StageNotFinished(bytes32 epochId, Stage stage, uint16 cursor, uint16 count);
    error EpochAlreadyOpen(bytes32 epochId);
    error EpochUnknown(bytes32 epochId);
    error NotSettlementEngine(address caller);
    error CandidateBoundExceeded(uint256 supplied, uint256 maximum);
    error ZeroBatch();

    constructor(
        ShrudIntentBook intentBook_,
        ShrudClearingVault clearingVault_,
        ShrudReferencePriceRegistry priceRegistry_,
        address settlementEngine_,
        ShrudPauseController pauseController_
    ) ShrudHandleIsolation(pauseController_) {
        intentBook = intentBook_;
        clearingVault = clearingVault_;
        priceRegistry = priceRegistry_;
        settlementEngine = settlementEngine_;
    }

    /// @notice The settlement engine is the only contract that ever receives a transient handle here.
    function isReviewedTransientRecipient(address recipient) public view override returns (bool) {
        return recipient == settlementEngine || recipient == address(clearingVault);
    }

    // -------------------------------------------------------------------------------------------
    // 0 · Open and seal
    // -------------------------------------------------------------------------------------------

    function openEpoch(
        bytes32 epochId,
        bytes32 orderFamily,
        address baseWrapper,
        address quoteWrapper
    ) external {
        pauseController.requireLive(ShrudPauseController.Activity.Seal);
        if (_epochs[epochId].stage != Stage.None) revert EpochAlreadyOpen(epochId);

        _epochs[epochId].baseWrapper = baseWrapper;
        _epochs[epochId].quoteWrapper = quoteWrapper;
        intentBook.openEpoch(epochId, orderFamily, baseWrapper, quoteWrapper);
        emit EpochOpened(epochId, orderFamily);
    }

    /**
     * @notice Fixes the candidate set and the reference price in one transaction.
     *
     * @dev Permissionless, and the coordinator has no privilege here — PRD section 13.2. Everything
     *      it could choose is constrained: the candidate set must be sorted (`ShrudIntentBook`), the
     *      price comes from the registry's own TWAP over a registered pool, and the snapshot records
     *      the block it came from. A second coordinator proposing the same set at the same block
     *      would produce the same epoch.
     *
     *      THE PRICE IS FIXED BEFORE ANY PRIVATE VALUE IS TOUCHED. If `fixPrice` reverts — stale
     *      observations, cardinality zero, spot too far from the mean — the epoch fails here,
     *      publicly, with every confidential handle untouched. PRD section 10.11.
     */
    function sealEpoch(bytes32 epochId, bytes32[] calldata intentIds, bytes32 routeId) external {
        pauseController.requireLive(ShrudPauseController.Activity.Seal);
        EpochCompute storage epoch = _epochs[epochId];
        if (epoch.stage != Stage.None) revert EpochAlreadyOpen(epochId);
        if (intentIds.length == 0) revert ZeroBatch();
        if (intentIds.length > ShrudOrderFamily.MAX_CANDIDATES) {
            revert CandidateBoundExceeded(intentIds.length, ShrudOrderFamily.MAX_CANDIDATES);
        }

        (bytes32 snapshotId, uint256 price) = priceRegistry.fixPrice(routeId);

        intentBook.sealEpoch(epochId, intentIds, snapshotId, price);

        epoch.stage = Stage.Sealed;
        epoch.count = uint16(intentIds.length);
        epoch.cursor = 0;
        epoch.price = price;

        Candidate[] storage slots = _candidates[epochId];
        for (uint256 i = 0; i < intentIds.length; ++i) {
            slots.push();
            slots[i].intentId = intentIds[i];
        }

        emit EpochSealed(epochId, uint16(intentIds.length), price, snapshotId);
    }

    // -------------------------------------------------------------------------------------------
    // A · Classify — side, private limit, eligibility
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Resolves each candidate's side and limit into gated amounts. Resumable.
     *
     * @dev THE ONLY PLACE A PRIVATE LIMIT IS COMPARED WITH THE PUBLIC PRICE. For a buyer holding a
     *      private MAXIMUM price, eligibility is `P <= l_i`. For a seller holding a private MINIMUM,
     *      it is `P >= l_i`. Both comparisons produce a ciphertext, both feed a `select`, and
     *      neither produces a branch, an event or a gas difference an observer could read.
     *
     *      An order that fails its limit, chose no recognised side, or locked nothing becomes an
     *      encrypted zero contribution and remains a candidate in every public sense.
     */
    function runClassification(bytes32 epochId, uint16 maxCandidates) external {
        EpochCompute storage epoch = _requireStage(epochId, Stage.Sealed);
        pauseController.requireNotHalted(ShrudPauseController.Activity.Clear);
        if (maxCandidates == 0) revert ZeroBatch();

        if (epoch.cursor == 0) _initialiseConstants(epochId, epoch);

        euint256 zero = euint256.wrap(epoch.zero);
        euint256 scale = euint256.wrap(epoch.scale);
        euint256 priceHandle = euint256.wrap(epoch.priceHandle);

        uint16 end = _batchEnd(epoch, maxCandidates);
        Candidate[] storage slots = _candidates[epochId];

        for (uint16 i = epoch.cursor; i < end; ++i) {
            ShrudIntentBook.IntentHandles memory handles = intentBook.handlesOf(slots[i].intentId);
            euint256 locked = clearingVault.escrowOf(slots[i].intentId);
            euint16 action = euint16.wrap(handles.actionId);
            euint256 limit = euint256.wrap(handles.limit);

            // Buy: spend quote, receive base. Eligible when the epoch price is at or below the
            // private maximum the owner set.
            euint256 buyQuote = Nox.select(
                Nox.eq(action, Nox.toEuint16(ShrudOrderFamily.ACTION_BUY_BASE)), locked, zero
            );
            buyQuote = Nox.select(Nox.le(priceHandle, limit), buyQuote, zero);

            // Sell: spend base, receive quote. Eligible at or above the private minimum.
            euint256 sellBase = Nox.select(
                Nox.eq(action, Nox.toEuint16(ShrudOrderFamily.ACTION_SELL_BASE)), locked, zero
            );
            sellBase = Nox.select(Nox.ge(priceHandle, limit), sellBase, zero);

            // Supply: no price condition. The pooled position accepts what it is given.
            euint256 supplyQuote = Nox.select(
                Nox.eq(action, Nox.toEuint16(ShrudOrderFamily.ACTION_SUPPLY_QUOTE)), locked, zero
            );

            // Quote units to base units at the epoch price. `_mulDiv` threads both success flags,
            // so an overflow or a zero price yields encrypted zero rather than a saturated maximum.
            euint256 buyDemandBase = _mulDiv(buyQuote, scale, priceHandle, zero);

            _persist(buyQuote);
            _persist(sellBase);
            _persist(supplyQuote);
            _persist(buyDemandBase);

            slots[i].buyQuote = euint256.unwrap(buyQuote);
            slots[i].sellBase = euint256.unwrap(sellBase);
            slots[i].supplyQuote = euint256.unwrap(supplyQuote);
            slots[i].buyDemandBase = euint256.unwrap(buyDemandBase);
        }

        _advance(epochId, epoch, end, Stage.Classified);
    }

    // -------------------------------------------------------------------------------------------
    // B · Accumulate — gross demand, gross supply, effective count
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Sums the encrypted contributions. Resumable.
     *
     * @dev `B` AND `Q` ARE NEVER PUBLISHED, AND PRD SECTION 10.3 SAYS SO FOR A REASON. Publishing
     *      gross buy demand alongside a net residual would let anyone subtract to obtain the crossed
     *      volume, and with a sixteen-candidate set the crossed volume plus the candidate list is
     *      most of the way to attribution. Only the NET leaves this contract.
     *
     *      The effective count is accumulated the same way, as an encrypted 0/1 indicator per
     *      candidate. `countEpoch` itself stays encrypted forever; only `countEpoch >= 3` is ever
     *      published, and that single bit is the entire public statement about who took part.
     */
    function runAccumulation(bytes32 epochId, uint16 maxCandidates) external {
        EpochCompute storage epoch = _requireStage(epochId, Stage.Classified);
        pauseController.requireNotHalted(ShrudPauseController.Activity.Clear);
        if (maxCandidates == 0) revert ZeroBatch();

        euint256 zero = euint256.wrap(epoch.zero);
        euint256 one = euint256.wrap(epoch.one);

        euint256 grossBuy = _loadOrZero(epoch.grossBuyDemandBase, zero);
        euint256 grossSell = _loadOrZero(epoch.grossSellSupplyBase, zero);
        euint256 grossSupply = _loadOrZero(epoch.grossSupplyQuote, zero);
        euint256 effective = _loadOrZero(epoch.effectiveCount, zero);
        euint256 supplyContributors = _loadOrZero(epoch.supplyContributorCount, zero);

        uint16 end = _batchEnd(epoch, maxCandidates);
        Candidate[] storage slots = _candidates[epochId];

        for (uint16 i = epoch.cursor; i < end; ++i) {
            Candidate storage slot = slots[i];
            grossBuy = Nox.add(grossBuy, euint256.wrap(slot.buyDemandBase));
            grossSell = Nox.add(grossSell, euint256.wrap(slot.sellBase));
            grossSupply = Nox.add(grossSupply, euint256.wrap(slot.supplyQuote));

            // One indicator per candidate: did it contribute anything at all, on any side.
            euint256 contribution = Nox.add(
                Nox.add(euint256.wrap(slot.buyQuote), euint256.wrap(slot.sellBase)),
                euint256.wrap(slot.supplyQuote)
            );
            effective = Nox.add(effective, Nox.select(Nox.gt(contribution, zero), one, zero));

            // The pooled route's own contributor count, accumulated here because `supplyQuote` is
            // final from classification onward and never changes again.
            supplyContributors = Nox.add(
                supplyContributors,
                Nox.select(Nox.gt(euint256.wrap(slot.supplyQuote), zero), one, zero)
            );
        }

        _persist(grossBuy);
        _persist(grossSell);
        _persist(grossSupply);
        _persist(effective);
        _persist(supplyContributors);

        epoch.supplyContributorCount = euint256.unwrap(supplyContributors);
        epoch.grossBuyDemandBase = euint256.unwrap(grossBuy);
        epoch.grossSellSupplyBase = euint256.unwrap(grossSell);
        epoch.grossSupplyQuote = euint256.unwrap(grossSupply);
        epoch.effectiveCount = euint256.unwrap(effective);

        _advance(epochId, epoch, end, Stage.Accumulated);
    }

    // -------------------------------------------------------------------------------------------
    // C · Cross — the decisive mechanism
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Computes how much of the two sides can settle against each other, privately.
     *
     * @dev `crossedBase = min(B, Q)`, expressed as `select(le(B, Q), B, Q)` because Nox has no
     *      `min`. Everything either side wanted beyond that is what the public venue will see, and
     *      nothing else about either side ever becomes visible.
     *
     *      This is the whole product in three primitives. The value is that a treasury's buy and
     *      another's sell settle at a public reference price without either amount, side or identity
     *      reaching a venue — and the venue's own volume, slippage and MEV surface shrink to the
     *      imbalance rather than the gross.
     */
    function runCrossing(bytes32 epochId) external {
        EpochCompute storage epoch = _requireStage(epochId, Stage.Accumulated);
        pauseController.requireNotHalted(ShrudPauseController.Activity.Clear);

        // THE CURSOR IS NOT CHECKED HERE, AND MUST NOT BE.
        //
        // `_advance` resets `cursor` to zero at the moment a per-candidate stage completes, and only
        // then sets the next stage. So an epoch that has reached `Accumulated` always has a cursor of
        // zero, and the previous `_requireCursorFinished` demanded `cursor == count` — satisfiable
        // only by an epoch with no candidates at all. Every real epoch reverted `StageNotFinished`
        // here and could never progress past accumulation.
        //
        // Being in `Accumulated` is already the proof this check was reaching for: `_advance` sets
        // that stage only when `end == count`, which is every candidate.

        euint256 zero = euint256.wrap(epoch.zero);
        euint256 grossBuy = euint256.wrap(epoch.grossBuyDemandBase);
        euint256 grossSell = euint256.wrap(epoch.grossSellSupplyBase);

        euint256 crossedBase = Nox.select(Nox.le(grossBuy, grossSell), grossBuy, grossSell);
        euint256 crossedQuote =
            _mulDiv(crossedBase, euint256.wrap(epoch.priceHandle), euint256.wrap(epoch.scale), zero);

        _persist(crossedBase);
        _persist(crossedQuote);

        epoch.crossedBase = euint256.unwrap(crossedBase);
        epoch.crossedQuote = euint256.unwrap(crossedQuote);
        epoch.cursor = 0;

        _setStage(epochId, epoch, Stage.Crossed);
    }

    // -------------------------------------------------------------------------------------------
    // D · Allocate — each treasury's share of the internal cross
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Pro-rata allocation of the crossed amount, with an ENCRYPTED denominator. Resumable.
     *
     * @dev THIS IS THE ONE THING THAT CANNOT BE DONE WITHOUT ENCRYPTED-BY-ENCRYPTED DIVISION.
     *      `buyerCrossBase_i = crossedBase * buyDemandBase_i / B` divides two ciphertexts by a
     *      third. Publishing `B` to make the divisor plaintext would publish gross demand, which is
     *      the value the whole design exists to hide.
     *
     *      `B` OR `Q` MAY LEGITIMATELY BE ZERO — a one-sided epoch is normal, not exceptional.
     *      `safeDiv` returns encrypted false and encrypted zero rather than reverting, and `_mulDiv`
     *      threads that flag, so a one-sided epoch produces zero internal cross and flows straight
     *      to the residual. No public branch is taken, and an observer cannot tell a one-sided epoch
     *      from a balanced one at this stage.
     *
     *      ROUNDING IS DIRECTIONAL AND DELIBERATE. Buyer base out floors, buyer quote used ceils:
     *      the buyer can never receive more base than they paid for, and the vault can never owe
     *      more than it holds. The gap is dust, it stays in a declared confidential balance, and it
     *      is never swept to a keeper or a team address (PRD section 10.9).
     */
    function runAllocation(bytes32 epochId, uint16 maxCandidates) external {
        EpochCompute storage epoch = _requireStage(epochId, Stage.Crossed);
        pauseController.requireNotHalted(ShrudPauseController.Activity.Clear);
        if (maxCandidates == 0) revert ZeroBatch();

        euint256 zero = euint256.wrap(epoch.zero);
        euint256 crossedBase = euint256.wrap(epoch.crossedBase);
        euint256 crossedQuote = euint256.wrap(epoch.crossedQuote);
        euint256 grossBuy = euint256.wrap(epoch.grossBuyDemandBase);
        euint256 grossSell = euint256.wrap(epoch.grossSellSupplyBase);

        uint16 end = _batchEnd(epoch, maxCandidates);
        Candidate[] storage slots = _candidates[epochId];

        for (uint16 i = epoch.cursor; i < end; ++i) {
            Candidate storage slot = slots[i];

            // Buyer: floor the base received, ceil the quote spent.
            euint256 crossBaseOut =
                _mulDiv(crossedBase, euint256.wrap(slot.buyDemandBase), grossBuy, zero);
            euint256 crossQuoteUsed = _mulDivCeil(
                crossBaseOut, euint256.wrap(epoch.priceHandle), euint256.wrap(epoch.scale), zero
            );

            // Seller: floor both. A seller can never give more base than it locked, and never
            // receive more quote than the cross produced.
            euint256 crossBaseUsed =
                _mulDiv(crossedBase, euint256.wrap(slot.sellBase), grossSell, zero);
            euint256 crossQuoteOut =
                _mulDiv(crossedQuote, euint256.wrap(slot.sellBase), grossSell, zero);

            _persist(crossBaseOut);
            _persist(crossQuoteUsed);
            _persist(crossBaseUsed);
            _persist(crossQuoteOut);

            slot.crossBaseOut = euint256.unwrap(crossBaseOut);
            slot.crossQuoteUsed = euint256.unwrap(crossQuoteUsed);
            slot.crossBaseUsed = euint256.unwrap(crossBaseUsed);
            slot.crossQuoteOut = euint256.unwrap(crossQuoteOut);
        }

        _advance(epochId, epoch, end, Stage.Allocated);
    }

    // -------------------------------------------------------------------------------------------
    // E · Residual — direction, aggregate input, aggregate minimum, floors
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Computes what — if anything — has to reach a public venue. Resumable.
     *
     * @dev `residualDirection` is a `euint16` carrying `ShrudOrderFamily.RESIDUAL_*`. It is composed
     *      from two comparisons and two selects and stays encrypted until the floors have passed.
     *
     *      A candidate's residual contribution is its unmatched leftover in whichever asset the
     *      residual direction spends: unspent quote for a buyer in a net-buy epoch, unsold base for
     *      a seller in a net-sell epoch, and encrypted zero on the losing side. `select` on the
     *      direction picks between them, so a candidate on the crossed-out side contributes zero
     *      without any branch revealing which side that was.
     */
    function runResidual(bytes32 epochId, uint16 maxCandidates) external {
        EpochCompute storage epoch = _requireStage(epochId, Stage.Allocated);
        pauseController.requireNotHalted(ShrudPauseController.Activity.Clear);
        if (maxCandidates == 0) revert ZeroBatch();

        if (epoch.cursor == 0) _computeDirection(epoch);

        _accumulateResidual(epochId, epoch, maxCandidates);
    }

    function _computeDirection(EpochCompute storage epoch) private {
        euint256 grossBuy = euint256.wrap(epoch.grossBuyDemandBase);
        euint256 grossSell = euint256.wrap(epoch.grossSellSupplyBase);

        ebool netBuy = Nox.gt(grossBuy, grossSell);
        ebool netSell = Nox.gt(grossSell, grossBuy);

        euint16 direction = Nox.select(
            netBuy,
            Nox.toEuint16(ShrudOrderFamily.RESIDUAL_BUY_BASE),
            Nox.select(
                netSell,
                Nox.toEuint16(ShrudOrderFamily.RESIDUAL_SELL_BASE),
                Nox.toEuint16(ShrudOrderFamily.RESIDUAL_NONE)
            )
        );
        Nox.allowThis(direction);
        epoch.residualDirection = euint16.unwrap(direction);
    }

    function _accumulateResidual(bytes32 epochId, EpochCompute storage epoch, uint16 maxCandidates)
        private
    {
        euint256 zero = euint256.wrap(epoch.zero);
        euint256 one = euint256.wrap(epoch.one);
        ebool isNetBuy =
            Nox.eq(euint16.wrap(epoch.residualDirection), Nox.toEuint16(ShrudOrderFamily.RESIDUAL_BUY_BASE));

        euint256 aggregate = _loadOrZero(epoch.residualAggregateInput, zero);
        euint256 contributors = _loadOrZero(epoch.residualContributorCount, zero);
        euint256 minimum = _loadOrZero(epoch.residualAggregateMinimum, zero);

        uint16 end = _batchEnd(epoch, maxCandidates);
        Candidate[] storage slots = _candidates[epochId];

        for (uint16 i = epoch.cursor; i < end; ++i) {
            Candidate storage slot = slots[i];

            // Unmatched leftovers on each side. `safeSub` cannot underflow here — a candidate's
            // cross allocation is bounded by its own contribution — but the flag is threaded anyway,
            // because "cannot underflow here" is an argument about today's call graph.
            euint256 unspentQuote =
                _safeSub(euint256.wrap(slot.buyQuote), euint256.wrap(slot.crossQuoteUsed), zero);
            euint256 unsoldBase =
                _safeSub(euint256.wrap(slot.sellBase), euint256.wrap(slot.crossBaseUsed), zero);

            euint256 contribution = Nox.select(isNetBuy, unspentQuote, unsoldBase);
            _persist(contribution);
            slot.residualContribution = euint256.unwrap(contribution);

            aggregate = Nox.add(aggregate, contribution);
            contributors = Nox.add(contributors, Nox.select(Nox.gt(contribution, zero), one, zero));
        }

        _persist(aggregate);
        _persist(contributors);
        epoch.residualAggregateInput = euint256.unwrap(aggregate);
        epoch.residualContributorCount = euint256.unwrap(contributors);
        _persist(minimum);
        epoch.residualAggregateMinimum = euint256.unwrap(minimum);

        _advance(epochId, epoch, end, Stage.ResidualComputed);
    }

    /**
     * @notice Computes the aggregate minimum output and both privacy floors.
     *
     * @dev Split from `runResidual` because it needs the FINAL aggregate, which only exists once
     *      every candidate has been through the loop above. Running it inside the resumable loop
     *      would compute each candidate's requirement against a partial aggregate — a bug that would
     *      produce a plausible-looking minimum that was simply too low, and would surface as a
     *      settlement that satisfied the aggregate check while shortchanging a participant.
     */
    function finaliseResidual(bytes32 epochId, uint16 maxCandidates) external {
        EpochCompute storage epoch = _requireStage(epochId, Stage.ResidualComputed);
        pauseController.requireNotHalted(ShrudPauseController.Activity.Clear);
        if (maxCandidates == 0) revert ZeroBatch();

        euint256 zero = euint256.wrap(epoch.zero);
        euint256 aggregate = euint256.wrap(epoch.residualAggregateInput);
        euint256 scale = euint256.wrap(epoch.scale);
        ebool isNetBuy =
            Nox.eq(euint16.wrap(epoch.residualDirection), Nox.toEuint16(ShrudOrderFamily.RESIDUAL_BUY_BASE));

        euint256 minimum = euint256.wrap(epoch.residualAggregateMinimum);

        uint16 end = _batchEnd(epoch, maxCandidates);
        Candidate[] storage slots = _candidates[epochId];

        for (uint16 i = epoch.cursor; i < end; ++i) {
            Candidate storage slot = slots[i];
            euint256 limit = euint256.wrap(intentBook.handlesOf(slot.intentId).limit);

            // See the contract header: `residualInput_i` cancels out of PRD section 10.7's formula,
            // leaving the requirement a function of the aggregate and this candidate's own limit.
            euint256 buyRequirement = _mulDivCeil(aggregate, scale, limit, zero);
            euint256 sellRequirement = _mulDivCeil(aggregate, limit, scale, zero);
            euint256 requirement = Nox.select(isNetBuy, buyRequirement, sellRequirement);

            // A non-contributor must not inflate the maximum.
            requirement = Nox.select(
                Nox.gt(euint256.wrap(slot.residualContribution), zero), requirement, zero
            );
            _persist(requirement);
            slot.requiredVenueTotal = euint256.unwrap(requirement);

            // The encrypted maximum, composed from `gt` and `select` — Nox has no `max`.
            minimum = Nox.select(Nox.gt(requirement, minimum), requirement, minimum);
        }

        _persist(minimum);
        epoch.residualAggregateMinimum = euint256.unwrap(minimum);

        uint16 next = end;
        epoch.cursor = next;
        emit StageProgress(epochId, Stage.ResidualComputed, next, epoch.count);

        if (next == epoch.count) {
            _computeFloors(epochId, epoch);
            epoch.cursor = 0;
            _setStage(epochId, epoch, Stage.Published);
        }
    }

    /**
     * @dev The two booleans, and the only two `ebool`s shrud ever publishes.
     *
     *      `_isolateBool` costs seven NoxCompute calls each and is worth every one: it is what makes
     *      a decryption proof issued for THIS epoch's floor unable to bind to another epoch's. Both
     *      values are public either way, so nothing leaks from a collision — but a binding that is
     *      weaker than it claims is a defect regardless of whether it is exploitable today.
     */
    function _computeFloors(bytes32 epochId, EpochCompute storage epoch) private {
        ebool condition = ebool.wrap(epoch.epochCondition);

        ebool epochFloor = Nox.ge(euint256.wrap(epoch.effectiveCount), Nox.toEuint256(EPOCH_FLOOR_K));
        ebool residualFloor =
            Nox.ge(euint256.wrap(epoch.residualContributorCount), Nox.toEuint256(RESIDUAL_FLOOR_K));

        ebool supplyFloor =
            Nox.ge(euint256.wrap(epoch.supplyContributorCount), Nox.toEuint256(RESIDUAL_FLOOR_K));

        epochFloor = _isolateBool(epochFloor, condition, isolationDomain(epochId, ROLE_EPOCH_FLOOR, 0));
        residualFloor =
            _isolateBool(residualFloor, condition, isolationDomain(epochId, ROLE_RESIDUAL_FLOOR, 0));
        supplyFloor =
            _isolateBool(supplyFloor, condition, isolationDomain(epochId, ROLE_SUPPLY_FLOOR, 0));

        Nox.allowThis(epochFloor);
        Nox.allowThis(residualFloor);
        Nox.allowThis(supplyFloor);
        epoch.meetsEpochFloor = ebool.unwrap(epochFloor);
        epoch.meetsResidualFloor = ebool.unwrap(residualFloor);
        epoch.meetsSupplyFloor = ebool.unwrap(supplyFloor);
    }

    // -------------------------------------------------------------------------------------------
    // F · Publish — the only five handles that ever become publicly decryptable
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Marks exactly five handles publicly decryptable and commits them to the intent book.
     *
     * @dev `allowPublicDecryption` IS IRREVERSIBLE. There is no counterpart in `sdk/Nox.sol` — no
     *      un-publish, no expiry, nothing. So this function is the single narrowest point in the
     *      whole system, and it publishes five values and no others:
     *
     *        meetsEpochFloor            was the epoch a real multi-party set
     *        meetsResidualFloor         does the public route have enough contributors
     *        residualDirection          which way the net imbalance points
     *        residualAggregateInput     how much goes to the venue
     *        residualAggregateMinimum   what must come back
     *
     *      Gross buy demand, gross sell supply, the crossed volume, the exact effective count, the
     *      exact contributor count and every per-treasury value are NOT here, and adding one later
     *      would be irreversible for every epoch it touched.
     *
     *      Committing the same five to `ShrudIntentBook` in the same transaction is what makes a
     *      decryption proof mean something. A proof is a pure signature check with no epoch binding
     *      (delta D-7); the settlement engine matches the proof's handle against this commitment
     *      before it will act on the value.
     */
    function publishResidual(bytes32 epochId) external {
        EpochCompute storage epoch = _requireStage(epochId, Stage.Published);
        pauseController.requireNotHalted(ShrudPauseController.Activity.Clear);

        Nox.allowPublicDecryption(ebool.wrap(epoch.meetsEpochFloor));
        Nox.allowPublicDecryption(ebool.wrap(epoch.meetsResidualFloor));
        Nox.allowPublicDecryption(euint16.wrap(epoch.residualDirection));
        Nox.allowPublicDecryption(euint256.wrap(epoch.residualAggregateInput));
        Nox.allowPublicDecryption(euint256.wrap(epoch.residualAggregateMinimum));
        Nox.allowPublicDecryption(ebool.wrap(epoch.meetsSupplyFloor));
        Nox.allowPublicDecryption(euint256.wrap(epoch.grossSupplyQuote));

        intentBook.commitPublishedHandles(
            epochId,
            ShrudIntentBook.EpochPublishedHandles({
                meetsEpochFloor: epoch.meetsEpochFloor,
                meetsResidualFloor: epoch.meetsResidualFloor,
                residualDirection: epoch.residualDirection,
                residualAggregateInput: epoch.residualAggregateInput,
                residualAggregateMinimum: epoch.residualAggregateMinimum,
                meetsSupplyFloor: epoch.meetsSupplyFloor,
                supplyAggregateInput: epoch.grossSupplyQuote
            })
        );
        intentBook.setEpochStatus(epochId, ShrudIntentBook.EpochStatus.ResidualReady);

        emit ResidualPublished(epochId);
    }

    // -------------------------------------------------------------------------------------------
    // Reads for the settlement engine and the verifier
    // -------------------------------------------------------------------------------------------

    function epochOf(bytes32 epochId) external view returns (EpochCompute memory) {
        return _epochs[epochId];
    }

    function candidateOf(bytes32 epochId, uint256 index) external view returns (Candidate memory) {
        return _candidates[epochId][index];
    }

    function candidateCount(bytes32 epochId) external view returns (uint256) {
        return _candidates[epochId].length;
    }

    /// @notice Grants the settlement engine what it needs to allocate the venue's output.
    function grantSettlementAccess(bytes32 epochId) external {
        if (msg.sender != settlementEngine) revert NotSettlementEngine(msg.sender);
        EpochCompute storage epoch = _epochs[epochId];
        if (epoch.stage != Stage.Published) revert WrongStage(epochId, Stage.Published, epoch.stage);

        Nox.allow(euint256.wrap(epoch.residualAggregateInput), settlementEngine);
        Nox.allow(euint256.wrap(epoch.grossSupplyQuote), settlementEngine);
        Candidate[] storage slots = _candidates[epochId];
        for (uint256 i = 0; i < slots.length; ++i) {
            Nox.allow(euint256.wrap(slots[i].residualContribution), settlementEngine);
            Nox.allow(euint256.wrap(slots[i].crossBaseOut), settlementEngine);
            Nox.allow(euint256.wrap(slots[i].crossQuoteOut), settlementEngine);
            Nox.allow(euint256.wrap(slots[i].supplyQuote), settlementEngine);
        }
    }

    // -------------------------------------------------------------------------------------------
    // Encrypted arithmetic helpers. One implementation each, used everywhere.
    // -------------------------------------------------------------------------------------------

    /// @dev `floor(a * b / d)`, with BOTH success flags threaded. Four NoxCompute calls.
    function _mulDiv(euint256 a, euint256 b, euint256 d, euint256 zero) private returns (euint256) {
        (ebool mulOk, euint256 product) = Nox.safeMul(a, b);
        (ebool divOk, euint256 quotient) = Nox.safeDiv(product, d);
        return Nox.select(mulOk, Nox.select(divOk, quotient, zero), zero);
    }

    /// @dev `ceil(a * b / d)`, computed as `floor((a*b + d - 1) / d)`. Seven NoxCompute calls.
    function _mulDivCeil(euint256 a, euint256 b, euint256 d, euint256 zero)
        private
        returns (euint256)
    {
        (ebool mulOk, euint256 product) = Nox.safeMul(a, b);
        (ebool subOk, euint256 dMinusOne) = Nox.safeSub(d, Nox.toEuint256(1));
        (ebool addOk, euint256 bumped) = Nox.safeAdd(product, dMinusOne);
        (ebool divOk, euint256 quotient) = Nox.safeDiv(bumped, d);
        euint256 gated = Nox.select(divOk, quotient, zero);
        gated = Nox.select(addOk, gated, zero);
        gated = Nox.select(subOk, gated, zero);
        return Nox.select(mulOk, gated, zero);
    }

    function _safeSub(euint256 a, euint256 b, euint256 zero) private returns (euint256) {
        (ebool ok, euint256 result) = Nox.safeSub(a, b);
        return Nox.select(ok, result, zero);
    }

    // -------------------------------------------------------------------------------------------
    // Stage plumbing
    // -------------------------------------------------------------------------------------------

    function _initialiseConstants(bytes32 epochId, EpochCompute storage epoch) private {
        euint256 zero = Nox.toEuint256(0);
        euint256 one = Nox.toEuint256(1);
        euint256 scale = Nox.toEuint256(ShrudOrderFamily.PRICE_SCALE);
        euint256 priceHandle = Nox.toEuint256(epoch.price);

        Nox.allowThis(zero);
        Nox.allowThis(one);
        Nox.allowThis(scale);
        Nox.allowThis(priceHandle);

        epoch.zero = euint256.unwrap(zero);
        epoch.one = euint256.unwrap(one);
        epoch.scale = euint256.unwrap(scale);
        epoch.priceHandle = euint256.unwrap(priceHandle);

        // The epoch condition needs a CONFIDENTIAL anchor, and the first candidate's escrow is the
        // first confidential handle this epoch owns. `_buildEpochCondition` asserts confidentiality
        // rather than assuming it, so an epoch whose first candidate somehow held a public handle
        // fails here — publicly, before anything private has moved.
        euint256 anchor = clearingVault.escrowOf(_candidates[epochId][0].intentId);
        ebool condition = _buildEpochCondition(epochId, anchor);
        Nox.allowThis(condition);
        epoch.epochCondition = ebool.unwrap(condition);
    }

    function _requireStage(bytes32 epochId, Stage expected) private view returns (EpochCompute storage) {
        EpochCompute storage epoch = _epochs[epochId];
        if (epoch.stage == Stage.None) revert EpochUnknown(epochId);
        if (epoch.stage != expected) revert WrongStage(epochId, expected, epoch.stage);
        return epoch;
    }

    function _batchEnd(EpochCompute storage epoch, uint16 maxCandidates) private view returns (uint16) {
        uint256 end = uint256(epoch.cursor) + uint256(maxCandidates);
        return end > epoch.count ? epoch.count : uint16(end);
    }

    /// @dev Advances the cursor; moves to the next stage only when every candidate is done.
    function _advance(bytes32 epochId, EpochCompute storage epoch, uint16 end, Stage next) private {
        epoch.cursor = end;
        emit StageProgress(epochId, epoch.stage, end, epoch.count);
        if (end == epoch.count) {
            epoch.cursor = 0;
            _setStage(epochId, epoch, next);
        }
    }

    function _setStage(bytes32 epochId, EpochCompute storage epoch, Stage next) private {
        Stage previous = epoch.stage;
        epoch.stage = next;
        emit StageAdvanced(epochId, previous, next);
    }

    function _persist(euint256 handle) private {
        Nox.allowThis(handle);
    }

    function _loadOrZero(bytes32 stored, euint256 zero) private pure returns (euint256) {
        return stored == bytes32(0) ? zero : euint256.wrap(stored);
    }
}
