// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

/**
 * @title SafeEnum
 * @notice Safe's own `Enum.Operation`, redeclared rather than imported.
 *
 * Safe's contracts are LGPL-3.0-only and pin `pragma solidity >=0.7.0 <0.9.0`. shrud declares the
 * three-member surface it actually uses instead of vendoring the package: the declaration is what
 * the ABI encoder needs, and `test/fork/SafeInterface.t.sol` checks every selector below against a
 * real Safe 1.5.0 on a Sepolia fork, so a drift is a failing test rather than a silent mismatch.
 */
library SafeEnum {
    enum Operation {
        Call,
        DelegateCall
    }
}

/**
 * @title ISafe
 * @notice The exact Safe 1.5.0 surface shrud depends on. Nothing wider.
 *
 * Verified against `safe-smart-account` 1.5.0:
 * `contracts/interfaces/ISafe.sol`, `contracts/interfaces/IModuleManager.sol`,
 * `contracts/interfaces/IOwnerManager.sol` and `contracts/common/StorageAccessible.sol`.
 *
 * WHY 1.5.0 AND NOT 1.4.1 — delta D-1. `setModuleGuard`, `IModuleGuard.checkModuleTransaction` and
 * `checkAfterModuleExecution` exist only from 1.5.0. Safe 1.4.1's guard covers `execTransaction`
 * and never `execTransactionFromModule`, so a shrud module installed on 1.4.1 would run completely
 * unguarded — the precise risk PRD section 20.2 exists to control. `ShrudModuleFactory` refuses any
 * Safe whose `VERSION()` is not `1.5.0`.
 */
interface ISafe {
    // ---------------------------------------------------------------------------------------
    // Authority
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Reverts unless `signatures` satisfies the Safe's CURRENT threshold over `dataHash`.
     *
     * THE `executor` ARGUMENT IS A SECURITY CHOICE, NOT A FORMALITY — delta D-2. Inside
     * `checkNSignatures`, a `v == 1` "approved hash" signature is accepted when
     * `executor == currentOwner` **even with no on-chain approval**:
     *
     *     if (executor != currentOwner && approvedHashes[currentOwner][dataHash] == 0) revert GS025
     *
     * The legacy `checkSignatures(bytes32,bytes,bytes)` form forwards `msg.sender` as the executor,
     * so calling it from a module would let a relayer who happens to be an owner satisfy one
     * signature of the threshold for free. shrud always passes `address(0)`: only genuinely
     * pre-approved hashes count, and activation cannot be cheapened by who submits it.
     */
    function checkSignatures(address executor, bytes32 dataHash, bytes memory signatures) external view;

    function checkNSignatures(
        address executor,
        bytes32 dataHash,
        bytes memory signatures,
        uint256 requiredSignatures
    ) external view;

    function approvedHashes(address owner, bytes32 messageHash) external view returns (uint256);

    function domainSeparator() external view returns (bytes32);

    // ---------------------------------------------------------------------------------------
    // Owner set. Read live at activation, never copied.
    // ---------------------------------------------------------------------------------------

    function getOwners() external view returns (address[] memory);

    function getThreshold() external view returns (uint256);

    function isOwner(address owner) external view returns (bool);

    // ---------------------------------------------------------------------------------------
    // Module execution
    // ---------------------------------------------------------------------------------------

    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes memory data,
        SafeEnum.Operation operation
    ) external returns (bool success);

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes memory data,
        SafeEnum.Operation operation
    ) external returns (bool success, bytes memory returnData);

    function isModuleEnabled(address module) external view returns (bool);

    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);

    function setModuleGuard(address moduleGuard) external;

    // ---------------------------------------------------------------------------------------
    // Introspection
    // ---------------------------------------------------------------------------------------

    function VERSION() external view returns (string memory);

    function nonce() external view returns (uint256);

    /**
     * @notice Raw storage read.
     *
     * @dev THE ONLY WAY TO READ THE INSTALLED MODULE GUARD. `ModuleManager.getModuleGuard()` is
     *      `internal`, so there is no getter. The guard lives at the fixed slot
     *      `keccak256("module_manager.module_guard.address")` =
     *      0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947, and
     *      `ShrudSafeIntrospection.moduleGuardOf` reads it through here. Verified against
     *      `ModuleManager.sol` 1.5.0 line 65.
     */
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
}

/**
 * @title IModuleGuard
 * @notice Safe 1.5.0's module guard hook pair. `interfaceId == 0x58401ed8`.
 *
 * @dev Both are called by the Safe itself, around `execTransactionFromModule`. `supportsInterface`
 *      is checked by `setModuleGuard` before it will accept a guard, so a guard that does not
 *      answer 0x58401ed8 cannot be installed at all.
 */
interface IModuleGuard {
    function checkModuleTransaction(
        address to,
        uint256 value,
        bytes memory data,
        SafeEnum.Operation operation,
        address module
    ) external returns (bytes32 moduleTxHash);

    function checkAfterModuleExecution(bytes32 txHash, bool success) external;

    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
