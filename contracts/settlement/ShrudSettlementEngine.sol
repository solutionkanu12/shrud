// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {IERC20ToERC7984Wrapper} from
    "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC20ToERC7984Wrapper.sol";
import {Nox, ebool, euint16, euint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ShrudAdapterRegistry} from "../adapters/ShrudAdapterRegistry.sol";
import {ShrudHandleIsolation} from "../base/ShrudHandleIsolation.sol";
import {ShrudClearingEngine} from "../clearing/ShrudClearingEngine.sol";
import {ShrudClearingVault} from "../clearing/ShrudClearingVault.sol";
import {ShrudReferencePriceRegistry} from "../clearing/ShrudReferencePriceRegistry.sol";
import {IShrudSettlementAdapter} from "../interfaces/IShrudSettlementAdapter.sol";
import {ShrudIntentBook} from "../intents/ShrudIntentBook.sol";
import {ISafe} from "../interfaces/ISafe.sol";
import {ShrudOrderFamily} from "../libraries/ShrudOrderFamily.sol";
import {ShrudPauseController} from "../recovery/ShrudPauseController.sol";
import {ShrudPositionLedger} from "./ShrudPositionLedger.sol";

/**
 * @title ShrudSettlementEngine
 * @notice The public boundary. Verifies the five proofs, calls one unchanged protocol, measures what
 *         came back, and hands the result to confidential reconciliation.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * A VALID DECRYPTION PROOF PROVES ALMOST NOTHING ON ITS OWN
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `INoxCompute.validateDecryptionProof` is a pure EIP-712 signature check. No ACL. No nonce. No
 * expiry. No caller binding. Read from `modules/Compute.sol` in nox-protocol-contracts 0.2.4 and
 * recorded as delta D-7.
 *
 * So a valid proof attests that the gateway decrypted SOME handle to SOME value, at some point,
 * forever, replayable by anyone. It says nothing about which epoch that handle belonged to.
 *
 * The binding is `ShrudIntentBook.publishedHandlesOf(epochId)`, committed by the clearing engine in
 * the same transaction that marked those five handles publicly decryptable. `_verifyPublished`
 * checks the proof AND that the handle is the exact one this sealed epoch committed to for that
 * role. Without that second half, an attacker could settle epoch A against epoch B's aggregate.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE OUTPUT IS MEASURED, NEVER REPORTED
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `IShrudSettlementAdapter.settle` returns what the adapter believes it produced. This engine
 * ignores it and takes the recipient's balance delta across the call.
 *
 * A returned number is a claim by the adapter. A balance delta is a fact about the chain. They
 * differ when a token takes a fee on transfer, when a venue partially fills, when an adapter has a
 * defect in its own accounting, and when a rebasing token accrues mid-transaction. Allocating
 * against the claim rather than the fact is how a vault ends up owing more than it holds.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * SETTLEMENT IS PERMISSIONLESS, AND THE KEEPER HAS NO TRUTH ROLE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PRD sections 9.9 and 13.3. Anyone holding the gateway's proofs can settle. The keeper exists so a
 * demo does not wait on a human, and it improves reliability — it does not hold custody, choose a
 * route, alter a price or change a sealed amount. Every one of those is fixed by the sealed epoch
 * and re-checked here, so a hostile keeper's only power is to not act, and then anyone else does.
 */
