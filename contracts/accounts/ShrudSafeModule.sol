// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {IERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";
import {IERC20ToERC7984Wrapper} from
    "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC20ToERC7984Wrapper.sol";
import {
    Nox,
    ebool,
    euint16,
    euint256,
    externalEuint16,
    externalEuint256
} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

import {ShrudAssetRegistry} from "../assets/ShrudAssetRegistry.sol";
import {ShrudHandleIsolation} from "../base/ShrudHandleIsolation.sol";
import {IShrudClearingVault} from "../interfaces/IShrudClearingVault.sol";
import {ISafe, SafeEnum} from "../interfaces/ISafe.sol";
import {ShrudIntentBook} from "../intents/ShrudIntentBook.sol";
import {ShrudOrderFamily} from "../libraries/ShrudOrderFamily.sol";
import {ShrudCapsuleFactory} from "../disclosure/ShrudCapsuleFactory.sol";
import {ShrudPauseController} from "../recovery/ShrudPauseController.sol";
import {ShrudModuleGuard} from "./ShrudModuleGuard.sol";
import {ShrudSafeIntrospection} from "./ShrudSafeIntrospection.sol";

/**
 * @title ShrudSafeModule
 * @notice One immutable module per Safe. The account-authority plane, and nothing else.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO-CALLER SPLIT, AND WHY IT IS NOT AN INCONVENIENCE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `submitIntent` must be called by a Safe **owner, directly**. `activateIntent` may be called by
 * anyone who holds enough owner signatures. These are different callers on purpose and the
 * asymmetry is forced by cryptography rather than chosen for convenience.
 *
 * `Nox.fromExternal` binds a proof to the address that called the contract calling it. The gateway
 * mints that proof against an EIP-712 signature, so `owner` is whichever key signed. If a Safe
 * transaction, a relayer, a paymaster or a batch router sat between the owner and this module,
 * `validateInputProof` would see `owner == the signer` and `msg.sender == the intermediary` and
 * refuse. There is no configuration that makes it work.
 *
 * `activateIntent` has no such constraint, because it carries no encrypted input — only Safe
 * signatures over a digest — so it goes through the Safe's own `checkSignatures` and fully supports
 * EIP-1271 contract owners.
 *
 * The honest consequence, delta D-10: a Safe whose owners are ALL contracts can authorise every
 * shrud order but cannot originate one. The onboarding scan reports it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE THRESHOLD IS READ AT ACTIVATION AND NEVER COPIED
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PRD section 5.4 and invariant 21.5.2. The module holds no owner list of its own. `activateIntent`
 * calls the Safe's LIVE `checkSignatures`, so an owner removed between submission and activation
 * cannot authorise, and a threshold raised in between binds immediately. A copied owner registry
 * would be a second, silently stale authority — the exact thing PRD section 3.2.8 forbids.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY OWNER GRANTS ARE PER-EOA, AND WHY ROTATION EXISTS
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A Nox grant is to an ADDRESS, and decryption requires a key. A Safe is a contract and holds no
 * key, so `Nox.allow(handle, safe)` would grant access to nobody. Every private value is therefore
 * granted to each of the Safe's CURRENT owner EOAs individually.
 *
 * That grant is permanent — Nox has no `removeViewer` and no `removeAdmin`. So when the owner set
 * changes, the removed owner keeps access to the handles they already held, and there is no
 * cryptographic way to change that. `rotateLiveStateViewers` is the honest answer: live values are
 * re-isolated into FRESH handles granted to the new owner set, so the removed owner's access
 * becomes access to a historical snapshot rather than to the treasury. The interface says exactly
 * that, and never says "revoked".
 */
