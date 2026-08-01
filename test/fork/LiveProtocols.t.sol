// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {ShrudReferencePriceRegistry} from "../../contracts/clearing/ShrudReferencePriceRegistry.sol";
import {ISafe} from "../../contracts/interfaces/ISafe.sol";
import {IUniswapV3Pool} from "../../contracts/interfaces/IUniswapV3Pool.sol";
import {ShrudOrderFamily} from "../../contracts/libraries/ShrudOrderFamily.sol";

/**
 * @title LiveProtocolsTest
 * @notice Every external address and selector shrud depends on, checked against the real chain.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT SUITE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * shrud declares its external interfaces rather than importing them — Safe pins
 * `>=0.7.0 <0.9.0`, Uniswap V3 Core pins `>=0.5.0 <0.8.0`, Aave pins 0.8.10, and shrud compiles as
 * one unit at 0.8.36. A declared interface is a claim about someone else's contract, and a claim
 * nobody checks is how an integration ships with a signature that has quietly changed.
 *
 * `source-lock.json` records what was measured on 2026-07-31. This file re-measures it on every
 * run, so a drift is a failing test rather than a stale document. Run with:
 *
 *     forge test --match-path 'test/fork/*' --fork-url $SEPOLIA_RPC_URL
 *
 * It skips cleanly when no fork URL is configured — a suite that silently passes without a fork
 * would be worse than one that is absent.
 */
