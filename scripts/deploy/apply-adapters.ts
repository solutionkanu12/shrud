/**
 * Applies the queued adapter registrations once the governance delay has elapsed.
 *
 * Permissionless, like every other `apply` in this protocol: the governor decides WHAT is queued and
 * whether it is cancelled, never whether a publicly reviewed change eventually lands. Making the
 * final step privileged too would turn a transparency mechanism into a discretionary one.
 */

import { createPublicClient, createWalletClient, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { artifact, readManifest, writeManifest } from "../lib/deployment.js";
import { waitForTimelock } from "../lib/timelock.js";
import { assertBroadcastAllowed, deployerPrivateKey, localRpcUrl, rpcUrl, say } from "../lib/env.js";

async function main(): Promise<void> {
  const local = process.argv.includes("local");
  if (!local) assertBroadcastAllowed();

  const account = privateKeyToAccount(deployerPrivateKey());
  const transport = http(local ? localRpcUrl() : rpcUrl());
  const chain = local ? undefined : sepolia;

  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const chainId = await publicClient.getChainId();
  const manifest = readManifest(chainId);

  const registry = manifest.contracts["ShrudAdapterRegistry"]?.address;
  if (registry === undefined) throw new Error("the manifest is missing ShrudAdapterRegistry");
  const abi = artifact("adapters/ShrudAdapterRegistry.sol", "ShrudAdapterRegistry").abi;

  const adapters = manifest.adapters ?? {};
  if (Object.keys(adapters).length === 0) {
    throw new Error("no adapters queued. Run scripts/deploy/adapters.ts first.");
  }

  // `--wait` polls the chain until each delay elapses. Without it the script reports what is left
  // and stops, which is the right default: a delay of days should not hold a terminal open.
  const wait = process.argv.includes("--wait");

  for (const [label, entry] of Object.entries(adapters)) {
    const queuedAt = (await publicClient.readContract({
      address: registry,
      abi,
      functionName: "queuedAt",
      args: [entry.address],
    })) as bigint;

    if (queuedAt === 0n) {
      say(`  ${label.padEnd(28)} already applied or never queued — skipping`);
      continue;
    }

    const head = await publicClient.getBlock({ blockTag: "latest" });
    if (head.timestamp < queuedAt) {
      if (!wait) {
        throw new Error(
          `${label} is queued but not executable for another ${Number(queuedAt - head.timestamp)} ` +
            "seconds of CHAIN time. The delay is the window in which a treasury that disagrees can " +
            "withdraw, so it is not skippable. Re-run with --wait to poll until it elapses.",
        );
      }
      await waitForTimelock(publicClient, { executableAfter: queuedAt, label });
    }

    const hash = await wallet.writeContract({
      address: registry,
      abi,
      functionName: "applyAdapter",
      args: [entry.address],
      account,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted`);

    // Record the code hash the REGISTRY captured, read back from the chain. The registry re-checks
    // this on every settlement, so the manifest must carry the same value the contract will compare
    // against — not the one this script computed a moment earlier from a local artifact.
    const code = await publicClient.getCode({ address: entry.address });
    entry.runtimeCodeHash = keccak256(code ?? "0x");
    say(`  ${label.padEnd(28)} registered`);
  }

  writeManifest(manifest);
  say("");
  say("All adapters registered. The protocol is live and empty.");
  say("Nothing has been seeded: no Safes, no orders, no epochs, no balances.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
