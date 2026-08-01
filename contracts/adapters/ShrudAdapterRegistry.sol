// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {IShrudSettlementAdapter} from "../interfaces/IShrudSettlementAdapter.sol";

/**
 * @title ShrudAdapterRegistry
 * @notice The finite set of reviewed public venue adapters, and the manifest each was reviewed
 *         against.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY A CODE HASH AND NOT AN ADDRESS
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * An address says which contract shrud intends to call. A runtime code hash says which CODE that
 * address will run. Those are the same thing right up until they are not: a proxy behind a
 * registered address can be upgraded, and an address whose contract self-destructed can be
 * recreated with different code at the same address.
 *
 * `requireEnabledAdapter` re-checks the hash on EVERY settlement, not at registration. A registered
 * adapter whose code has changed fails there, publicly, before the residual is unwrapped — which is
 * the only moment where the check can still prevent something.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE ADAPTER IS ASKED TO AGREE WITH ITS OWN MANIFEST
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * At registration the registry reads `routeId()`, `venue()`, `fixedRecipient()`, `inputToken()` and
 * `outputToken()` from the adapter and compares them with the manifest being registered. A manifest
 * that describes an adapter the adapter does not agree with is the failure that a review process
 * cannot catch, because the reviewer read the manifest.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * DELAYED GOVERNANCE, AND WHY A SAFE MODULE CANNOT ADD A TARGET
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PRD section 9.10: adapter changes require delayed governance, and individual Safe modules cannot
 * add targets. Both hold structurally here — modules have no write path into this contract at all,
 * and the governor's additions are public for `registrationDelay` before they can be applied. Disabling
 * is immediate, because stopping a venue that has gone wrong must never wait for a timer.
 */
