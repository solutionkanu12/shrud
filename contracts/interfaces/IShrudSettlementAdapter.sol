// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

/**
 * @title IShrudSettlementAdapter
 * @notice The narrow, fixed-target interface every public venue adapter implements.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT AN ADAPTER IS NOT ALLOWED TO BE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PRD section 3.2.5 forbids arbitrary calldata, delegatecall and user-selected adapter targets, and
 * this interface is the shape that makes those impossible rather than discouraged.
 *
 * There is no `bytes data` parameter. There is no target address in `SettleParams`. There is no
 * command array, no route encoding, no fee recipient and no callback registration. An adapter's
 * venue, its permitted selectors and its recipient rule are constructor immutables, verified
 * against `ShrudAdapterRegistry` before the settlement engine will call it.
 *
 * The reason is not defensive tidiness. An adapter is called by a contract holding the aggregate
 * residual of several treasuries, in the one moment of the whole lifecycle where a plaintext amount
 * exists. A `bytes data` parameter at that moment is a general-purpose call from a vault.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE RECIPIENT IS NOT A PARAMETER EITHER
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `SettleParams` names a recipient so the engine's intent is explicit and appears in the trace, but
 * every adapter checks it against its own immutable and reverts on any other value. A recipient the
 * caller could choose is the whole exploit: the output of a correctly priced, correctly bounded swap
 * sent somewhere else.
 */
interface IShrudSettlementAdapter {
    struct SettleParams {
        /// The sealed epoch this settlement belongs to. Consumed once by the engine.
        bytes32 epochId;
        address inputToken;
        address outputToken;
        /// The publicly decrypted `residualAggregateInput`, already transferred to this adapter.
        uint256 amountIn;
        /// The publicly decrypted `residualAggregateMinimum`.
        uint256 minAmountOut;
        /// Always the clearing vault or the position vault. Checked against an immutable.
        address recipient;
        uint256 deadline;
    }

    /**
     * @notice Executes one fixed public venue call.
     *
     * @dev The return value is what the ADAPTER believes it produced. The settlement engine ignores
     *      it and measures the recipient's balance delta instead — see
     *      `ShrudSettlementEngine._settleResidual`. A venue that reported an output it did not
     *      deliver, or an adapter with a defect in its own accounting, is caught by the measurement
     *      and not by the report.
     */
    function settle(SettleParams calldata params) external returns (uint256 amountOut);

    /// @notice The route this adapter serves. Must equal its registry entry.
    function routeId() external view returns (bytes32);

    /// @notice The one venue contract this adapter ever calls.
    function venue() external view returns (address);

    /// @notice The one address this adapter will ever send output to.
    function fixedRecipient() external view returns (address);

    function inputToken() external view returns (address);

    function outputToken() external view returns (address);
}
