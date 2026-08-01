// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {ebool, euint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

/**
 * @title IShrudClearingVault
 * @notice The surface a Safe-bound module needs from the clearing vault.
 *
 * @dev Declared as an interface rather than imported as a contract so `ShrudSafeModule` does not
 *      pull the whole vault into its own compilation dependency graph — the module is deployed once
 *      per Safe and its size matters. `pnpm verify:abi` compares these declarations against the
 *      compiled vault artifact, selectors and return shapes both, so a drift is a failing check
 *      rather than a runtime surprise.
 */
interface IShrudClearingVault {
    /**
     * @notice Confirms a lock the module has just performed, and hands the vault the handles.
     *
     * @param intentId the order whose assets are now in epoch escrow
     * @param lockedAmount ISOLATED handle for the amount actually moved. Encrypted zero when the
     *        Safe's confidential balance did not cover the order — which is indistinguishable from
     *        a genuine zero, deliberately.
     * @param lockSuccess ISOLATED encrypted boolean. Readable by the Safe's current owners and by
     *        nobody else.
     */
    function confirmLock(bytes32 intentId, euint256 lockedAmount, ebool lockSuccess) external;

    /// @notice Escrowed balance for one intent. Only the clearing engine may compute on it.
    function escrowOf(bytes32 intentId) external view returns (euint256);

    /// @notice Returns the confidential refund of an unsealed, cancelled order to its Safe.
    function refundCancelled(bytes32 intentId) external;
}
