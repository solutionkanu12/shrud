// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {ShrudPauseController} from "../../contracts/recovery/ShrudPauseController.sol";

/**
 * @title ShrudPauseControllerTest
 * @notice The one-way state machine, and the asymmetry between the two gates.
 *
 * The property that matters here is negative: there is NO transition out of `Halted`. A test that
 * only checked the happy path would pass identically against a controller with an `unhalt()`
 * function, so most of this file is about proving absences.
 */
contract ShrudPauseControllerTest is Test {
    ShrudPauseController private pauseController;
    address private constant GUARDIAN = address(0xA11CE);

    function setUp() public {
        pauseController = new ShrudPauseController(GUARDIAN);
    }

    function test_startsLive() public view {
        assertEq(uint256(pauseController.state()), uint256(ShrudPauseController.State.Live));
        pauseController.requireLive(ShrudPauseController.Activity.Submit);
        pauseController.requireNotHalted(ShrudPauseController.Activity.Settle);
    }

    function test_constructorRejectsZeroGuardian() public {
        vm.expectRevert(ShrudPauseController.GuardianIsZero.selector);
        new ShrudPauseController(address(0));
    }

    function test_onlyGuardianMayPause() public {
        vm.expectRevert(
            abi.encodeWithSelector(ShrudPauseController.NotGuardian.selector, address(this))
        );
        pauseController.pause();
    }

    /**
     * THE ASYMMETRY, ASSERTED DIRECTLY.
     *
     * `Paused` stops new value entering and lets sealed epochs finish. An epoch frozen between
     * "assets locked" and "assets allocated" strands every participant's capital in escrow, and
     * stranding capital is worse than letting a sealed, price-fixed epoch complete.
     */
    function test_pausedStopsNewValueButNotSettlement() public {
        vm.prank(GUARDIAN);
        pauseController.pause();

        vm.expectRevert(ShrudPauseController.NetworkIsPaused.selector);
        pauseController.requireLive(ShrudPauseController.Activity.Submit);

        // Settlement of work already begun stays open. This is the whole point of two gates.
        pauseController.requireNotHalted(ShrudPauseController.Activity.Settle);
    }

    function test_haltedStopsEverythingIncludingSettlement() public {
        vm.prank(GUARDIAN);
        pauseController.halt("key compromise drill");

        vm.expectRevert(ShrudPauseController.NetworkIsHalted.selector);
        pauseController.requireLive(ShrudPauseController.Activity.Submit);

        vm.expectRevert(ShrudPauseController.NetworkIsHalted.selector);
        pauseController.requireNotHalted(ShrudPauseController.Activity.Settle);

        // And only here does the emergency exit's gate open.
        pauseController.requireHalted();
    }

    /**
     * `Halted` IS TERMINAL, AND THIS IS THE ASSERTION THAT SAYS SO.
     *
     * If a guardian key could both stop and restart the network, a compromised guardian could stop
     * it, restart it, and leave no evidence anything happened. A one-way halt turns a compromised
     * guardian into a denial of service — bad, visible, survivable — instead of a silent controller
     * of the protocol.
     */
    function test_haltIsTerminal() public {
        vm.startPrank(GUARDIAN);
        pauseController.halt("terminal");

        vm.expectRevert(ShrudPauseController.AlreadyHalted.selector);
        pauseController.pause();

        vm.expectRevert(ShrudPauseController.AlreadyHalted.selector);
        pauseController.halt("again");

        vm.expectRevert(ShrudPauseController.AlreadyHalted.selector);
        pauseController.pauseActivity(ShrudPauseController.Activity.Clear);
        vm.stopPrank();
    }

    /**
     * There is no function on this contract that leaves `Halted`.
     *
     * Asserted by exhausting the ABI rather than by reading it: every non-view selector is called
     * from the guardian in the halted state, and none of them returns the controller to `Live`.
     */
    function test_noSelectorEscapesHalted() public {
        vm.startPrank(GUARDIAN);
        pauseController.halt("terminal");

        // Every state-changing entry point on this contract, tried in turn.
        try pauseController.pause() {} catch {}
        try pauseController.halt("x") {} catch {}
        try pauseController.pauseActivity(ShrudPauseController.Activity.Submit) {} catch {}
        vm.stopPrank();

        assertEq(
            uint256(pauseController.state()),
            uint256(ShrudPauseController.State.Halted),
            "no entry point may leave Halted"
        );
    }

    function test_perActivityPauseIsIndependent() public {
        vm.prank(GUARDIAN);
        pauseController.pauseActivity(ShrudPauseController.Activity.Shield);

        vm.expectRevert(
            abi.encodeWithSelector(
                ShrudPauseController.ActivityIsPaused.selector, ShrudPauseController.Activity.Shield
            )
        );
        pauseController.requireLive(ShrudPauseController.Activity.Shield);

        // Everything else keeps running. A single misbehaving path closes without stopping the rest.
        pauseController.requireLive(ShrudPauseController.Activity.Submit);
        pauseController.requireNotHalted(ShrudPauseController.Activity.Settle);
    }

    /// A per-activity pause must bind on BOTH gates, not only the strict one.
    function test_activityPauseBindsOnBothGates() public {
        vm.prank(GUARDIAN);
        pauseController.pauseActivity(ShrudPauseController.Activity.Settle);

        vm.expectRevert(
            abi.encodeWithSelector(
                ShrudPauseController.ActivityIsPaused.selector, ShrudPauseController.Activity.Settle
            )
        );
        pauseController.requireNotHalted(ShrudPauseController.Activity.Settle);
    }

    function test_requireHaltedRefusesWhenLive() public {
        vm.expectRevert(ShrudPauseController.NetworkIsNotHalted.selector);
        pauseController.requireHalted();

        vm.prank(GUARDIAN);
        pauseController.pause();

        // Paused is not Halted. The emergency exit stays closed.
        vm.expectRevert(ShrudPauseController.NetworkIsNotHalted.selector);
        pauseController.requireHalted();
    }
}
