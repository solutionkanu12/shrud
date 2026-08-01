// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {ShrudModuleFactory} from "../../contracts/accounts/ShrudModuleFactory.sol";
import {ISafe} from "../../contracts/interfaces/ISafe.sol";
import {ShrudAdapterRegistry} from "../../contracts/adapters/ShrudAdapterRegistry.sol";
import {AaveSupplyAdapter} from "../../contracts/adapters/AaveSupplyAdapter.sol";
import {UniswapResidualAdapter} from "../../contracts/adapters/UniswapResidualAdapter.sol";
import {ShrudAssetRegistry} from "../../contracts/assets/ShrudAssetRegistry.sol";
import {ShrudWrappedAsset} from "../../contracts/assets/wrappers/ShrudWrappedAsset.sol";
import {ShrudClearingEngine} from "../../contracts/clearing/ShrudClearingEngine.sol";
import {ShrudClearingVault} from "../../contracts/clearing/ShrudClearingVault.sol";
import {ShrudReferencePriceRegistry} from "../../contracts/clearing/ShrudReferencePriceRegistry.sol";
import {ShrudCapsuleFactory} from "../../contracts/disclosure/ShrudCapsuleFactory.sol";
import {ShrudIntentBook} from "../../contracts/intents/ShrudIntentBook.sol";
import {ShrudEmergencyExit} from "../../contracts/recovery/ShrudEmergencyExit.sol";
import {ShrudPauseController} from "../../contracts/recovery/ShrudPauseController.sol";
import {ShrudPositionLedger} from "../../contracts/settlement/ShrudPositionLedger.sol";
import {ShrudSettlementEngine} from "../../contracts/settlement/ShrudSettlementEngine.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

/**
 * @title DeploymentTest
 * @notice Stands the ENTIRE protocol up on a Sepolia fork, exactly as `scripts/deploy/` does.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS RATHER THAN A DRY RUN AGAINST A LOCAL NODE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A deployment dry run is a one-off that proves the script worked on the day somebody ran it. This
 * is the same sequence as a regression test, against the REAL Uniswap pool, the REAL Aave pool and
 * the REAL tokens — so the two cycles, the wiring, the registrations and the governance delay are
 * checked on every run rather than the day before a deployment.
 *
 * It also caught what a dry run could not have: `anvil --fork-url` died twice on RPC timeouts while
 * fetching state, which looks exactly like a deployment failure and is not one. Foundry's fork cache
 * makes the same sequence deterministic.
 *
 * Run with:
 *
 *     forge test --match-path 'test/fork/Deployment.t.sol' --fork-url $SEPOLIA_RPC_URL -vv
 */
