import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { nox } from "@iexec-nox/nox-hardhat-plugin";


/**
 * The first test in the suite, and it takes milliseconds.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS CATCHES, AND WHY IT HAS TO RUN FIRST
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * shrud compiles at `evmVersion: "osaka"`, because Ethereum Sepolia is on Osaka and one artifact
 * must deploy to both the local node and the live chain. Osaka adds CLZ — count leading zeros,
 * EIP-7939, opcode 0x1e — and solc emits it.
 *
 * The Nox Hardhat plugin's default node is `chainType: "op"`, whose latest EDR hardfork is Isthmus.
 * On that node CLZ is an INVALID opcode. The symptom is the worst kind there is: every contract
 * deploys, every constructor runs, every view returns — and then one arithmetic path deep inside a
 * clearing stage dies with a bare `invalid opcode`. No revert reason. No selector. Nothing naming
 * the cause. It looks exactly like a Nox failure, and it is not.
 *
 * `hardhat.config.ts` sets `chainType: "l1"` and `hardfork: "osaka"`. This file is the assertion
 * that the setting took effect, and it is numbered `00` so the whole suite fails in milliseconds
 * with a message that names the problem rather than an hour later with one that does not.
 */
describe("00 · the chain under test executes Osaka opcodes", () => {
  let connection: Awaited<ReturnType<typeof nox.connect>>;

  before(async () => {
    connection = await nox.connect();
  });

  it("executes CLZ and returns the right answer", async () => {
    const probe = await connection.viem.deployContract("ShrudOsakaProbe", []);

    // clz(1) is 255: one set bit in the least significant position leaves 255 leading zeros in a
    // 256-bit word. A node without Osaka fails this call with `invalid opcode` rather than a revert.
    const leadingZeros = await probe.read.verifyOsaka();

    assert.equal(
      leadingZeros,
      255n,
      "CLZ returned the wrong answer, which should be impossible — check the EDR hardfork",
    );
  });

  it("reports the chain id the rest of the suite assumes", async () => {
    const publicClient = await connection.viem.getPublicClient();
    const chainId = await publicClient.getChainId();
    assert.equal(chainId, 31337, "the local Nox stack runs on 31337; sdk/Nox.sol hardcodes it");
  });
});