contract ShrudSettlementEngine is ShrudHandleIsolation {
    using SafeERC20 for IERC20;

    enum SettlementStatus {
        None,
        /// Proofs verified, floors passed, nothing executed yet.
        Verified,
        /// The venue call is in flight. Set before any external call.
        Settling,
        /// The venue returned and the output was measured.
        Executed,
        /// Every candidate's final allocation has been computed and delivered.
        Reconciled,
        /// The residual was encrypted zero and no venue was called.
        NoPublicResidual,
        /// The venue call failed. Confidential refunds are the path out.
        Recoverable
    }

    struct SupplyRecord {
        SettlementStatus status;
        uint16 cursor;
        address adapter;
        bytes32 positionId;
        uint256 aggregateInput;
        /// Measured aToken delta at the position ledger. Never Aave's word for it — `supply`
        /// returns nothing at all and aTokens rebase, so a delta is the only number available.
        uint256 measuredOutput;
        uint256 sharesPerAsset;
        uint64 settledAtBlock;
    }

    struct SettlementRecord {
        SettlementStatus status;
        uint8 direction;
        uint16 cursor;
        address adapter;
        uint64 verifiedAtBlock;
        uint256 aggregateInput;
        uint256 aggregateMinimum;
        /// Measured, not reported.
        uint256 actualOutput;
        uint64 settledAtBlock;
    }

    /**
     * @notice Roughly two hours at 12-second blocks.
     *
     * @dev Long enough that ordinary gateway latency or a congested block never trips it — the Nox
     *      runner is asynchronous and testnet latency is not a number this project has enough
     *      samples to bound. Short enough that a treasury whose keeper has stopped answering is not
     *      waiting a day to reach its own escrow.
     */
    uint64 public constant SETTLEMENT_TIMEOUT_BLOCKS = 600;

    ShrudIntentBook public immutable intentBook;
    ShrudClearingEngine public immutable clearingEngine;
    ShrudClearingVault public immutable clearingVault;
    ShrudAdapterRegistry public immutable adapterRegistry;
    ShrudReferencePriceRegistry public immutable priceRegistry;
    ShrudPositionLedger public immutable positionLedger;

    mapping(bytes32 epochId => SettlementRecord) private _settlements;

    /**
     * @notice The pooled-position route, which is INDEPENDENT of the swap route.
     *
     * An epoch can produce both, one, or neither. They are tracked separately because they settle
     * through different venues, satisfy different floors, and fail independently: an Aave outage
     * must not strand a Uniswap residual, and a swap route that misses its floor must not block a
     * supply that met its own.
     */
    mapping(bytes32 epochId => SupplyRecord) private _supplies;

    /// @dev One epoch settles once. The most basic invariant, and the one every replay tries first.
    mapping(bytes32 epochId => bool) private _consumed;

    event ResidualVerified(
        bytes32 indexed epochId, uint8 direction, uint256 aggregateInput, uint256 aggregateMinimum
    );
    event ResidualSettled(bytes32 indexed epochId, address adapter, uint256 amountIn, uint256 measuredOut);
    event NoPublicResidualDeclared(bytes32 indexed epochId);
    event SettlementFailed(bytes32 indexed epochId, address adapter);
    event AllocationReconciled(bytes32 indexed epochId, uint16 cursor, uint16 count);

    error EpochAlreadyConsumed(bytes32 epochId);
    error WrongSettlementStatus(bytes32 epochId, SettlementStatus expected, SettlementStatus actual);
    error PublishedHandleMismatch(bytes32 epochId, string field);
    error EpochFloorNotMet(bytes32 epochId);
    error ResidualFloorNotMet(bytes32 epochId);
    error ResidualIsZero(bytes32 epochId);
    error ResidualIsNotZero(bytes32 epochId, uint256 aggregateInput);
    error UnknownResidualDirection(uint8 direction);
    error AdapterRouteMismatch(address adapter, bytes32 expected, bytes32 actual);
    error DeadlineOutsideWindow(uint256 deadline, uint32 window);
    error OutputBelowAggregateMinimum(uint256 measured, uint256 required);
    error VenueCallFailed(bytes32 epochId);
    error CursorNotFinished(bytes32 epochId, uint16 cursor, uint16 count);
    error SettlementNotTimedOut(bytes32 epochId, uint64 timeoutBlock);

    constructor(
        ShrudIntentBook intentBook_,
        ShrudClearingEngine clearingEngine_,
        ShrudClearingVault clearingVault_,
        ShrudAdapterRegistry adapterRegistry_,
        ShrudReferencePriceRegistry priceRegistry_,
        ShrudPositionLedger positionLedger_,
        ShrudPauseController pauseController_
    ) ShrudHandleIsolation(pauseController_) {
        intentBook = intentBook_;
        clearingEngine = clearingEngine_;
        clearingVault = clearingVault_;
        adapterRegistry = adapterRegistry_;
        priceRegistry = priceRegistry_;
        positionLedger = positionLedger_;
    }

    function isReviewedTransientRecipient(address recipient) public view override returns (bool) {
        return recipient == address(clearingVault) || recipient == address(clearingEngine);
    }

    // -------------------------------------------------------------------------------------------
    // 1 · Verify the five proofs against the sealed epoch's commitment
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Verifies every published value and both floors before anything is executed.
     *
     * @dev THE FLOORS ARE CHECKED HERE AND NOT AT DISPLAY TIME. PRD invariant 21.6.5 forbids
     *      presenting a failed privacy floor as multi-party clearing; this contract goes further and
     *      refuses to SETTLE one. An epoch with two effective treasuries, or a residual route with a
     *      single contributor, does not reach a public venue at all — because a residual with one
     *      contributor is that contributor's order, in plaintext, with a privacy story attached.
     *
     *      Refusing is the honest failure. The epoch becomes recoverable and every participant gets
     *      their confidential escrow back, which is a worse outcome for throughput and the only
     *      acceptable one for the claim on the tin.
     */
    function verifyResidual(
        bytes32 epochId,
        bytes calldata epochFloorProof,
        bytes calldata residualFloorProof,
        bytes calldata directionProof,
        bytes calldata aggregateInputProof,
        bytes calldata aggregateMinimumProof
    ) external {
        pauseController.requireNotHalted(ShrudPauseController.Activity.Settle);
        if (_consumed[epochId]) revert EpochAlreadyConsumed(epochId);

        SettlementRecord storage record = _settlements[epochId];
        if (record.status != SettlementStatus.None) {
            revert WrongSettlementStatus(epochId, SettlementStatus.None, record.status);
        }

        ShrudIntentBook.EpochPublishedHandles memory published = intentBook.publishedHandlesOf(epochId);
        if (published.residualAggregateInput == bytes32(0)) {
            revert PublishedHandleMismatch(epochId, "notCommitted");
        }

        // Each proof is checked against the handle THIS epoch committed to. Delta D-7.
        bool epochFloor = Nox.publicDecrypt(ebool.wrap(published.meetsEpochFloor), epochFloorProof);
        bool residualFloor =
            Nox.publicDecrypt(ebool.wrap(published.meetsResidualFloor), residualFloorProof);
        uint16 direction = Nox.publicDecrypt(euint16.wrap(published.residualDirection), directionProof);
        uint256 aggregateInput =
            Nox.publicDecrypt(euint256.wrap(published.residualAggregateInput), aggregateInputProof);
        uint256 aggregateMinimum =
            Nox.publicDecrypt(euint256.wrap(published.residualAggregateMinimum), aggregateMinimumProof);

        if (!epochFloor) revert EpochFloorNotMet(epochId);

        record.status = SettlementStatus.Verified;
        record.verifiedAtBlock = uint64(block.number);
        record.direction = uint8(direction);
        record.aggregateInput = aggregateInput;
        record.aggregateMinimum = aggregateMinimum;

        // A zero residual is a complete, correct outcome — PRD section 10.10. Both sides crossed
        // fully and no venue is needed. The residual floor is irrelevant when nothing is exposed.
        if (aggregateInput == 0 || direction == ShrudOrderFamily.RESIDUAL_NONE) {
            record.status = SettlementStatus.NoPublicResidual;
            _consumed[epochId] = true;
            intentBook.setEpochStatus(epochId, ShrudIntentBook.EpochStatus.NoPublicResidual);
            emit NoPublicResidualDeclared(epochId);
            return;
        }

        if (!residualFloor) revert ResidualFloorNotMet(epochId);

        emit ResidualVerified(epochId, uint8(direction), aggregateInput, aggregateMinimum);
    }

    // -------------------------------------------------------------------------------------------
    // 2 · Execute one public venue call
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Unwraps exactly the sealed aggregate, calls one registered adapter, measures the delta.
     *
     * @dev REENTRANCY IS HANDLED BY THE STATE MACHINE, NOT BY A GUARD MODIFIER. `Settling` is
     *      written BEFORE any external call and `Executed` after, and every entry point checks the
     *      status it requires. A reentrant call arrives in `Settling` and finds no function that
     *      accepts it. That is PRD section 20.6, and it is stronger than a boolean lock because it
     *      also excludes the re-entry that arrives in a LATER transaction.
     *
     *      The epoch is marked consumed before the venue call for the same reason.
     */
    function settleResidual(
        bytes32 epochId,
        address adapter,
        bytes32 unwrapRequestHandle,
        bytes calldata unwrapProof,
        uint256 deadline
    ) external {
        pauseController.requireNotHalted(ShrudPauseController.Activity.Settle);

        SettlementRecord storage record = _settlements[epochId];
        if (record.status != SettlementStatus.Verified) {
            revert WrongSettlementStatus(epochId, SettlementStatus.Verified, record.status);
        }
        if (_consumed[epochId]) revert EpochAlreadyConsumed(epochId);

        ShrudAdapterRegistry.AdapterManifest memory manifest =
            adapterRegistry.requireEnabledAdapter(adapter);

        ShrudIntentBook.EpochRecord memory epoch = intentBook.epochOf(epochId);
        // Staleness is checked at USE. A snapshot captured correctly ten minutes ago is a stale
        // price with a valid provenance record.
        priceRegistry.requireFresh(epoch.priceSnapshotId);

        if (deadline > block.timestamp + manifest.maxDeadlineWindow) {
            revert DeadlineOutsideWindow(deadline, manifest.maxDeadlineWindow);
        }

        // Effects before interactions, and before the epoch can be re-entered.
        _consumed[epochId] = true;
        record.status = SettlementStatus.Settling;
        record.adapter = adapter;
        intentBook.setEpochStatus(epochId, ShrudIntentBook.EpochStatus.Settling);

        // The wrapper whose confidential balance backs this epoch's residual input, chosen by the
        // published direction rather than by the caller — and then required to agree with the
        // adapter about which ERC-20 it wraps. Without that second check, a correctly proved
        // residual in one asset could be settled through an adapter denominated in another.
        address wrapper = _residualWrapper(epochId, record.direction);
        if (IERC20ToERC7984Wrapper(wrapper).underlying() != manifest.inputToken) {
            revert PublishedHandleMismatch(epochId, "residualAsset");
        }

        // The wrapper's own two-step unwrap. `finalizeUnwrap` pays the underlying out against the
        // gateway's proof for the burn handle — so the plaintext that reaches this contract is the
        // one the wrapper burned, not a number this contract chose.
        IERC20ToERC7984Wrapper(wrapper).finalizeUnwrap(euint256.wrap(unwrapRequestHandle), unwrapProof);

        IERC20 input = IERC20(manifest.inputToken);
        uint256 held = input.balanceOf(address(this));
        if (held < record.aggregateInput) revert ResidualIsZero(epochId);

        input.safeTransfer(adapter, record.aggregateInput);

        uint256 before = IERC20(manifest.outputToken).balanceOf(manifest.fixedRecipient);

        // NO try/catch, AND THAT IS DELIBERATE. Catching here to write `Recoverable` would not
        // work: a `revert` after the catch rolls the write back, and NOT reverting would leave the
        // unwrapped plaintext residual sitting on this contract with the epoch consumed. A venue
        // failure therefore reverts the whole transaction — nothing is consumed, nothing moves, and
        // the keeper or anyone else can retry.
        //
        // Recovery is a separate, time-bounded path (`declareTimedOut`) rather than an exception
        // handler, which is also what PRD section 9.15 describes: recover a TIMED-OUT residual after
        // proving no public venue call succeeded.
        //
        // The adapter's own return value is discarded. See the contract header — the output is
        // measured from the recipient's balance delta, never taken on report.
        IShrudSettlementAdapter(adapter).settle(
            IShrudSettlementAdapter.SettleParams({
                epochId: epochId,
                inputToken: manifest.inputToken,
                outputToken: manifest.outputToken,
                amountIn: record.aggregateInput,
                minAmountOut: record.aggregateMinimum,
                recipient: manifest.fixedRecipient,
                deadline: deadline
            })
        );

        uint256 measured = IERC20(manifest.outputToken).balanceOf(manifest.fixedRecipient) - before;
        if (measured < record.aggregateMinimum) {
            revert OutputBelowAggregateMinimum(measured, record.aggregateMinimum);
        }

        record.actualOutput = measured;
        record.status = SettlementStatus.Executed;
        record.settledAtBlock = uint64(block.number);
        intentBook.setEpochStatus(epochId, ShrudIntentBook.EpochStatus.Settled);

        emit ResidualSettled(epochId, adapter, record.aggregateInput, measured);
    }

    // -------------------------------------------------------------------------------------------
    // 3 · Reconcile — internal plus external, into each Safe's confidential balance
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Allocates the measured venue output among residual contributors, pro rata. Resumable.
     *
     * @dev `external_i = floor(Y * residualInput_i / residualAggregateInput)` — PRD section 10.8.
     *      `Y` and the aggregate are PLAINTEXT here, because both are already public; only
     *      `residualInput_i` is encrypted, which is precisely the value that must never be.
     *
     *      FLOOR, ALWAYS. The sum of floors is at most `Y`, so the vault can never owe more output
     *      than the venue actually delivered. The remainder is output dust: it stays in a declared
     *      confidential balance, and PRD section 10.9 forbids sending it to a keeper or a team
     *      address. A rounding rule that could over-allocate would be a solvency bug that only
     *      appears under specific participant counts.
     */
    function reconcile(bytes32 epochId, uint16 maxCandidates) external {
        pauseController.requireNotHalted(ShrudPauseController.Activity.Settle);

        SettlementRecord storage record = _settlements[epochId];
        if (record.status != SettlementStatus.Executed && record.status != SettlementStatus.NoPublicResidual)
        {
            revert WrongSettlementStatus(epochId, SettlementStatus.Executed, record.status);
        }

        if (record.cursor == 0) clearingEngine.grantSettlementAccess(epochId);

        uint256 count = clearingEngine.candidateCount(epochId);
        uint256 end = uint256(record.cursor) + uint256(maxCandidates);
        if (end > count) end = count;

        euint256 zero = Nox.toEuint256(0);
        euint256 outputHandle = Nox.toEuint256(record.actualOutput);
        euint256 aggregateHandle = Nox.toEuint256(record.aggregateInput == 0 ? 1 : record.aggregateInput);

        for (uint256 i = record.cursor; i < end; ++i) {
            ShrudClearingEngine.Candidate memory candidate = clearingEngine.candidateOf(epochId, i);

            euint256 contribution = euint256.wrap(candidate.residualContribution);
            euint256 external_ = _mulDiv(outputHandle, contribution, aggregateHandle, zero);

            // Internal plus external. A candidate that crossed fully has zero external; one that
            // only reached the residual has zero internal; most have both.
            euint256 finalBase = Nox.add(euint256.wrap(candidate.crossBaseOut), external_);
            euint256 finalQuote = euint256.wrap(candidate.crossQuoteOut);

            Nox.allowThis(external_);
            Nox.allowThis(finalBase);
            Nox.allowThis(finalQuote);

            ShrudIntentBook.IntentHandles memory handles = intentBook.handlesOf(candidate.intentId);
            handles.externalAllocation = euint256.unwrap(external_);
            handles.finalAllocation = euint256.unwrap(finalBase);
            intentBook.recordClearingHandles(candidate.intentId, handles);
            intentBook.recordProcessed(candidate.intentId, epochId);
        }

        record.cursor = uint16(end);
        emit AllocationReconciled(epochId, uint16(end), uint16(count));

        if (end == count) {
            record.status = SettlementStatus.Reconciled;
            intentBook.setEpochStatus(epochId, ShrudIntentBook.EpochStatus.Settled);
        }
    }

    // -------------------------------------------------------------------------------------------
    // 4 · The pooled-position route — independent of the swap route above
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Verifies the aggregate supply and its own floor.
     *
     * @dev A SEPARATE FLOOR, AND THAT IS THE POINT. An epoch's swap route and its supply route are
     *      two independent public disclosures. Sharing one floor would let a two-contributor swap
     *      authorise a one-contributor supply — which is that contributor's amount in plaintext,
     *      with a privacy story attached. Each route stands on its own contributor count.
     *
     *      The epoch floor still gates both: an epoch that was never a real multi-party set does not
     *      get to publish anything.
     */
    function verifyAggregateSupply(
        bytes32 epochId,
        bytes calldata epochFloorProof,
        bytes calldata supplyFloorProof,
        bytes calldata aggregateProof
    ) external {
        pauseController.requireNotHalted(ShrudPauseController.Activity.Settle);

        SupplyRecord storage record = _supplies[epochId];
        if (record.status != SettlementStatus.None) {
            revert WrongSettlementStatus(epochId, SettlementStatus.None, record.status);
        }

        ShrudIntentBook.EpochPublishedHandles memory published = intentBook.publishedHandlesOf(epochId);
        if (published.supplyAggregateInput == bytes32(0)) {
            revert PublishedHandleMismatch(epochId, "notCommitted");
        }

        bool epochFloor = Nox.publicDecrypt(ebool.wrap(published.meetsEpochFloor), epochFloorProof);
        bool supplyFloor = Nox.publicDecrypt(ebool.wrap(published.meetsSupplyFloor), supplyFloorProof);
        uint256 aggregate =
            Nox.publicDecrypt(euint256.wrap(published.supplyAggregateInput), aggregateProof);

        if (!epochFloor) revert EpochFloorNotMet(epochId);

        // No supply this epoch is a complete, correct outcome. Most epochs will look like this.
        if (aggregate == 0) {
            record.status = SettlementStatus.NoPublicResidual;
            emit NoPublicResidualDeclared(epochId);
            return;
        }

        if (!supplyFloor) revert ResidualFloorNotMet(epochId);

        record.status = SettlementStatus.Verified;
        record.aggregateInput = aggregate;
        emit ResidualVerified(epochId, ShrudOrderFamily.RESIDUAL_SUPPLY_QUOTE, aggregate, 0);
    }

    /**
     * @notice Unwraps the aggregate and supplies it to Aave, on behalf of the position ledger.
     *
     * @dev THE OUTPUT IS MEASURED AT THE LEDGER, NOT REPORTED BY AAVE. `Pool.supply` returns nothing
     *      at all, and aTokens rebase — so an aToken balance delta at the recipient is the only
     *      number available, and it happens to be the right one anyway.
     *
     *      `sharesPerAsset` is recorded from the ledger BEFORE the principal moves, because the ratio
     *      a supplier buys in at is the one that held when they supplied. Reading it afterwards would
     *      price this epoch's entrants at the position they just enlarged.
     */
    function settleAggregateSupply(
        bytes32 epochId,
        address adapter,
        bytes32 positionId,
        bytes32 unwrapRequestHandle,
        bytes calldata unwrapProof,
        uint256 deadline
    ) external {
        pauseController.requireNotHalted(ShrudPauseController.Activity.Settle);

        SupplyRecord storage record = _supplies[epochId];
        if (record.status != SettlementStatus.Verified) {
            revert WrongSettlementStatus(epochId, SettlementStatus.Verified, record.status);
        }

        ShrudAdapterRegistry.AdapterManifest memory manifest =
            adapterRegistry.requireEnabledAdapter(adapter);

        if (deadline > block.timestamp + manifest.maxDeadlineWindow) {
            revert DeadlineOutsideWindow(deadline, manifest.maxDeadlineWindow);
        }

        // The supply always spends the epoch's QUOTE asset, chosen by the epoch record rather than
        // by the caller, and then required to agree with the adapter about what it wraps.
        ShrudIntentBook.EpochRecord memory epoch = intentBook.epochOf(epochId);
        address wrapper = epoch.quoteAsset;
        if (IERC20ToERC7984Wrapper(wrapper).underlying() != manifest.inputToken) {
            revert PublishedHandleMismatch(epochId, "supplyAsset");
        }

        // Effects before interactions.
        record.status = SettlementStatus.Settling;
        record.adapter = adapter;
        record.positionId = positionId;

        IERC20ToERC7984Wrapper(wrapper).finalizeUnwrap(euint256.wrap(unwrapRequestHandle), unwrapProof);

        IERC20 input = IERC20(manifest.inputToken);
        if (input.balanceOf(address(this)) < record.aggregateInput) revert ResidualIsZero(epochId);

        // The buy-in ratio, read BEFORE the principal moves. See the note above.
        record.sharesPerAsset = positionLedger.recordSupply(positionId, record.aggregateInput);

        input.safeTransfer(adapter, record.aggregateInput);

        uint256 before = IERC20(manifest.outputToken).balanceOf(manifest.fixedRecipient);

        IShrudSettlementAdapter(adapter).settle(
            IShrudSettlementAdapter.SettleParams({
                epochId: epochId,
                inputToken: manifest.inputToken,
                outputToken: manifest.outputToken,
                amountIn: record.aggregateInput,
                minAmountOut: 0,
                recipient: manifest.fixedRecipient,
                deadline: deadline
            })
        );

        record.measuredOutput =
            IERC20(manifest.outputToken).balanceOf(manifest.fixedRecipient) - before;
        record.status = SettlementStatus.Executed;
        record.settledAtBlock = uint64(block.number);

        emit ResidualSettled(epochId, adapter, record.aggregateInput, record.measuredOutput);
    }

    /**
     * @notice Mints each supplier's encrypted share of the pooled position. Resumable.
     *
     * @dev `shares_i = supplyQuote_i * sharesPerAsset` — one operand confidential, one public. That
     *      split is the whole design: the RATIO is public and derivable by anyone from the position's
     *      two public numbers, so an auditor can reconcile the pool from chain state alone; the
     *      CONTRIBUTION stays encrypted, so nobody learns whose it is.
     *
     *      A candidate that supplied nothing mints encrypted zero. There is no branch skipping it,
     *      because a skipped candidate is a public statement that it did not supply.
     */
    function reconcileSupply(bytes32 epochId, uint16 maxCandidates) external {
        pauseController.requireNotHalted(ShrudPauseController.Activity.Settle);

        SupplyRecord storage record = _supplies[epochId];
        if (record.status != SettlementStatus.Executed) {
            revert WrongSettlementStatus(epochId, SettlementStatus.Executed, record.status);
        }

        uint256 count = clearingEngine.candidateCount(epochId);
        uint256 end = uint256(record.cursor) + uint256(maxCandidates);
        if (end > count) end = count;

        euint256 ratio = Nox.toEuint256(record.sharesPerAsset);

        for (uint256 i = record.cursor; i < end; ++i) {
            ShrudClearingEngine.Candidate memory candidate = clearingEngine.candidateOf(epochId, i);
            ShrudIntentBook.IntentHeader memory header = intentBook.headerOf(candidate.intentId);

            euint256 shares = Nox.mul(euint256.wrap(candidate.supplyQuote), ratio);
            Nox.allowThis(shares);
            Nox.allow(shares, address(positionLedger));

            positionLedger.mintShares(
                record.positionId, epochId, header.safe, shares, ISafe(header.safe).getOwners()
            );
        }

        record.cursor = uint16(end);
        emit AllocationReconciled(epochId, uint16(end), uint16(count));

        if (end == count) record.status = SettlementStatus.Reconciled;
    }

    function supplyOf(bytes32 epochId) external view returns (SupplyRecord memory) {
        return _supplies[epochId];
    }

    // -------------------------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------------------------

    function settlementOf(bytes32 epochId) external view returns (SettlementRecord memory) {
        return _settlements[epochId];
    }

    function isConsumed(bytes32 epochId) external view returns (bool) {
        return _consumed[epochId];
    }

    // -------------------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------------------

    /// @dev `floor(a * b / d)` with both success flags threaded. Identical to the clearing engine's.
    function _mulDiv(euint256 a, euint256 b, euint256 d, euint256 zero) private returns (euint256) {
        (ebool mulOk, euint256 product) = Nox.safeMul(a, b);
        (ebool divOk, euint256 quotient) = Nox.safeDiv(product, d);
        return Nox.select(mulOk, Nox.select(divOk, quotient, zero), zero);
    }

    /**
     * @dev The wrapper the residual spends from, derived from the PUBLISHED direction.
     *
     * Not a parameter, because the direction is one of the five values the epoch committed to and
     * a caller who could choose the asset could settle a quote-denominated residual out of the base
     * escrow. A net buy spends quote; a net sell spends base; an aggregate supply spends quote.
     */
    function _residualWrapper(bytes32 epochId, uint8 direction) private view returns (address) {
        ShrudIntentBook.EpochRecord memory epoch = intentBook.epochOf(epochId);
        if (
            direction == ShrudOrderFamily.RESIDUAL_BUY_BASE
                || direction == ShrudOrderFamily.RESIDUAL_SUPPLY_QUOTE
        ) return epoch.quoteAsset;
        if (direction == ShrudOrderFamily.RESIDUAL_SELL_BASE) return epoch.baseAsset;
        revert UnknownResidualDirection(direction);
    }

    // -------------------------------------------------------------------------------------------
    // Recovery
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Moves a verified-but-unsettled epoch to `Recoverable` after the timeout.
     *
     * @dev Permissionless, and it must be: the participants whose capital is in escrow are exactly
     *      the people who cannot be made to wait for a keeper that has stopped answering.
     *
     *      `_consumed` is set here so the epoch cannot afterwards be settled by a keeper that comes
     *      back — a settlement executing against an epoch whose participants have already exited
     *      would be paying out twice.
     */
    function declareTimedOut(bytes32 epochId) external {
        SettlementRecord storage record = _settlements[epochId];
        if (record.status != SettlementStatus.Verified) {
            revert WrongSettlementStatus(epochId, SettlementStatus.Verified, record.status);
        }
        if (block.number <= record.verifiedAtBlock + SETTLEMENT_TIMEOUT_BLOCKS) {
            revert SettlementNotTimedOut(epochId, record.verifiedAtBlock + SETTLEMENT_TIMEOUT_BLOCKS);
        }
        _consumed[epochId] = true;
        record.status = SettlementStatus.Recoverable;
        intentBook.setEpochStatus(epochId, ShrudIntentBook.EpochStatus.Recoverable);
        emit SettlementFailed(epochId, record.adapter);
    }
}