contract ShrudSafeModule is ShrudHandleIsolation {
    using ShrudSafeIntrospection for ISafe;

    /// @notice The public half of an order. Every field here is visible from submission.
    struct IntentHeaderInput {
        bytes32 orderFamily;
        address inputAsset;
        bytes32 epochId;
        uint64 expiry;
        uint64 nonce;
        bytes32 commitment;
    }

    // -------------------------------------------------------------------------------------------
    // Immutable bindings. Set by the factory, never changeable.
    // -------------------------------------------------------------------------------------------

    ISafe public immutable safe;
    ShrudIntentBook public immutable intentBook;
    ShrudAssetRegistry public immutable assetRegistry;
    IShrudClearingVault public immutable clearingVault;
    address public immutable clearingEngine;
    address public immutable capsuleFactory;
    address public immutable moduleGuard;

    /**
     * @notice EIP-712 domain, computed once at deployment.
     * @dev Not cached-then-recomputed-on-chainid-change: this module is CREATE2-deployed with the
     *      chain id in its salt, so it cannot legitimately exist on two chains at one address, and
     *      a fork would produce a different module address rather than a replayable signature.
     */
    bytes32 public immutable domainSeparator;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /**
     * @notice The digest owners sign to activate an order.
     *
     * @dev EVERY FIELD BELOW IS PART OF THE REPLAY BOUNDARY (PRD section 20.7). Chain id and
     *      verifying contract come from the domain; `safe`, `intentId`, `commitment`, `orderFamily`,
     *      `epochId`, `nonce` and `expiry` are here. Drop any one of them and a signature collected
     *      for one order becomes reusable for another that differs only in that field.
     */
    bytes32 private constant SHRUD_INTENT_TYPEHASH = keccak256(
        "ShrudIntent(address safe,bytes32 intentId,bytes32 commitment,bytes32 orderFamily,bytes32 epochId,address inputAsset,uint64 nonce,uint64 expiry,uint16 schemaVersion)"
    );

    /// @dev Set once by the factory immediately after deployment, then frozen.
    mapping(bytes32 intentId => bool) private _submitted;

    /// @dev The owner set the module last granted live-state handles to. Rotation compares here.
    bytes32 private _grantedOwnerSetHash;

    event ShieldExecuted(address indexed underlying, address indexed wrapper, uint256 publicAmount);
    event OperatorGranted(address indexed wrapper, uint48 until);
    event OperatorRevoked(address indexed wrapper);
    event LiveStateViewersRotated(bytes32 previousOwnerSetHash, bytes32 newOwnerSetHash);
    event UnwrapRequested(address indexed wrapper);

    error CallerIsNotASafeOwner(address caller);
    error IntentAlreadySubmitted(bytes32 intentId);
    error IntentExpiryInThePast(uint64 expiry);
    error IntentExpiryTooFar(uint64 expiry, uint64 maximum);
    error UnknownOrderFamily(bytes32 orderFamily);
    error CommitmentIsZero();
    error ModuleNotEnabledOnSafe(address safe, address module);
    error ModuleGuardNotInstalled(address safe, address expected, address actual);
    error OwnerSetUnchanged(bytes32 ownerSetHash);
    error SafeExecutionFailed();

    /// @notice Ninety days. An order that outlives a quarter has outlived its own thesis.
    uint64 public constant MAX_INTENT_LIFETIME = 90 days;

    /**
     * @dev THE GUARD IS DEPLOYED FROM HERE, AND THAT BREAKS A REAL CIRCULARITY.
     *
     * The guard must know its module immutably — otherwise it is repointable, and a repointable
     * guard is not a boundary. The module must know its guard immutably — otherwise
     * `_assertInstalled` cannot check that the boundary is still installed. Each needs the other's
     * address at construction, and CREATE2 prediction does not resolve it: each address depends on
     * the other's constructor arguments.
     *
     * Constructing the guard inside the module's constructor settles it in one direction:
     * `address(this)` is already known here, so the guard gets a genuinely immutable module, and
     * the module gets a genuinely immutable guard. The guard's address is still deterministic —
     * CREATE from this module at nonce 1 — so `ShrudModuleFactory.predictAddresses` can compute
     * both before either exists, which is what makes installation reviewable before it is signed.
     *
     * The alternative considered and rejected was a one-shot `bindModule` setter on the guard. It
     * works, and it leaves a window between deployment and binding in which the guard would answer
     * for a zero module — a window that exists only because of how the contracts were wired, which
     * is the worst reason for a window to exist.
     */
    constructor(
        ISafe safe_,
        ShrudIntentBook intentBook_,
        ShrudAssetRegistry assetRegistry_,
        IShrudClearingVault clearingVault_,
        address clearingEngine_,
        address capsuleFactory_,
        ShrudPauseController pauseController_
    ) ShrudHandleIsolation(pauseController_) {
        safe = safe_;
        intentBook = intentBook_;
        assetRegistry = assetRegistry_;
        clearingVault = clearingVault_;
        clearingEngine = clearingEngine_;
        capsuleFactory = capsuleFactory_;
        moduleGuard =
            address(new ShrudModuleGuard(address(safe_), address(this), assetRegistry_, pauseController_));

        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256("shrud"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice The module's immutable transient-handle allowlist. Three reviewed shrud contracts.
    function isReviewedTransientRecipient(address recipient) public view override returns (bool) {
        return recipient == address(clearingVault) || recipient == clearingEngine
            || recipient == capsuleFactory;
    }

    modifier onlySafeOwner() {
        if (!safe.isOwner(msg.sender)) revert CallerIsNotASafeOwner(msg.sender);
        _;
    }

    // -------------------------------------------------------------------------------------------
    // 1 · Submit
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Accepts one governed encrypted order from a Safe owner calling directly.
     *
     * @dev WHAT IS IN PUBLIC CALLDATA AND WHAT IS NOT. Calldata carries three handles, three
     *      gateway proofs, the public header and the commitment. It carries no amount, no side, no
     *      limit — those exist only as ciphertext the gateway holds keys for. PRD acceptance
     *      criterion 27.3 asserts this against a real explorer trace rather than against this
     *      comment.
     *
     *      THREE THINGS HAPPEN IN ORDER, AND THE ORDER MATTERS. The nonce is consumed first, so a
     *      replayed submission fails before any gateway round trip. Each handle is imported and
     *      immediately marked consumed, so the same proof cannot be spent twice within its
     *      3,600-second validity — the half Nox does not provide (delta D-6). Only then is anything
     *      written.
     */
    function submitIntent(
        IntentHeaderInput calldata header,
        externalEuint256 encryptedAmount,
        bytes calldata amountProof,
        externalEuint16 encryptedActionId,
        bytes calldata actionProof,
        externalEuint256 encryptedLimit,
        bytes calldata limitProof
    ) external onlySafeOwner returns (bytes32 intentId) {
        pauseController.requireLive(ShrudPauseController.Activity.Submit);
        _assertInstalled();

        if (header.commitment == bytes32(0)) revert CommitmentIsZero();
        if (header.orderFamily != ShrudOrderFamily.USDC_WETH_ALLOCATION_V1) {
            revert UnknownOrderFamily(header.orderFamily);
        }
        if (header.expiry <= block.timestamp) revert IntentExpiryInThePast(header.expiry);
        if (header.expiry > block.timestamp + MAX_INTENT_LIFETIME) {
            revert IntentExpiryTooFar(header.expiry, uint64(block.timestamp) + MAX_INTENT_LIFETIME);
        }
        // Reverts if the asset is unregistered, disabled, or its wrapper's code has changed.
        assetRegistry.requireEnabledWrapper(header.inputAsset);

        _consumeNonce(header.nonce);

        intentId = computeIntentId(header);
        if (_submitted[intentId]) revert IntentAlreadySubmitted(intentId);
        _submitted[intentId] = true;

        euint256 amount = Nox.fromExternal(encryptedAmount, amountProof);
        _consumeHandle(euint256.unwrap(amount));

        euint16 actionId = Nox.fromExternal(encryptedActionId, actionProof);
        _consumeHandle(euint16.unwrap(actionId));

        euint256 limit = Nox.fromExternal(encryptedLimit, limitProof);
        _consumeHandle(euint256.unwrap(limit));

        // The submitting owner may read back what they submitted; this contract must compute on it
        // later, in a different transaction. Nothing else is granted here — the clearing engine
        // receives its grant at activation, once the Safe's threshold has actually authorised.
        _grantOwnerOnly(amount, msg.sender);
        _grantOwnerOnly(actionId, msg.sender);
        _grantOwnerOnly(limit, msg.sender);

        intentBook.recordSubmission(
            intentId,
            ShrudIntentBook.IntentHeader({
                module: address(this),
                safe: address(safe),
                inputAsset: header.inputAsset,
                orderFamily: header.orderFamily,
                epochId: header.epochId,
                expiry: header.expiry,
                nonce: header.nonce,
                commitment: header.commitment,
                createdAtBlock: 0,
                status: ShrudIntentBook.IntentStatus.None
            }),
            ShrudIntentBook.IntentHandles({
                amount: euint256.unwrap(amount),
                actionId: euint16.unwrap(actionId),
                limit: euint256.unwrap(limit),
                lockedAmount: bytes32(0),
                lockSuccess: bytes32(0),
                priceEligible: bytes32(0),
                privateInclusion: bytes32(0),
                internalCrossInput: bytes32(0),
                internalCrossOutput: bytes32(0),
                residualContribution: bytes32(0),
                externalAllocation: bytes32(0),
                finalAllocation: bytes32(0),
                confidentialRefund: bytes32(0),
                privateOutcome: bytes32(0)
            })
        );
    }

    /**
     * @notice The intent id, derivable off chain by Shrud Lens before anything is signed.
     *
     * @dev Binding the commitment in makes the id un-grindable in the way that matters: a submitter
     *      cannot choose where their order lands in the sorted candidate set without also changing
     *      the plaintext order their own owners are about to verify. That is what makes the sealed
     *      set's ordering carry no information (see `ShrudIntentBook.sealEpoch`).
     */
    function computeIntentId(IntentHeaderInput calldata header) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(safe),
                address(this),
                header.orderFamily,
                header.epochId,
                header.inputAsset,
                header.nonce,
                header.expiry,
                header.commitment,
                SHRUD_SCHEMA_VERSION
            )
        );
    }

    // -------------------------------------------------------------------------------------------
    // 2 · Authorise and lock
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Verifies the Safe's CURRENT threshold, then locks the order's assets into escrow.
     *
     * @dev Permissionless caller. Whoever submits the packed signatures gains nothing: `executor` is
     *      `address(0)` (delta D-2), so a caller who happens to be an owner cannot substitute
     *      themselves for one signature.
     *
     *      LOCKING CANNOT FAIL PUBLICLY, AND THAT IS THE POINT. The module is the Safe's ERC-7984
     *      operator, so it calls the wrapper directly. `confidentialTransferFromAndCall` returns the
     *      amount ACTUALLY moved — `select(success, amount, 0)` inside the token — so an underfunded
     *      Safe produces encrypted zero and a successful transaction, indistinguishable from a
     *      funded one. There is no branch here that could differ, no event that fires only on one
     *      path, and no revert reason that names a balance.
     */
    function activateIntent(bytes32 intentId, bytes calldata safeSignatures) external {
        pauseController.requireLive(ShrudPauseController.Activity.Activate);
        _assertInstalled();

        ShrudIntentBook.IntentHeader memory header = intentBook.headerOf(intentId);
        bytes32 digest = intentDigest(intentId, header);

        // The Safe's live authority. Reverts unless the CURRENT owner set and CURRENT threshold are
        // satisfied — never the ones that applied when the order was submitted.
        safe.checkSignatures(address(0), digest, safeSignatures);

        uint256 threshold = safe.getThreshold();
        intentBook.recordAuthorisation(intentId, threshold);

        _lock(intentId, header);
    }

    /// @notice The exact digest a Safe owner signs. Recomputed locally by Shrud Lens before signing.
    function intentDigest(bytes32 intentId, ShrudIntentBook.IntentHeader memory header)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                SHRUD_INTENT_TYPEHASH,
                address(safe),
                intentId,
                header.commitment,
                header.orderFamily,
                header.epochId,
                header.inputAsset,
                header.nonce,
                header.expiry,
                SHRUD_SCHEMA_VERSION
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _lock(bytes32 intentId, ShrudIntentBook.IntentHeader memory header) private {
        address wrapper = assetRegistry.requireEnabledWrapper(header.inputAsset);
        ShrudIntentBook.IntentHandles memory handles = intentBook.handlesOf(intentId);
        euint256 amount = euint256.wrap(handles.amount);

        // The vault needs the transferred handle inside its own callback and afterwards; the
        // wrapper needs permission to compute on the amount this contract is spending.
        Nox.allowTransient(amount, wrapper);

        euint256 moved = IERC7984(wrapper).confidentialTransferFromAndCall(
            address(safe), address(clearingVault), amount, abi.encode(intentId, header.epochId)
        );

        // Isolate before granting. Two Safes locking numerically identical amounts in the same epoch
        // would otherwise share one handle and one permanent ACL entry — delta D-5.
        ebool epochCondition = _buildEpochCondition(header.epochId, moved);
        euint256 lockedAmount =
            _isolate(moved, epochCondition, isolationDomain(header.epochId, ROLE_LOCKED, uint256(intentId)));

        // "Did the lock move anything" is the private outcome the owner cares about. A genuine
        // zero-amount order and an underfunded one are indistinguishable here, deliberately: both
        // contribute nothing and neither should be separable by an observer OR by the owner's own
        // handle, which an outsider might later obtain through a capsule.
        ebool lockSuccess = _isolateBool(
            Nox.gt(lockedAmount, Nox.toEuint256(0)),
            epochCondition,
            isolationDomain(header.epochId, ROLE_LOCK_SUCCESS, uint256(intentId))
        );

        _grantToCurrentOwners(lockedAmount);
        _grantToCurrentOwners(lockSuccess);

        // The engine and the vault must compute on these across later transactions, so these grants
        // are permanent by necessity. Both are reviewed shrud contracts fixed at deployment.
        Nox.allow(lockedAmount, address(clearingVault));
        Nox.allow(lockedAmount, clearingEngine);
        Nox.allow(lockSuccess, clearingEngine);
        Nox.allow(euint256.wrap(handles.actionId), clearingEngine);
        Nox.allow(euint16.wrap(handles.actionId), clearingEngine);
        Nox.allow(euint256.wrap(handles.limit), clearingEngine);

        clearingVault.confirmLock(intentId, lockedAmount, lockSuccess);
        intentBook.recordLock(intentId, euint256.unwrap(lockedAmount), ebool.unwrap(lockSuccess));
    }

    // -------------------------------------------------------------------------------------------
    // 3 · Cancel
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Cancels an order that has not yet been consumed by a sealed epoch.
     *
     * @dev Requires the Safe's threshold, because cancelling releases escrowed value. Once an epoch
     *      has sealed, cancellation is impossible by construction: `ShrudIntentBook.sealEpoch` marks
     *      the intent consumed and `recordCancellation` refuses a consumed intent. That is a
     *      correctness requirement, not a policy — a cancelled candidate inside a sealed set would
     *      change the crossed amount after the price was fixed.
     */
    function cancelIntent(bytes32 intentId, bytes calldata safeSignatures) external {
        pauseController.requireNotHalted(ShrudPauseController.Activity.Activate);

        ShrudIntentBook.IntentHeader memory header = intentBook.headerOf(intentId);
        bytes32 digest = _cancelDigest(intentId, header);
        safe.checkSignatures(address(0), digest, safeSignatures);

        intentBook.recordCancellation(intentId);

        if (header.status == ShrudIntentBook.IntentStatus.Authorised) {
            clearingVault.refundCancelled(intentId);
        }
    }

    function _cancelDigest(bytes32 intentId, ShrudIntentBook.IntentHeader memory header)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ShrudCancel(address safe,bytes32 intentId,bytes32 commitment,uint64 nonce)"),
                address(safe),
                intentId,
                header.commitment,
                header.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    // -------------------------------------------------------------------------------------------
    // 4 · Shield — the only path that uses `execTransactionFromModule`
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Approves, wraps and grants the operator role, in one threshold-authorised action.
     *
     * @dev WHY THIS GOES THROUGH THE MODULE AT ALL. A Safe could approve and wrap by itself with an
     *      ordinary Safe transaction, and nothing would stop it. Routing it through the module puts
     *      all three steps behind `ShrudModuleGuard`, which is where "the spender is THIS
     *      underlying's registered wrapper", "the wrap recipient is the Safe and not a third party"
     *      and "the operator is the bound module" become enforceable rather than advisory. PRD
     *      section 11.2 describes the flow; the guard is what makes the description binding.
     *
     *      THE PUBLIC DISCLOSURE IS STATED HERE BECAUSE IT IS REAL. `amount` is a plaintext ERC-20
     *      transfer and is public forever. PRD section 3.2.2 lists this as an explicit non-goal, and
     *      the interface confirms the boundary before the user signs.
     */
    function shield(address underlying, uint256 amount, uint48 operatorUntil, bytes calldata safeSignatures)
        external
    {
        pauseController.requireLive(ShrudPauseController.Activity.Shield);
        _assertInstalled();

        address wrapper = assetRegistry.requireEnabledWrapper(underlying);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ShrudShield(address safe,address underlying,uint256 amount,uint48 operatorUntil,uint256 safeNonce)"
                ),
                address(safe),
                underlying,
                amount,
                operatorUntil,
                safe.nonce()
            )
        );
        safe.checkSignatures(
            address(0),
            keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)),
            safeSignatures
        );

        _execFromSafe(underlying, abi.encodeCall(IERC20.approve, (wrapper, amount)));
        _execFromSafe(wrapper, abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (address(safe), amount)));
        _execFromSafe(wrapper, abi.encodeCall(IERC7984.setOperator, (address(this), operatorUntil)));

        emit ShieldExecuted(underlying, wrapper, amount);
        emit OperatorGranted(wrapper, operatorUntil);
    }

    /// @notice Revokes the module's operator role. Threshold-authorised, and always available.
    function revokeOperator(address underlying, bytes calldata safeSignatures) external {
        // Deliberately NOT gated on `requireLive`. Withdrawing authority from shrud must work when
        // shrud is paused — that is precisely when a treasury is most likely to want it.
        address wrapper = assetRegistry.assetOf(underlying).wrapper;

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ShrudRevokeOperator(address safe,address wrapper,uint256 safeNonce)"),
                address(safe),
                wrapper,
                safe.nonce()
            )
        );
        safe.checkSignatures(
            address(0),
            keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)),
            safeSignatures
        );

        _execFromSafe(wrapper, abi.encodeCall(IERC7984.setOperator, (address(this), 0)));
        emit OperatorRevoked(wrapper);
    }

    function _execFromSafe(address to, bytes memory data) private {
        // The guard's post-hook already converts a failed inner call into a revert. This second
        // check is not redundant: it holds even if the Safe's module guard were somehow unset
        // between `_assertInstalled` and here, and it costs one comparison.
        bool ok = safe.execTransactionFromModule(to, 0, data, SafeEnum.Operation.Call);
        if (!ok) revert SafeExecutionFailed();
    }

    // -------------------------------------------------------------------------------------------
    // 5 · Disclosure
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Issues one frozen disclosure capsule, under the Safe's own threshold.
     *
     * @dev THRESHOLD-AUTHORISED BECAUSE DISCLOSURE IS A TREASURY DECISION. A single owner must not
     *      be able to hand a counterparty a solvency report. This is the same bar as moving assets,
     *      and it is the same bar deliberately: a report naming a treasury's positions is, to a
     *      counterparty, worth roughly what the positions are.
     *
     *      THE PERMANENCE WARNING BELONGS AT THE POINT OF SIGNING, NOT IN A TOOLTIP. Nox has no
     *      `removeViewer`, so the viewer keeps this snapshot forever. `ShrudCapsuleFactory` copies
     *      each value into a fresh handle so "forever" applies to a dated snapshot rather than to
     *      the treasury — but the grant itself genuinely cannot be undone, and the capsule builder
     *      says so before the first signature is collected.
     */
    function createCapsule(
        ShrudCapsuleFactory.CapsuleSchema schema,
        address viewer,
        bytes32 subjectId,
        euint256[] calldata liveHandles,
        string[] calldata fieldNames,
        bytes calldata safeSignatures
    ) external returns (bytes32 capsuleId) {
        pauseController.requireLive(ShrudPauseController.Activity.Disclose);
        _assertInstalled();

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ShrudCapsule(address safe,uint8 schema,address viewer,bytes32 subjectId,bytes32 fieldsHash,uint256 safeNonce)"
                ),
                address(safe),
                uint8(schema),
                viewer,
                subjectId,
                keccak256(abi.encode(liveHandles, fieldNames)),
                safe.nonce()
            )
        );
        safe.checkSignatures(
            address(0),
            keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)),
            safeSignatures
        );

        capsuleId = ShrudCapsuleFactory(capsuleFactory).createCapsule(
            address(safe), viewer, schema, subjectId, liveHandles, fieldNames
        );
    }

    // -------------------------------------------------------------------------------------------
    // 5 · Owner-set rotation
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Re-grants live-state handles to the CURRENT owner set after an owner change.
     *
     * @dev THIS IS NOT REVOCATION AND THE INTERFACE MUST NEVER CALL IT THAT. Nox has no
     *      `removeViewer`. A removed owner keeps whatever handles they were granted, permanently.
     *      What rotation changes is which handles are LIVE: everything the dashboard shows from here
     *      on is a fresh handle the removed owner has no grant on, so their access becomes access to
     *      a dated snapshot rather than to the treasury.
     *
     *      The correct words are "live access ended", "future values are not shared", and "this
     *      historical snapshot remains readable". PRD section 6.4 states the same rule.
     *
     *      Permissionless, and gated only on the owner set having actually changed. Requiring a
     *      threshold would mean a Safe that has just removed a compromised owner needs a second
     *      signing round before its future values stop being shared with them.
     */
    function rotateLiveStateViewers() external returns (bytes32 newOwnerSetHash) {
        newOwnerSetHash = currentOwnerSetHash();
        bytes32 previous = _grantedOwnerSetHash;
        if (previous == newOwnerSetHash) revert OwnerSetUnchanged(newOwnerSetHash);
        _grantedOwnerSetHash = newOwnerSetHash;
        emit LiveStateViewersRotated(previous, newOwnerSetHash);
    }

    function currentOwnerSetHash() public view returns (bytes32) {
        return keccak256(abi.encode(safe.getOwners(), safe.getThreshold()));
    }

    function grantedOwnerSetHash() external view returns (bytes32) {
        return _grantedOwnerSetHash;
    }

    /// @notice True when the owner set has moved since the last rotation and live values are stale.
    function rotationRequired() external view returns (bool) {
        return _grantedOwnerSetHash != currentOwnerSetHash();
    }

    // -------------------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------------------

    /**
     * @dev Refuses to act unless the module is enabled AND the shrud guard is the installed module
     *      guard.
     *
     *      THE SECOND CHECK IS THE ONE THAT MATTERS. `setModuleGuard` is a normal Safe transaction,
     *      so a Safe can remove the guard at any time with its own threshold — that is correct and
     *      must stay possible. What must not happen is shrud continuing to operate as though a
     *      boundary existed after it was removed. Reading the guard slot on every privileged entry
     *      point makes "the guard is installed" a live fact rather than an installation-time claim.
     */
    function _assertInstalled() private view {
        if (!safe.isModuleEnabled(address(this))) {
            revert ModuleNotEnabledOnSafe(address(safe), address(this));
        }
        address installed = safe.moduleGuardOf();
        if (installed != moduleGuard) {
            revert ModuleGuardNotInstalled(address(safe), moduleGuard, installed);
        }
    }

    function _grantToCurrentOwners(euint256 handle) private {
        Nox.allowThis(handle);
        address[] memory owners = safe.getOwners();
        for (uint256 i = 0; i < owners.length; ++i) {
            Nox.allow(handle, owners[i]);
        }
    }

    function _grantToCurrentOwners(ebool handle) private {
        Nox.allowThis(handle);
        address[] memory owners = safe.getOwners();
        for (uint256 i = 0; i < owners.length; ++i) {
            Nox.allow(handle, owners[i]);
        }
    }
}
