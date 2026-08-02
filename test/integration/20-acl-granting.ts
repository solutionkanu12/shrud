import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { nox } from "@iexec-nox/nox-hardhat-plugin";

/**
 * D-7 · Granting a handle requires already holding it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A real bug shipped to Sepolia because nothing asserted this. `ShrudClearingVault.confirmLock`
 * called `Nox.allowThis(lockSuccess)` on a handle `ShrudSafeModule._lock` grants only to the
 * clearing engine. Granting is itself ACL-guarded — NoxCompute's `allow` sits behind `onlyAllowed`
 * — so the call reverted `UnauthorizedSender(vault)`, every `activateIntent` failed, and no epoch
 * could ever clear. The grant was not even needed: nothing in the vault reads `lockSuccess`.
 *
 * It survived 51 unit tests, 19 fork tests and a live deployment for one reason: NO MOCK ENFORCES
 * THE ACL. A `vm.etch`-ed NoxCompute answers every `allow` with success, so the only place this is
 * observable is against the real stack in Docker — which is where this test runs.
 *
 * The lesson generalises past the one line that was wrong. Any contract in a Nox flow that grants a
 * handle it did not compute or receive will fail this way, and it will fail at ACL time rather than
 * at compile time.
 */
describe("20 · Nox ACL, against the real stack", () => {
  let connection: Awaited<ReturnType<typeof nox.connect>>;

  before(async () => {
    connection = await nox.connect();
  });

  /**
   * The exact call the vault made, in isolation.
   *
   * A handle that belongs to someone else cannot be granted onward, even to yourself. If a future
   * Nox release relaxed this, the assertion below would fail and the workaround in `confirmLock`
   * could be simplified — which is worth knowing either way.
   */
  it("refuses to grant a handle the caller was never granted", async () => {
    const probe = await connection.viem.deployContract("NoxPrimitiveProbe", []);

    // A well-formed handle this contract has no relationship to. Its bytes do not need to name a
    // real computation: the ACL check runs before anything else can care.
    const foreign = `0x${"11".repeat(32)}` as `0x${string}`;

    await assert.rejects(
      async () => {
        await probe.write.grantSelfWithoutPermission([foreign]);
      },
      (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        assert.match(
          text,
          /UnauthorizedSender|revert/i,
          "granting an unheld handle must be refused by the ACL",
        );
        return true;
      },
      "Nox permitted a grant from an address holding no permission on the handle",
    );
  });
});