contract DeploymentTest is Test {
    // From source-lock.json. Re-verified by LiveProtocols.t.sol on every fork run.
    address private constant USDC = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;
    address private constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address private constant AUSDC = 0x16dA4541aD1807f4443d92D26044C1147406EB80;
    address private constant POOL = 0xbA57Efa18073647E5269DB04Ff70B8e26Fd0BEaF;
    address private constant SWAP_ROUTER = 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E;
    address private constant AAVE_POOL = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;

    uint256 private constant DELAY = 6 hours;
    uint24 private constant POOL_FEE = 500;
    uint32 private constant TWAP_WINDOW = 1800;

    address private governor;

    ShrudPauseController private pauseController;
    ShrudAssetRegistry private assetRegistry;
    ShrudAdapterRegistry private adapterRegistry;
    ShrudReferencePriceRegistry private priceRegistry;
    ShrudIntentBook private intentBook;
    ShrudPositionLedger private positionLedger;
    ShrudClearingVault private clearingVault;
    ShrudCapsuleFactory private capsuleFactory;
    ShrudClearingEngine private clearingEngine;
    ShrudSettlementEngine private settlementEngine;
    ShrudModuleFactory private moduleFactory;
    ShrudEmergencyExit private emergencyExit;
    ShrudWrappedAsset private usdcWrapper;
    ShrudWrappedAsset private wethWrapper;

    modifier onFork() {
        if (block.chainid != 11155111) {
            emit log("SKIPPED: not forked from Ethereum Sepolia. Pass --fork-url $SEPOLIA_RPC_URL.");
            return;
        }
        _;
    }

    function setUp() public {
        governor = address(this);
    }

    /**
     * The complete deployment, in the order `scripts/deploy/deploy.ts` uses.
     *
     * BOTH CYCLES ARE RESOLVED BY PREDICTION AND THEN ASSERTED. `vm.computeCreateAddress` is the same
     * function the script's `getContractAddress` computes: a contract address is a pure function of
     * the deployer and a nonce, so a future address is knowable — and a prediction that is used
     * without being checked is a wiring step that fails silently by pointing at nothing.
     */
    function _deployAll() private {
        uint256 nonce = vm.getNonce(address(this));

        // The two forward predictions, computed before anything exists.
        address predictedCapsuleFactory = vm.computeCreateAddress(address(this), nonce + 7);
        address predictedClearingEngine = vm.computeCreateAddress(address(this), nonce + 8);
        address predictedSettlementEngine = vm.computeCreateAddress(address(this), nonce + 9);
        address predictedModuleFactory = vm.computeCreateAddress(address(this), nonce + 10);

        pauseController = new ShrudPauseController(governor);
        assetRegistry = new ShrudAssetRegistry(governor, DELAY);
        adapterRegistry = new ShrudAdapterRegistry(governor, DELAY);
        priceRegistry = new ShrudReferencePriceRegistry(governor, DELAY);
        intentBook = new ShrudIntentBook(address(this));
        positionLedger = new ShrudPositionLedger(pauseController);
        clearingVault = new ShrudClearingVault(assetRegistry, intentBook, pauseController);

        capsuleFactory = new ShrudCapsuleFactory(predictedModuleFactory, pauseController);
        assertEq(address(capsuleFactory), predictedCapsuleFactory, "capsule factory prediction");

        clearingEngine = new ShrudClearingEngine(
            intentBook, clearingVault, priceRegistry, predictedSettlementEngine, pauseController
        );
        assertEq(address(clearingEngine), predictedClearingEngine, "clearing engine prediction");

        settlementEngine = new ShrudSettlementEngine(
            intentBook, clearingEngine, clearingVault, adapterRegistry, priceRegistry, positionLedger, pauseController
        );
        assertEq(address(settlementEngine), predictedSettlementEngine, "settlement engine prediction");

        moduleFactory = new ShrudModuleFactory(
            intentBook, assetRegistry, clearingVault, address(clearingEngine), address(capsuleFactory), pauseController
        );
        assertEq(address(moduleFactory), predictedModuleFactory, "module factory prediction");

        emergencyExit =
            new ShrudEmergencyExit(clearingVault, intentBook, pauseController, address(settlementEngine));

        usdcWrapper = new ShrudWrappedAsset(
            "shrud confidential USDC", "cUSDC", "", IERC20(USDC), 1e6 * 1e9
        );
        wethWrapper = new ShrudWrappedAsset(
            "shrud confidential WETH", "cWETH", "", IERC20(WETH), 1e18 * 1e6
        );

        intentBook.wire(address(clearingEngine), address(settlementEngine), address(moduleFactory));
        clearingVault.wire(
            address(clearingEngine), address(settlementEngine), address(emergencyExit), address(moduleFactory)
        );
        positionLedger.wire(address(settlementEngine));
    }

    function test_theWholeProtocolDeploysAndWires() public onFork {
        _deployAll();

        assertTrue(intentBook.isWired(), "intent book wired");
        assertTrue(clearingVault.isWired(), "clearing vault wired");
        assertTrue(positionLedger.isWired(), "position ledger wired");

        assertTrue(intentBook.isWriter(address(clearingEngine)), "clearing engine may write");
        assertTrue(intentBook.isWriter(address(settlementEngine)), "settlement engine may write");
        assertFalse(intentBook.isWriter(address(this)), "and nobody else may");
    }

    /// Wiring is one-shot. A second chance to install a writer is authority nobody should hold.
    function test_wiringCannotBeRepeated() public onFork {
        _deployAll();

        vm.expectRevert(ShrudIntentBook.AlreadyWired.selector);
        intentBook.wire(address(1), address(2), address(3));

        vm.expectRevert(ShrudClearingVault.AlreadyWired.selector);
        clearingVault.wire(address(1), address(2), address(3), address(4));
    }

    /**
     * THE GOVERNANCE DELAY IS REAL, AND THIS IS WHERE THAT STOPS BEING A CLAIM.
     *
     * Registration is refused before the delay elapses and accepted after. The delay is the window in
     * which a treasury that disagrees with a queued change can withdraw, so a deployment where it
     * were zero would be a deployment where that window does not exist.
     */
    function test_assetRegistrationWaitsOutTheDelayAndThenApplies() public onFork {
        _deployAll();

        assetRegistry.queueRegistration(USDC, address(usdcWrapper), 1e6 * 1e9);
        bytes32 id = keccak256(abi.encode(block.chainid, address(assetRegistry), USDC, address(usdcWrapper)));

        vm.expectRevert(
            abi.encodeWithSelector(
                ShrudAssetRegistry.RegistrationNotYetExecutable.selector, id, block.timestamp + DELAY
            )
        );
        assetRegistry.applyRegistration(id);

        vm.warp(block.timestamp + DELAY + 1);
        assetRegistry.applyRegistration(id);

        assertEq(assetRegistry.requireEnabledWrapper(USDC), address(usdcWrapper), "USDC registered");
        assertTrue(assetRegistry.isRegisteredWrapper(address(usdcWrapper)));
    }

    /**
     * The reference-price route, against the REAL pool.
     *
     * This is the check a local dry run cannot make: `queueRoute` reads `token0()` and `token1()` from
     * the pool and refuses a config that names a pair the pool does not hold. On a chain without the
     * pool it reverts, which looks identical to a bug in the config.
     */
    function test_routeRegistersAgainstTheRealPoolAndFixesAPrice() public onFork {
        _deployAll();

        priceRegistry.queueRoute(
            ShrudReferencePriceRegistry.RouteConfig({
                pool: POOL,
                baseToken: WETH,
                quoteToken: USDC,
                twapWindow: TWAP_WINDOW,
                minObservationHistory: TWAP_WINDOW,
                maxStaleness: 3600,
                maxTickDeviation: 1000,
                enabled: false
            })
        );

        bytes32 routeId = priceRegistry.routeIdFor(WETH, USDC, POOL);
        vm.warp(block.timestamp + DELAY + 1);
        priceRegistry.applyRoute(routeId);

        // And the price actually fixes, from the pool's real observations.
        (bytes32 snapshotId, uint256 price) = priceRegistry.fixPrice(routeId);
        assertGt(price, 0, "a real TWAP price");

        ShrudReferencePriceRegistry.Snapshot memory snapshot = priceRegistry.snapshotOf(snapshotId);
        assertEq(snapshot.pool, POOL);
        assertEq(snapshot.twapWindow, TWAP_WINDOW);
        assertGt(snapshot.observationCardinality, 1, "the pool must have real observation history");

        emit log_named_uint("raw USDC per raw WETH, scaled 1e18", price);
        emit log_named_int("arithmetic mean tick", snapshot.arithmeticMeanTick);
    }

    /// A snapshot is only usable while fresh. Staleness is checked at USE, not at capture.
    function test_priceSnapshotGoesStale() public onFork {
        _deployAll();
        priceRegistry.queueRoute(
            ShrudReferencePriceRegistry.RouteConfig({
                pool: POOL,
                baseToken: WETH,
                quoteToken: USDC,
                twapWindow: TWAP_WINDOW,
                minObservationHistory: TWAP_WINDOW,
                maxStaleness: 3600,
                maxTickDeviation: 1000,
                enabled: false
            })
        );
        bytes32 routeId = priceRegistry.routeIdFor(WETH, USDC, POOL);
        vm.warp(block.timestamp + DELAY + 1);
        priceRegistry.applyRoute(routeId);

        (bytes32 snapshotId,) = priceRegistry.fixPrice(routeId);
        priceRegistry.requireFresh(snapshotId);

        vm.warp(block.timestamp + 3601);
        vm.expectRevert();
        priceRegistry.requireFresh(snapshotId);
    }

    /**
     * All three adapters, registered against their real venues.
     *
     * THREE, NOT ONE, and the registry proves why: it keys one adapter per route id, and each
     * adapter's tokens are constructor immutables. A net buy spends USDC for WETH; a net sell spends
     * WETH for USDC; a supply spends USDC for aUSDC. One contract cannot be all three without taking
     * its direction from the caller, which is the thing the interface exists to forbid.
     */
    function test_allThreeAdaptersDeployAndRegister() public onFork {
        _deployAll();

        bytes32 base = priceRegistry.routeIdFor(WETH, USDC, POOL);
        bytes32 buyRoute = keccak256(abi.encode(base, bytes32("BUY_BASE")));
        bytes32 sellRoute = keccak256(abi.encode(base, bytes32("SELL_BASE")));
        bytes32 supplyRoute = keccak256(abi.encode(base, bytes32("SUPPLY_QUOTE")));

        UniswapResidualAdapter buyAdapter = new UniswapResidualAdapter(
            buyRoute, SWAP_ROUTER, USDC, WETH, address(clearingVault), POOL_FEE, address(settlementEngine)
        );
        UniswapResidualAdapter sellAdapter = new UniswapResidualAdapter(
            sellRoute, SWAP_ROUTER, WETH, USDC, address(clearingVault), POOL_FEE, address(settlementEngine)
        );
        AaveSupplyAdapter aaveAdapter = new AaveSupplyAdapter(
            supplyRoute, AAVE_POOL, USDC, AUSDC, address(positionLedger), address(settlementEngine)
        );

        _queue(address(buyAdapter), buyRoute, SWAP_ROUTER, USDC, WETH, address(clearingVault));
        _queue(address(sellAdapter), sellRoute, SWAP_ROUTER, WETH, USDC, address(clearingVault));
        _queue(address(aaveAdapter), supplyRoute, AAVE_POOL, USDC, AUSDC, address(positionLedger));

        vm.warp(block.timestamp + DELAY + 1);
        adapterRegistry.applyAdapter(address(buyAdapter));
        adapterRegistry.applyAdapter(address(sellAdapter));
        adapterRegistry.applyAdapter(address(aaveAdapter));

        assertEq(adapterRegistry.adapterOfRoute(buyRoute), address(buyAdapter));
        assertEq(adapterRegistry.adapterOfRoute(sellRoute), address(sellAdapter));
        assertEq(adapterRegistry.adapterOfRoute(supplyRoute), address(aaveAdapter));
        assertEq(adapterRegistry.adapters().length, 3);
    }

    /**
     * The registry asks each adapter to agree with its own manifest.
     *
     * A manifest describing an adapter the adapter does not agree with is the failure a review
     * process cannot catch, because the reviewer read the manifest.
     */
    function test_aManifestThatDisagreesWithItsAdapterIsRefused() public onFork {
        _deployAll();

        bytes32 base = priceRegistry.routeIdFor(WETH, USDC, POOL);
        bytes32 route = keccak256(abi.encode(base, bytes32("BUY_BASE")));
        UniswapResidualAdapter adapter = new UniswapResidualAdapter(
            route, SWAP_ROUTER, USDC, WETH, address(clearingVault), POOL_FEE, address(settlementEngine)
        );

        // The manifest claims the output is USDC. The adapter says WETH.
        vm.expectRevert(
            abi.encodeWithSelector(
                ShrudAdapterRegistry.ManifestDisagreesWithAdapter.selector, address(adapter), "outputToken"
            )
        );
        _queue(address(adapter), route, SWAP_ROUTER, USDC, USDC, address(clearingVault));
    }

    /// The one number that must be zero, and the registry enforces it rather than documenting it.
    function test_anySlippageToleranceIsRefused() public onFork {
        _deployAll();

        bytes32 base = priceRegistry.routeIdFor(WETH, USDC, POOL);
        bytes32 route = keccak256(abi.encode(base, bytes32("BUY_BASE")));
        UniswapResidualAdapter adapter = new UniswapResidualAdapter(
            route, SWAP_ROUTER, USDC, WETH, address(clearingVault), POOL_FEE, address(settlementEngine)
        );

        ShrudAdapterRegistry.AdapterManifest memory manifest = _manifest(
            address(adapter), route, SWAP_ROUTER, USDC, WETH, address(clearingVault)
        );
        manifest.slippageToleranceBps = 1; // a single basis point

        vm.expectRevert(abi.encodeWithSelector(ShrudAdapterRegistry.SlippageToleranceRefused.selector, 1));
        adapterRegistry.queueAdapter(manifest);
    }

    /**
     * The module factory refuses an address that is not a Safe 1.5.0 — delta D-1.
     *
     * USDC is a real, deployed contract with no `VERSION()`, so the call reverts inside
     * `requireSupportedVersion`. That is the correct outcome and the reason the check is on the
     * VERSION string rather than on probed behaviour: Safe 1.4.1 does not revert on
     * `setModuleGuard` at all, it silently swallows the call and installs nothing.
     */
    function test_moduleFactoryRefusesSomethingThatIsNotASafe() public onFork {
        _deployAll();
        vm.expectRevert();
        moduleFactory.deployModule(ISafe(USDC));
    }

    // ── helpers ───────────────────────────────────────────────────────────────────────────

    function _manifest(
        address adapter,
        bytes32 routeId,
        address venue,
        address inputToken,
        address outputToken,
        address recipient
    ) private pure returns (ShrudAdapterRegistry.AdapterManifest memory) {
        return ShrudAdapterRegistry.AdapterManifest({
            adapter: adapter,
            codeHash: bytes32(0),
            protocolId: keccak256("shrud.protocol"),
            routeId: routeId,
            venue: venue,
            inputToken: inputToken,
            outputToken: outputToken,
            fixedRecipient: recipient,
            maxDeadlineWindow: 900,
            slippageToleranceBps: 0,
            enabled: false,
            registeredAtBlock: 0
        });
    }

    function _queue(
        address adapter,
        bytes32 routeId,
        address venue,
        address inputToken,
        address outputToken,
        address recipient
    ) private {
        adapterRegistry.queueAdapter(
            _manifest(adapter, routeId, venue, inputToken, outputToken, recipient)
        );
    }

}
