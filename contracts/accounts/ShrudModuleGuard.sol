// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {IERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";
import {IERC20ToERC7984Wrapper} from
    "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC20ToERC7984Wrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

import {ShrudAssetRegistry} from "../assets/ShrudAssetRegistry.sol";
import {IModuleGuard, SafeEnum} from "../interfaces/ISafe.sol";
import {ShrudPauseController} from "../recovery/ShrudPauseController.sol";

/**
 * @title ShrudModuleGuard
 * @notice The fixed execution boundary around every Safe-triggered shrud action.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT A SAFE MODULE ACTUALLY IS, AND WHY THIS CONTRACT EXISTS
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Safe's own documentation puts the warning in the source: *"Modules are a security risk since they
 * can execute arbitrary transactions... A malicious module can completely take over a Safe."* An
 * enabled module may call `execTransactionFromModule(to, value, data, operation)` with ANY target,
 * ANY calldata, ANY value, and `operation == DelegateCall` — which would run arbitrary code in the
 * Safe's own storage context.
 *
 * The module guard is the only thing standing between "shrud is installed" and "shrud can do
 * anything". It is not a nicety, and it is why shrud refuses Safe 1.4.1, where module guards do not
 * exist (delta D-1).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * ONE GUARD PER MODULE, BOTH ADDRESSES IMMUTABLE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PRD section 24.1 specifies one guard per module, and binding both the Safe and the module as
 * constructor immutables is what makes the checks below tight rather than approximate: this guard
 * cannot be reused, cannot be repointed, and answers `checkModuleTransaction` for exactly one
 * (Safe, module) pair. Every deployment shares one runtime code hash, so verification is still a
 * single hash comparison — only the constructor arguments differ, and those are in the manifest.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE ALLOWLIST IS (TARGET, SELECTOR, ARGUMENT SHAPE) — NOT TARGET, AND NOT SELECTOR
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A target allowlist alone is not enough: `wrap(to, amount)` on a registered wrapper is a perfectly
 * legitimate call that mints a confidential balance TO AN ARBITRARY ADDRESS. A selector allowlist
 * alone is not enough either, for the mirror reason. Each of the four permitted calls therefore has
 * its arguments decoded and checked:
 *
 *   approve(spender, amount)    spender MUST be the registered wrapper for this exact underlying
 *   wrap(to, amount)            to MUST be the bound Safe — never a third party
 *   setOperator(operator, until) operator MUST be the bound module or a revocation
 *   unwrap(from, to, amount)    from AND to MUST both be the bound Safe
 *
 * Everything else reverts. Delegatecall reverts. Non-zero value reverts.
 */
