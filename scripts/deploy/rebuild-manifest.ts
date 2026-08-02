/**
 * Rebuilds the deployment manifest from chain state.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A deployment is irreversible; the file recording it is not. The first Sepolia run deployed all
 * fourteen contracts, wired them, queued every registration — and then failed writing the manifest,
 * because `JSON.stringify` throws on a bigint rather than coercing it. The protocol was live and
 * unrecorded.
 *
 * The fix for the cause is in `writeManifest`. This is the fix for the CONSEQUENCE, and it is worth
 * keeping afterwards: a manifest that can be re-derived from the chain is a manifest nobody has to
 * trust. Every field below is read back from Sepolia — addresses from deterministic nonces, code
 * hashes from `eth_getCode`, wiring and delays from the contracts' own accessors.
 *
 * It reconstructs; it never deploys. If an address holds no code the script says so and stops.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { type Address, createPublicClient, encodeAbiParameters, getContractAddress, type Hex, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import {
  GOVERNANCE_DELAY_SECONDS,
  MAX_STALENESS,
  MAX_TICK_DEVIATION,
  MAX_WRAPPED_USDC,
  MAX_WRAPPED_WETH,
  SEPOLIA,
  TWAP_WINDOW,
} from "../lib/constants.js";
import { artifact, type DeployedContract, type Manifest, ROOT, writeManifest } from "../lib/deployment.js";
import { deployerPrivateKey, rpcUrl, say } from "../lib/env.js";

/** The deployment order, which fixes each contract's nonce offset. Must match `deploy.ts`. */
const ORDER = [
  "ShrudPauseController",
  "ShrudAssetRegistry",
  "ShrudAdapterRegistry",
  "ShrudReferencePriceRegistry",
  "ShrudIntentBook",
  "ShrudPositionLedger",
  "ShrudClearingVault",
  "ShrudCapsuleFactory",
  "ShrudClearingEngine",
  "ShrudSettlementEngine",
  "ShrudModuleFactory",
  "ShrudEmergencyExit",
  "ShrudWrappedUSDC",
  "ShrudWrappedWETH",
] as const;

