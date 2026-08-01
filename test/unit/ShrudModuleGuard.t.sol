// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {IERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";
import {IERC20ToERC7984Wrapper} from
    "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC20ToERC7984Wrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {ShrudModuleGuard} from "../../contracts/accounts/ShrudModuleGuard.sol";
import {ShrudAssetRegistry} from "../../contracts/assets/ShrudAssetRegistry.sol";
import {SafeEnum} from "../../contracts/interfaces/ISafe.sol";
import {ShrudPauseController} from "../../contracts/recovery/ShrudPauseController.sol";

/**
 * @title ShrudModuleGuardTest
 * @notice The execution boundary, attacked along every axis it is meant to close.
 *
 * Safe's own source carries the warning this contract exists to answer: *"Modules are a security
 * risk since they can execute arbitrary transactions... A malicious module can completely take over
 * a Safe."* Every test below is one of those arbitrary transactions, attempted.
 */
contract ShrudModuleGuardTest is Test {
    ShrudModuleGuard private guard;
    ShrudAssetRegistry private registry;
    ShrudPauseController private pauseController;
    StubWrapper private wrapper;
    StubToken private underlying;

    address private constant SAFE = address(0x5AFE);
    address private constant MODULE = address(0x0D01E);
    address private constant GOVERNOR = address(0x9012);
    address private constant STRANGER = address(0xBAD);

    /// A testnet-shaped delay. Chain id 1 enforces seven days on chain regardless.
    uint256 private constant TEST_DELAY = 1 days;

    function setUp() public {
        pauseController = new ShrudPauseController(GOVERNOR);
        registry = new ShrudAssetRegistry(GOVERNOR, TEST_DELAY);
        underlying = new StubToken();
        wrapper = new StubWrapper(address(underlying));

        vm.prank(GOVERNOR);
        registry.queueRegistration(address(underlying), address(wrapper), type(uint128).max);
        vm.warp(block.timestamp + registry.registrationDelay() + 1);
        registry.applyRegistration(
            keccak256(abi.encode(block.chainid, address(registry), address(underlying), address(wrapper)))
        );

        guard = new ShrudModuleGuard(SAFE, MODULE, registry, pauseController);
    }

    // -------------------------------------------------------------------------------------------
    // The absolutes
    // -------------------------------------------------------------------------------------------

    /// Delegatecall would run arbitrary code in the Safe's own storage context. Never permitted.
    function test_delegatecallIsRefused() public {
        vm.prank(SAFE);
        vm.expectRevert(ShrudModuleGuard.DelegateCallForbidden.selector);
        guard.checkModuleTransaction(
            address(wrapper),
            0,
            abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (SAFE, 1)),
            SafeEnum.Operation.DelegateCall,
            MODULE
        );
    }

    /// A shrud module never moves ether.
    function test_valueTransferIsRefused() public {
        vm.prank(SAFE);
        vm.expectRevert(abi.encodeWithSelector(ShrudModuleGuard.ValueTransferForbidden.selector, 1 ether));
        guard.checkModuleTransaction(
            address(wrapper),
            1 ether,
            abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (SAFE, 1)),
            SafeEnum.Operation.Call,
            MODULE
        );
    }

    /**
     * Only the bound Safe may call the guard.
     *
     * Without this, anyone could call `checkModuleTransaction` to plant a pending hash that the real
     * post-hook would then accept — turning the two-call protocol into a way to launder one call.
     */
    function test_onlyTheBoundSafeMayCall() public {
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(ShrudModuleGuard.CallerIsNotTheBoundSafe.selector, STRANGER, SAFE)
        );
        guard.checkModuleTransaction(
            address(wrapper), 0, abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (SAFE, 1)), SafeEnum.Operation.Call, MODULE
        );
    }

    function test_onlyTheBoundModuleIsPermitted() public {
        vm.prank(SAFE);
        vm.expectRevert(
            abi.encodeWithSelector(ShrudModuleGuard.ModuleIsNotBound.selector, STRANGER, MODULE)
        );
        guard.checkModuleTransaction(
            address(wrapper), 0, abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (SAFE, 1)), SafeEnum.Operation.Call, STRANGER
        );
    }

    // -------------------------------------------------------------------------------------------
    // The allowlist is (target, selector, ARGUMENT SHAPE)
    // -------------------------------------------------------------------------------------------

    /**
     * THE TEST THAT JUSTIFIES DECODING ARGUMENTS AT ALL.
     *
     * `wrap(to, amount)` on a properly registered wrapper with an allowlisted selector is a
     * completely legitimate call — that mints a confidential balance TO AN ARBITRARY ADDRESS. A
     * target allowlist alone permits it. A selector allowlist alone permits it. Only decoding
     * `to` and comparing it with the bound Safe refuses it.
     */
    function test_wrapToAThirdPartyIsRefused() public {
        vm.prank(SAFE);
        vm.expectRevert(
            abi.encodeWithSelector(ShrudModuleGuard.WrapRecipientMustBeSafe.selector, STRANGER, SAFE)
        );
        guard.checkModuleTransaction(
            address(wrapper),
            0,
            abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (STRANGER, 1000)),
            SafeEnum.Operation.Call,
            MODULE
        );
    }

    function test_wrapToTheSafeIsPermitted() public {
        vm.prank(SAFE);
        bytes32 h = guard.checkModuleTransaction(
            address(wrapper),
            0,
            abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (SAFE, 1000)),
            SafeEnum.Operation.Call,
            MODULE
        );
        assertTrue(h != bytes32(0));
    }

    /**
     * `approve` must name THIS underlying's wrapper, not merely a registered one.
     *
     * Accepting "spender is some registered wrapper" would let a Safe approve the USDC wrapper to
     * spend its WETH. No shrud flow needs that, and a mistake could produce it.
     */
    function test_approveToAnUnrelatedSpenderIsRefused() public {
        vm.prank(SAFE);
        vm.expectRevert(
            abi.encodeWithSelector(
                ShrudModuleGuard.ApproveSpenderMustBeRegisteredWrapper.selector, STRANGER, address(wrapper)
            )
        );
        guard.checkModuleTransaction(
            address(underlying),
            0,
            abi.encodeCall(IERC20.approve, (STRANGER, 1000)),
            SafeEnum.Operation.Call,
            MODULE
        );
    }

    /// An operator that is not the bound module would be a second key over the Safe's balance.
    function test_operatorMustBeTheBoundModule() public {
        vm.prank(SAFE);
        vm.expectRevert(
            abi.encodeWithSelector(ShrudModuleGuard.OperatorMustBeBoundModule.selector, STRANGER, MODULE)
        );
        guard.checkModuleTransaction(
            address(wrapper),
            0,
            abi.encodeCall(IERC7984.setOperator, (STRANGER, uint48(block.timestamp + 1 days))),
            SafeEnum.Operation.Call,
            MODULE
        );
    }

    /// Revocation is `setOperator(module, 0)` and must always pass.
    function test_operatorRevocationIsPermitted() public {
        vm.prank(SAFE);
        guard.checkModuleTransaction(
            address(wrapper),
            0,
            abi.encodeCall(IERC7984.setOperator, (MODULE, 0)),
            SafeEnum.Operation.Call,
            MODULE
        );
    }

    function test_unregisteredTargetIsRefused() public {
        vm.prank(SAFE);
        vm.expectRevert(abi.encodeWithSelector(ShrudModuleGuard.TargetNotAllowed.selector, STRANGER));
        guard.checkModuleTransaction(
            address(STRANGER),
            0,
            abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (SAFE, 1)),
            SafeEnum.Operation.Call,
            MODULE
        );
    }

    function test_unknownSelectorOnARegisteredTargetIsRefused() public {
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", SAFE, 1);
        vm.prank(SAFE);
        vm.expectRevert(
            abi.encodeWithSelector(
                ShrudModuleGuard.SelectorNotAllowedForTarget.selector, address(wrapper), bytes4(data)
            )
        );
        guard.checkModuleTransaction(address(wrapper), 0, data, SafeEnum.Operation.Call, MODULE);
    }

    function test_shortCalldataIsRefused() public {
        vm.prank(SAFE);
        vm.expectRevert(abi.encodeWithSelector(ShrudModuleGuard.CalldataTooShort.selector, 3));
        guard.checkModuleTransaction(address(wrapper), 0, hex"010203", SafeEnum.Operation.Call, MODULE);
    }

    // -------------------------------------------------------------------------------------------
    // The post-hook
    // -------------------------------------------------------------------------------------------

    /**
     * THE POST-HOOK IS NOT A NO-OP, AND THIS IS WHY.
     *
     * `execTransactionFromModule` does NOT revert when the inner call fails — it returns `false` and
     * emits `ExecutionFromModuleFailure`. A module ignoring the return value would proceed as though
     * a wrap had happened when it had not, and the mismatch would surface much later as a reserve
     * discrepancy nobody could trace back.
     */
    function test_postHookConvertsSilentFailureIntoARevert() public {
        vm.startPrank(SAFE);
        bytes32 h = guard.checkModuleTransaction(
            address(wrapper),
            0,
            abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (SAFE, 1)),
            SafeEnum.Operation.Call,
            MODULE
        );

        vm.expectRevert(abi.encodeWithSelector(ShrudModuleGuard.ModuleExecutionFailed.selector, h));
        guard.checkAfterModuleExecution(h, false);
        vm.stopPrank();
    }

    function test_postHookRejectsAnUnknownHash() public {
        vm.startPrank(SAFE);
        guard.checkModuleTransaction(
            address(wrapper),
            0,
            abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (SAFE, 1)),
            SafeEnum.Operation.Call,
            MODULE
        );
        vm.expectRevert();
        guard.checkAfterModuleExecution(keccak256("not the pending hash"), true);
        vm.stopPrank();
    }

    /**
     * The pending hash is consumed exactly once.
     *
     * WHAT THIS TEST CAN AND CANNOT SHOW, STATED RATHER THAN GLOSSED. The pending hash lives in
     * EIP-1153 transient storage precisely so it cannot outlive the transaction — persistent storage
     * would leave a dangling hash if a later step reverted in a way that skipped the post-hook, and
     * the next transaction would inherit it.
     *
     * Foundry cannot exercise that directly: `vm.prank` changes the caller, not the transaction, and
     * `vm.roll`/`vm.warp` do not clear transient storage either. Every call inside one test function
     * shares one transaction context, so a "second transaction" here would be a fiction. The
     * cross-transaction clearing is an EVM guarantee and is exercised for real in
     * `test/integration/`, where each call is a genuine transaction.
     *
     * What IS testable here, and is the half that lives in shrud's own code: the hash is cleared on
     * consumption, so a second post-hook in the same transaction finds nothing pending.
     */
    function test_pendingHashIsConsumedExactlyOnce() public {
        vm.startPrank(SAFE);
        bytes32 h = guard.checkModuleTransaction(
            address(wrapper),
            0,
            abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (SAFE, 1)),
            SafeEnum.Operation.Call,
            MODULE
        );
        guard.checkAfterModuleExecution(h, true);

        vm.expectRevert(ShrudModuleGuard.NoPendingModuleTransaction.selector);
        guard.checkAfterModuleExecution(h, true);
        vm.stopPrank();
    }

    /// Two identical calls in one block must produce different hashes.
    function test_moduleTxHashesAreUnique() public {
        vm.startPrank(SAFE);
        bytes memory data = abi.encodeCall(IERC20ToERC7984Wrapper.wrap, (SAFE, 1));
        bytes32 first = guard.checkModuleTransaction(address(wrapper), 0, data, SafeEnum.Operation.Call, MODULE);
        guard.checkAfterModuleExecution(first, true);
        bytes32 second = guard.checkModuleTransaction(address(wrapper), 0, data, SafeEnum.Operation.Call, MODULE);
        vm.stopPrank();

        assertTrue(first != second, "identical calls must not collide");
    }

    // -------------------------------------------------------------------------------------------
    // Interface
    // -------------------------------------------------------------------------------------------

    /// Safe's `setModuleGuard` refuses a guard that does not answer this id, so it must be exact.
    function test_supportsTheModuleGuardInterfaceId() public view {
        assertTrue(guard.supportsInterface(0x58401ed8), "IModuleGuard");
        assertTrue(guard.supportsInterface(0x01ffc9a7), "IERC165");
        assertFalse(guard.supportsInterface(0xffffffff));
    }
}

// -----------------------------------------------------------------------------------------------
// Stubs. shrud's own logic only — nothing on the protocol path is faked here.
// -----------------------------------------------------------------------------------------------

contract StubToken {
    function decimals() external pure returns (uint8) {
        return 6;
    }
}

contract StubWrapper {
    address private immutable _underlying;

    constructor(address underlying_) {
        _underlying = underlying_;
    }

    function underlying() external view returns (address) {
        return _underlying;
    }
}
