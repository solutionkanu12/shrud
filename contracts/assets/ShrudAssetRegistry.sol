// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title ShrudAssetRegistry
 * @notice The finite set of public ERC-20s shrud will shield, and the one official ERC-7984 wrapper
 *         for each.
 *
 * WHY A REGISTRY AND NOT A PERMISSIONLESS WRAPPER FACTORY. A confidential balance is only as sound
 * as the reserve behind it. If any address could register a wrapper for USDC, a Safe could be
 * persuaded to shield into a wrapper whose `underlying()` is a look-alike token, and no amount of
 * correct clearing maths downstream would save it. The registry is the point where "this handle is
 * backed by real USDC" becomes checkable, so it is deliberately narrow: one wrapper per underlying,
 * bound by runtime code hash, changeable only through the delay below.
 *
 * WHY REGISTRATION IS DELAYED AND NOT IMMEDIATE. PRD section 9.4 permits either immutability or an
 * explicit delay. shrud takes the delay, because a launch that cannot add its second asset without
 * redeploying every module is not production shaped — but the delay is real: a queued registration
 * is public for `registrationDelay` before it can be applied, which is the window in which a
 * treasury that disagrees can withdraw. Disabling is immediate in the other direction, because
 * refusing new deposits into a wrapper that has gone wrong must never wait.
 */
