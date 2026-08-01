// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {ShrudOrderFamily} from "../libraries/ShrudOrderFamily.sol";

/**
 * @title ShrudIntentBook
 * @notice Immutable public order metadata, the handle graph, and ONE uniform public lifecycle.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE PUBLIC STATE MACHINE IS THE PRIVACY BOUNDARY. IT HAS FIVE MEMBERS AND MUST NEVER GAIN A SIXTH.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 *     Submitted -> Authorised -> Processed        (terminal)
 *     Submitted -> Expired  |  Cancelled          (terminal)
 *     Authorised -> Expired |  Cancelled          (terminal)
 *
 * `Processed` is where EVERY order that entered a sealed epoch ends up — the one that crossed
 * fully, the one that crossed partially and contributed to the residual, the one whose private
 * limit failed, the one that was underfunded, the one that was deferred by the privacy floor, and
 * the one that simply held. They are indistinguishable from outside.
 *
 * PRD section 9.5 lists the states that must never exist: `Rejected`, `InsufficientBalance`, `Buy`,
 * `Sell`, `Crossed`, `LimitFailed`, `Excluded`. Each of them is a free oracle. `InsufficientBalance`
 * turns repeated oversized orders into a binary search over a treasury's confidential balance.
 * `Buy`/`Sell` publishes exactly what the product exists to hide. `Excluded` identifies who did not
 * make the cut, which with a small candidate set identifies who did.
 *
 * The real result lives in `PrivateOutcome` — an encrypted `euint16` handle, decryptable only by the
 * owning Safe's current owners. `test/privacy/` asserts that an underfunded order and a fully
 * successful one produce byte-identical public traces: same status, same events, same event
 * ordering.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY HANDLES ARE STORED AS `bytes32` AND NOT AS `euint256`
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This contract stores the handle graph but never computes on it. Keeping the storage type as raw
 * `bytes32` keeps `ShrudIntentBook` out of the Nox compilation surface entirely, which is what lets
 * the Foundry suite fuzz its state machine and its replay guards at thousands of runs — a thing the
 * Hardhat/Docker Nox stack cannot do. The engine wraps them back into `euint256` at the point of
 * use, where the type is meaningful.
 */
