// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {IERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";
import {IERC7984Receiver} from
    "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984Receiver.sol";
import {Nox, ebool, euint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

import {ShrudAssetRegistry} from "../assets/ShrudAssetRegistry.sol";
import {ShrudHandleIsolation} from "../base/ShrudHandleIsolation.sol";
import {IShrudClearingVault} from "../interfaces/IShrudClearingVault.sol";
import {ShrudIntentBook} from "../intents/ShrudIntentBook.sol";
import {ShrudPauseController} from "../recovery/ShrudPauseController.sol";

/**
 * @title ShrudClearingVault
 * @notice Custody for everything a clearing epoch touches, and no way out except the four paths
 *         below.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THERE IS NO OWNER WITHDRAWAL FUNCTION, AND THAT IS THE MOST IMPORTANT THING ABOUT THIS FILE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PRD section 9.8: the vault "has no independent owner-controlled withdrawal function". Value can
 * leave here in exactly four ways, and each is triggered by a contract fixed at deployment:
 *
 *   1. the clearing engine distributing a computed final allocation to the owning Safe;
 *   2. the settlement engine unwrapping a sealed residual for a public venue call;
 *   3. a Safe-authorised cancellation refunding an unsealed order;
 *   4. `ShrudEmergencyExit`, under a halted network, returning escrow to its Safe.
 *
 * No admin, no governor, no pause-privileged sweep, no rescue function. A rescue function is how a
 * vault with correct accounting loses its assets anyway, and every argument for adding one is an
 * argument for a key that can take the money.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE CALLBACK IS THE ATTACK SURFACE, SO IT ASSUMES NOTHING
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `onConfidentialTransferReceived` is called by an ERC-7984 token during
 * `confidentialTransferFromAndCall`. Three things are checked and none of them can be skipped:
 *
 *   - `msg.sender` must be a wrapper the asset registry currently recognises, code hash and all.
 *     Any contract can call this function; only a registered wrapper's call means anything.
 *   - `operator` must be a Safe-bound shrud module whose registered Safe is `from`. A wrapper
 *     transfer initiated by anything else is not a lock.
 *   - the callback data must name an intent whose header agrees with `from`, `operator` and the
 *     epoch. A correct transfer credited to the wrong intent is a theft with a valid receipt.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE CALLBACK DOES NOT COMPUTE ON `amount`
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `IERC7984Receiver`'s documentation says *"The `amount` handle is accessible to this contract via
 * the ACL."* It is not. `ERC7984Base._transferAndCall` grants transient access to `msg.sender` —
 * the operator — and never to the receiver, so a receiver that tried to compute on the amount would
 * be refused inside NoxCompute. Verified by reading `ERC7984Base.sol` in
 * `nox-confidential-contracts` 0.2.2; recorded in `feedback.md`.
 *
 * shrud works with the implementation rather than the documentation. The callback records that a
 * credit is expected and returns encrypted acceptance. The module — which does hold the grant —
 * isolates the transferred handle and hands it back through `confirmLock`. One extra call, and the
 * accounting is anchored to a handle the vault provably has permission on.
 */
contract ShrudClearingVault is ShrudHandleIsolation, IShrudClearingVault, IERC7984Receiver {
    struct EscrowRecord {
        address safe;
        /// The Safe-bound module that performed the lock. Recorded at credit time so the caller
        /// check on `confirmLock` and `refundCancelled` needs no external read and cannot be
        /// answered by a different module that happens to know the intent id.
        address module;
        address wrapper;
        bytes32 epochId;
        /// Isolated handle for the amount actually locked. Encrypted zero when the balance fell short.
        bytes32 amount;
        bool confirmed;
        bool released;
    }

    /// @notice Set once, by the deployer, immediately after the dependent contracts exist.
    address public immutable deployer;

    ShrudAssetRegistry public immutable assetRegistry;
    ShrudIntentBook public immutable intentBook;

    address public clearingEngine;
    address public settlementEngine;
    address public emergencyExit;
    address public moduleFactory;
    bool private _wired;

    mapping(bytes32 intentId => EscrowRecord) private _escrow;
    /// @dev Credits the callback has seen but `confirmLock` has not yet anchored.
    mapping(bytes32 intentId => bool) private _pendingCredit;

    event LockCredited(bytes32 indexed intentId, address indexed safe, address indexed wrapper);
    event LockConfirmed(bytes32 indexed intentId, bytes32 epochId);
    event EscrowReleased(bytes32 indexed intentId, address indexed safe, bytes32 reason);
    event Wired(address clearingEngine, address settlementEngine, address emergencyExit, address moduleFactory);

    error NotDeployer(address caller);
    error AlreadyWired();
    error NotWired();
    error SenderIsNotARegisteredWrapper(address sender);
    error OperatorIsNotAShrudModule(address operator);
    error OperatorSafeMismatch(address operator, address expectedSafe, address actualSafe);
    error CallbackDataMismatch(bytes32 intentId);
    error NoPendingCredit(bytes32 intentId);
    error EscrowAlreadyConfirmed(bytes32 intentId);
    error EscrowNotConfirmed(bytes32 intentId);
    error EscrowAlreadyReleased(bytes32 intentId);
    error NotClearingEngine(address caller);
    error NotSettlementEngine(address caller);
    error NotEmergencyExit(address caller);
    error NotTheOwningModule(address caller, address expected);

    constructor(
        ShrudAssetRegistry assetRegistry_,
        ShrudIntentBook intentBook_,
        ShrudPauseController pauseController_
    ) ShrudHandleIsolation(pauseController_) {
        deployer = msg.sender;
        assetRegistry = assetRegistry_;
        intentBook = intentBook_;
    }

    /**
     * @notice One-shot wiring for the four contracts allowed to move value.
     *
     * @dev A CONSTRUCTOR CANNOT DO THIS AND THE CYCLE IS REAL: the module factory needs the vault's
     *      address to build modules, the clearing engine needs it to hold escrow, and the vault
     *      needs all of theirs. One of the four has to learn the others afterwards.
     *
     *      What makes it safe is that it is genuinely one-shot and permanently closed by the same
     *      transaction that opens it. `_wired` has no setter that clears it and no path that skips
     *      it: after this call the four addresses are as fixed as constructor immutables, and
     *      `pnpm verify:live` asserts they match the deployment manifest.
     */
    function wire(
        address clearingEngine_,
        address settlementEngine_,
        address emergencyExit_,
        address moduleFactory_
    ) external {
        if (msg.sender != deployer) revert NotDeployer(msg.sender);
        if (_wired) revert AlreadyWired();
        _wired = true;
        clearingEngine = clearingEngine_;
        settlementEngine = settlementEngine_;
        emergencyExit = emergencyExit_;
        moduleFactory = moduleFactory_;
        emit Wired(clearingEngine_, settlementEngine_, emergencyExit_, moduleFactory_);
    }

    /// @notice Only the four wired contracts, which is also the transient-handle allowlist.
    function isReviewedTransientRecipient(address recipient) public view override returns (bool) {
        return recipient == clearingEngine || recipient == settlementEngine || recipient == emergencyExit;
    }

    // -------------------------------------------------------------------------------------------
    // 1 · Receiving a lock
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IERC7984Receiver
    function onConfidentialTransferReceived(
        address operator,
        address from,
        euint256, /* amount — see the header: the receiver holds no grant on this handle */
        bytes calldata data
    ) external override returns (ebool) {
        if (!_wired) revert NotWired();

        // Check 1. Any contract can call this; only a registered wrapper's call is a lock. The
        // registry re-checks the wrapper's runtime code hash, so an upgraded proxy at a registered
        // address fails here rather than being trusted on a check that ran at registration.
        if (!assetRegistry.isRegisteredWrapper(msg.sender)) {
            revert SenderIsNotARegisteredWrapper(msg.sender);
        }

        (bytes32 intentId, bytes32 epochId) = abi.decode(data, (bytes32, bytes32));
        ShrudIntentBook.IntentHeader memory header = intentBook.headerOf(intentId);

        // Check 2. The operator must be the shrud module bound to `from`.
        if (header.module != operator) revert OperatorIsNotAShrudModule(operator);
        if (header.safe != from) revert OperatorSafeMismatch(operator, header.safe, from);

        // Check 3. The credit must land on the intent the data names, in the epoch it names.
        if (header.epochId != epochId) revert CallbackDataMismatch(intentId);
        if (_escrow[intentId].confirmed) revert EscrowAlreadyConfirmed(intentId);

        _pendingCredit[intentId] = true;
        _escrow[intentId].safe = from;
        _escrow[intentId].module = operator;
        _escrow[intentId].wrapper = msg.sender;
        _escrow[intentId].epochId = epochId;

        emit LockCredited(intentId, from, msg.sender);

        // Encrypted acceptance. Returning encrypted `false` here would make the token refund the
        // sender — a mechanism shrud never uses, because every reason to refuse is a PUBLIC fault
        // that has already reverted above.
        return Nox.toEbool(true);
    }

    /// @inheritdoc IShrudClearingVault
    function confirmLock(bytes32 intentId, euint256 lockedAmount, ebool lockSuccess) external override {
        EscrowRecord storage record = _escrow[intentId];
        if (msg.sender != record.module) revert NotTheOwningModule(msg.sender, record.module);
        if (!_pendingCredit[intentId]) revert NoPendingCredit(intentId);
        if (record.confirmed) revert EscrowAlreadyConfirmed(intentId);

        delete _pendingCredit[intentId];
        record.confirmed = true;
        record.amount = euint256.unwrap(lockedAmount);

        // Persist so the engine can compute on it in a later transaction, and grant the engine the
        // same. Permanent by necessity: the clearing graph spans several transactions and Nox has
        // no callback that could re-grant mid-flight.
        Nox.allowThis(lockedAmount);
        Nox.allow(lockedAmount, clearingEngine);
        Nox.allowThis(lockSuccess);

        emit LockConfirmed(intentId, record.epochId);
    }

    // -------------------------------------------------------------------------------------------
    // 2 · Releasing value. Four callers, four reasons, nothing else.
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Delivers a computed confidential allocation to its Safe.
     *
     * @dev The engine has already isolated `amount` under this intent's domain, so the transfer's
     *      own arithmetic cannot make two Safes' allocations collide into one handle.
     */
    function distribute(bytes32 intentId, address wrapper, address safe, euint256 amount) external {
        if (msg.sender != clearingEngine) revert NotClearingEngine(msg.sender);
        Nox.allowTransient(amount, wrapper);
        IERC7984(wrapper).confidentialTransfer(safe, amount);
        emit EscrowReleased(intentId, safe, "allocation");
    }

    /// @notice Hands the settlement engine the aggregate residual to unwrap for a public venue call.
    function releaseResidual(address wrapper, euint256 amount) external {
        if (msg.sender != settlementEngine) revert NotSettlementEngine(msg.sender);
        Nox.allowTransient(amount, wrapper);
        Nox.allowTransient(amount, settlementEngine);
        emit EscrowReleased(bytes32(0), settlementEngine, "residual");
    }

    /// @inheritdoc IShrudClearingVault
    function refundCancelled(bytes32 intentId) external override {
        EscrowRecord storage record = _escrow[intentId];
        if (msg.sender != record.module) revert NotTheOwningModule(msg.sender, record.module);
        if (!record.confirmed) revert EscrowNotConfirmed(intentId);
        if (record.released) revert EscrowAlreadyReleased(intentId);
        record.released = true;

        euint256 amount = euint256.wrap(record.amount);
        Nox.allowTransient(amount, record.wrapper);
        IERC7984(record.wrapper).confidentialTransfer(record.safe, amount);

        emit EscrowReleased(intentId, record.safe, "cancelled");
    }

    /// @notice The halted-network path. Returns confirmed, unreleased escrow to its Safe.
    function emergencyRelease(bytes32 intentId) external {
        if (msg.sender != emergencyExit) revert NotEmergencyExit(msg.sender);
        pauseController.requireHalted();

        EscrowRecord storage record = _escrow[intentId];
        if (!record.confirmed) revert EscrowNotConfirmed(intentId);
        if (record.released) revert EscrowAlreadyReleased(intentId);
        record.released = true;

        euint256 amount = euint256.wrap(record.amount);
        Nox.allowTransient(amount, record.wrapper);
        IERC7984(record.wrapper).confidentialTransfer(record.safe, amount);

        emit EscrowReleased(intentId, record.safe, "emergency");
    }

    /// @notice Marks escrow spent by a settled epoch, so it cannot also be refunded or exited.
    function markConsumed(bytes32 intentId) external {
        if (msg.sender != clearingEngine) revert NotClearingEngine(msg.sender);
        EscrowRecord storage record = _escrow[intentId];
        if (record.released) revert EscrowAlreadyReleased(intentId);
        record.released = true;
    }

    // -------------------------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IShrudClearingVault
    function escrowOf(bytes32 intentId) external view override returns (euint256) {
        return euint256.wrap(_escrow[intentId].amount);
    }

    function escrowRecordOf(bytes32 intentId) external view returns (EscrowRecord memory) {
        return _escrow[intentId];
    }

    function hasPendingCredit(bytes32 intentId) external view returns (bool) {
        return _pendingCredit[intentId];
    }

    function isWired() external view returns (bool) {
        return _wired;
    }
}
