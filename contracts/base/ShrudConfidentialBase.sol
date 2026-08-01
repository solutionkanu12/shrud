// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {Nox, ebool, euint16, euint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

import {ShrudPauseController} from "../recovery/ShrudPauseController.sol";

/**
 * @title ShrudConfidentialBase
 * @notice The rules every shrud contract that touches an encrypted handle must obey, in one place
 *         so none can be forgotten and each has exactly one implementation.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * 1 · APPLICATION BINDING IS FREE. CALLER BINDING IS FREE. REPLAY PROTECTION IS NOT.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `Nox.fromExternal` is a library `internal` function, so it inlines into the calling contract and
 * NoxCompute sees `app == this contract` and `owner == this contract's msg.sender`. A proof minted
 * for one shrud contract can never be spent at another, and a proof minted for one owner can never
 * be spent by a different caller. Both are structural.
 *
 * What is NOT structural, verified against `modules/Compute.sol::validateInputProof`
 * (nox-protocol-contracts 0.2.4): the proof check reads the handle's embedded chain id, the TEE
 * type, the 137-byte proof length, `createdAt + proofExpirationDuration`, `app == msg.sender`,
 * `owner`, and the gateway signature — **and nothing else**. There is no nonce and no consumption
 * marker, so a proof stays replayable by its own owner against its own app until it expires.
 *
 * shrud supplies the missing half: every input handle is consumed exactly once per contract, and
 * every submission carries a strictly increasing per-owner nonce. Delta D-6.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * 2 · WHY THERE IS NO `msg.sender == tx.origin` CHECK
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A contract that is a Safe owner cannot mint an input proof for itself: encryption is an EIP-712
 * signature by a key, and the gateway binds `owner` to the signing address. If an EOA signs and a
 * contract relays, `validateInputProof` sees `owner == the EOA` and `msg.sender == the contract`
 * and refuses. The binding already forbids the pattern, so an `tx.origin` check would add a
 * restriction on top of a defence rather than a defence.
 *
 * The honest consequence, recorded as delta D-10: an EIP-1271 contract owner can AUTHORISE every
 * shrud order — that path is the Safe's own `checkSignatures` and is untouched — but cannot
 * ORIGINATE one. `/app/[safe]/security` lists this under known limitations rather than hiding it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * 3 · THE EXACT ACL POLICY
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * For a value owned by one account, shrud grants exactly two things: `allowThis`, so this contract
 * may compute on the handle in a later transaction, and `allow(handle, owner)`, so that owner — and
 * nobody else — may decrypt it.
 *
 * It never calls `addViewer` on a live handle and never calls `allowPublicDecryption` on a private
 * value. Both are PERMANENT: `sdk/Nox.sol` 0.2.4 has no `removeViewer`, no `removeAdmin` and no way
 * to un-set public decryption. `disallowTransient` is the only revocation that exists, and it only
 * undoes a grant that would have expired at the end of the transaction anyway.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * 4 · TRANSIENT ACCESS IS NOT A WEAKER GRANT
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Within the transaction, a recipient holding a transient handle may call `allowPublicDecryption`
 * and publish the value forever, or `allow` a third party permanently. Transient access is
 * therefore a FULL grant with a convenient default expiry, and shrud passes transient handles only
 * to reviewed shrud contracts fixed at deployment.
 * `_assertReviewedTransientRecipient` is the only gate, and each contract supplies its own
 * immutable allowlist.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * 5 · CONFIDENTIAL FAILURE IS NEVER A PUBLIC REASON
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A private shortfall, a failed limit, a route exclusion or a missed privacy floor contributes
 * encrypted zero and emits the same event as success. Public reverts are reserved for public
 * failures: invalid proof, expired proof, replayed handle, wrong nonce, stale epoch, unregistered
 * adapter, unauthorised caller, broken reserve accounting, paused activity.
 *
 * This is the property adversaries attack first, so it is asserted directly in
 * `test/privacy/` rather than assumed from code review.
 */
abstract contract ShrudConfidentialBase {
    /// @dev Schema version of every encrypted layout this release accepts. Part of every binding.
    uint16 internal constant SHRUD_SCHEMA_VERSION = 1;

    ShrudPauseController public immutable pauseController;

    /// @dev Input handles already spent at this contract. The one-shot half Nox does not provide.
    mapping(bytes32 handle => bool) private _handleConsumed;

    /// @dev Next acceptable submission nonce per owner. Strictly increasing, never reused.
    mapping(address owner => uint256) private _nextNonce;

    event HandleConsumed(address indexed owner, bytes32 indexed handle);

    error HandleAlreadyConsumed(bytes32 handle);
    error WrongNonce(address owner, uint256 expected, uint256 supplied);
    error UnreviewedTransientRecipient(address recipient);
    error PauseControllerIsZero();
    error UninitializedHandle();

    constructor(ShrudPauseController pauseController_) {
        if (address(pauseController_) == address(0)) revert PauseControllerIsZero();
        pauseController = pauseController_;
    }

    // -------------------------------------------------------------------------------------------
    // Replay protection — the half Nox leaves to the application
    // -------------------------------------------------------------------------------------------

    /// @dev Marks one input handle spent. Reverts publicly on replay; a replay is a public fault.
    function _consumeHandle(bytes32 handle) internal {
        if (handle == bytes32(0)) revert UninitializedHandle();
        if (_handleConsumed[handle]) revert HandleAlreadyConsumed(handle);
        _handleConsumed[handle] = true;
        emit HandleConsumed(msg.sender, handle);
    }

    function isHandleConsumed(bytes32 handle) external view returns (bool) {
        return _handleConsumed[handle];
    }

    /// @dev Consumes the caller's next nonce. Strictly increasing, so no submission repeats.
    function _consumeNonce(uint256 supplied) internal {
        uint256 expected = _nextNonce[msg.sender];
        if (supplied != expected) revert WrongNonce(msg.sender, expected, supplied);
        _nextNonce[msg.sender] = expected + 1;
    }

    function nextNonce(address owner) external view returns (uint256) {
        return _nextNonce[owner];
    }

    // -------------------------------------------------------------------------------------------
    // Transient handles
    // -------------------------------------------------------------------------------------------

    /// @dev The only gate for handing a transient handle to another contract.
    function _assertReviewedTransientRecipient(address recipient) internal view {
        if (!isReviewedTransientRecipient(recipient)) revert UnreviewedTransientRecipient(recipient);
    }

    /// @dev Implemented by each contract with its own immutable, deployment-time allowlist.
    function isReviewedTransientRecipient(address recipient) public view virtual returns (bool);

    // -------------------------------------------------------------------------------------------
    // The exact grant. Nothing wider, anywhere.
    // -------------------------------------------------------------------------------------------

    function _grantOwnerOnly(euint256 handle, address owner) internal {
        Nox.allowThis(handle);
        Nox.allow(handle, owner);
    }

    function _grantOwnerOnly(euint16 handle, address owner) internal {
        Nox.allowThis(handle);
        Nox.allow(handle, owner);
    }

    function _grantOwnerOnly(ebool handle, address owner) internal {
        Nox.allowThis(handle);
        Nox.allow(handle, owner);
    }

    /// @dev Persist a handle for this contract's own later use. No third party gains anything.
    function _keep(euint256 handle) internal {
        Nox.allowThis(handle);
    }

    function _keep(ebool handle) internal {
        Nox.allowThis(handle);
    }

    function _keep(euint16 handle) internal {
        Nox.allowThis(handle);
    }
}
