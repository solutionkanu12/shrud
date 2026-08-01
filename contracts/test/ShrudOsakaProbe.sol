// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

/**
 * @title ShrudOsakaProbe
 * @notice Proves the chain under test executes Osaka opcodes, in one call, before anything else runs.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE FAILURE THIS EXISTS TO CATCH, AND WHY IT IS ALMOST INVISIBLE WITHOUT IT
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * shrud compiles at `evmVersion: "osaka"`, because Ethereum Sepolia is on Osaka and one artifact
 * must deploy to both the local node and the live chain. Osaka adds CLZ — count leading zeros,
 * EIP-7939, opcode 0x1e — and solc emits it.
 *
 * The Nox Hardhat plugin's default node is configured `chainType: "op"`, whose latest EDR hardfork
 * is Isthmus. On that node CLZ is an INVALID opcode. And the symptom is the worst kind: every
 * contract deploys, every constructor runs, every view function returns — and then one arithmetic
 * path somewhere deep in a clearing stage dies with a bare `invalid opcode`. No revert reason. No
 * selector. Nothing naming the cause. It looks exactly like a Nox failure, and it is not.
 *
 * `hardhat.config.ts` sets `chainType: "l1"` and `hardfork: "osaka"` for this reason. This probe is
 * the assertion that the setting took effect, and `test/integration/00-osaka.ts` runs it first so
 * the whole suite fails in milliseconds with a message that names the problem.
 */
contract ShrudOsakaProbe {
    error OsakaNotAvailable();

    /**
     * @notice Executes CLZ directly and checks the answer.
     *
     * @dev Written in assembly rather than relying on solc emitting CLZ from `Math.log2` or similar,
     *      because whether the optimiser chooses that opcode is not something a probe should depend
     *      on. `clz(1)` is 255: a single set bit in the least significant position leaves 255 leading
     *      zeros in a 256-bit word.
     */
    function verifyOsaka() external pure returns (uint256 leadingZeros) {
        assembly ("memory-safe") {
            leadingZeros := clz(1)
        }
        if (leadingZeros != 255) revert OsakaNotAvailable();
    }
}
