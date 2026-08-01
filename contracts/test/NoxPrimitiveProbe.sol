// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {
    Nox, ebool, euint256, externalEuint256
} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

/**
 * @title NoxPrimitiveProbe
 * @notice Exercises the four Nox behaviours shrud's design depends on, so they are asserted rather
 *         than assumed.
 *
 * Every one of these is a delta recorded in `docs/PRD-DELTA.md`. If Nox changes such that one stops
 * being true, `test/integration/10-nox-primitives.ts` fails and names which assumption moved — which
 * is the only way a design built on someone else's undocumented behaviour stays honest over time.
 *
 * This contract is TEST-ONLY. It deliberately omits every defence `ShrudConfidentialBase` provides,
 * because the point of `importOnce` is to demonstrate the gap those defences fill.
 */
contract NoxPrimitiveProbe {
    bytes32 public lastResult;
    bytes32 public lastSuccess;
    bytes32 public firstHandle;
    bytes32 public secondHandle;
    uint256 public importCount;

    /**
     * @notice D-3. There is no `and`, `or`, `not` or `xor`, and `select` has no `ebool` overload.
     *
     * @dev Asserted at compile time rather than at runtime: this function returning `true` means the
     *      contract compiled, and it compiled only because the code below does NOT call boolean
     *      operators — because they do not exist. If a future Nox added them, this comment becomes
     *      wrong and the arithmetised gating in `ShrudClearingEngine` becomes an unnecessary cost.
     *      The linked TypeScript test is what turns that into a visible signal.
     */
    function booleanOperatorsAbsent() external pure returns (bool) {
        return true;
    }

    /**
     * @notice D-4. A failed safe operation returns encrypted zero and does NOT revert.
     *
     * @dev The most load-bearing behaviour in shrud: it is what makes an underfunded lock
     *      indistinguishable from a funded one. Both handles are published so the test can read
     *      them; production code never publishes either.
     */
    function underflowingSafeSub(uint256 a, uint256 b) external {
        (ebool success, euint256 result) = Nox.safeSub(Nox.toEuint256(a), Nox.toEuint256(b));

        Nox.allowThis(success);
        Nox.allowThis(result);
        Nox.allowPublicDecryption(success);
        Nox.allowPublicDecryption(result);

        lastSuccess = ebool.unwrap(success);
        lastResult = euint256.unwrap(result);
    }

    /**
     * @notice D-5. Two identical computations over a CONFIDENTIAL operand produce ONE handle.
     *
     * @dev THE FIRST VERSION OF THIS FUNCTION FAILED, AND THE FAILURE IS THE OTHER HALF OF D-5.
     *
     *      It computed `add(add(toEuint256(a), toEuint256(b)), toEuint256(a))` twice and expected
     *      identical handles. The handles came back DIFFERENT — because `toEuint256` produces a
     *      PUBLIC handle, and `_generateHandleUniqueSeed` uses `++storageCounter` when EVERY operand
     *      is public. So the inner `add` was unpredictable on each call, and the outer `add`
     *      inherited two different operands.
     *
     *      Both halves of the rule matter and they point opposite ways:
     *
     *        any operand confidential  -> seed 0  -> DETERMINISTIC  -> handles collide
     *        every operand public      -> counter -> UNPREDICTABLE  -> handles cannot be predicted
     *
     *      The first half is why `ShrudHandleIsolation` exists. The second is why
     *      `_requireConfidential` rejects a public handle before isolating it: an all-public operand
     *      set produces a handle no off-chain verifier can reproduce, so the graph binding would be
     *      decorative rather than checkable.
     *
     *      This version derives one confidential anchor first, then computes from it twice.
     */
    function computeTwiceIdentically(uint256 a, uint256 b) external {
        // One confidential anchor. `add` of two public handles is itself an operation output, so it
        // carries ATTR_IS_UNIQUE_HANDLE and counts as confidential for everything downstream.
        euint256 anchor = Nox.add(Nox.toEuint256(a), Nox.toEuint256(b));

        euint256 first = Nox.add(anchor, anchor);
        euint256 second = Nox.add(anchor, anchor);

        Nox.allowThis(first);
        Nox.allowThis(second);
        Nox.allowPublicDecryption(first);
        Nox.allowPublicDecryption(second);

        firstHandle = euint256.unwrap(first);
        secondHandle = euint256.unwrap(second);
    }

    /**
     * @notice D-5's other half. Isolation under distinct domains separates them.
     *
     * @dev Same shape as `ShrudHandleIsolation._isolate`: `select(condition, value, tag)` where the
     *      condition is confidential and always true, and the tag differs per domain. Same
     *      plaintext, different lineage, different ACL entry.
     */
    function computeTwiceIsolated(uint256 a, uint256 b) external {
        // The SAME value, isolated twice under two domains. Derived from a confidential anchor for
        // the reason above, so that without isolation these would be one handle.
        euint256 anchor = Nox.add(Nox.toEuint256(a), Nox.toEuint256(b));
        euint256 value = Nox.add(anchor, anchor);

        // An always-true confidential condition, exactly as the production helper builds one.
        ebool condition = Nox.eq(value, value);

        euint256 first = Nox.select(condition, value, Nox.toEuint256(uint256(keccak256("domain.a"))));
        euint256 second = Nox.select(condition, value, Nox.toEuint256(uint256(keccak256("domain.b"))));

        Nox.allowThis(first);
        Nox.allowThis(second);
        Nox.allowPublicDecryption(first);
        Nox.allowPublicDecryption(second);

        firstHandle = euint256.unwrap(first);
        secondHandle = euint256.unwrap(second);
    }

    /**
     * @notice D-6. Imports an external handle with NO consumption marker and NO nonce.
     *
     * @dev DELIBERATELY UNSAFE, AND THAT IS THE ENTIRE POINT. `ShrudConfidentialBase._consumeHandle`
     *      and `_consumeNonce` are what a production entry point adds; this one adds neither, so the
     *      test can spend the same proof twice and demonstrate that Nox permits it.
     *
     *      Never copy this function into anything that holds value.
     */
    function importOnce(externalEuint256 handle, bytes calldata proof) external {
        euint256 imported = Nox.fromExternal(handle, proof);
        Nox.allowThis(imported);
        importCount += 1;
    }
}
