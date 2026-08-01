// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IShrudSettlementAdapter} from "../interfaces/IShrudSettlementAdapter.sol";

/**
 * @title IAavePool
 * @notice The two Aave V3 Pool methods this adapter calls.
 *
 * @dev Verified against `aave/core-v3` 1.19.3, `contracts/interfaces/IPool.sol` lines 248 and 287.
 *      Declared rather than imported: `core-v3` pins solc 0.8.10 and pulls in the whole protocol
 *      type graph for two functions.
 */
interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/**
 * @title AaveSupplyAdapter
 * @notice One public pooled Aave position, with every treasury's ownership share confidential.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE ASYMMETRY THAT MAKES THIS WORK
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Aave sees one supplier holding one balance: the shrud position vault. It does not see how many
 * treasuries stand behind it, in what proportion, or when any of them entered. Those live in
 * `ShrudPositionLedger` as encrypted shares.
 *
 * The public number — the pooled position — is genuinely public and shrud does not pretend
 * otherwise. What stays private is the only thing that was ever attributable: whose it is.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * `onBehalfOf` IS THE POSITION VAULT AND IS NEVER A PARAMETER
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Aave mints aTokens to `onBehalfOf`. A caller-supplied `onBehalfOf` would let the aggregate supply
 * of several treasuries mint its aTokens somewhere else — the same class of exploit as a
 * caller-supplied swap recipient, with the added property that the loss would look like a
 * successful supply in every log. It is an immutable, and `settle` refuses any `recipient` that
 * disagrees with it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * `withdraw` IS SEPARATE FROM `settle`, AND DELIBERATELY SO
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `settle` supplies. Withdrawal is a different function with a different caller check, because
 * folding both into one entry point behind a direction flag means the flag becomes the only thing
 * standing between "add to the position" and "take from it". Two functions, two call sites, no
 * flag.
 *
 * Aave's `withdraw` returns the amount ACTUALLY withdrawn, which can be less than requested when the
 * reserve lacks liquidity. That return value is passed back and the settlement engine allocates
 * against it — never against what was asked for.
 */
contract AaveSupplyAdapter is IShrudSettlementAdapter {
    using SafeERC20 for IERC20;

    /// @dev Aave's referral programme is inactive; zero is the documented value for "none".
    uint16 private constant NO_REFERRAL = 0;

    bytes32 private immutable _routeId;
    address private immutable _pool;
    address private immutable _asset;
    address private immutable _aToken;
    address private immutable _positionVault;

    address public immutable settlementEngine;

    event AggregateSupplied(bytes32 indexed epochId, uint256 amount);
    event AggregateWithdrawn(bytes32 indexed epochId, uint256 requested, uint256 received);

    error NotSettlementEngine(address caller);
    error RecipientNotFixed(address supplied, address expected);
    error TokenMismatch(address supplied, address expected);
    error AmountIsZero();
    error DeadlineInThePast(uint256 deadline);
    error NothingSupplied(uint256 amount);

    constructor(
        bytes32 routeId_,
        address pool_,
        address asset_,
        address aToken_,
        address positionVault_,
        address settlementEngine_
    ) {
        _routeId = routeId_;
        _pool = pool_;
        _asset = asset_;
        _aToken = aToken_;
        _positionVault = positionVault_;
        settlementEngine = settlementEngine_;
    }

    /**
     * @notice Supplies the aggregate to Aave, on behalf of the position vault.
     *
     * @dev The output measurement is the aToken balance delta at the position vault, not Aave's
     *      word for it. Aave's aTokens are rebasing and `supply` returns nothing at all, so a
     *      measured delta is the only number available — and it is the right one regardless.
     */
    function settle(SettleParams calldata params) external override returns (uint256 amountOut) {
        if (msg.sender != settlementEngine) revert NotSettlementEngine(msg.sender);
        if (params.recipient != _positionVault) {
            revert RecipientNotFixed(params.recipient, _positionVault);
        }
        if (params.inputToken != _asset) revert TokenMismatch(params.inputToken, _asset);
        if (params.outputToken != _aToken) revert TokenMismatch(params.outputToken, _aToken);
        if (params.amountIn == 0) revert AmountIsZero();
        if (params.deadline < block.timestamp) revert DeadlineInThePast(params.deadline);

        uint256 before = IERC20(_aToken).balanceOf(_positionVault);

        IERC20(_asset).forceApprove(_pool, params.amountIn);
        IAavePool(_pool).supply(_asset, params.amountIn, _positionVault, NO_REFERRAL);
        IERC20(_asset).forceApprove(_pool, 0);

        amountOut = IERC20(_aToken).balanceOf(_positionVault) - before;
        if (amountOut == 0) revert NothingSupplied(params.amountIn);

        // Never hold a balance.
        uint256 leftover = IERC20(_asset).balanceOf(address(this));
        if (leftover != 0) IERC20(_asset).safeTransfer(_positionVault, leftover);

        emit AggregateSupplied(params.epochId, params.amountIn);
    }

    /**
     * @notice Withdraws the aggregate from Aave to the clearing vault.
     *
     * @dev Called by the position vault, which holds the aTokens — Aave burns them from
     *      `msg.sender`, so no other caller could execute this even if the check were absent. The
     *      check is here anyway, because a defence that depends on another protocol's internals is
     *      a defence that changes when that protocol does.
     */
    function withdrawAggregate(bytes32 epochId, uint256 amount, address to)
        external
        returns (uint256 received)
    {
        if (msg.sender != _positionVault) revert NotSettlementEngine(msg.sender);
        if (amount == 0) revert AmountIsZero();
        if (to == address(0)) revert RecipientNotFixed(to, _positionVault);

        // Aave returns the amount ACTUALLY withdrawn, which is less than requested when the reserve
        // is short of liquidity. Everything downstream allocates against this, never against
        // `amount`.
        received = IAavePool(_pool).withdraw(_asset, amount, to);
        emit AggregateWithdrawn(epochId, amount, received);
    }

    function routeId() external view override returns (bytes32) {
        return _routeId;
    }

    function venue() external view override returns (address) {
        return _pool;
    }

    function fixedRecipient() external view override returns (address) {
        return _positionVault;
    }

    function inputToken() external view override returns (address) {
        return _asset;
    }

    function outputToken() external view override returns (address) {
        return _aToken;
    }

    function aToken() external view returns (address) {
        return _aToken;
    }
}