contract ShrudIntentBook {
    // -------------------------------------------------------------------------------------------
    // Public lifecycle
    // -------------------------------------------------------------------------------------------

    enum IntentStatus {
        None,
        Submitted,
        Authorised,
        Processed,
        Expired,
        Cancelled
    }

    enum EpochStatus {
        None,
        Open,
        Sealed,
        PriceFixed,
        Computing,
        ResidualReady,
        NoPublicResidual,
        Settling,
        Settled,
        TimedOut,
        Recoverable
    }

    /// @notice Everything about an order that is public from the moment it is submitted.
    struct IntentHeader {
        /// The Safe-bound module that accepted it. The Safe is implied by the module.
        address module;
        /// The governing Safe.
        address safe;
        /// The confidential asset the order spends.
        address inputAsset;
        /// The reviewed order family. Broad by design: it says "USDC/WETH", never which side.
        bytes32 orderFamily;
        /// The clearing epoch this order is a candidate for.
        bytes32 epochId;
        /// Public expiry. A public fact with no private content.
        uint64 expiry;
        /// Per-owner submission nonce, consumed at the module.
        uint64 nonce;
        /// keccak of the canonical plaintext order. What Shrud Lens recomputes before signing.
        bytes32 commitment;
        uint64 createdAtBlock;
        IntentStatus status;
    }

    /**
     * @notice The handle graph for one order. Every field is a Nox handle; none is a plaintext.
     *
     * @dev `amount`, `actionId` and `limit` arrive from the owner. Everything below `lockedAmount`
     *      is produced by the clearing engine and written back here, so a verifier can walk the
     *      whole lineage of one order from submission to final allocation without decrypting
     *      anything.
     */
    struct IntentHandles {
        bytes32 amount;
        bytes32 actionId;
        bytes32 limit;
        bytes32 lockedAmount;
        bytes32 lockSuccess;
        bytes32 priceEligible;
        bytes32 privateInclusion;
        bytes32 internalCrossInput;
        bytes32 internalCrossOutput;
        bytes32 residualContribution;
        bytes32 externalAllocation;
        bytes32 finalAllocation;
        bytes32 confidentialRefund;
        bytes32 privateOutcome;
    }

    /// @notice The public record of one clearing epoch.
    struct EpochRecord {
        bytes32 orderFamily;
        address baseAsset;
        address quoteAsset;
        EpochStatus status;
        /// Public and equal to the number of candidates. Says nothing about how many were valid.
        uint16 candidateCount;
        uint64 sealedAtBlock;
        uint64 settledAtBlock;
        /// The sealed reference-price snapshot id from ShrudReferencePriceRegistry.
        bytes32 priceSnapshotId;
        /// Quote units per whole base unit, scaled by ShrudOrderFamily.PRICE_SCALE.
        uint256 referencePrice;
    }

    /**
     * @notice The five handles a sealed epoch commits to publishing, and nothing else.
     *
     * @dev DELTA D-7 LIVES HERE. `validateDecryptionProof` is a pure EIP-712 signature check — no
     *      ACL, no nonce, no expiry, no caller binding — so a valid proof attests that the gateway
     *      decrypted SOME handle to SOME value and nothing more. It becomes a statement about THIS
     *      epoch only once the handle is checked against the commitment recorded here at seal time.
     *      `ShrudSettlementEngine` reads these and refuses anything else, which is why "matches
     *      stored handles" in PRD section 9.9 is load-bearing rather than descriptive.
     */
    struct EpochPublishedHandles {
        // --- the swap route ---------------------------------------------------------------
        bytes32 meetsEpochFloor;
        bytes32 meetsResidualFloor;
        bytes32 residualDirection;
        bytes32 residualAggregateInput;
        bytes32 residualAggregateMinimum;
        // --- the pooled-position route ----------------------------------------------------
        // An epoch carries TWO independent public routes: the unmatched swap imbalance, and the
        // aggregate supply heading for the pooled Aave position. They are not alternatives — a
        // single epoch can produce both, one, or neither — so each carries its own floor. Sharing
        // one floor would let a two-contributor swap route authorise a one-contributor supply,
        // which is that contributor's amount in plaintext with a privacy story attached.
        bytes32 meetsSupplyFloor;
        bytes32 supplyAggregateInput;
    }

    // -------------------------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------------------------

    /**
     * @notice The address that performs the one-shot wiring. The deployer, and nothing after that.
     *
     * ════════════════════════════════════════════════════════════════════════════════════════
     * WHY THERE IS A WRITER SET AND NOT A SINGLE REGISTRAR
     * ════════════════════════════════════════════════════════════════════════════════════════
     *
     * The first version of this contract had one immutable `registrar`, which reads as the tighter
     * design and is unbuildable. FOUR different contracts write here, and they must:
     *
     *   ShrudSafeModule       recordSubmission, recordAuthorisation, recordLock, recordCancellation
     *   ShrudClearingEngine   openEpoch, sealEpoch, commitPublishedHandles, setEpochStatus
     *   ShrudSettlementEngine setEpochStatus, recordClearingHandles, recordProcessed
     *   (one module per Safe, deployed later by the factory, so not knowable at construction)
     *
     * Collapsing them behind one address would mean routing every write through a hub — which is a
     * contract with authority over the whole book and no purpose except to hold that authority.
     *
     * The set is instead CLOSED at wiring: three addresses fixed in one transaction, plus modules
     * that only `ShrudModuleFactory` may add. There is no function that removes a writer and none
     * that re-opens the wiring, so after deployment the set grows only by one module per Safe and
     * only through a factory whose own bindings are constructor immutables.
     */
    address public immutable deployer;

    /// @notice The factory permitted to authorise per-Safe modules. Set once, at wiring.
    address public moduleFactory;

    mapping(address writer => bool) private _writers;
    bool private _wired;

    mapping(bytes32 intentId => IntentHeader) private _headers;
    mapping(bytes32 intentId => IntentHandles) private _handles;
    mapping(bytes32 epochId => EpochRecord) private _epochs;
    mapping(bytes32 epochId => EpochPublishedHandles) private _published;
    mapping(bytes32 epochId => bytes32[]) private _candidates;
    mapping(bytes32 intentId => bytes32 epochId) private _consumedBy;
    mapping(address safe => bytes32[]) private _intentsOfSafe;

    // -------------------------------------------------------------------------------------------
    // Events. Uniform by construction — see the header. No event carries a private value, and no
    // event fires on one private outcome and not another.
    // -------------------------------------------------------------------------------------------

    event IntentSubmitted(
        bytes32 indexed intentId,
        address indexed safe,
        address indexed module,
        bytes32 orderFamily,
        bytes32 epochId,
        bytes32 commitment
    );
    event IntentAuthorised(bytes32 indexed intentId, address indexed safe, uint256 threshold);
    event IntentProcessed(bytes32 indexed intentId, bytes32 indexed epochId);
    event IntentExpired(bytes32 indexed intentId);
    event IntentCancelled(bytes32 indexed intentId);
    event IntentHandlesUpdated(bytes32 indexed intentId, bytes32 indexed epochId);

    event EpochOpened(bytes32 indexed epochId, bytes32 orderFamily, address baseAsset, address quoteAsset);
    event EpochSealed(bytes32 indexed epochId, uint16 candidateCount, bytes32 priceSnapshotId, uint256 referencePrice);
    event EpochStatusChanged(bytes32 indexed epochId, EpochStatus from, EpochStatus to);
    event EpochPublishedHandlesCommitted(bytes32 indexed epochId);

    event Wired(address clearingEngine, address settlementEngine, address moduleFactory);
    event ModuleAuthorised(address indexed module);

    // -------------------------------------------------------------------------------------------
    // Errors. Every one names a PUBLIC fault. None can be reached by a private outcome.
    // -------------------------------------------------------------------------------------------

    error NotRegistrar(address caller);
    error AlreadyWired();
    error RegistrarIsZero();
    error IntentAlreadyExists(bytes32 intentId);
    error UnknownIntent(bytes32 intentId);
    error UnknownEpoch(bytes32 epochId);
    error EpochAlreadyExists(bytes32 epochId);
    error WrongIntentStatus(bytes32 intentId, IntentStatus expected, IntentStatus actual);
    error WrongEpochStatus(bytes32 epochId, EpochStatus expected, EpochStatus actual);
    error IntentAlreadyConsumed(bytes32 intentId, bytes32 byEpoch);
    error IntentNotExpired(bytes32 intentId, uint64 expiry);
    error CandidateBoundExceeded(uint256 supplied, uint256 maximum);
    error CandidateNotSorted(uint256 index);
    error CandidateEpochMismatch(bytes32 intentId, bytes32 expected, bytes32 actual);
    error CandidateFamilyMismatch(bytes32 intentId);
    error PublishedHandlesAlreadyCommitted(bytes32 epochId);
    error EmptyCandidateSet(bytes32 epochId);

    constructor(address deployer_) {
        if (deployer_ == address(0)) revert RegistrarIsZero();
        deployer = deployer_;
    }

    /**
     * @notice Fixes the three protocol writers and the module factory. One shot, permanently closed.
     *
     * @dev A constructor cannot do this and the cycle is real: the clearing engine needs the book's
     *      address, the settlement engine needs the clearing engine's, and the factory needs all of
     *      them. Something has to learn the others afterwards.
     *
     *      What makes it safe is that it is genuinely one-shot and closed by the same transaction
     *      that opens it. `_wired` has no setter that clears it and no path that skips it, so after
     *      this call the three addresses are as fixed as constructor immutables — and
     *      `pnpm verify:live` asserts they match the deployment manifest.
     */
    function wire(address clearingEngine, address settlementEngine, address moduleFactory_) external {
        if (msg.sender != deployer) revert NotRegistrar(msg.sender);
        if (_wired) revert AlreadyWired();
        _wired = true;
        _writers[clearingEngine] = true;
        _writers[settlementEngine] = true;
        moduleFactory = moduleFactory_;
        emit Wired(clearingEngine, settlementEngine, moduleFactory_);
    }

    /**
     * @notice Authorises one Safe-bound module to write its own intents.
     *
     * @dev Only `ShrudModuleFactory`, and only for a module it just deployed. A module's Safe is a
     *      constructor immutable and every write path re-reads the header it created, so an
     *      authorised module can still only touch intents whose `module` field is itself.
     */
    function authoriseModule(address module) external {
        if (msg.sender != moduleFactory) revert NotRegistrar(msg.sender);
        _writers[module] = true;
        emit ModuleAuthorised(module);
    }

    function isWriter(address account) external view returns (bool) {
        return _writers[account];
    }

    function isWired() external view returns (bool) {
        return _wired;
    }

    modifier onlyRegistrar() {
        if (!_writers[msg.sender]) revert NotRegistrar(msg.sender);
        _;
    }

    // -------------------------------------------------------------------------------------------
    // Intent lifecycle
    // -------------------------------------------------------------------------------------------

    function recordSubmission(bytes32 intentId, IntentHeader calldata header, IntentHandles calldata handles)
        external
        onlyRegistrar
    {
        if (_headers[intentId].status != IntentStatus.None) revert IntentAlreadyExists(intentId);

        IntentHeader memory stored = header;
        stored.status = IntentStatus.Submitted;
        stored.createdAtBlock = uint64(block.number);

        _headers[intentId] = stored;
        _handles[intentId] = handles;
        _intentsOfSafe[header.safe].push(intentId);

        emit IntentSubmitted(
            intentId, header.safe, header.module, header.orderFamily, header.epochId, header.commitment
        );
    }

    function recordAuthorisation(bytes32 intentId, uint256 threshold) external onlyRegistrar {
        IntentHeader storage header = _requireStatus(intentId, IntentStatus.Submitted);
        header.status = IntentStatus.Authorised;
        emit IntentAuthorised(intentId, header.safe, threshold);
    }

    /**
     * @notice The lock result, written back after the confidential transfer into epoch escrow.
     *
     * @dev Fires the SAME event whether the lock moved the full amount or encrypted zero. That is
     *      the point: `Nox.transfer` returns an encrypted success flag and leaves state unchanged on
     *      failure, so an underfunded Safe produces the same public trace as a funded one and the
     *      transaction succeeds either way. Anything that varied here — a different event, a
     *      different status, even a different gas cost bucket — would be the balance oracle the
     *      whole design exists to remove.
     */
    function recordLock(bytes32 intentId, bytes32 lockedAmount, bytes32 lockSuccess)
        external
        onlyRegistrar
    {
        IntentHeader storage header = _requireStatus(intentId, IntentStatus.Authorised);
        IntentHandles storage handles = _handles[intentId];
        handles.lockedAmount = lockedAmount;
        handles.lockSuccess = lockSuccess;
        emit IntentHandlesUpdated(intentId, header.epochId);
    }

    function recordClearingHandles(bytes32 intentId, IntentHandles calldata handles)
        external
        onlyRegistrar
    {
        IntentHeader storage header = _headers[intentId];
        if (header.status == IntentStatus.None) revert UnknownIntent(intentId);
        _handles[intentId] = handles;
        emit IntentHandlesUpdated(intentId, header.epochId);
    }

    function recordProcessed(bytes32 intentId, bytes32 epochId) external onlyRegistrar {
        IntentHeader storage header = _headers[intentId];
        if (header.status == IntentStatus.None) revert UnknownIntent(intentId);
        header.status = IntentStatus.Processed;
        emit IntentProcessed(intentId, epochId);
    }

    /**
     * @notice Expiry is permissionless.
     *
     * @dev Anyone may expire a passed-expiry order, and this is a privacy property rather than a
     *      convenience. If only the owning Safe could expire its own orders, then whether an order
     *      was expired promptly or left sitting would itself be a signal — an owner who cleans up
     *      immediately behaves differently from one who does not, and the difference is observable.
     *      Making it permissionless means expiry says nothing about the owner.
     */
    function expireIntent(bytes32 intentId) external {
        IntentHeader storage header = _headers[intentId];
        if (header.status == IntentStatus.None) revert UnknownIntent(intentId);
        if (header.status != IntentStatus.Submitted && header.status != IntentStatus.Authorised) {
            revert WrongIntentStatus(intentId, IntentStatus.Submitted, header.status);
        }
        if (block.timestamp <= header.expiry) revert IntentNotExpired(intentId, header.expiry);
        if (_consumedBy[intentId] != bytes32(0)) {
            revert IntentAlreadyConsumed(intentId, _consumedBy[intentId]);
        }
        header.status = IntentStatus.Expired;
        emit IntentExpired(intentId);
    }

    function recordCancellation(bytes32 intentId) external onlyRegistrar {
        IntentHeader storage header = _headers[intentId];
        if (header.status != IntentStatus.Submitted && header.status != IntentStatus.Authorised) {
            revert WrongIntentStatus(intentId, IntentStatus.Authorised, header.status);
        }
        if (_consumedBy[intentId] != bytes32(0)) {
            revert IntentAlreadyConsumed(intentId, _consumedBy[intentId]);
        }
        header.status = IntentStatus.Cancelled;
        emit IntentCancelled(intentId);
    }

    // -------------------------------------------------------------------------------------------
    // Epoch lifecycle
    // -------------------------------------------------------------------------------------------

    function openEpoch(bytes32 epochId, bytes32 orderFamily, address baseAsset, address quoteAsset)
        external
        onlyRegistrar
    {
        if (_epochs[epochId].status != EpochStatus.None) revert EpochAlreadyExists(epochId);
        _epochs[epochId] = EpochRecord({
            orderFamily: orderFamily,
            baseAsset: baseAsset,
            quoteAsset: quoteAsset,
            status: EpochStatus.Open,
            candidateCount: 0,
            sealedAtBlock: 0,
            settledAtBlock: 0,
            priceSnapshotId: bytes32(0),
            referencePrice: 0
        });
        emit EpochOpened(epochId, orderFamily, baseAsset, quoteAsset);
    }

    /**
     * @notice Fixes the candidate set and the price snapshot together, in one transaction.
     *
     * @dev THE SET IS DETERMINISTIC AND SORTED, AND THAT IS A PRIVACY REQUIREMENT.
     *
     *      PRD section 11.6 asks for "a deterministic candidate set sorted by intent ID". The reason
     *      is not tidiness. If a coordinator could choose the ORDER of candidates, the ordering
     *      would carry information: place the orders you expect to cross adjacently, or place the
     *      residual contributors last, and the public candidate list starts leaking the private
     *      classification. Sorting by intent id — a hash the submitter cannot grind cheaply, since
     *      it binds the Safe, module, nonce and commitment — makes the ordering carry nothing.
     *
     *      Duplicate rejection falls out of the strict ordering check for free: `<=` catches both a
     *      repeat and an unsorted pair in one comparison.
     */
    function sealEpoch(
        bytes32 epochId,
        bytes32[] calldata candidates,
        bytes32 priceSnapshotId,
        uint256 referencePrice
    ) external onlyRegistrar {
        EpochRecord storage epoch = _requireEpochStatus(epochId, EpochStatus.Open);

        uint256 count = candidates.length;
        if (count == 0) revert EmptyCandidateSet(epochId);
        if (count > ShrudOrderFamily.MAX_CANDIDATES) {
            revert CandidateBoundExceeded(count, ShrudOrderFamily.MAX_CANDIDATES);
        }

        bytes32 previous = bytes32(0);
        for (uint256 i = 0; i < count; ++i) {
            bytes32 intentId = candidates[i];
            if (uint256(intentId) <= uint256(previous)) revert CandidateNotSorted(i);
            previous = intentId;

            IntentHeader storage header = _headers[intentId];
            if (header.status != IntentStatus.Authorised) {
                revert WrongIntentStatus(intentId, IntentStatus.Authorised, header.status);
            }
            if (header.epochId != epochId) {
                revert CandidateEpochMismatch(intentId, epochId, header.epochId);
            }
            if (header.orderFamily != epoch.orderFamily) revert CandidateFamilyMismatch(intentId);
            if (_consumedBy[intentId] != bytes32(0)) {
                revert IntentAlreadyConsumed(intentId, _consumedBy[intentId]);
            }
            if (block.timestamp > header.expiry) revert IntentNotExpired(intentId, header.expiry);

            _consumedBy[intentId] = epochId;
        }

        _candidates[epochId] = candidates;
        epoch.candidateCount = uint16(count);
        epoch.priceSnapshotId = priceSnapshotId;
        epoch.referencePrice = referencePrice;
        epoch.sealedAtBlock = uint64(block.number);
        _setEpochStatus(epoch, epochId, EpochStatus.PriceFixed);

        emit EpochSealed(epochId, uint16(count), priceSnapshotId, referencePrice);
    }

    /// @notice Commits the exact five handles this epoch is permitted to publish. Write-once.
    function commitPublishedHandles(bytes32 epochId, EpochPublishedHandles calldata handles)
        external
        onlyRegistrar
    {
        if (_epochs[epochId].status == EpochStatus.None) revert UnknownEpoch(epochId);
        if (_published[epochId].residualAggregateInput != bytes32(0)) {
            revert PublishedHandlesAlreadyCommitted(epochId);
        }
        _published[epochId] = handles;
        emit EpochPublishedHandlesCommitted(epochId);
    }

    function setEpochStatus(bytes32 epochId, EpochStatus next) external onlyRegistrar {
        EpochRecord storage epoch = _epochs[epochId];
        if (epoch.status == EpochStatus.None) revert UnknownEpoch(epochId);
        if (next == EpochStatus.Settled) epoch.settledAtBlock = uint64(block.number);
        _setEpochStatus(epoch, epochId, next);
    }

    // -------------------------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------------------------

    function headerOf(bytes32 intentId) external view returns (IntentHeader memory) {
        return _headers[intentId];
    }

    function handlesOf(bytes32 intentId) external view returns (IntentHandles memory) {
        return _handles[intentId];
    }

    function epochOf(bytes32 epochId) external view returns (EpochRecord memory) {
        return _epochs[epochId];
    }

    function publishedHandlesOf(bytes32 epochId) external view returns (EpochPublishedHandles memory) {
        return _published[epochId];
    }

    function candidatesOf(bytes32 epochId) external view returns (bytes32[] memory) {
        return _candidates[epochId];
    }

    function consumedBy(bytes32 intentId) external view returns (bytes32) {
        return _consumedBy[intentId];
    }

    function intentsOfSafe(address safe) external view returns (bytes32[] memory) {
        return _intentsOfSafe[safe];
    }

    // -------------------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------------------

    function _requireStatus(bytes32 intentId, IntentStatus expected)
        private
        view
        returns (IntentHeader storage header)
    {
        header = _headers[intentId];
        if (header.status == IntentStatus.None) revert UnknownIntent(intentId);
        if (header.status != expected) revert WrongIntentStatus(intentId, expected, header.status);
    }

    function _requireEpochStatus(bytes32 epochId, EpochStatus expected)
        private
        view
        returns (EpochRecord storage epoch)
    {
        epoch = _epochs[epochId];
        if (epoch.status == EpochStatus.None) revert UnknownEpoch(epochId);
        if (epoch.status != expected) revert WrongEpochStatus(epochId, expected, epoch.status);
    }

    function _setEpochStatus(EpochRecord storage epoch, bytes32 epochId, EpochStatus next) private {
        EpochStatus previous = epoch.status;
        epoch.status = next;
        emit EpochStatusChanged(epochId, previous, next);
    }
}