contract ShrudModuleGuard is IModuleGuard {
    /// @notice Safe 1.5.0's `IModuleGuard` interface id, quoted from `ModuleManager.sol` line 44.
    bytes4 private constant MODULE_GUARD_INTERFACE_ID = 0x58401ed8;
    bytes4 private constant ERC165_INTERFACE_ID = 0x01ffc9a7;

    /// @notice The one Safe this guard answers for.
    address public immutable safe;

    /// @notice The one module this guard permits.
    address public immutable module;

    ShrudAssetRegistry public immutable assetRegistry;
    ShrudPauseController public immutable pauseController;

    /**
     * @dev The hash of the call currently mid-flight.
     *
     * WHY TRANSIENT STORAGE. `checkModuleTransaction` and `checkAfterModuleExecution` are two calls
     * in one transaction, and the value must not survive it. Persistent storage would leave a
     * dangling pending hash if a later step reverted in a way that skipped the post-hook, and the
     * next transaction would inherit it. Transient storage (EIP-1153) is cleared at the end of the
     * transaction by the EVM, which is exactly the lifetime this needs.
     */
    bytes32 private transient _pendingTxHash;

    /**
     * @dev Strictly increasing, so two identical module calls in one block produce different
     *      hashes. Persistent rather than transient on purpose: the hash is what an indexer and
     *      `pnpm verify:live` key a guarded call on, so it has to be reproducible from chain state
     *      after the fact rather than only inside the transaction that made it.
     */
    uint256 public checkedCount;

    event ModuleTransactionChecked(bytes32 indexed moduleTxHash, address indexed to, bytes4 selector);

    error CallerIsNotTheBoundSafe(address caller, address expected);
    error ModuleIsNotBound(address module, address expected);
    error DelegateCallForbidden();
    error ValueTransferForbidden(uint256 value);
    error CalldataTooShort(uint256 length);
    error TargetNotAllowed(address to);
    error SelectorNotAllowedForTarget(address to, bytes4 selector);
    error ApproveSpenderMustBeRegisteredWrapper(address spender, address expected);
    error WrapRecipientMustBeSafe(address recipient, address expected);
    error OperatorMustBeBoundModule(address operator, address expected);
    error UnwrapPartyMustBeSafe(address party, address expected);
    error NoPendingModuleTransaction();
    error PendingModuleTransactionMismatch(bytes32 expected, bytes32 actual);
    error ModuleExecutionFailed(bytes32 moduleTxHash);
    error SafeIsZero();
    error ModuleIsZero();

    constructor(
        address safe_,
        address module_,
        ShrudAssetRegistry assetRegistry_,
        ShrudPauseController pauseController_
    ) {
        if (safe_ == address(0)) revert SafeIsZero();
        if (module_ == address(0)) revert ModuleIsZero();
        safe = safe_;
        module = module_;
        assetRegistry = assetRegistry_;
        pauseController = pauseController_;
    }

    /// @inheritdoc IModuleGuard
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == MODULE_GUARD_INTERFACE_ID || interfaceId == ERC165_INTERFACE_ID;
    }

    /**
     * @notice The pre-execution gate. Called by the Safe, before it executes the module's call.
     *
     * @dev `msg.sender` is the SAFE, not the module. Safe calls
     *      `IModuleGuard(guard).checkModuleTransaction(...)` from inside `preModuleExecution`, so
     *      binding on `msg.sender == safe` is what stops anyone else calling this guard to plant a
     *      pending hash the real post-hook would then accept.
     */
    function checkModuleTransaction(
        address to,
        uint256 value,
        bytes memory data,
        SafeEnum.Operation operation,
        address module_
    ) external override returns (bytes32 moduleTxHash) {
        if (msg.sender != safe) revert CallerIsNotTheBoundSafe(msg.sender, safe);
        if (module_ != module) revert ModuleIsNotBound(module_, module);

        // A shrud module never delegatecalls and never moves ether. Both are absolute.
        if (operation != SafeEnum.Operation.Call) revert DelegateCallForbidden();
        if (value != 0) revert ValueTransferForbidden(value);

        pauseController.requireNotHalted(ShrudPauseController.Activity.Shield);

        if (data.length < 4) revert CalldataTooShort(data.length);
        bytes4 selector = _selectorOf(data);

        _checkCall(to, selector, data);

        uint256 sequence = checkedCount;
        checkedCount = sequence + 1;

        moduleTxHash =
            keccak256(abi.encode(block.chainid, safe, module, to, keccak256(data), sequence));
        _pendingTxHash = moduleTxHash;

        emit ModuleTransactionChecked(moduleTxHash, to, selector);
    }

    /**
     * @notice The post-execution gate.
     *
     * @dev TURNS A SILENT FAILURE INTO A REVERT, WHICH IS THE WHOLE REASON IT IS NOT A NO-OP.
     *      `execTransactionFromModule` does NOT revert when the inner call fails — it returns
     *      `false` and emits `ExecutionFromModuleFailure`. A module that ignores the return value
     *      would proceed as if a wrap had happened when it had not, and the mismatch would surface
     *      much later as a reserve discrepancy nobody could trace back. Reverting here makes the
     *      failure loud and local.
     */
    function checkAfterModuleExecution(bytes32 txHash, bool success) external override {
        if (msg.sender != safe) revert CallerIsNotTheBoundSafe(msg.sender, safe);

        bytes32 pending = _pendingTxHash;
        if (pending == bytes32(0)) revert NoPendingModuleTransaction();
        if (pending != txHash) revert PendingModuleTransactionMismatch(pending, txHash);
        _pendingTxHash = bytes32(0);

        if (!success) revert ModuleExecutionFailed(txHash);
    }

    // -------------------------------------------------------------------------------------------
    // The allowlist
    // -------------------------------------------------------------------------------------------

    function _checkCall(address to, bytes4 selector, bytes memory data) private view {
        // --- Path 1: approve a registered wrapper to pull a registered underlying -------------
        if (selector == IERC20.approve.selector) {
            // `to` must be a registered underlying, and the spender must be ITS wrapper. Checking
            // "spender is some registered wrapper" would let a Safe approve the USDC wrapper to
            // spend its WETH, which is not a thing any shrud flow needs and is a thing a mistake
            // could produce.
            address wrapper = assetRegistry.requireEnabledWrapper(to);
            (address spender,) = _decodeAddressUint(data);
            if (spender != wrapper) revert ApproveSpenderMustBeRegisteredWrapper(spender, wrapper);
            return;
        }

        // Everything below targets a wrapper.
        if (!assetRegistry.isRegisteredWrapper(to)) revert TargetNotAllowed(to);

        // --- Path 2: wrap public ERC-20 into a confidential balance held BY THE SAFE ----------
        if (selector == IERC20ToERC7984Wrapper.wrap.selector) {
            (address recipient,) = _decodeAddressUint(data);
            if (recipient != safe) revert WrapRecipientMustBeSafe(recipient, safe);
            return;
        }

        // --- Path 3: grant or revoke the module's operator role -------------------------------
        if (selector == IERC7984.setOperator.selector) {
            (address operator,) = _decodeAddressUint(data);
            // The wrapper itself bounds `until` and refuses EOA operators; this guard bounds WHO.
            // A revocation is `setOperator(module, 0)`, which passes the same check.
            if (operator != module) revert OperatorMustBeBoundModule(operator, module);
            return;
        }

        // --- Path 4: request an unwrap, from the Safe, to the Safe ----------------------------
        if (selector == bytes4(keccak256("unwrap(address,address,bytes32)"))) {
            (address from, address unwrapTo) = _decodeAddressAddress(data);
            if (from != safe) revert UnwrapPartyMustBeSafe(from, safe);
            if (unwrapTo != safe) revert UnwrapPartyMustBeSafe(unwrapTo, safe);
            return;
        }

        revert SelectorNotAllowedForTarget(to, selector);
    }

    /// @dev The leading four bytes of a `bytes memory` blob. `bytes4(data)` is not a legal
    ///      conversion from memory — only from a calldata slice — so this is the memory form.
    function _selectorOf(bytes memory data) private pure returns (bytes4 selector) {
        assembly ("memory-safe") {
            selector := and(mload(add(data, 32)), 0xffffffff00000000000000000000000000000000000000000000000000000000)
        }
    }

    /// @dev Decodes `(address, uint256)` from `data[4:]` without copying the whole calldata blob.
    function _decodeAddressUint(bytes memory data) private pure returns (address a, uint256 b) {
        if (data.length < 4 + 64) revert CalldataTooShort(data.length);
        assembly ("memory-safe") {
            a := and(mload(add(data, 36)), 0xffffffffffffffffffffffffffffffffffffffff)
            b := mload(add(data, 68))
        }
    }

    /// @dev Decodes the first two `address` arguments from `data[4:]`.
    function _decodeAddressAddress(bytes memory data) private pure returns (address a, address b) {
        if (data.length < 4 + 64) revert CalldataTooShort(data.length);
        assembly ("memory-safe") {
            a := and(mload(add(data, 36)), 0xffffffffffffffffffffffffffffffffffffffff)
            b := and(mload(add(data, 68)), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }
}
