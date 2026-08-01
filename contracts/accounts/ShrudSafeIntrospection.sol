// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {ISafe} from "../interfaces/ISafe.sol";

/**
 * @title ShrudSafeIntrospection
 * @notice Reads the two facts about a Safe that Safe itself does not expose.
 */
library ShrudSafeIntrospection {
    /**
     * @dev `keccak256("module_manager.module_guard.address")`.
     *
     * VERIFIED against `safe-smart-account` 1.5.0,
     * `contracts/base/ModuleManager.sol` line 65, where the constant is declared with the same
     * comment. It is quoted here rather than recomputed because a recomputation in a different file
     * is a second source of truth, and the two could drift.
     */
    bytes32 internal constant MODULE_GUARD_STORAGE_SLOT =
        0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;

    /// @dev The one version shrud installs on. Delta D-1.
    string internal constant REQUIRED_SAFE_VERSION = "1.5.0";

    error SafeVersionUnsupported(address safe, string version, string required);
    error ModuleGuardSlotMalformed(address safe, uint256 length);

    /**
     * @notice Returns the module guard installed on `safe`, or the zero address.
     *
     * @dev `ModuleManager.getModuleGuard()` is `internal`, so there is no getter and this raw
     *      storage read is the only way to answer the question on chain. `getStorageAt(offset,
     *      length)` returns `length` 32-byte words starting at `offset`, so one word is 32 bytes.
     */
    function moduleGuardOf(ISafe safe) internal view returns (address guard) {
        bytes memory word = safe.getStorageAt(uint256(MODULE_GUARD_STORAGE_SLOT), 1);
        if (word.length != 32) revert ModuleGuardSlotMalformed(address(safe), word.length);
        assembly ("memory-safe") {
            guard := mload(add(word, 32))
        }
    }

    /**
     * @notice Reverts unless the Safe is exactly version 1.5.0.
     *
     * @dev THIS IS THE D-1 GATE AND IT IS NOT A PREFERENCE. `setModuleGuard` does not exist before
     *      1.5.0, and Safe 1.4.1's transaction guard covers `execTransaction` and never
     *      `execTransactionFromModule`. Installing on 1.4.1 would produce a module with unlimited
     *      authority over the Safe and no guard at all — quietly, because everything else would
     *      appear to work.
     *
     *      Compared as a hash rather than with a version parser. A range check would have to decide
     *      what "1.6.0" means before 1.6.0 exists, and guessing that a future Safe keeps a storage
     *      slot and a hook signature unchanged is exactly the kind of assumption this codebase
     *      refuses to make. When a new Safe version ships, it gets read and then added here.
     */
    function requireSupportedVersion(ISafe safe) internal view {
        string memory version = safe.VERSION();
        if (keccak256(bytes(version)) != keccak256(bytes(REQUIRED_SAFE_VERSION))) {
            revert SafeVersionUnsupported(address(safe), version, REQUIRED_SAFE_VERSION);
        }
    }
}