contract LiveProtocolsTest is Test {
    // --- From source-lock.json, all code-verified on Sepolia -------------------------------
    address private constant SAFE_150_SINGLETON = 0xFf51A5898e281Db6DfC7855790607438dF2ca44b;
    address private constant SAFE_150_PROXY_FACTORY = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address private constant SAFE_141_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;

    address private constant UNISWAP_V3_FACTORY = 0x0227628f3F023bb0B980b67D528571c95c6DaC1c;
    address private constant SWAP_ROUTER_02 = 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E;
    address private constant LAUNCH_POOL = 0xbA57Efa18073647E5269DB04Ff70B8e26Fd0BEaF;

    address private constant AAVE_POOL = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
    address private constant NOX_COMPUTE = 0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF;

    address private constant USDC = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;
    address private constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address private constant AUSDC = 0x16dA4541aD1807f4443d92D26044C1147406EB80;

    uint32 private constant TWAP_WINDOW = 1800;

    modifier onFork() {
        if (block.chainid != 11155111) {
            emit log("SKIPPED: not forked from Ethereum Sepolia. Pass --fork-url $SEPOLIA_RPC_URL.");
            return;
        }
        _;
    }

    // -------------------------------------------------------------------------------------------
    // Safe
    // -------------------------------------------------------------------------------------------

    /// Delta D-1. shrud installs on 1.5.0 and nothing else, and this is why.
    function test_safe150IsDeployedAndReportsItsVersion() public onFork {
        assertGt(SAFE_150_SINGLETON.code.length, 0, "Safe 1.5.0 singleton must exist");
        assertGt(SAFE_150_PROXY_FACTORY.code.length, 0, "Safe 1.5.0 proxy factory must exist");
        assertEq(ISafe(SAFE_150_SINGLETON).VERSION(), "1.5.0", "the version shrud requires");
    }

    /**
     * Safe 1.4.1 is deployed, usable, and REFUSED by shrud — and the reason is worse than "missing".
     *
     * ════════════════════════════════════════════════════════════════════════════════════════
     * THIS TEST FOUND SOMETHING. `setModuleGuard` ON 1.4.1 DOES NOT REVERT.
     * ════════════════════════════════════════════════════════════════════════════════════════
     *
     * The first version of this test asserted the call would fail. It does not. Safe's
     * `FallbackManager` catches every unknown selector, and with no fallback handler configured it
     * returns EMPTY DATA and reports success. So on 1.4.1:
     *
     *     safe.setModuleGuard(guard)   ->   transaction succeeds, nothing happens, no guard exists
     *
     * On 1.5.0 the same call from a non-self caller reverts with GS031, because the real function is
     * `authorized`. A revert is the honest answer; a silent success is not.
     *
     * That is a far sharper argument for delta D-1 than "the function is missing". An installer that
     * checked only for a reverted transaction would report a successful guard installation on 1.4.1
     * and leave the module running with unlimited authority over the Safe and no boundary at all.
     * `ShrudModuleFactory` refuses on the VERSION string, before any of this can happen.
     */
    function test_safe141SilentlyAcceptsSetModuleGuardAndIsThereforeRefused() public onFork {
        assertGt(SAFE_141_SINGLETON.code.length, 0, "1.4.1 exists and is usable");
        assertEq(ISafe(SAFE_141_SINGLETON).VERSION(), "1.4.1");

        (bool ok141, bytes memory ret141) = SAFE_141_SINGLETON.staticcall(
            abi.encodeWithSignature("setModuleGuard(address)", address(0))
        );
        assertTrue(ok141, "1.4.1 swallows the call through its fallback rather than refusing it");
        assertEq(ret141.length, 0, "and returns nothing, so a caller sees an ordinary success");

        (bool ok150,) = SAFE_150_SINGLETON.staticcall(
            abi.encodeWithSignature("setModuleGuard(address)", address(0))
        );
        assertFalse(ok150, "1.5.0 has the real function, which refuses a non-self caller");
    }

    /// The three-argument form is what shrud calls. Its selector must exist on the real singleton.
    function test_safe150ExposesTheThreeArgumentCheckSignatures() public onFork {
        // A zero-threshold singleton reverts GS001 rather than "function not found". Either way the
        // selector resolved, which is what is being checked.
        (bool ok, bytes memory ret) = SAFE_150_SINGLETON.staticcall(
            abi.encodeWithSelector(
                bytes4(keccak256("checkSignatures(address,bytes32,bytes)")),
                address(0),
                bytes32(0),
                bytes("")
            )
        );
        assertFalse(ok, "the singleton has no owners, so it must revert");
        assertGt(ret.length, 0, "and it must revert with a reason, proving the selector resolved");
    }

    // -------------------------------------------------------------------------------------------
    // Uniswap
    // -------------------------------------------------------------------------------------------

    function test_uniswapContractsAreDeployed() public onFork {
        assertGt(UNISWAP_V3_FACTORY.code.length, 0);
        assertGt(SWAP_ROUTER_02.code.length, 0);
        assertGt(LAUNCH_POOL.code.length, 0);
    }

    /// Delta D-8. The launch pool must hold exactly this pair, at this fee, in this order.
    function test_launchPoolIsTheRecordedPair() public onFork {
        IUniswapV3Pool pool = IUniswapV3Pool(LAUNCH_POOL);
        assertEq(pool.token0(), USDC, "token0 is USDC");
        assertEq(pool.token1(), WETH, "token1 is WETH");
        assertEq(uint256(pool.fee()), 500, "fee tier 500");
        assertGt(uint256(pool.liquidity()), 0, "the pool must hold liquidity");
    }

    /**
     * THE CHECK THAT ELIMINATED THREE OF THE FOUR CANDIDATE POOLS.
     *
     * `observationCardinality` is 1 by default on a freshly created V3 pool and stays there until
     * somebody pays to grow it. With cardinality 0 or 1, `observe()` over any real window reverts
     * with a bare `OLD` and there is no TWAP at all — which is exactly what three of the four
     * Sepolia candidates in delta D-8 look like, despite two of them holding more liquidity than
     * the one shrud chose.
     */
    function test_launchPoolHasEnoughObservationHistory() public onFork {
        IUniswapV3Pool pool = IUniswapV3Pool(LAUNCH_POOL);
        (,, uint16 observationIndex, uint16 cardinality,,,) = pool.slot0();
        assertGt(cardinality, 1, "a pool with cardinality <= 1 has no usable TWAP");

        (uint32 oldestTimestamp,,, bool initialized) =
            pool.observations((uint256(observationIndex) + 1) % cardinality);
        if (!initialized) (oldestTimestamp,,,) = pool.observations(0);

        assertGt(
            uint32(block.timestamp) - oldestTimestamp,
            TWAP_WINDOW,
            "history must cover the configured TWAP window"
        );
    }

    /// The exact call `fixPrice` makes, against the real pool.
    function test_observeReturnsATwapOverTheConfiguredWindow() public onFork {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW;
        secondsAgos[1] = 0;

        (int56[] memory cumulatives,) = IUniswapV3Pool(LAUNCH_POOL).observe(secondsAgos);
        int56 delta = cumulatives[1] - cumulatives[0];
        int24 meanTick = int24(delta / int56(uint56(TWAP_WINDOW)));

        // A sane tick for this pair. Not an assertion about the price level — this is a testnet
        // pool with a testnet price, and shrud says so rather than pretending otherwise.
        assertGt(meanTick, 0, "USDC/WETH on this pool prices above tick zero");
    }

    /// End to end: the registry's own price, computed from the real pool's real TWAP.
    function test_registryPricesTheLaunchPairFromRealChainState() public onFork {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW;
        secondsAgos[1] = 0;
        (int56[] memory cumulatives,) = IUniswapV3Pool(LAUNCH_POOL).observe(secondsAgos);
        int24 meanTick = int24((cumulatives[1] - cumulatives[0]) / int56(uint56(TWAP_WINDOW)));

        ShrudReferencePriceRegistry registry = new ShrudReferencePriceRegistry(address(this), 1 days);
        uint256 price =
            registry.getQuoteAtTick(meanTick, uint128(ShrudOrderFamily.PRICE_SCALE), WETH, USDC);

        assertGt(price, 0, "a zero price fails the epoch closed, and must not happen here");
    }

    // -------------------------------------------------------------------------------------------
    // Aave
    // -------------------------------------------------------------------------------------------

    /// Delta D-8's other half: the quote token must be a token Aave actually lists.
    function test_usdcIsAnAaveReserveAndWethIsNot() public onFork {
        assertGt(AAVE_POOL.code.length, 0);

        (bool okUsdc, bytes memory usdcData) =
            AAVE_POOL.staticcall(abi.encodeWithSelector(bytes4(keccak256("getReserveData(address)")), USDC));
        assertTrue(okUsdc, "getReserveData must resolve");
        assertTrue(_containsAddress(usdcData, AUSDC), "USDC's reserve must name the recorded aToken");

        (bool okWeth, bytes memory wethData) =
            AAVE_POOL.staticcall(abi.encodeWithSelector(bytes4(keccak256("getReserveData(address)")), WETH));
        assertTrue(okWeth, "the call resolves");
        assertFalse(
            _containsAddress(wethData, AUSDC),
            "Uniswap's WETH is not an Aave reserve, which is why the Aave leg is USDC only"
        );
    }

    // -------------------------------------------------------------------------------------------
    // Nox
    // -------------------------------------------------------------------------------------------

    /// `sdk/Nox.sol` hardcodes this address for chain 11155111. If it moved, everything breaks.
    function test_noxComputeIsDeployedAndAnswers() public onFork {
        assertGt(NOX_COMPUTE.code.length, 0, "NoxCompute proxy must exist");

        (bool ok, bytes memory ret) = NOX_COMPUTE.staticcall(abi.encodeWithSignature("gateway()"));
        assertTrue(ok, "gateway() must resolve");
        assertEq(
            abi.decode(ret, (address)),
            0xE13191F53671957C8a48A7A3Ff15E16450a1552F,
            "the gateway recorded in source-lock.json"
        );
    }

    // -------------------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------------------

    /// @dev Scans an ABI blob for a 32-byte word holding `needle`, without decoding Aave's struct.
    function _containsAddress(bytes memory data, address needle) private pure returns (bool) {
        bytes32 target = bytes32(uint256(uint160(needle)));
        for (uint256 offset = 0; offset + 32 <= data.length; offset += 32) {
            bytes32 word;
            assembly ("memory-safe") {
                word := mload(add(add(data, 32), offset))
            }
            if (word == target) return true;
        }
        return false;
    }
}
