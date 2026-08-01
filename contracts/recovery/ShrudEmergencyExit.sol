// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {ShrudClearingVault} from "../clearing/ShrudClearingVault.sol";
import {ISafe} from "../interfaces/ISafe.sol";
import {ShrudIntentBook} from "../intents/ShrudIntentBook.sol";
import {ShrudPauseController} from "./ShrudPauseController.sol";

/**
 * @title ShrudEmergencyExit
 * @notice The way out. Safe-authorised, per-treasury, and unable to reach anyone else's assets.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE THING THIS CONTRACT MUST NOT BE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * An emergency exit is the most attractive contract in any protocol to compromise, because its
 * entire purpose is moving other people's assets under unusual conditions. Every design decision
 * below is about making the compromise worthless rather than unlikely:
 *
 *   - Every function needs the OWNING SAFE's own threshold signature. Not a guardian's, not a
 *     governor's, not this contract's. A compromised shrud deployment cannot exit a treasury that
 *     did not sign.
 *   - Assets return to the Safe that locked them and to no other address. There is no destination
 *     parameter anywhere in this file.
 *   - `PRD section 9.15`: emergency exit cannot bypass Safe authority or claim another Safe's
 *     assets. Both hold structurally, not by review.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * TWO DOORS, AND THEY OPEN UNDER DIFFERENT CONDITIONS
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **Halted-network exit.** When the guardian has halted shrud — a terminal, one-way state — a Safe
 * may reclaim any confirmed, unreleased escrow. This is the path for "shrud itself has gone wrong".
 *
 * **Timed-out-epoch exit.** When an epoch was verified for settlement and no venue call succeeded
 * within `ShrudSettlementEngine.SETTLEMENT_TIMEOUT_BLOCKS`, anyone may declare it recoverable and
 * each participating Safe may reclaim its escrow. This is the path for "the keeper stopped and my
 * capital is sitting in escrow", and it deliberately does NOT require the network to be halted:
 * a treasury waiting on a stalled epoch should not also have to wait for a guardian to decide the
 * whole network is broken.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS CONTRACT CANNOT DO, AND WHY THAT IS CORRECT
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * It cannot disable the module or remove the guard. Those are `execTransaction` on the Safe with
 * the Safe's own threshold — `disableModule` and `setModuleGuard(address(0))` — and routing them
 * through shrud would mean the way to remove shrud goes through shrud. A treasury's escape hatch
 * must not depend on the thing it is escaping from. The runbook documents the two Safe transactions
 * and the app builds them, but no shrud contract is on that path.
 */
contract ShrudEmergencyExit {
    ShrudClearingVault public immutable clearingVault;
    ShrudIntentBook public immutable intentBook;
    ShrudPauseController public immutable pauseController;
    address public immutable settlementEngine;

    mapping(bytes32 intentId => bool) private _exited;

    event EmergencyExitExecuted(
        bytes32 indexed intentId, address indexed safe, bytes32 indexed epochId, bytes32 reason
    );

    error AlreadyExited(bytes32 intentId);
    error NotTheOwningSafe(address caller, address safe);
    error EpochNotRecoverable(bytes32 epochId, ShrudIntentBook.EpochStatus status);
    error IntentNotInAnEpoch(bytes32 intentId);
    error SignaturesRequired();

    constructor(
        ShrudClearingVault clearingVault_,
        ShrudIntentBook intentBook_,
        ShrudPauseController pauseController_,
        address settlementEngine_
    ) {
        clearingVault = clearingVault_;
        intentBook = intentBook_;
        pauseController = pauseController_;
        settlementEngine = settlementEngine_;
    }

    /**
     * @notice Door one — the network is halted. Reclaims one intent's escrow to its own Safe.
     *
     * @dev The Safe's threshold is checked against a digest binding the chain, this contract, the
     *      Safe and the intent. `executor` is `address(0)` for the same reason it is everywhere else
     *      in shrud (delta D-2): a relayer who happens to be an owner must not get a free signature,
     *      and an emergency path is the last place to relax that.
     */
    function exitHalted(bytes32 intentId, bytes calldata safeSignatures) external {
        pauseController.requireHalted();

        ShrudIntentBook.IntentHeader memory header = intentBook.headerOf(intentId);
        _authorise(header, intentId, "halted", safeSignatures);

        if (_exited[intentId]) revert AlreadyExited(intentId);
        _exited[intentId] = true;

        clearingVault.emergencyRelease(intentId);
        emit EmergencyExitExecuted(intentId, header.safe, header.epochId, "halted");
    }

    /**
     * @notice Door two — the epoch timed out. Reclaims one intent's escrow to its own Safe.
     *
     * @dev Requires the epoch to be `Recoverable`, which `ShrudSettlementEngine.declareTimedOut`
     *      sets and which also marks the epoch consumed — so a keeper that comes back cannot settle
     *      an epoch whose participants have already left. Without that ordering the protocol would
     *      pay the same escrow out twice.
     */
    function exitTimedOut(bytes32 intentId, bytes calldata safeSignatures) external {
        ShrudIntentBook.IntentHeader memory header = intentBook.headerOf(intentId);
        if (header.epochId == bytes32(0)) revert IntentNotInAnEpoch(intentId);

        ShrudIntentBook.EpochRecord memory epoch = intentBook.epochOf(header.epochId);
        if (epoch.status != ShrudIntentBook.EpochStatus.Recoverable) {
            revert EpochNotRecoverable(header.epochId, epoch.status);
        }

        _authorise(header, intentId, "timedOut", safeSignatures);

        if (_exited[intentId]) revert AlreadyExited(intentId);
        _exited[intentId] = true;

        clearingVault.emergencyRelease(intentId);
        emit EmergencyExitExecuted(intentId, header.safe, header.epochId, "timedOut");
    }

    function hasExited(bytes32 intentId) external view returns (bool) {
        return _exited[intentId];
    }

    /// @notice The digest the owning Safe's owners sign. Recomputable off chain before signing.
    function exitDigest(bytes32 intentId, address safe, bytes32 reason) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("ShrudEmergencyExit(uint256 chainId,address exit,address safe,bytes32 intentId,bytes32 reason)"),
                block.chainid,
                address(this),
                safe,
                intentId,
                reason
            )
        );
    }

    function _authorise(
        ShrudIntentBook.IntentHeader memory header,
        bytes32 intentId,
        bytes32 reason,
        bytes calldata safeSignatures
    ) private view {
        if (safeSignatures.length == 0) revert SignaturesRequired();
        ISafe(header.safe).checkSignatures(
            address(0), exitDigest(intentId, header.safe, reason), safeSignatures
        );
    }
}
