// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.36;

/**
 * @title TickMath
 * @notice `getSqrtRatioAtTick` from Uniswap V3 Core, vendored.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * PROVENANCE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Copied verbatim from `uniswap/v3-core` 1.0.1, `contracts/libraries/TickMath.sol`, whose own
 * licence header declares GPL-2.0-or-later — compatible with shrud's GPL-3.0-or-later, and carried
 * unchanged at the top of this file. The magic constants, the bit-by-bit order and the rounding-up
 * downcast are UNCHANGED. Any of them would change the price shrud crosses treasuries at.
 *
 * TWO EDITS, BOTH MECHANICAL AND BOTH NECESSARY:
 *
 * 1. `pragma >=0.5.0 <0.8.0` became `0.8.36`, because shrud compiles as one unit at the version
 *    `nox-protocol-contracts` requires.
 * 2. The body is wrapped in `unchecked`. The original was written for a compiler with no automatic
 *    overflow checks and DEPENDS on wrapping: `type(uint256).max / ratio` and the accumulating
 *    `(ratio * constant) >> 128` chain are exact only without them. Leaving the checks on would
 *    make the function revert on perfectly ordinary ticks — a defect that would appear as "the
 *    reference price is unavailable" rather than as an arithmetic error.
 *
 * `getTickAtSqrtRatio` is NOT vendored, because shrud never needs it: the tick comes from
 * `observe()` and never from a sqrt price. Vendoring code that is not called is how a dependency
 * becomes a liability nobody re-reads.
 *
 * Verification: `test/unit/TickMath.t.sol` checks this implementation against known
 * (tick, sqrtRatioX96) pairs including MIN_TICK, MAX_TICK, 0, and the tick 120,482 that the live
 * Sepolia launch pool actually returned.
 */
library TickMath {
    /// @dev The minimum tick that may be passed, computed from log base 1.0001 of 2**-128.
    int24 internal constant MIN_TICK = -887272;
    /// @dev The maximum tick that may be passed.
    int24 internal constant MAX_TICK = -MIN_TICK;

    /// @dev `getSqrtRatioAtTick(MIN_TICK)`.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    /// @dev `getSqrtRatioAtTick(MAX_TICK)`.
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    error TickOutOfBounds(int24 tick);

    /// @notice Calculates sqrt(1.0001^tick) * 2^96 as a Q64.96.
    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            if (absTick > uint256(int256(MAX_TICK))) revert TickOutOfBounds(tick);

            uint256 ratio = absTick & 0x1 != 0
                ? 0xfffcb933bd6fad37aa2d162d1a594001
                : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            if (tick > 0) ratio = type(uint256).max / ratio;

            // Divide by 1<<32 rounding UP, taking Q128.128 to Q128.96. The rounding direction is
            // load-bearing in Uniswap: it keeps getTickAtSqrtRatio(getSqrtRatioAtTick(t)) == t.
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}
