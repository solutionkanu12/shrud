// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

/**
 * @title ShrudPauseController
 * @notice The one emergency switch, with a state machine that cannot walk backwards.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO `Recovered` MEMBER, AND WHY ONE MUST NEVER BE ADDED
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `Halted` is terminal. A guardian who halts the network cannot un-halt it, and there is no
 * governance path that can. That is deliberate and it is the only property that makes the halt
 * worth having: if a guardian key can both stop and restart the network, then a compromised
 * guardian key can stop it, drain nothing, restart it, and leave no evidence that anything
 * happened. A one-way halt turns a compromised guardian into a denial of service — bad, visible,
 * survivable — instead of a silent controller of the protocol.
 *
 * Recovery after `Halted` is per-Safe and runs through `ShrudEmergencyExit`, which needs the
 * Safe's own threshold and touches only that Safe's assets. No global restart exists.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A PAUSE DOES AND DOES NOT STOP
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `Paused` stops NEW value entering: submission, activation, locking, sealing. It does NOT stop a
 * sealed epoch from finishing, and it must not — an epoch halted between "assets locked" and
 * "assets allocated" strands every participant's capital in escrow with no way out but the
 * emergency exit. Settlement of an already-sealed epoch stays open under `Paused` and closes only
 * under `Halted`, where the emergency exit is the intended path.
 *
 * `Halted` stops everything including settlement. `ShrudEmergencyExit` is the only contract that
 * reads `Halted` as permission rather than prohibition.
 */
contract ShrudPauseController {
    enum Activity {
        /// Accepting an encrypted order into a Safe-bound module.
        Submit,
        /// Verifying Safe threshold signatures and locking confidential assets.
        Activate,
        /// Forming a candidate set and fixing a reference price.
        Seal,
        /// Running the confidential clearing operation graph.
        Clear,
        /// Executing a public venue call for a sealed residual.
        Settle,
        /// Creating a frozen disclosure capsule.
        Disclose,
        /// Wrapping public ERC-20 into a confidential balance.
        Shield
    }

    enum State {
        /// Everything permitted.
        Live,
        /// New value refused; sealed epochs still settle.
        Paused,
        /// Everything refused. Terminal. Only `ShrudEmergencyExit` proceeds.
        Halted
    }

    /// @notice The address that may pause and halt. Held by a Safe, never an EOA, in production.
    address public immutable guardian;

    State private _state;

    /// @dev Per-activity pause, so a single misbehaving path can be closed without stopping the rest.
    mapping(Activity => bool) private _activityPaused;

    event Paused(address indexed guardian, uint256 atTimestamp);
    event ActivityPaused(address indexed guardian, Activity indexed activity, uint256 atTimestamp);
    event Halted(address indexed guardian, uint256 atTimestamp, string reason);

    error NotGuardian(address caller);
    error GuardianIsZero();
    error AlreadyHalted();
    error ActivityIsPaused(Activity activity);
    error NetworkIsPaused();
    error NetworkIsHalted();
    error NetworkIsNotHalted();

    constructor(address guardian_) {
        if (guardian_ == address(0)) revert GuardianIsZero();
        guardian = guardian_;
        _state = State.Live;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);
        _;
    }

    // -------------------------------------------------------------------------------------------
    // Transitions. Live -> Paused -> Halted, one direction only.
    // -------------------------------------------------------------------------------------------

    function pause() external onlyGuardian {
        if (_state == State.Halted) revert AlreadyHalted();
        _state = State.Paused;
        emit Paused(msg.sender, block.timestamp);
    }

    function pauseActivity(Activity activity) external onlyGuardian {
        if (_state == State.Halted) revert AlreadyHalted();
        _activityPaused[activity] = true;
        emit ActivityPaused(msg.sender, activity, block.timestamp);
    }

    /// @notice Terminal. There is no counterpart, by design. See the contract header.
    function halt(string calldata reason) external onlyGuardian {
        if (_state == State.Halted) revert AlreadyHalted();
        _state = State.Halted;
        emit Halted(msg.sender, block.timestamp, reason);
    }

    // -------------------------------------------------------------------------------------------
    // Assertions. Every one reverts PUBLICLY — a pause is a public fact, not a confidential one.
    // -------------------------------------------------------------------------------------------

    /// @dev The gate for anything that brings NEW value in.
    function requireLive(Activity activity) external view {
        if (_state == State.Halted) revert NetworkIsHalted();
        if (_state == State.Paused) revert NetworkIsPaused();
        if (_activityPaused[activity]) revert ActivityIsPaused(activity);
    }

    /**
     * @dev The gate for finishing work already begun. Permitted under `Paused` deliberately: an
     *      epoch stopped between locking and allocation strands capital in escrow, and stranding
     *      capital is a worse outcome than letting a sealed, price-fixed epoch complete.
     */
    function requireNotHalted(Activity activity) external view {
        if (_state == State.Halted) revert NetworkIsHalted();
        if (_activityPaused[activity]) revert ActivityIsPaused(activity);
    }

    /// @dev The emergency exit's gate. The only place `Halted` reads as permission.
    function requireHalted() external view {
        if (_state != State.Halted) revert NetworkIsNotHalted();
    }

    function state() external view returns (State) {
        return _state;
    }

    function isActivityPaused(Activity activity) external view returns (bool) {
        return _activityPaused[activity];
    }
}
