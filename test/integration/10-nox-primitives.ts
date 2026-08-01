import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { nox } from "@iexec-nox/nox-hardhat-plugin";

/**
 * The Nox facts shrud's whole design rests on, asserted against the REAL stack.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS RUNS AGAINST DOCKER AND NOT AGAINST A MOCK
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every Nox primitive is an external call into the NoxCompute proxy whose result is computed off
 * chain by the KMS, the ingestor and the TDX runner. A `vm.etch`-ed NoxCompute would return numbers
 * this repository chose, which is not evidence about a confidentiality boundary — it is evidence
 * about the mock. `@iexec-nox/nox-hardhat-plugin` boots the real stack in Docker, so everything
 * below is a real handle, a real gateway proof and a real ACL decision.
 *
 * **Docker must be running.** Without it the plugin cannot bring the stack up and this file fails
 * at `before`, loudly, rather than passing against nothing.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FOUR CLAIMS BEING CHECKED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Each is a delta the contracts were designed around. If any of them stops being true, shrud's
 * design is wrong somewhere specific, and this file says where.
 *
 *   D-3  There is no boolean algebra: no `and`/`or`/`not`/`xor`, and `select` has no `ebool` form.
 *   D-4  Safe ops fail into encrypted zero WITHOUT reverting, so the flag must be threaded.
 *   D-5  Handles are deterministic in their operands, so identical computations collide.
 *   D-6  Input proofs carry no nonce, so replay protection is the application's job.
 */
describe("10 · Nox primitives, against the real stack", () => {
  let connection: Awaited<ReturnType<typeof nox.connect>>;
  
  before(async () => {
    connection = await nox.connect();
      });

  /**
   * D-3, asserted against the deployed ABI rather than against the documentation.
   *
   * The check is on the SDK library's own surface: if a future release added `and`, this test would
   * fail and shrud's arithmetised gating would become an unnecessary cost rather than a necessity.
   * Either outcome is worth knowing; silently keeping the workaround is not.
   */
  it("has no boolean algebra, which is why gating is arithmetised", async () => {
    const probe = await connection.viem.deployContract("NoxPrimitiveProbe", []);
    const absent = await probe.read.booleanOperatorsAbsent();
    assert.equal(absent, true, "Nox gained boolean operators — revisit delta D-3");
  });

  /**
   * D-4. The transaction SUCCEEDS and the result is encrypted zero.
   *
   * This is the single most load-bearing behaviour in shrud: it is what makes an underfunded lock
   * indistinguishable from a funded one. A revert here would turn every private shortfall into a
   * public oracle.
   */
  it("returns encrypted zero from a failed safeSub without reverting", async () => {
    const probe = await connection.viem.deployContract("NoxPrimitiveProbe", []);

    // 5 - 10 underflows. The call must not revert.
    const hash = await probe.write.underflowingSafeSub([5n, 10n]);
    const publicClient = await connection.viem.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", "a failed safe op must not revert the transaction");

    const resultHandle = await probe.read.lastResult();
    const successHandle = await probe.read.lastSuccess();

    const { value: result } = await nox.publicDecrypt(resultHandle);
    const { value: success } = await nox.publicDecrypt(successHandle);

    assert.equal(result, 0n, "the result must be encrypted zero, not a wrapped value");
    assert.equal(success, false, "and the success flag must be encrypted false");
  });

  /**
   * D-5, and the reason `ShrudHandleIsolation` exists.
   *
   * Two logically distinct quantities computed identically from identical operands come back as ONE
   * handle. The test asserts the collision rather than avoiding it, because the collision is the
   * premise: a design that assumed handles were unique would grant one Safe another's value and
   * nothing would look wrong.
   */
  it("produces IDENTICAL handles for identical computations", async () => {
    const probe = await connection.viem.deployContract("NoxPrimitiveProbe", []);

    await probe.write.computeTwiceIdentically([7n, 11n]);
    const first = await probe.read.firstHandle();
    const second = await probe.read.secondHandle();

    assert.equal(
      first,
      second,
      "handles are deterministic in their operands — if this ever stops being true, " +
        "ShrudHandleIsolation becomes unnecessary rather than merely expensive",
    );
  });

  /**
   * D-5's other half: isolation actually separates them.
   *
   * THE NEGATIVE IS THE POINT. The test above proves the collision exists. This one proves the
   * defence works — and it is run in the same file so that removing the defence makes a test fail
   * rather than making a comment stale.
   */
  it("produces DIFFERENT handles once isolated under different domains", async () => {
    const probe = await connection.viem.deployContract("NoxPrimitiveProbe", []);

    await probe.write.computeTwiceIsolated([7n, 11n]);
    const first = await probe.read.firstHandle();
    const second = await probe.read.secondHandle();

    assert.notEqual(first, second, "isolation under distinct domains must produce distinct handles");

    // Same plaintext, different lineage. Both must decrypt to the same number.
    const { value: a } = await nox.publicDecrypt(first);
    const { value: b } = await nox.publicDecrypt(second);
    assert.equal(a, b, "isolation changes the handle, never the value");
  });

  /**
   * D-6. A proof is replayable by its own owner until it expires.
   *
   * `validateInputProof` checks chain id, TEE type, proof length, `createdAt + expiry`,
   * `app == msg.sender`, `owner` and the gateway signature — and nothing else. No nonce, no
   * consumption marker. `ShrudConfidentialBase._consumeHandle` is the missing half, and this test
   * demonstrates the gap it fills by spending the same proof twice at a contract that does not.
   */
  it("accepts the same input proof twice at a contract with no consumption marker", async () => {
    const probe = await connection.viem.deployContract("NoxPrimitiveProbe", []);
    const [wallet] = await connection.viem.getWalletClients();

    const encrypted = await nox.encryptInput(1234n, "uint256", probe.address);

    await probe.write.importOnce([encrypted.handle, encrypted.handleProof], {
      account: wallet.account,
    });

    // Nox itself does not stop this. Only the application can.
    await probe.write.importOnce([encrypted.handle, encrypted.handleProof], {
      account: wallet.account,
    });

    const consumedTwice = await probe.read.importCount();
    assert.equal(
      consumedTwice,
      2n,
      "Nox permits the replay; ShrudConfidentialBase is what refuses it",
    );
  });
});
