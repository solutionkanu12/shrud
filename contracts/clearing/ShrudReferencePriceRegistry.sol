// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";
import {ShrudOrderFamily} from "../libraries/ShrudOrderFamily.sol";
import {TickMath} from "../libraries/uniswap/TickMath.sol";

/**
 * @title ShrudReferencePriceRegistry
 * @notice Binds each crossing pair to one fixed, auditable public price method, and records the
 *         exact snapshot an epoch crossed at.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS CONTRACT CARRIES MORE RISK THAN ITS SIZE SUGGESTS
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Internal crossing moves value between treasuries at a price nobody outside can see. If the price
 * is wrong, the transfer is still confidential — it just moves the wrong amount, from a Safe that
 * cannot tell, to a Safe that cannot tell either. There is no slippage check to catch it, because
 * the whole point of crossing is that it never touches a public venue.
 *
 * So the price method is not a parameter. It is fixed in the route manifest, the snapshot records
 * the block, pool, window and cardinality it came from, and every check below fails the epoch
 * CLOSED and PUBLICLY before any private redistribution happens (PRD section 10.11).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE FOUR CONTROLS, AND WHAT EACH ONE ACTUALLY STOPS
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **1 · A time-weighted mean, not a spot price.** `slot0().tick` is whatever the last swap left
 * behind and costs one flash-loaned trade to move. `observe()` returns cumulative ticks, so the
 * arithmetic mean over a window costs the attacker the price impact sustained across that whole
 * window.
 *
 * **2 · Minimum observation history, checked against the ring buffer.** A TWAP window is a promise
 * the pool may not be able to keep. `observe()` reverts with `OLD` when the window predates the
 * oldest stored observation, and a pool with `observationCardinality == 0` — which is the DEFAULT
 * for a freshly created pool, and was true of three of the four Sepolia candidates measured in
 * delta D-8 — has no history at all. shrud reads the oldest observation directly and refuses a
 * window it cannot cover, so the refusal names the cause instead of surfacing as a bare `OLD`.
 *
 * **3 · A bound on how far spot may sit from the mean, expressed in TICKS.** A basis-point bound
 * would need a price to compare against, which means an extra `getSqrtRatioAtTick` per side and a
 * division whose rounding then has to be argued about. Ticks are what the pool actually stores,
 * the relationship is exact (`1.0001^d`), and the comparison is one subtraction. `MAX_TICK_DEVIATION`
 * of 1,000 ticks is about 10.5 percent.
 *
 * **4 · Staleness, checked at USE and not only at capture.** A snapshot taken correctly and then
 * settled against ten minutes later is a stale price with a valid provenance record.
 * `requireFresh` is called by the settlement engine, not by whoever captured it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT `price` MEANS, EXACTLY
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 *     price = raw quote units per raw base unit, multiplied by PRICE_SCALE (1e18)
 *
 * Computed as `getQuoteAtTick(meanTick, PRICE_SCALE, base, quote)` — the quote received for
 * `PRICE_SCALE` raw base units — which is the same number and avoids the rounding-to-zero that
 * asking for one raw base unit would produce.
 *
 * Keeping it in RAW units on both sides means the 6-versus-18 decimal gap between USDC and WETH is
 * absorbed here, once, and never appears again in the encrypted arithmetic. Inside the clearing
 * engine a misplaced decimal factor would be an encrypted, unobservable value transfer between
 * crossed participants — the single worst place in this system for one to hide.
 */