contract ShrudAdapterRegistry {
    struct AdapterManifest {
        address adapter;
        /// The runtime code hash at registration. Re-checked on every use.
        bytes32 codeHash;
        /// The public protocol this adapter settles through, e.g. keccak("uniswap-v3").
        bytes32 protocolId;
        /// The specific route, matching `ShrudReferencePriceRegistry`'s route id where one applies.
        bytes32 routeId;
        address venue;
        address inputToken;
        address outputToken;
        address fixedRecipient;
        /// Seconds a settlement transaction may specify as its deadline beyond `block.timestamp`.
        uint32 maxDeadlineWindow;
        /// Basis points below the aggregate minimum that a settlement may NOT go. Always zero at
        /// launch: the aggregate minimum is derived from real private limits, not from a tolerance.
        uint16 slippageToleranceBps;
        bool enabled;
        uint64 registeredAtBlock;
    }

    /**
     * @notice The delay between queueing an adapter and being able to apply it.
     *
     * WHY A DEPLOYMENT PARAMETER AND NOT A CONSTANT. The delay is the window in which a treasury
     * that disagrees with a queued adapter can withdraw. On a network holding real value that window
     * must be long enough for a human to notice, and `MAINNET_MINIMUM_DELAY` is enforced ON CHAIN for
     * chain id 1 — a mainnet deployment cannot choose a shorter one whatever its deploy script says.
     *
     * On a testnet the same seven days would mean the protocol cannot register its first venue for a
     * week, which makes the deployment untestable and teaches a reviewer nothing about the mechanism.
     * The value is chosen at deployment and RECORDED IN THE MANIFEST, so what a given deployment
     * actually enforces is a published fact rather than an assumption from a different one's source.
     */
    uint256 public immutable registrationDelay;

    /// @notice Seven days. Enforced on chain id 1; advisory everywhere else.
    uint256 public constant MAINNET_MINIMUM_DELAY = 7 days;

    /// @notice Zero, and it is a statement rather than a default. See `slippageToleranceBps`.
    uint16 public constant MAX_SLIPPAGE_TOLERANCE_BPS = 0;

    address public immutable governor;

    mapping(address adapter => AdapterManifest) private _manifests;
    mapping(bytes32 routeId => address adapter) private _adapterOfRoute;
    mapping(address adapter => uint256 executableAfter) private _queued;
    mapping(address adapter => AdapterManifest) private _queuedManifest;
    address[] private _adapters;

    event AdapterQueued(address indexed adapter, bytes32 indexed routeId, uint256 executableAfter);
    event AdapterRegistered(
        address indexed adapter, bytes32 indexed routeId, address venue, bytes32 codeHash
    );
    event AdapterDisabled(address indexed adapter);

    error NotGovernor(address caller);
    error GovernorIsZero();
    error DelayBelowMainnetMinimum(uint256 supplied, uint256 minimum);
    error AdapterIsNotAContract(address adapter);
    error AdapterAlreadyRegistered(address adapter);
    error RouteAlreadyServed(bytes32 routeId, address adapter);
    error AdapterNotQueued(address adapter);
    error AdapterNotYetExecutable(address adapter, uint256 executableAfter);
    error AdapterNotRegistered(address adapter);
    error AdapterIsDisabled(address adapter);
    error AdapterCodeHashChanged(address adapter, bytes32 expected, bytes32 actual);
    error ManifestDisagreesWithAdapter(address adapter, string field);
    error SlippageToleranceRefused(uint16 supplied);
    error DeadlineWindowIsZero();

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
    // Registration
    // -------------------------------------------------------------------------------------------

    function queueAdapter(AdapterManifest calldata manifest) external onlyGovernor {
        address adapter = manifest.adapter;
        if (adapter.code.length == 0) revert AdapterIsNotAContract(adapter);
        if (_manifests[adapter].adapter != address(0)) revert AdapterAlreadyRegistered(adapter);
        if (_adapterOfRoute[manifest.routeId] != address(0)) {
            revert RouteAlreadyServed(manifest.routeId, _adapterOfRoute[manifest.routeId]);
        }
        if (manifest.slippageToleranceBps > MAX_SLIPPAGE_TOLERANCE_BPS) {
            revert SlippageToleranceRefused(manifest.slippageToleranceBps);
        }
        if (manifest.maxDeadlineWindow == 0) revert DeadlineWindowIsZero();

        _assertManifestMatchesAdapter(manifest);

        _queuedManifest[adapter] = manifest;
        _queued[adapter] = block.timestamp + registrationDelay;
        emit AdapterQueued(adapter, manifest.routeId, block.timestamp + registrationDelay);
    }

    function applyAdapter(address adapter) external {
        uint256 executableAfter = _queued[adapter];
        if (executableAfter == 0) revert AdapterNotQueued(adapter);
        if (block.timestamp < executableAfter) revert AdapterNotYetExecutable(adapter, executableAfter);
        if (_manifests[adapter].adapter != address(0)) revert AdapterAlreadyRegistered(adapter);

        AdapterManifest memory manifest = _queuedManifest[adapter];

        // Re-checked at apply, not only at queue. Seven days is long enough for a proxy behind the
        // queued address to be upgraded into something the reviewer never saw.
        _assertManifestMatchesAdapter(manifest);

        manifest.codeHash = adapter.codehash;
        manifest.enabled = true;
        manifest.registeredAtBlock = uint64(block.number);

        _manifests[adapter] = manifest;
        _adapterOfRoute[manifest.routeId] = adapter;
        _adapters.push(adapter);
        delete _queued[adapter];
        delete _queuedManifest[adapter];

        emit AdapterRegistered(adapter, manifest.routeId, manifest.venue, manifest.codeHash);
    }

    function disableAdapter(address adapter) external onlyGovernor {
        if (_manifests[adapter].adapter == address(0)) revert AdapterNotRegistered(adapter);
        _manifests[adapter].enabled = false;
        emit AdapterDisabled(adapter);
    }

    // -------------------------------------------------------------------------------------------
    // The gate
    // -------------------------------------------------------------------------------------------

    /// @notice The single check every settlement passes before an adapter is called.
    function requireEnabledAdapter(address adapter)
        external
        view
        returns (AdapterManifest memory manifest)
    {
        manifest = _manifests[adapter];
        if (manifest.adapter == address(0)) revert AdapterNotRegistered(adapter);
        if (!manifest.enabled) revert AdapterIsDisabled(adapter);
        if (adapter.codehash != manifest.codeHash) {
            revert AdapterCodeHashChanged(adapter, manifest.codeHash, adapter.codehash);
        }
    }

    function manifestOf(address adapter) external view returns (AdapterManifest memory) {
        return _manifests[adapter];
    }

    function adapterOfRoute(bytes32 routeId) external view returns (address) {
        return _adapterOfRoute[routeId];
    }

    function adapters() external view returns (address[] memory) {
        return _adapters;
    }

    function queuedAt(address adapter) external view returns (uint256) {
        return _queued[adapter];
    }

    // -------------------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------------------

    function _assertManifestMatchesAdapter(AdapterManifest memory manifest) private view {
        IShrudSettlementAdapter a = IShrudSettlementAdapter(manifest.adapter);
        if (a.routeId() != manifest.routeId) {
            revert ManifestDisagreesWithAdapter(manifest.adapter, "routeId");
        }
        if (a.venue() != manifest.venue) revert ManifestDisagreesWithAdapter(manifest.adapter, "venue");
        if (a.fixedRecipient() != manifest.fixedRecipient) {
            revert ManifestDisagreesWithAdapter(manifest.adapter, "fixedRecipient");
        }
        if (a.inputToken() != manifest.inputToken) {
            revert ManifestDisagreesWithAdapter(manifest.adapter, "inputToken");
        }
        if (a.outputToken() != manifest.outputToken) {
            revert ManifestDisagreesWithAdapter(manifest.adapter, "outputToken");
        }
    }
}
