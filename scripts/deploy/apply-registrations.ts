/**
 * Applies the asset and route registrations once the governance delay has elapsed.
 *
 * SEPARATE FROM `deploy.ts` BECAUSE THE DELAY IS REAL. `deploy.ts` queues; this applies. If the two
 * were one command the delay would have to be zero, and a timelock that is zero on the network you
 * can test is a timelock nobody has ever seen work.
 *
 * `applyRegistration` and `applyRoute` are both PERMISSIONLESS by design — the governor's authority
 * is over what is queued and whether it is cancelled, not over whether a publicly reviewed change
 * eventually lands. This script therefore needs a funded key for gas and nothing else.
 */

import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { artifact, readManifest } from "../lib/deployment.js";
import { waitForTimelock } from "../lib/timelock.js";
import { assertBroadcastAllowed, deployerPrivateKey, localRpcUrl, rpcUrl, say } from "../lib/env.js";

async function main(): Promise<void> {
  const local = process.argv.includes("--network") && process.argv.includes("local");
  if (!local) assertBroadcastAllowed();

  const account = privateKeyToAccount(deployerPrivateKey());
  const transport = http(local ? localRpcUrl() : rpcUrl());
  const chain = local ? undefined : sepolia;

  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const chainId = await publicClient.getChainId();
  const manifest = readManifest(chainId);

  const assetRegistry = manifest.contracts["ShrudAssetRegistry"]?.address;
  const priceRegistry = manifest.contracts["ShrudReferencePriceRegistry"]?.address;
  if (assetRegistry === undefined || priceRegistry === undefined) {
    throw new Error("the manifest is missing a registry address; re-run the deployment");
  }

  const assetAbi = artifact("assets/ShrudAssetRegistry.sol", "ShrudAssetRegistry").abi;
  const priceAbi = artifact(
    "clearing/ShrudReferencePriceRegistry.sol",
    "ShrudReferencePriceRegistry",
  ).abi;

  // `--wait` polls the chain until the delay elapses; without it the script reports and stops.
  const wait = process.argv.includes("--wait");

  for (const [label, registrationId] of Object.entries(manifest.registrationIds)) {
    const pending = (await publicClient.readContract({
      address: assetRegistry,
      abi: assetAbi,
      functionName: "pendingRegistration",
      args: [registrationId],
    })) as { executableAfter: bigint; wrapper: `0x${string}` };

    if (pending.wrapper === "0x0000000000000000000000000000000000000000") {
      say(`  ${label.padEnd(10)} already applied or never queued — skipping`);
      continue;
    }
    const head = await publicClient.getBlock({ blockTag: "latest" });
    if (head.timestamp < pending.executableAfter) {
      if (!wait) {
        throw new Error(
          `${label} is queued but not yet executable. ` +
            `${Number(pending.executableAfter - head.timestamp)} seconds of CHAIN time remain. The ` +
            "delay is the window in which a treasury that disagrees can withdraw, so it is not " +
            "skippable. Re-run with --wait to poll until it elapses.",
        );
      }
      await waitForTimelock(publicClient, { executableAfter: pending.executableAfter, label });
    }

    const hash = await wallet.writeContract({
      address: assetRegistry,
      abi: assetAbi,
      functionName: "applyRegistration",
      args: [registrationId],
      account,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    say(`  ${label.padEnd(10)} registered`);
  }

  const routeId = manifest.route["routeId"] as `0x${string}`;
  const queuedAt = (await publicClient.readContract({
    address: priceRegistry,
    abi: priceAbi,
    functionName: "routeOf",
    args: [routeId],
  })) as { pool: `0x${string}` };

  if (queuedAt.pool !== "0x0000000000000000000000000000000000000000") {
    say("  route      already registered — skipping");
  } else {
    const hash = await wallet.writeContract({
      address: priceRegistry,
      abi: priceAbi,
      functionName: "applyRoute",
      args: [routeId],
      account,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    say("  route      registered");
  }

  say("");
  say("Registrations applied. Next: pnpm tsx scripts/deploy/adapters.ts");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