contract ShrudReferencePriceRegistry {
    struct RouteConfig {
        address pool;
        address baseToken;
        address quoteToken;
        /// Seconds of TWAP. The launch route uses 1800.
        uint32 twapWindow;
        /// Seconds of history the pool must already hold. Never less than `twapWindow`.
        uint32 minObservationHistory;
        /// Seconds a snapshot stays usable for settlement.
        uint32 maxStaleness;
        /// Maximum |spotTick - meanTick|.
        int24 maxTickDeviation;
        bool enabled;
    }

    struct Snapshot {
        bytes32 routeId;
        address pool;
        address baseToken;
        address quoteToken;
        uint32 twapWindow;
        int24 arithmeticMeanTick;
        int24 spotTickAtCapture;
        uint16 observationCardinality;
        uint256 price;
        uint64 capturedAtBlock;
        uint64 capturedAtTimestamp;
    }

    /// @notice About 10.5 percent. A hard ceiling no route may be configured above.
    int24 public constant MAX_TICK_DEVIATION_CEILING = 1000;

    /**
     * @notice The delay between queueing a change and being able to apply it.
     *
     * ════════════════════════════════════════════════════════════════════════════════════════
     * WHY THIS IS A DEPLOYMENT PARAMETER AND NOT A CONSTANT
     * ════════════════════════════════════════════════════════════════════════════════════════
     *
     * The delay is the window in which a treasury that disagrees with a queued change can withdraw.
     * On a network holding real value that window has to be long enough for a human to notice, and
     * `MAINNET_MINIMUM_DELAY` is enforced ON CHAIN for chain id 1 — a mainnet deployment cannot
     * choose a shorter one, whatever its deploy script says.
     *
     * On a testnet the same seven days would mean the protocol cannot register its first asset for a
     * week, which makes the deployment untestable and teaches a reviewer nothing about the mechanism.
     * The value is therefore chosen at deployment and RECORDED IN THE MANIFEST, so what a given
     * deployment actually enforces is a published fact rather than an assumption from reading the
     * source of a different one.
     */
    uint256 public immutable registrationDelay;

    /// @notice Seven days. Enforced on chain id 1; advisory everywhere else.
    uint256 public constant MAINNET_MINIMUM_DELAY = 7 days;

    address public immutable governor;

    mapping(bytes32 routeId => RouteConfig) private _routes;
    mapping(bytes32 routeId => uint256 executableAfter) private _queued;
    mapping(bytes32 routeId => RouteConfig) private _queuedConfig;
    mapping(bytes32 snapshotId => Snapshot) private _snapshots;
    bytes32[] private _routeIds;

    event RouteQueued(bytes32 indexed routeId, address indexed pool, uint256 executableAfter);
    event RouteRegistered(
        bytes32 indexed routeId, address indexed pool, address baseToken, address quoteToken, uint32 twapWindow
    );
    event RouteDisabled(bytes32 indexed routeId);
    event PriceFixed(
        bytes32 indexed snapshotId,
        bytes32 indexed routeId,
        int24 arithmeticMeanTick,
        uint256 price,
        uint16 observationCardinality
    );

    error NotGovernor(address caller);
    error GovernorIsZero();
    error DelayBelowMainnetMinimum(uint256 supplied, uint256 minimum);
    error RouteNotRegistered(bytes32 routeId);
    error RouteDisabledError(bytes32 routeId);
    error RouteAlreadyRegistered(bytes32 routeId);
    error RouteNotQueued(bytes32 routeId);
    error RouteNotYetExecutable(bytes32 routeId, uint256 executableAfter);
    error PoolTokensMismatch(address pool, address token0, address token1);
    error TwapWindowIsZero();
    error ObservationHistoryTooShort(uint32 required, uint32 available);
    error NoObservations(address pool);
    error TickDeviationTooLarge(int24 spotTick, int24 meanTick, int24 maximum);
    error DeviationCeilingExceeded(int24 supplied, int24 ceiling);
    error PriceIsZero(bytes32 routeId, int24 meanTick);
    error SnapshotUnknown(bytes32 snapshotId);
    error SnapshotStale(bytes32 snapshotId, uint64 capturedAt, uint32 maxStaleness);

    constructor(address governor_, uint256 registrationDelay_) {
        if (governor_ == address(0)) revert GovernorIsZero();
        if (block.chainid == 1 && registrationDelay_ < MAINNET_MINIMUM_DELAY) {
            revert DelayBelowMainnetMinimum(registrationDelay_, MAINNET_MINIMUM_DELAY);
        }
        governor = governor_;
        registrationDelay = registrationDelay_;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor(msg.sender);
        _;
    }

    // -------------------------------------------------------------------------------------------
    // Route registration
    // -------------------------------------------------------------------------------------------

    function routeIdFor(address baseToken, address quoteToken, address pool)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, baseToken, quoteToken, pool));
    }

    function queueRoute(RouteConfig calldata config) external onlyGovernor returns (bytes32 routeId) {
        routeId = routeIdFor(config.baseToken, config.quoteToken, config.pool);
        if (_routes[routeId].pool != address(0)) revert RouteAlreadyRegistered(routeId);
        if (config.twapWindow == 0) revert TwapWindowIsZero();
        if (config.minObservationHistory < config.twapWindow) {
            revert ObservationHistoryTooShort(config.twapWindow, config.minObservationHistory);
        }
        if (config.maxTickDeviation > MAX_TICK_DEVIATION_CEILING || config.maxTickDeviation <= 0) {
            revert DeviationCeilingExceeded(config.maxTickDeviation, MAX_TICK_DEVIATION_CEILING);
        }

        // The pool must actually hold this pair. Checked here rather than trusted from the config,
        // because a transposed base and quote would invert every crossed price silently.
        (address token0, address token1) =
            (IUniswapV3Pool(config.pool).token0(), IUniswapV3Pool(config.pool).token1());
        bool matches = (token0 == config.baseToken && token1 == config.quoteToken)
            || (token0 == config.quoteToken && token1 == config.baseToken);
        if (!matches) revert PoolTokensMismatch(config.pool, token0, token1);

        _queuedConfig[routeId] = config;
        _queued[routeId] = block.timestamp + registrationDelay;
        emit RouteQueued(routeId, config.pool, block.timestamp + registrationDelay);
    }

    function applyRoute(bytes32 routeId) external {
        uint256 executableAfter = _queued[routeId];
        if (executableAfter == 0) revert RouteNotQueued(routeId);
        if (block.timestamp < executableAfter) revert RouteNotYetExecutable(routeId, executableAfter);
        if (_routes[routeId].pool != address(0)) revert RouteAlreadyRegistered(routeId);

        RouteConfig memory config = _queuedConfig[routeId];
        config.enabled = true;
        _routes[routeId] = config;
        _routeIds.push(routeId);
        delete _queued[routeId];
        delete _queuedConfig[routeId];

        emit RouteRegistered(routeId, config.pool, config.baseToken, config.quoteToken, config.twapWindow);
    }

    function disableRoute(bytes32 routeId) external onlyGovernor {
        if (_routes[routeId].pool == address(0)) revert RouteNotRegistered(routeId);
        _routes[routeId].enabled = false;
        emit RouteDisabled(routeId);
    }

    // -------------------------------------------------------------------------------------------
    // Fixing a price
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Captures the sealed reference price for one route.
     *
     * @dev Permissionless, and it has to be: sealing an epoch is permissionless too, and a price
     *      only a privileged party could fix would be a price that party controls the timing of.
     *      Every check below is public and deterministic, so a caller gains nothing from being the
     *      one to call it — the snapshot is a function of chain state, not of the caller.
     *
     *      EVERY FAILURE HERE IS PUBLIC AND HAPPENS BEFORE ANY PRIVATE REDISTRIBUTION. PRD section
     *      10.11: a stale, malformed or out-of-bounds price fails the epoch closed while every
     *      private handle is still untouched. No confidential asset moves under a price snapshot
     *      that did not pass.
     */
    function fixPrice(bytes32 routeId) external returns (bytes32 snapshotId, uint256 price) {
        RouteConfig memory config = _routes[routeId];
        if (config.pool == address(0)) revert RouteNotRegistered(routeId);
        if (!config.enabled) revert RouteDisabledError(routeId);

        IUniswapV3Pool pool = IUniswapV3Pool(config.pool);

        (, int24 spotTick, uint16 observationIndex, uint16 observationCardinality,,,) = pool.slot0();
        if (observationCardinality == 0) revert NoObservations(config.pool);

        // Control 2. The ring buffer's oldest entry sits at (index + 1) % cardinality; when the
        // buffer has not yet wrapped that slot is uninitialised and index 0 is the oldest.
        uint32 available = _oldestObservationAge(pool, observationIndex, observationCardinality);
        if (available < config.minObservationHistory) {
            revert ObservationHistoryTooShort(config.minObservationHistory, available);
        }

        // Control 1. The arithmetic mean tick over the configured window.
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = config.twapWindow;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int24 meanTick = int24(delta / int56(uint56(config.twapWindow)));
        // Solidity truncates toward zero; Uniswap's own consult() floors. The correction matters
        // only for negative ticks, and only by one tick — but "only one tick" on a crossed amount
        // is still a value transfer, so it is applied rather than waved away.
        if (delta < 0 && (delta % int56(uint56(config.twapWindow)) != 0)) meanTick--;

        // Control 3.
        int24 deviation = spotTick > meanTick ? spotTick - meanTick : meanTick - spotTick;
        if (deviation > config.maxTickDeviation) {
            revert TickDeviationTooLarge(spotTick, meanTick, config.maxTickDeviation);
        }

        price = getQuoteAtTick(
            meanTick, uint128(ShrudOrderFamily.PRICE_SCALE), config.baseToken, config.quoteToken
        );
        if (price == 0) revert PriceIsZero(routeId, meanTick);

        snapshotId = keccak256(
            abi.encode(block.chainid, address(this), routeId, block.number, meanTick, price)
        );
        _snapshots[snapshotId] = Snapshot({
            routeId: routeId,
            pool: config.pool,
            baseToken: config.baseToken,
            quoteToken: config.quoteToken,
            twapWindow: config.twapWindow,
            arithmeticMeanTick: meanTick,
            spotTickAtCapture: spotTick,
            observationCardinality: observationCardinality,
            price: price,
            capturedAtBlock: uint64(block.number),
            capturedAtTimestamp: uint64(block.timestamp)
        });

        emit PriceFixed(snapshotId, routeId, meanTick, price, observationCardinality);
    }

    /// @notice Control 4. Called at settlement, by the settlement engine — never by the capturer.
    function requireFresh(bytes32 snapshotId) external view returns (Snapshot memory snapshot) {
        snapshot = _snapshots[snapshotId];
        if (snapshot.pool == address(0)) revert SnapshotUnknown(snapshotId);
        uint32 maxStaleness = _routes[snapshot.routeId].maxStaleness;
        if (block.timestamp > snapshot.capturedAtTimestamp + maxStaleness) {
            revert SnapshotStale(snapshotId, snapshot.capturedAtTimestamp, maxStaleness);
        }
    }

    // -------------------------------------------------------------------------------------------
    // Price maths
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Quote-token amount received for `baseAmount` of base token at `tick`.
     *
     * @dev Ported from Uniswap's `OracleLibrary.getQuoteAtTick` (v3-periphery, GPL-2.0-or-later),
     *      with `FullMath.mulDiv` replaced by OpenZeppelin's `Math.mulDiv`. They implement the same
     *      512-bit intermediate algorithm; the substitution avoids vendoring a second copy of it,
     *      and OpenZeppelin's is 0.8-native rather than a wrapping-dependent 0.7 file.
     *
     *      The two branches are a precision choice, not a special case: when `sqrtRatioX96` fits in
     *      128 bits, squaring it directly keeps full Q192 precision. When it does not, the square
     *      is taken down to Q128 first so the intermediate cannot overflow.
     */
    function getQuoteAtTick(int24 tick, uint128 baseAmount, address baseToken, address quoteToken)
        public
        pure
        returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);

        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? Math.mulDiv(ratioX192, baseAmount, 1 << 192)
                : Math.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? Math.mulDiv(ratioX128, baseAmount, 1 << 128)
                : Math.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }

    // -------------------------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------------------------

    function routeOf(bytes32 routeId) external view returns (RouteConfig memory) {
        return _routes[routeId];
    }

    function snapshotOf(bytes32 snapshotId) external view returns (Snapshot memory) {
        return _snapshots[snapshotId];
    }

    function routeIds() external view returns (bytes32[] memory) {
        return _routeIds;
    }

    // -------------------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------------------

    function _oldestObservationAge(IUniswapV3Pool pool, uint16 observationIndex, uint16 cardinality)
        private
        view
        returns (uint32 age)
    {
        (uint32 oldestTimestamp,,, bool initialized) =
            pool.observations((uint256(observationIndex) + 1) % cardinality);

        // Before the buffer wraps, slot (index + 1) is uninitialised and slot 0 holds the oldest.
        if (!initialized) {
            (oldestTimestamp,,,) = pool.observations(0);
        }

        // `block.timestamp` is a uint256 and the pool stores uint32; the subtraction is done in the
        // pool's own 32-bit space so it stays correct across the 2106 wrap the pool is built for.
        unchecked {
            age = uint32(block.timestamp) - oldestTimestamp;
        }
    }
}
