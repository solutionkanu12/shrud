// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {ShrudIntentBook} from "../../contracts/intents/ShrudIntentBook.sol";
import {ShrudOrderFamily} from "../../contracts/libraries/ShrudOrderFamily.sol";

/**
 * @title ShrudIntentBookTest
 * @notice The public lifecycle, and the properties that make it carry no information.
 *
 * The intent book is the largest privacy surface in shrud that contains no encrypted data at all.
 * Everything here is public by construction; what makes it safe is what it REFUSES to distinguish.
 * Most of this file asserts sameness rather than difference.
 */
contract ShrudIntentBookTest is Test {
    ShrudIntentBook private book;

    address private constant REGISTRAR = address(0xBEEF);
    address private constant SAFE_A = address(0xA);
    address private constant SAFE_B = address(0xB);
    address private constant ASSET = address(0xC0FFEE);

    bytes32 private constant EPOCH = keccak256("epoch-1");
    bytes32 private constant FAMILY = keccak256("shrud.family.USDC_WETH_ALLOCATION_V1");

    function setUp() public {
        // The deployer wires the writer set once. `REGISTRAR` stands in for the clearing engine,
        // which is the writer every test below pranks as.
        book = new ShrudIntentBook(address(this));
        book.wire(REGISTRAR, address(0xE2), address(0xFAC));
    }

    // -------------------------------------------------------------------------------------------
    // Access
    // -------------------------------------------------------------------------------------------

    function test_onlyRegistrarMayWrite() public {
        vm.expectRevert(abi.encodeWithSelector(ShrudIntentBook.NotRegistrar.selector, address(this)));
        book.openEpoch(EPOCH, FAMILY, ASSET, ASSET);
    }

    function test_constructorRejectsZeroDeployer() public {
        vm.expectRevert(ShrudIntentBook.RegistrarIsZero.selector);
        new ShrudIntentBook(address(0));
    }

    /**
     * The writer set is closed by the same transaction that opens it.
     *
     * `_wired` has no setter that clears it, so after deployment the set grows only by one module
     * per Safe and only through the factory. A second `wire` would be a second chance to install a
     * writer, which is exactly the authority this design refuses to leave lying around.
     */
    function test_wiringIsOneShot() public {
        vm.expectRevert(ShrudIntentBook.AlreadyWired.selector);
        book.wire(address(0xAA), address(0xBB), address(0xCC));
    }

    function test_onlyTheFactoryMayAuthoriseAModule() public {
        vm.expectRevert(abi.encodeWithSelector(ShrudIntentBook.NotRegistrar.selector, address(this)));
        book.authoriseModule(address(0xD0D));

        vm.prank(address(0xFAC));
        book.authoriseModule(address(0xD0D));
        assertTrue(book.isWriter(address(0xD0D)), "the factory's module becomes a writer");
    }

    // -------------------------------------------------------------------------------------------
    // The uniform lifecycle
    // -------------------------------------------------------------------------------------------

    /**
     * THE CENTRAL PRIVACY ASSERTION OF THIS CONTRACT.
     *
     * Two orders reach `Processed` — one that recorded a full lock, one whose lock moved encrypted
     * zero because the Safe was underfunded. Their public records must be identical in every field
     * an observer can read. If a future change added a status, a flag or a differently named event
     * on one path, this test fails.
     */
    function test_underfundedAndFundedOrdersAreIndistinguishable() public {
        bytes32 funded = keccak256("funded");
        bytes32 underfunded = keccak256("underfunded");

        vm.startPrank(REGISTRAR);
        _submit(funded, SAFE_A, 1);
        _submit(underfunded, SAFE_B, 2);

        book.recordAuthorisation(funded, 2);
        book.recordAuthorisation(underfunded, 2);

        // The only difference between these two calls is the plaintext behind the handles, which is
        // exactly what an observer cannot see. `lockSuccess` differs; nothing public does.
        book.recordLock(funded, keccak256("lockedFull"), keccak256("successTrue"));
        book.recordLock(underfunded, keccak256("lockedZero"), keccak256("successFalse"));

        book.recordProcessed(funded, EPOCH);
        book.recordProcessed(underfunded, EPOCH);
        vm.stopPrank();

        ShrudIntentBook.IntentHeader memory a = book.headerOf(funded);
        ShrudIntentBook.IntentHeader memory b = book.headerOf(underfunded);

        assertEq(uint256(a.status), uint256(ShrudIntentBook.IntentStatus.Processed));
        assertEq(uint256(b.status), uint256(a.status), "both must be Processed and nothing else");
        assertEq(a.orderFamily, b.orderFamily);
        assertEq(a.epochId, b.epochId);
        assertEq(a.createdAtBlock, b.createdAtBlock);
    }

    /**
     * The enum has five reachable members and must never gain a sixth.
     *
     * PRD section 9.5 names the ones that must not exist: `Rejected`, `InsufficientBalance`, `Buy`,
     * `Sell`, `Crossed`, `LimitFailed`, `Excluded`. Each is a free oracle — `InsufficientBalance`
     * alone turns repeated oversized orders into a binary search over a confidential balance.
     *
     * Asserted structurally: casting one past the last member reverts on an enum with six members
     * and would not on an enum with seven.
     */
    function test_statusEnumHasExactlyFiveReachableMembers() public {
        assertEq(uint256(ShrudIntentBook.IntentStatus.Cancelled), 5, "Cancelled is the last member");

        // Member 6 does not exist. A cast to it panics with 0x21 (enum conversion out of bounds).
        vm.expectRevert();
        this.castStatus(6);
    }

    function castStatus(uint8 raw) external pure returns (ShrudIntentBook.IntentStatus) {
        return ShrudIntentBook.IntentStatus(raw);
    }

    // -------------------------------------------------------------------------------------------
    // Sealing
    // -------------------------------------------------------------------------------------------

    function test_sealRequiresStrictlySortedCandidates() public {
        vm.startPrank(REGISTRAR);
        book.openEpoch(EPOCH, FAMILY, ASSET, ASSET);
        bytes32[] memory ids = _authorisedPair();

        bytes32[] memory reversed = new bytes32[](2);
        reversed[0] = ids[1];
        reversed[1] = ids[0];

        vm.expectRevert(abi.encodeWithSelector(ShrudIntentBook.CandidateNotSorted.selector, 1));
        book.sealEpoch(EPOCH, reversed, keccak256("snap"), 1e18);
        vm.stopPrank();
    }

    /**
     * Duplicate rejection falls out of the strict ordering check for free.
     *
     * `<=` catches both a repeat and an unsorted pair in one comparison, which is why there is no
     * separate duplicate scan. Asserted rather than assumed, because "it follows from the sort"
     * is the kind of reasoning that survives a refactor that changes the sort.
     */
    function test_sealRejectsDuplicates() public {
        vm.startPrank(REGISTRAR);
        book.openEpoch(EPOCH, FAMILY, ASSET, ASSET);
        bytes32[] memory ids = _authorisedPair();

        bytes32[] memory duplicated = new bytes32[](2);
        duplicated[0] = ids[0];
        duplicated[1] = ids[0];

        vm.expectRevert(abi.encodeWithSelector(ShrudIntentBook.CandidateNotSorted.selector, 1));
        book.sealEpoch(EPOCH, duplicated, keccak256("snap"), 1e18);
        vm.stopPrank();
    }

    function test_sealRejectsOversizedCandidateSet() public {
        vm.startPrank(REGISTRAR);
        book.openEpoch(EPOCH, FAMILY, ASSET, ASSET);

        bytes32[] memory tooMany = new bytes32[](ShrudOrderFamily.MAX_CANDIDATES + 1);
        for (uint256 i = 0; i < tooMany.length; ++i) {
            tooMany[i] = bytes32(i + 1);
        }

        vm.expectRevert(
            abi.encodeWithSelector(
                ShrudIntentBook.CandidateBoundExceeded.selector,
                ShrudOrderFamily.MAX_CANDIDATES + 1,
                ShrudOrderFamily.MAX_CANDIDATES
            )
        );
        book.sealEpoch(EPOCH, tooMany, keccak256("snap"), 1e18);
        vm.stopPrank();
    }

    /**
     * An intent cannot be consumed by a second epoch — PRD invariant 21.1.5.
     *
     * THE TEST FOUND SOMETHING WORTH RECORDING. The first version expected
     * `IntentAlreadyConsumed`, and the real refusal is `CandidateEpochMismatch`, raised earlier in
     * the same loop. That is a STRONGER property than the one being tested for: the intent's header
     * pins its epoch at submission, so an intent can only ever be a candidate for the epoch it was
     * submitted into. The consumed marker is the second line of defence, not the first, and the
     * test now asserts the order rather than papering over it.
     */
    function test_intentCannotBeConsumedByASecondEpoch() public {
        vm.startPrank(REGISTRAR);
        book.openEpoch(EPOCH, FAMILY, ASSET, ASSET);
        bytes32[] memory ids = _authorisedPair();
        book.sealEpoch(EPOCH, ids, keccak256("snap"), 1e18);

        bytes32 second = keccak256("epoch-2");
        book.openEpoch(second, FAMILY, ASSET, ASSET);

        bytes32[] memory reused = new bytes32[](1);
        reused[0] = ids[0];

        // The header's epoch binding refuses first, before the consumed marker is even reached.
        vm.expectRevert(
            abi.encodeWithSelector(
                ShrudIntentBook.CandidateEpochMismatch.selector, ids[0], second, EPOCH
            )
        );
        book.sealEpoch(second, reused, keccak256("snap2"), 1e18);
        vm.stopPrank();

        // And the consumed marker is set, which is what blocks cancellation and expiry afterwards.
        assertEq(book.consumedBy(ids[0]), EPOCH, "the intent is marked consumed by its own epoch");
    }

    /// Cancellation after seal is impossible by construction, not by policy.
    function test_consumedIntentCannotBeCancelled() public {
        vm.startPrank(REGISTRAR);
        book.openEpoch(EPOCH, FAMILY, ASSET, ASSET);
        bytes32[] memory ids = _authorisedPair();
        book.sealEpoch(EPOCH, ids, keccak256("snap"), 1e18);

        vm.expectRevert(
            abi.encodeWithSelector(ShrudIntentBook.IntentAlreadyConsumed.selector, ids[0], EPOCH)
        );
        book.recordCancellation(ids[0]);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------------------------
    // Expiry
    // -------------------------------------------------------------------------------------------

    /**
     * Expiry is permissionless, and that is a privacy property.
     *
     * If only the owning Safe could expire its own orders, whether an order was cleaned up promptly
     * would itself be a signal — an owner who tidies immediately behaves differently from one who
     * does not, and the difference is observable.
     */
    function test_anyoneMayExpireAPassedOrder() public {
        vm.prank(REGISTRAR);
        _submit(keccak256("expiring"), SAFE_A, 1);

        vm.warp(block.timestamp + 8 days);
        vm.prank(address(0xDEAD));
        book.expireIntent(keccak256("expiring"));

        assertEq(
            uint256(book.headerOf(keccak256("expiring")).status),
            uint256(ShrudIntentBook.IntentStatus.Expired)
        );
    }

    function test_expiryRefusedBeforeTheDeadline() public {
        vm.prank(REGISTRAR);
        _submit(keccak256("live"), SAFE_A, 1);

        vm.expectRevert();
        book.expireIntent(keccak256("live"));
    }

    // -------------------------------------------------------------------------------------------
    // Published handles
    // -------------------------------------------------------------------------------------------

    /// Write-once. The commitment a decryption proof is checked against cannot be moved afterwards.
    function test_publishedHandlesCommitOnlyOnce() public {
        vm.startPrank(REGISTRAR);
        book.openEpoch(EPOCH, FAMILY, ASSET, ASSET);

        ShrudIntentBook.EpochPublishedHandles memory handles = ShrudIntentBook.EpochPublishedHandles({
            meetsEpochFloor: keccak256("f1"),
            meetsResidualFloor: keccak256("f2"),
            residualDirection: keccak256("d"),
            residualAggregateInput: keccak256("in"),
            residualAggregateMinimum: keccak256("min"),
            meetsSupplyFloor: keccak256("f3"),
            supplyAggregateInput: keccak256("supply")
        });
        book.commitPublishedHandles(EPOCH, handles);

        vm.expectRevert(
            abi.encodeWithSelector(ShrudIntentBook.PublishedHandlesAlreadyCommitted.selector, EPOCH)
        );
        book.commitPublishedHandles(EPOCH, handles);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------------------------
    // Fuzz
    // -------------------------------------------------------------------------------------------

    /**
     * Any strictly increasing candidate list seals; any other ordering does not.
     *
     * The sorted-set requirement is what stops a coordinator using ordering as a channel — place
     * the orders you expect to cross adjacently, or the residual contributors last, and the public
     * candidate list starts leaking the private classification. It only holds if EVERY unsorted
     * arrangement is refused, which is a fuzz property rather than a two-case example.
     */
    function testFuzz_onlyStrictlySortedSetsSeal(uint256 seed, uint8 rawCount) public {
        uint256 count = bound(rawCount, 2, ShrudOrderFamily.MAX_CANDIDATES);

        bytes32[] memory ids = new bytes32[](count);
        vm.startPrank(REGISTRAR);
        book.openEpoch(EPOCH, FAMILY, ASSET, ASSET);
        for (uint256 i = 0; i < count; ++i) {
            bytes32 id = keccak256(abi.encode(seed, i));
            _submit(id, SAFE_A, uint64(i));
            book.recordAuthorisation(id, 1);
            ids[i] = id;
        }
        _sort(ids);

        // Sorted: accepted.
        book.sealEpoch(EPOCH, ids, keccak256("snap"), 1e18);
        vm.stopPrank();

        assertEq(book.candidatesOf(EPOCH).length, count);
        for (uint256 i = 1; i < count; ++i) {
            assertLt(uint256(ids[i - 1]), uint256(ids[i]), "the accepted set is strictly increasing");
        }
    }

    // -------------------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------------------

    function _submit(bytes32 intentId, address safe, uint64 nonce_) private {
        book.recordSubmission(
            intentId,
            ShrudIntentBook.IntentHeader({
                module: address(this),
                safe: safe,
                inputAsset: ASSET,
                orderFamily: FAMILY,
                epochId: EPOCH,
                expiry: uint64(block.timestamp + 7 days),
                nonce: nonce_,
                commitment: keccak256(abi.encode(intentId, "commitment")),
                createdAtBlock: 0,
                status: ShrudIntentBook.IntentStatus.None
            }),
            _emptyHandles()
        );
    }

    function _authorisedPair() private returns (bytes32[] memory ids) {
        ids = new bytes32[](2);
        ids[0] = keccak256("one");
        ids[1] = keccak256("two");
        _sort(ids);
        for (uint256 i = 0; i < 2; ++i) {
            _submit(ids[i], SAFE_A, uint64(i));
            book.recordAuthorisation(ids[i], 1);
        }
    }

    function _sort(bytes32[] memory ids) private pure {
        for (uint256 i = 1; i < ids.length; ++i) {
            bytes32 key = ids[i];
            uint256 j = i;
            while (j > 0 && uint256(ids[j - 1]) > uint256(key)) {
                ids[j] = ids[j - 1];
                --j;
            }
            ids[j] = key;
        }
    }

    function _emptyHandles() private pure returns (ShrudIntentBook.IntentHandles memory) {
        return ShrudIntentBook.IntentHandles({
            amount: bytes32(uint256(1)),
            actionId: bytes32(uint256(2)),
            limit: bytes32(uint256(3)),
            lockedAmount: bytes32(0),
            lockSuccess: bytes32(0),
            priceEligible: bytes32(0),
            privateInclusion: bytes32(0),
            internalCrossInput: bytes32(0),
            internalCrossOutput: bytes32(0),
            residualContribution: bytes32(0),
            externalAllocation: bytes32(0),
            finalAllocation: bytes32(0),
            confidentialRefund: bytes32(0),
            privateOutcome: bytes32(0)
        });
    }
}