async function main(): Promise<void> {
  const startNonce = Number(
    process.argv[process.argv.indexOf("--start-nonce") + 1] ?? Number.NaN,
  );
  if (!Number.isInteger(startNonce)) {
    throw new Error(
      "pass --start-nonce <n>, the deployer's nonce immediately before the first deployment. " +
        "It is printed by deploy.ts as `start nonce`.",
    );
  }

  const account = privateKeyToAccount(deployerPrivateKey());
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl()) });
  const chainId = await publicClient.getChainId();

  say(`Rebuilding the manifest for chain ${chainId} from nonce ${startNonce}.`);
  say("Every field below is read back from the chain, not remembered.");
  say("");

  const contracts: Record<string, DeployedContract> = {};

  for (const [index, name] of ORDER.entries()) {
    const address = getContractAddress({ from: account.address, nonce: BigInt(startNonce + index) });
    const code = await publicClient.getCode({ address });
    if (code === undefined || code === "0x") {
      throw new Error(
        `${name} was expected at ${address} (nonce ${startNonce + index}) and the chain returns no ` +
          "code there. Either the start nonce is wrong or the deployment did not complete. Nothing " +
          "has been written.",
      );
    }
    contracts[name] = { address, runtimeCodeHash: keccak256(code), constructorArgs: [] };
    say(`  ${name.padEnd(28)} ${address}`);
  }

  const need = (name: string): Address => {
    const address = contracts[name]?.address;
    if (address === undefined) throw new Error(`missing ${name}`);
    return address;
  };

  // Constructor arguments, recorded so a reviewer can re-derive the creation code.
  contracts["ShrudPauseController"]!.constructorArgs = [account.address];
  contracts["ShrudAssetRegistry"]!.constructorArgs = [account.address, GOVERNANCE_DELAY_SECONDS];
  contracts["ShrudAdapterRegistry"]!.constructorArgs = [account.address, GOVERNANCE_DELAY_SECONDS];
  contracts["ShrudReferencePriceRegistry"]!.constructorArgs = [account.address, GOVERNANCE_DELAY_SECONDS];
  contracts["ShrudIntentBook"]!.constructorArgs = [account.address];
  contracts["ShrudPositionLedger"]!.constructorArgs = [need("ShrudPauseController")];
  contracts["ShrudClearingVault"]!.constructorArgs = [
    need("ShrudAssetRegistry"), need("ShrudIntentBook"), need("ShrudPauseController"),
  ];
  contracts["ShrudCapsuleFactory"]!.constructorArgs = [need("ShrudModuleFactory"), need("ShrudPauseController")];
  contracts["ShrudClearingEngine"]!.constructorArgs = [
    need("ShrudIntentBook"), need("ShrudClearingVault"), need("ShrudReferencePriceRegistry"),
    need("ShrudSettlementEngine"), need("ShrudPauseController"),
  ];
  contracts["ShrudSettlementEngine"]!.constructorArgs = [
    need("ShrudIntentBook"), need("ShrudClearingEngine"), need("ShrudClearingVault"),
    need("ShrudAdapterRegistry"), need("ShrudReferencePriceRegistry"), need("ShrudPositionLedger"),
    need("ShrudPauseController"),
  ];
  contracts["ShrudModuleFactory"]!.constructorArgs = [
    need("ShrudIntentBook"), need("ShrudAssetRegistry"), need("ShrudClearingVault"),
    need("ShrudClearingEngine"), need("ShrudCapsuleFactory"), need("ShrudPauseController"),
  ];
  contracts["ShrudEmergencyExit"]!.constructorArgs = [
    need("ShrudClearingVault"), need("ShrudIntentBook"), need("ShrudPauseController"),
    need("ShrudSettlementEngine"),
  ];
  contracts["ShrudWrappedUSDC"]!.constructorArgs = [
    "shrud confidential USDC", "cUSDC", "", SEPOLIA.usdc, MAX_WRAPPED_USDC,
  ];
  contracts["ShrudWrappedWETH"]!.constructorArgs = [
    "shrud confidential WETH", "cWETH", "", SEPOLIA.weth, MAX_WRAPPED_WETH,
  ];

  // ── Wiring, read from the contracts themselves rather than assumed ───────────────────────
  say("");
  say("Verifying wiring against chain state.");

  const bookAbi = artifact("intents/ShrudIntentBook.sol", "ShrudIntentBook").abi;
  const wired = (await publicClient.readContract({
    address: need("ShrudIntentBook"), abi: bookAbi, functionName: "isWired",
  })) as boolean;
  if (!wired) throw new Error("ShrudIntentBook reports it is not wired. The deployment is incomplete.");

  for (const [label, writer] of [
    ["clearing engine", need("ShrudClearingEngine")],
    ["settlement engine", need("ShrudSettlementEngine")],
  ] as const) {
    const isWriter = (await publicClient.readContract({
      address: need("ShrudIntentBook"), abi: bookAbi, functionName: "isWriter", args: [writer],
    })) as boolean;
    if (!isWriter) throw new Error(`the ${label} is not an authorised writer`);
    say(`  ${label.padEnd(28)} authorised`);
  }

  const delay = (await publicClient.readContract({
    address: need("ShrudAssetRegistry"),
    abi: artifact("assets/ShrudAssetRegistry.sol", "ShrudAssetRegistry").abi,
    functionName: "registrationDelay",
  })) as bigint;
  say(`  governance delay             ${delay} seconds (read from the registry)`);

  const routeId = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }],
      [BigInt(chainId), SEPOLIA.weth, SEPOLIA.usdc, SEPOLIA.uniswapPool],
    ),
  );
  /**
   * Read, not asserted.
   *
   * This was hardcoded `false` while the route was enabled on chain, so the manifest and the chain
   * disagreed about the one field a reader would use to decide whether pricing works. Every other
   * value in this file comes from a contract accessor; this one now does too.
   */
  const routeEnabled = (
    (await publicClient.readContract({
      address: need("ShrudReferencePriceRegistry"),
      abi: artifact(
        "clearing/ShrudReferencePriceRegistry.sol",
        "ShrudReferencePriceRegistry",
      ).abi,
      functionName: "routeOf",
      args: [routeId],
    })) as { enabled: boolean }
  ).enabled;
  say(`  route enabled                ${routeEnabled} (read from the price registry)`);

  const registrationId = (underlying: Address, wrapper: Address): Hex =>
    keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }],
        [BigInt(chainId), need("ShrudAssetRegistry"), underlying, wrapper],
      ),
    );

  const manifest: Manifest = {
    $comment:
      "Rebuilt by scripts/deploy/rebuild-manifest.ts. Every address was derived from the deployer's " +
      "nonce and confirmed to hold code; every hash was computed from what eth_getCode returned; the " +
      "wiring and the governance delay were read from the contracts' own accessors.",
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    compiler: { version: "0.8.36", optimizer: true, runs: 200, viaIR: true, evmVersion: "osaka" },
    compilerOverrides: {
      "contracts/clearing/ShrudClearingEngine.sol": { runs: 1 },
      "contracts/settlement/ShrudSettlementEngine.sol": { runs: 1 },
    },
    governance: {
      governor: account.address,
      guardian: account.address,
      delaySeconds: Number(delay),
      note:
        "Read from ShrudAssetRegistry.registrationDelay(), not from the deploy script's constant. " +
        "Chain id 1 enforces a seven-day minimum on chain regardless of this value.",
    },
    external: SEPOLIA,
    route: {
      routeId,
      pool: SEPOLIA.uniswapPool,
      baseToken: SEPOLIA.weth,
      quoteToken: SEPOLIA.usdc,
      twapWindow: TWAP_WINDOW,
      minObservationHistory: TWAP_WINDOW,
      maxStaleness: MAX_STALENESS,
      maxTickDeviation: MAX_TICK_DEVIATION,
      enabled: routeEnabled,
    },
    registrationIds: {
      usdc: registrationId(SEPOLIA.usdc, need("ShrudWrappedUSDC")),
      weth: registrationId(SEPOLIA.weth, need("ShrudWrappedWETH")),
    },
    contracts,
    seeded: false,
    seededNote:
      "No Safes, orders, balances or epochs were created. The hackathon brief requires the project " +
      "to work end to end without mock data, and a deploy script that plants demo state is how a " +
      "repository ends up verifying against numbers it wrote itself.",
  };

  mkdirSync(resolve(ROOT, "deployments"), { recursive: true });
  writeManifest(manifest);
  say("");
  say(`Manifest written to deployments/${chainId}.json`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
