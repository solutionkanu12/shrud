// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IShrudSettlementAdapter} from "../interfaces/IShrudSettlementAdapter.sol";

/**
 * @title IV3SwapRouter
 * @notice The one SwapRouter02 method this adapter calls.
 *
 * @dev Declared rather than imported: `uniswap/swap-router-contracts` pins `pragma >=0.7.5` and
 *      pulls in the whole periphery. NOTE that SwapRouter02's `ExactInputSingleParams` has **no
 *      `deadline` field** — the deadline moved out of the params struct when SwapRouter02 replaced
 *      SwapRouter, and passing the old seven-field struct silently misaligns every argument after
 *      `recipient`. Verified against `swap-router-contracts` 1.3.1
 *      `contracts/interfaces/IV3SwapRouter.sol`.
 */
interface IV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/**
 * @title UniswapResidualAdapter
 * @notice One aggregate exact-input swap for the unmatched side of a clearing epoch. Nothing else.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS ADAPTER NEVER SEES
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * It never receives a Safe address, an intent id, a per-treasury amount, a side, a limit, or a
 * count of participants. It receives an aggregate input, an aggregate minimum, and a recipient it
 * then refuses to honour unless it equals its own immutable.
 *
 * That is the whole boundary. Uniswap sees a swap. It cannot see whose.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY DEGREE OF FREEDOM IS REMOVED, INCLUDING THE ONES THAT LOOK HARMLESS
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `tokenIn`, `tokenOut`, `fee` and `recipient` are constructor immutables, not parameters. So is the
 * router. `sqrtPriceLimitX96` is hard-wired to zero, which in Uniswap means "no limit" and is
 * correct here because the real bound is `amountOutMinimum` — a private-limit-derived number the
 * engine computed, not a price the caller picked.
 *
 * The one thing that looks harmless and is not: **`amountIn == 0` is refused.** SwapRouter02
 * documents that "setting `amountIn` to 0 will cause the contract to look up its own balance, and
 * swap the entire amount". A zero-input settlement would therefore not be a no-op — it would sweep
 * whatever this adapter happened to be holding. PRD invariant 21.3.8 says a public venue is never
 * called for an encrypted-zero residual; this is the line that makes the invariant hold even if a
 * caller reached here anyway.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * UNUSED INPUT RETURNS TO THE VAULT
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `exactInputSingle` should consume the whole input, but "should" is not an accounting policy. The
 * adapter sweeps any input token left on itself back to the vault in the same transaction, so it
 * never accumulates a balance — which is also what makes the `amountIn == 0` sweep behaviour above
 * unable to find anything worth sweeping.
 *
 * The approval is set to exactly `amountIn` and reset to zero afterwards, so no standing allowance
 * survives the call.
 */
contract UniswapResidualAdapter is IShrudSettlementAdapter {
    using SafeERC20 for IERC20;

    bytes32 private immutable _routeId;
    address private immutable _router;
    address private immutable _inputToken;
    address private immutable _outputToken;
    address private immutable _fixedRecipient;
    uint24 private immutable _fee;

    /// @notice The settlement engine. The only caller this adapter accepts.
    address public immutable settlementEngine;

    event ResidualSwapped(
        bytes32 indexed epochId, uint256 amountIn, uint256 minAmountOut, uint256 amountOut
    );

    error NotSettlementEngine(address caller);
    error RecipientNotFixed(address supplied, address expected);
    error TokenMismatch(address supplied, address expected);
    error AmountInIsZero();
    error MinAmountOutIsZero();
    error DeadlineInThePast(uint256 deadline);
    error OutputBelowMinimum(uint256 amountOut, uint256 minAmountOut);

    constructor(
        bytes32 routeId_,
        address router_,
        address inputToken_,
        address outputToken_,
        address fixedRecipient_,
        uint24 fee_,
        address settlementEngine_
    ) {
        _routeId = routeId_;
        _router = router_;
        _inputToken = inputToken_;
        _outputToken = outputToken_;
        _fixedRecipient = fixedRecipient_;
        _fee = fee_;
        settlementEngine = settlementEngine_;
    }

    /// @inheritdoc IShrudSettlementAdapter
    function settle(SettleParams calldata params) external override returns (uint256 amountOut) {
        if (msg.sender != settlementEngine) revert NotSettlementEngine(msg.sender);
        if (params.recipient != _fixedRecipient) {
            revert RecipientNotFixed(params.recipient, _fixedRecipient);
        }
        if (params.inputToken != _inputToken) revert TokenMismatch(params.inputToken, _inputToken);
        if (params.outputToken != _outputToken) {
            revert TokenMismatch(params.outputToken, _outputToken);
        }
        // See the header: zero would make SwapRouter02 sweep this adapter's own balance.
        if (params.amountIn == 0) revert AmountInIsZero();
        if (params.minAmountOut == 0) revert MinAmountOutIsZero();
        if (params.deadline < block.timestamp) revert DeadlineInThePast(params.deadline);

        IERC20 input = IERC20(_inputToken);
        input.forceApprove(_router, params.amountIn);

        amountOut = IV3SwapRouter(_router).exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: _inputToken,
                tokenOut: _outputToken,
                fee: _fee,
                recipient: _fixedRecipient,
                amountIn: params.amountIn,
                amountOutMinimum: params.minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );

        // No standing allowance survives this call.
        input.forceApprove(_router, 0);

        // The router enforces `amountOutMinimum` itself. Checking again costs one comparison and
        // means a future router whose enforcement changed could not quietly weaken shrud's.
        if (amountOut < params.minAmountOut) revert OutputBelowMinimum(amountOut, params.minAmountOut);

        // Never hold a balance. See the header.
        uint256 leftover = input.balanceOf(address(this));
        if (leftover != 0) input.safeTransfer(_fixedRecipient, leftover);

        emit ResidualSwapped(params.epochId, params.amountIn, params.minAmountOut, amountOut);
    }

    function routeId() external view override returns (bytes32) {
        return _routeId;
    }

    function venue() external view override returns (address) {
        return _router;
    }

    function fixedRecipient() external view override returns (address) {
        return _fixedRecipient;
    }

    function inputToken() external view override returns (address) {
        return _inputToken;
    }

    function outputToken() external view override returns (address) {
        return _outputToken;
    }

    function poolFee() external view returns (uint24) {
        return _fee;
    }
}
