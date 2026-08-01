// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

/**
 * @title IUniswapV3Pool
 * @notice The four pool methods shrud's reference-price registry uses. Nothing wider.
 *
 * @dev Declared rather than imported: `@uniswap/v3-core@1.0.1` pins `pragma >=0.5.0 <0.8.0` and its
 *      pool interface pulls in a dozen files shrud never calls. Every selector below is checked
 *      against the live Sepolia launch pool `0xba57efa1…` in `test/fork/UniswapPool.t.sol`, so a
 *      drift is a failing test rather than a silent mismatch.
 */
interface IUniswapV3Pool {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

    function liquidity() external view returns (uint128);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /**
     * @notice Cumulative tick and liquidity values at each `secondsAgos`.
     *
     * @dev REVERTS WITH `OLD` when the requested window predates the oldest stored observation, and
     *      reverts outright when `observationCardinality` is zero. Both are public failures with no
     *      confidential content, which is why `fixPrice` lets them fail the epoch closed rather than
     *      catching them — PRD section 10.11.
     */
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    function observations(uint256 index)
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidityCumulativeX128,
            bool initialized
        );

    /// @notice Grows the observation ring buffer. Permissionless, and required before a TWAP exists.
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}
