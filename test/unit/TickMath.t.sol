// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {ShrudReferencePriceRegistry} from "../../contracts/clearing/ShrudReferencePriceRegistry.sol";
import {TickMath} from "../../contracts/libraries/uniswap/TickMath.sol";

/**
 * @title TickMathTest
 * @notice Proves the vendored port is the same function Uniswap ships.
 *
 * A vendored library is a liability the moment nobody checks it still agrees with its source. The
 * two edits made when vendoring — the pragma, and wrapping the body in `unchecked` — are exactly the
 * kind that produce a function which compiles, returns plausible numbers, and is subtly wrong for
 * negative ticks or near the bounds.
 *
 * The vectors below are Uniswap's own published constants plus the tick the LIVE Sepolia launch pool
 * returned on 2026-07-31. If this file passes, the price shrud crosses treasuries at is the price
 * Uniswap would compute.
 */
contract TickMathTest is Test {
    ShrudReferencePriceRegistry private registry;

    // The launch pair, from source-lock.json.
    address private constant USDC = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;
    address private constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    function setUp() public {
        registry = new ShrudReferencePriceRegistry(address(this), 1 days);
    }

    /// Uniswap's own MIN_SQRT_RATIO, declared as `getSqrtRatioAtTick(MIN_TICK)`.
    function test_minTickMatchesUniswapConstant() public pure {
        assertEq(
            uint256(TickMath.getSqrtRatioAtTick(TickMath.MIN_TICK)),
            uint256(TickMath.MIN_SQRT_RATIO),
            "MIN_TICK must produce MIN_SQRT_RATIO"
        );
    }

    /// Uniswap's own MAX_SQRT_RATIO. The `type(uint256).max / ratio` inversion runs only here.
    function test_maxTickMatchesUniswapConstant() public pure {
        assertEq(
            uint256(TickMath.getSqrtRatioAtTick(TickMath.MAX_TICK)),
            uint256(TickMath.MAX_SQRT_RATIO),
            "MAX_TICK must produce MAX_SQRT_RATIO"
        );
    }

    /// sqrt(1.0001^0) * 2^96 == 2^96 exactly.
    function test_zeroTickIsExactlyQ96() public pure {
        assertEq(uint256(TickMath.getSqrtRatioAtTick(0)), 1 << 96, "tick 0 must be exactly 2^96");
    }

    /**
     * The tick the live Sepolia launch pool returned for a 1800-second TWAP on 2026-07-31.
     *
     * The expected value was computed independently, by replaying the published algorithm in a
     * separate implementation rather than by running this one — so agreement means two
     * implementations agree, not that one implementation is self-consistent.
     */
    function test_livePoolTickReproducesMeasuredSqrtPrice() public pure {
        assertEq(
            uint256(TickMath.getSqrtRatioAtTick(120482)),
            32732725556913782187452051720199,
            "tick 120482 must reproduce the independently computed sqrtPriceX96"
        );
    }

    /// The whole point of a tick: price is strictly increasing in it.
    function testFuzz_monotonic(int24 a, int24 b) public pure {
        a = int24(bound(int256(a), TickMath.MIN_TICK, TickMath.MAX_TICK - 1));
        b = int24(bound(int256(b), int256(a) + 1, TickMath.MAX_TICK));
        assertLt(
            uint256(TickMath.getSqrtRatioAtTick(a)),
            uint256(TickMath.getSqrtRatioAtTick(b)),
            "a higher tick must always mean a higher sqrt price"
        );
    }

    /**
     * `unchecked` is required, and this is the assertion that says so.
     *
     * Every tick in range must return without reverting. With the `unchecked` block removed, the
     * accumulating `(ratio * constant) >> 128` chain and the `type(uint256).max / ratio` inversion
     * trip Solidity's overflow checks on perfectly ordinary ticks — and the failure would surface as
     * "the reference price is unavailable" rather than as an arithmetic error.
     */
    function testFuzz_neverRevertsInRange(int24 tick) public pure {
        tick = int24(bound(int256(tick), TickMath.MIN_TICK, TickMath.MAX_TICK));
        uint160 ratio = TickMath.getSqrtRatioAtTick(tick);
        assertGe(uint256(ratio), uint256(TickMath.MIN_SQRT_RATIO));
        assertLe(uint256(ratio), uint256(TickMath.MAX_SQRT_RATIO));
    }

    /**
     * @dev Goes through a harness contract rather than calling the library directly.
     *
     * `getSqrtRatioAtTick` is `internal`, so solc inlines it into whatever calls it — including this
     * test. `vm.expectRevert` needs the revert to happen at a lower call depth than the cheatcode,
     * and an inlined function has no depth of its own. Without the harness the test fails with
     * "call didn't revert at a lower depth", which reads like a broken assertion rather than a
     * broken test, and is the kind of thing that gets deleted instead of fixed.
     */
    function test_outOfBoundsTickReverts() public {
        TickMathHarness harness = new TickMathHarness();
        vm.expectRevert(
            abi.encodeWithSelector(TickMath.TickOutOfBounds.selector, TickMath.MAX_TICK + 1)
        );
        harness.sqrtRatioAt(TickMath.MAX_TICK + 1);
    }

    // -------------------------------------------------------------------------------------------
    // getQuoteAtTick — the decimal-gap absorber
    // -------------------------------------------------------------------------------------------

    /**
     * The launch pair's price, end to end, against the independently computed number.
     *
     * `getQuoteAtTick(120482, 1e18, WETH, USDC)` is raw USDC per raw WETH, scaled by 1e18. WETH's
     * address sorts ABOVE USDC's, so this exercises the `1<<192 / ratioX192` branch — the one that
     * inverts, and therefore the one a transposed base and quote would silently break.
     */
    function test_launchPairPriceMatchesIndependentComputation() public view {
        uint256 price = registry.getQuoteAtTick(120482, 1e18, WETH, USDC);
        assertEq(price, 5858613244027, "raw USDC per raw WETH, scaled by 1e18");

        // Sanity in human units: 1 WETH (1e18 wei) costs price/1e18 * 1e18 raw USDC.
        uint256 usdcPerWeth = (price * 1e18) / 1e18 / 1e6;
        assertEq(usdcPerWeth, 5858613, "a testnet price, and stated as one");
    }

    /**
     * Transposing base and quote must invert the price, not shift it.
     *
     * This is the check that catches the single worst class of error in this file's neighbourhood:
     * a swapped base and quote produces a number that looks like a price, passes every bound, and
     * moves value between crossed treasuries in the wrong direction.
     */
    function test_transposingBaseAndQuoteInvertsThePrice() public view {
        uint256 usdcPerWeth = registry.getQuoteAtTick(120482, 1e18, WETH, USDC);
        uint256 wethPerUsdc = registry.getQuoteAtTick(120482, 1e18, USDC, WETH);

        // Their product is 1e36 up to rounding in both directions.
        uint256 product = (usdcPerWeth * wethPerUsdc) / 1e18;
        assertApproxEqRel(product, 1e18, 1e12, "inverse prices must multiply back to one");
    }
}

/// @dev Gives the internal library an external call frame, so `expectRevert` has a depth to catch.
contract TickMathHarness {
    function sqrtRatioAt(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(tick);
    }
}