contract ShrudAssetRegistry {
    /// @notice Public reserve policy for one registered asset.
    struct AssetRecord {
        /// The public ERC-20 backing the confidential balance.
        address underlying;
        /// The one official ERC-7984 wrapper. `wrap` mints 1:1; `unwrap` is two-step.
        address wrapper;
        /// Read from the underlying at registration and frozen. A token that lies about decimals
        /// after registration cannot retroactively change the maths that already ran.
        uint8 decimals;
        /// The wrapper's runtime code hash at registration. Checked on every use.
        bytes32 wrapperCodeHash;
        /// Ceiling on confidential supply. Bounds the blast radius of a wrapper defect.
        uint256 maxConfidentialSupply;
        /// Registered and not disabled.
        bool enabled;
        /// Block at which the record became active. Part of the deployment manifest.
        uint256 activatedAtBlock;
    }

    struct PendingRegistration {
        address underlying;
        address wrapper;
        uint256 maxConfidentialSupply;
        uint256 executableAfter;
    }

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

    /// @notice Holds the queue and the disable switch. A Safe in production, never an EOA.
    address public immutable governor;

    mapping(address underlying => AssetRecord) private _byUnderlying;
    mapping(address wrapper => address underlying) private _underlyingOfWrapper;
    mapping(bytes32 registrationId => PendingRegistration) private _pending;

    address[] private _registeredUnderlyings;

    event RegistrationQueued(
        bytes32 indexed registrationId,
        address indexed underlying,
        address indexed wrapper,
        uint256 executableAfter
    );
    event RegistrationCancelled(bytes32 indexed registrationId);
    event AssetRegistered(
        address indexed underlying, address indexed wrapper, uint8 decimals, bytes32 wrapperCodeHash
    );
    event AssetDisabled(address indexed underlying, address indexed wrapper);

    error NotGovernor(address caller);
    error GovernorIsZero();
    error DelayBelowMainnetMinimum(uint256 supplied, uint256 minimum);
    error UnderlyingIsZero();
    error WrapperIsZero();
    error WrapperIsNotAContract(address wrapper);
    error DuplicateUnderlying(address underlying);
    error WrapperAlreadyBound(address wrapper, address toUnderlying);
    error WrapperUnderlyingMismatch(address wrapper, address declared, address actual);
    error RegistrationNotQueued(bytes32 registrationId);
    error RegistrationNotYetExecutable(bytes32 registrationId, uint256 executableAfter);
    error AssetNotRegistered(address underlying);
    error AssetIsDisabled(address underlying);
    error WrapperCodeHashChanged(address wrapper, bytes32 expected, bytes32 actual);
    error MaxSupplyIsZero();

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
    // Registration: queue, wait, apply
    // -------------------------------------------------------------------------------------------

    function queueRegistration(address underlying, address wrapper, uint256 maxConfidentialSupply)
        external
        onlyGovernor
        returns (bytes32 registrationId)
    {
        if (underlying == address(0)) revert UnderlyingIsZero();
        if (wrapper == address(0)) revert WrapperIsZero();
        if (maxConfidentialSupply == 0) revert MaxSupplyIsZero();
        if (_byUnderlying[underlying].wrapper != address(0)) revert DuplicateUnderlying(underlying);

        address boundTo = _underlyingOfWrapper[wrapper];
        if (boundTo != address(0)) revert WrapperAlreadyBound(wrapper, boundTo);

        registrationId = keccak256(abi.encode(block.chainid, address(this), underlying, wrapper));
        _pending[registrationId] = PendingRegistration({
            underlying: underlying,
            wrapper: wrapper,
            maxConfidentialSupply: maxConfidentialSupply,
            executableAfter: block.timestamp + registrationDelay
        });

        emit RegistrationQueued(registrationId, underlying, wrapper, block.timestamp + registrationDelay);
    }

    function cancelRegistration(bytes32 registrationId) external onlyGovernor {
        if (_pending[registrationId].wrapper == address(0)) revert RegistrationNotQueued(registrationId);
        delete _pending[registrationId];
        emit RegistrationCancelled(registrationId);
    }

    /**
     * @notice Applies a queued registration once its delay has elapsed.
     *
     * @dev Permissionless on purpose. The governor's authority is over WHAT is queued and whether it
     *      is cancelled; making the final step also require the governor would let a queued,
     *      publicly reviewed registration be silently withheld, which turns a transparency mechanism
     *      into a discretionary one.
     */
    function applyRegistration(bytes32 registrationId) external {
        PendingRegistration memory queued = _pending[registrationId];
        if (queued.wrapper == address(0)) revert RegistrationNotQueued(registrationId);
        if (block.timestamp < queued.executableAfter) {
            revert RegistrationNotYetExecutable(registrationId, queued.executableAfter);
        }
        if (_byUnderlying[queued.underlying].wrapper != address(0)) {
            revert DuplicateUnderlying(queued.underlying);
        }
        if (queued.wrapper.code.length == 0) revert WrapperIsNotAContract(queued.wrapper);

        // The wrapper must agree about what it wraps. A wrapper that names a different underlying
        // would mint confidential balances backed by a token nobody checked.
        address actual = IShrudWrapperUnderlying(queued.wrapper).underlying();
        if (actual != queued.underlying) {
            revert WrapperUnderlyingMismatch(queued.wrapper, queued.underlying, actual);
        }

        uint8 decimals_ = IERC20Metadata(queued.underlying).decimals();

        _byUnderlying[queued.underlying] = AssetRecord({
            underlying: queued.underlying,
            wrapper: queued.wrapper,
            decimals: decimals_,
            wrapperCodeHash: queued.wrapper.codehash,
            maxConfidentialSupply: queued.maxConfidentialSupply,
            enabled: true,
            activatedAtBlock: block.number
        });
        _underlyingOfWrapper[queued.wrapper] = queued.underlying;
        _registeredUnderlyings.push(queued.underlying);
        delete _pending[registrationId];

        emit AssetRegistered(queued.underlying, queued.wrapper, decimals_, queued.wrapper.codehash);
    }

    /// @notice Immediate, and deliberately asymmetric with registration. Stopping never waits.
    function disableAsset(address underlying) external onlyGovernor {
        AssetRecord storage record = _byUnderlying[underlying];
        if (record.wrapper == address(0)) revert AssetNotRegistered(underlying);
        record.enabled = false;
        emit AssetDisabled(underlying, record.wrapper);
    }

    // -------------------------------------------------------------------------------------------
    // Reads. Every consumer goes through `requireEnabledWrapper`, not through the raw mapping.
    // -------------------------------------------------------------------------------------------

    /**
     * @notice The single gate every shrud contract uses before touching a confidential asset.
     *
     * @dev Re-checks the runtime code hash on EVERY call, not only at registration. A registered
     *      address whose code has changed is either a proxy that was upgraded or a contract at an
     *      address that was self-destructed and recreated. Neither is a thing shrud can keep
     *      trusting on the strength of a check that ran once, months ago.
     */
    function requireEnabledWrapper(address underlying) external view returns (address wrapper) {
        AssetRecord storage record = _byUnderlying[underlying];
        if (record.wrapper == address(0)) revert AssetNotRegistered(underlying);
        if (!record.enabled) revert AssetIsDisabled(underlying);
        if (record.wrapper.codehash != record.wrapperCodeHash) {
            revert WrapperCodeHashChanged(record.wrapper, record.wrapperCodeHash, record.wrapper.codehash);
        }
        return record.wrapper;
    }

    function assetOf(address underlying) external view returns (AssetRecord memory) {
        return _byUnderlying[underlying];
    }

    function underlyingOfWrapper(address wrapper) external view returns (address) {
        return _underlyingOfWrapper[wrapper];
    }

    function isRegisteredWrapper(address wrapper) external view returns (bool) {
        address underlying = _underlyingOfWrapper[wrapper];
        return underlying != address(0) && _byUnderlying[underlying].enabled;
    }

    function registeredUnderlyings() external view returns (address[] memory) {
        return _registeredUnderlyings;
    }

    function pendingRegistration(bytes32 registrationId)
        external
        view
        returns (PendingRegistration memory)
    {
        return _pending[registrationId];
    }
}

/// @dev The one method `applyRegistration` needs from a wrapper, declared rather than imported so
///      the registry stays free of the Nox compilation surface.
interface IShrudWrapperUnderlying {
    function underlying() external view returns (address);
}
