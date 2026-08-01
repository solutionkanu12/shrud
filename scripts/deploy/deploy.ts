/**
 * The shrud deployment. Contracts and registrations only.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCRIPT DOES NOT DO, AND WILL NOT BE MADE TO DO
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * It creates no Safes, submits no orders, seeds no balances and fabricates no epochs. The hackathon
 * brief is explicit that the project must work end to end **without mock data**, and a deploy script
 * that plants demo state is how a repository ends up with a verifier that passes against numbers the
 * repository wrote.
 *
 * What comes out of this script is a protocol with nothing in it. Every Safe, every order and every
 * epoch after that belongs to whoever created it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO DEPLOYMENT CYCLES, RESOLVED BY PREDICTION AND THEN ASSERTED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   ShrudClearingEngine  needs the settlement engine's address
 *   ShrudSettlementEngine needs the clearing engine's
 *
 *   ShrudCapsuleFactory  needs the module factory's address
 *   ShrudModuleFactory   needs the capsule factory's
 *
 * Sequential deployment from one account makes every future address a pure function of the deployer
 * and a nonce, so the cycle is broken by computing the later address before deploying the earlier
 * contract — and then CHECKING it. A prediction that is merely used is a wiring step that fails
 * silently by pointing at the wrong contract; a prediction that is asserted fails loudly at the one
 * moment somebody is watching.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE MANIFEST IS THE DELIVERABLE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything a reviewer needs to check this deployment against a build of this repository —
 * addresses, runtime code hashes, compiler settings, constructor arguments, the governance delays
 * actually enforced — is written to `deployments/<chainId>.json`. `pnpm verify:live` reads it and
 * re-derives every claim from chain state.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getContractAddress,
  type Hex,
  http,
  keccak256,
} from "viem";
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
import { type Manifest, writeManifest } from "../lib/deployment.js";
import { assertBroadcastAllowed, deployerPrivateKey, localRpcUrl, rpcUrl, say } from "../lib/env.js";

// ══════════════════════════════════════════════════════════════════════════════════════════════

interface Artifact {
  abi: readonly unknown[];
  bytecode: Hex;
  deployedBytecode: Hex;
}

const ROOT = resolve(import.meta.dirname, "../..");

function artifact(path: string, name: string): Artifact {
  const file = resolve(ROOT, "artifacts/contracts", path, `${name}.json`);
  const json = JSON.parse(readFileSync(file, "utf8")) as {
    abi: readonly unknown[];
    bytecode: Hex | { object: Hex };
    deployedBytecode: Hex | { object: Hex };
  };
  const unwrap = (v: Hex | { object: Hex }): Hex => (typeof v === "string" ? v : v.object);
  return {
    abi: json.abi,
    bytecode: unwrap(json.bytecode),
    deployedBytecode: unwrap(json.deployedBytecode),
  };
}

interface DeployedContract {
  readonly address: Address;
  readonly runtimeCodeHash: Hex;
  readonly constructorArgs: readonly unknown[];
}

async function main(): Promise<void> {
  const network = process.argv.includes("--network")
    ? process.argv[process.argv.indexOf("--network") + 1]
    : "sepolia";

  if (network !== "sepolia" && network !== "local") {
    throw new Error(`unknown network "${network}". Use --network sepolia or --network local.`);
  }
  if (network === "sepolia") assertBroadcastAllowed();

  const account = privateKeyToAccount(deployerPrivateKey());
  const transport = http(network === "local" ? localRpcUrl() : rpcUrl());
  const chain = network === "local" ? undefined : sepolia;

  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  const chainId = await publicClient.getChainId();
  const balance = await publicClient.getBalance({ address: account.address });

  say(`network        ${network} (chain ${chainId})`);
  say(`deployer       ${account.address}`);
  say(`balance        ${Number(balance) / 1e18} ETH`);

  if (balance === 0n) {
    throw new Error(
      `${account.address} holds no ETH on chain ${chainId}. Fund it before deploying — this script ` +
        "reads the balance first so a run that cannot finish stops before it has spent anything.",
    );
  }

  const deployed: Record<string, DeployedContract> = {};

  /** Deploys one contract, waits for it, and records its runtime code hash. */
  async function deploy(
    label: string,
    path: string,
    name: string,
    args: readonly unknown[],
  ): Promise<Address> {
    const art = artifact(path, name);
    const hash = await wallet.deployContract({
      abi: art.abi,
      bytecode: art.bytecode,
      args: args as never,
      account,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const address = receipt.contractAddress;
    if (address === null || address === undefined) {
      throw new Error(`${label} produced no contract address`);
    }

    const code = await publicClient.getCode({ address });
    if (code === undefined || code === "0x") {
      throw new Error(`${label} deployed to ${address} but the chain returned no code`);
    }

    deployed[label] = { address, runtimeCodeHash: keccak256(code), constructorArgs: args };
    say(`  ${label.padEnd(28)} ${address}`);
    return address;
  }

  /** The address this deployer will produce at `nonce`. Asserted after the fact, never trusted. */
  async function predict(nonce: number): Promise<Address> {
    return getContractAddress({ from: account.address, nonce: BigInt(nonce) });
  }

  const startNonce = await publicClient.getTransactionCount({ address: account.address });
  say(`start nonce    ${startNonce}`);
  say("");
  say("Deploying. Nothing is seeded — this produces a protocol with nothing in it.");
  say("");

  // ── The two forward predictions, computed before anything is deployed ────────────────────
  //
  // Deployment order below is fixed, so each contract's nonce is known in advance. Both cycles are
  // broken by predicting the later address and then asserting it once the contract exists.
  const n = (offset: number): number => startNonce + offset;
  const predictedCapsuleFactory = await predict(n(7));
  const predictedClearingEngine = await predict(n(8));
  const predictedSettlementEngine = await predict(n(9));
  const predictedModuleFactory = await predict(n(10));

  // ── 0..6 · no cycles ─────────────────────────────────────────────────────────────────────
  const pauseController = await deploy(
    "ShrudPauseController",
    "recovery/ShrudPauseController.sol",
    "ShrudPauseController",
    [account.address],
  );
  const assetRegistry = await deploy(
    "ShrudAssetRegistry",
    "assets/ShrudAssetRegistry.sol",
    "ShrudAssetRegistry",
    [account.address, GOVERNANCE_DELAY_SECONDS],
  );
  const adapterRegistry = await deploy(
    "ShrudAdapterRegistry",
    "adapters/ShrudAdapterRegistry.sol",
    "ShrudAdapterRegistry",
    [account.address, GOVERNANCE_DELAY_SECONDS],
  );
  const priceRegistry = await deploy(
    "ShrudReferencePriceRegistry",
    "clearing/ShrudReferencePriceRegistry.sol",
    "ShrudReferencePriceRegistry",
    [account.address, GOVERNANCE_DELAY_SECONDS],
  );
  const intentBook = await deploy(
    "ShrudIntentBook",
    "intents/ShrudIntentBook.sol",
    "ShrudIntentBook",
    [account.address],
  );
  const positionLedger = await deploy(
    "ShrudPositionLedger",
    "settlement/ShrudPositionLedger.sol",
    "ShrudPositionLedger",
    [pauseController],
  );
  const clearingVault = await deploy(
    "ShrudClearingVault",
    "clearing/ShrudClearingVault.sol",
    "ShrudClearingVault",
    [assetRegistry, intentBook, pauseController],
  );

  // ── 7..10 · the two cycles ───────────────────────────────────────────────────────────────
  const capsuleFactory = await deploy(
    "ShrudCapsuleFactory",
    "disclosure/ShrudCapsuleFactory.sol",
    "ShrudCapsuleFactory",
    [predictedModuleFactory, pauseController],
  );
  assertPredicted("ShrudCapsuleFactory", predictedCapsuleFactory, capsuleFactory);

  const clearingEngine = await deploy(
    "ShrudClearingEngine",
    "clearing/ShrudClearingEngine.sol",
    "ShrudClearingEngine",
    [intentBook, clearingVault, priceRegistry, predictedSettlementEngine, pauseController],
  );
  assertPredicted("ShrudClearingEngine", predictedClearingEngine, clearingEngine);

  const settlementEngine = await deploy(
    "ShrudSettlementEngine",
    "settlement/ShrudSettlementEngine.sol",
    "ShrudSettlementEngine",
    [
      intentBook,
      clearingEngine,
      clearingVault,
      adapterRegistry,
      priceRegistry,
      positionLedger,
      pauseController,
    ],
  );
  assertPredicted("ShrudSettlementEngine", predictedSettlementEngine, settlementEngine);

  const moduleFactory = await deploy(
    "ShrudModuleFactory",
    "accounts/ShrudModuleFactory.sol",
    "ShrudModuleFactory",
    [intentBook, assetRegistry, clearingVault, clearingEngine, capsuleFactory, pauseController],
  );
  assertPredicted("ShrudModuleFactory", predictedModuleFactory, moduleFactory);

  const emergencyExit = await deploy(
    "ShrudEmergencyExit",
    "recovery/ShrudEmergencyExit.sol",
    "ShrudEmergencyExit",
    [clearingVault, intentBook, pauseController, settlementEngine],
  );

  // ── 12..13 · the confidential wrappers ───────────────────────────────────────────────────
  const usdcWrapper = await deploy(
    "ShrudWrappedUSDC",
    "assets/wrappers/ShrudWrappedAsset.sol",
    "ShrudWrappedAsset",
    ["shrud confidential USDC", "cUSDC", "", SEPOLIA.usdc, MAX_WRAPPED_USDC],
  );
  const wethWrapper = await deploy(
    "ShrudWrappedWETH",
    "assets/wrappers/ShrudWrappedAsset.sol",
    "ShrudWrappedAsset",
    ["shrud confidential WETH", "cWETH", "", SEPOLIA.weth, MAX_WRAPPED_WETH],
  );

  // ── Wiring. Each is one-shot and permanently closed by the same transaction. ──────────────
  say("");
  say("Wiring.");

  await send(
    "intentBook.wire",
    intentBook,
    "intents/ShrudIntentBook.sol",
    "ShrudIntentBook",
    "wire",
    [clearingEngine, settlementEngine, moduleFactory],
  );
  await send(
    "clearingVault.wire",
    clearingVault,
    "clearing/ShrudClearingVault.sol",
    "ShrudClearingVault",
    "wire",
    [clearingEngine, settlementEngine, emergencyExit, moduleFactory],
  );
  await send(
    "positionLedger.wire",
    positionLedger,
    "settlement/ShrudPositionLedger.sol",
    "ShrudPositionLedger",
    "wire",
    [settlementEngine],
  );

  // ── Registrations. Queue, wait out the delay, apply. ─────────────────────────────────────
  say("");
  say("Registering assets and the reference-price route.");

  const usdcRegistrationId = keccak256(
    encodeRegistrationId(chainId, assetRegistry, SEPOLIA.usdc, usdcWrapper),
  );
  const wethRegistrationId = keccak256(
    encodeRegistrationId(chainId, assetRegistry, SEPOLIA.weth, wethWrapper),
  );

  await send(
    "queue USDC",
    assetRegistry,
    "assets/ShrudAssetRegistry.sol",
    "ShrudAssetRegistry",
    "queueRegistration",
    [SEPOLIA.usdc, usdcWrapper, MAX_WRAPPED_USDC],
  );
  await send(
    "queue WETH",
    assetRegistry,
    "assets/ShrudAssetRegistry.sol",
    "ShrudAssetRegistry",
    "queueRegistration",
    [SEPOLIA.weth, wethWrapper, MAX_WRAPPED_WETH],
  );

  const routeConfig = {
    pool: SEPOLIA.uniswapPool,
    baseToken: SEPOLIA.weth,
    quoteToken: SEPOLIA.usdc,
    twapWindow: TWAP_WINDOW,
    minObservationHistory: TWAP_WINDOW,
    maxStaleness: MAX_STALENESS,
    maxTickDeviation: MAX_TICK_DEVIATION,
    enabled: false,
  };
  await send(
    "queue route",
    priceRegistry,
    "clearing/ShrudReferencePriceRegistry.sol",
    "ShrudReferencePriceRegistry",
    "queueRoute",
    [routeConfig],
  );

  const routeId = keccak256(
    encodeRouteId(chainId, SEPOLIA.weth, SEPOLIA.usdc, SEPOLIA.uniswapPool),
  );

  say("");
  say(`Queued. The governance delay is ${GOVERNANCE_DELAY_SECONDS} seconds and it is real —`);
  say("the registrations cannot be applied until it elapses. Run:");
  say("");
  say("    pnpm tsx scripts/deploy/apply-registrations.ts");
  say("");
  say("once it has, then deploy the adapters with:");
  say("");
  say("    pnpm tsx scripts/deploy/adapters.ts");
  say("");

  // ── Manifest ─────────────────────────────────────────────────────────────────────────────
  const manifest = {
    $comment:
      "Generated by scripts/deploy/deploy.ts. Every address below was read back from the chain and " +
      "its runtime code hash computed from what the chain returned, not from the local artifact.",
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
      delaySeconds: Number(GOVERNANCE_DELAY_SECONDS),
      note:
        "Chain id 1 enforces a seven-day minimum on chain regardless of this value. On a testnet a " +
        "week would make the deployment untestable, so a shorter delay is chosen and recorded here " +
        "rather than assumed from another deployment's source.",
    },
    external: SEPOLIA,
    route: { routeId, ...routeConfig },
    registrationIds: { usdc: usdcRegistrationId, weth: wethRegistrationId },
    contracts: deployed,
    seeded: false,
    seededNote:
      "No Safes, orders, balances or epochs were created. The hackathon brief requires the project " +
      "to work end to end without mock data, and a deploy script that plants demo state is how a " +
      "repository ends up verifying against numbers it wrote itself.",
  };

  mkdirSync(resolve(ROOT, "deployments"), { recursive: true });
  // `JSON.stringify` throws on a bigint rather than coercing it, and constructor arguments are full
  // of them. Without the replacer this fails AFTER every contract is on chain — the deployment
  // succeeds and the record of it does not.
  writeManifest(manifest as unknown as Manifest);
  say(`Manifest written to deployments/${chainId}.json`);

  // ── Helpers that need the clients ────────────────────────────────────────────────────────
  async function send(
    label: string,
    address: Address,
    path: string,
    name: string,
    functionName: string,
    args: readonly unknown[],
  ): Promise<void> {
    const art = artifact(path, name);
    const hash = await wallet.writeContract({
      address,
      abi: art.abi,
      functionName,
      args: args as never,
      account,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted`);
    say(`  ${label.padEnd(28)} ok`);
  }
}

/**
 * A prediction that is merely used is a wiring step that fails silently by pointing at the wrong
 * contract. Asserting it turns that into a loud failure at the one moment somebody is watching.
 */
function assertPredicted(label: string, predicted: Address, actual: Address): void {
  if (predicted.toLowerCase() !== actual.toLowerCase()) {
    throw new Error(
      `${label} was predicted at ${predicted} but deployed to ${actual}. The deployment order in ` +
        "this script no longer matches the nonces it assumes, and every contract wired against the " +
        "prediction is now pointing at nothing. Nothing further has been deployed.",
    );
  }
}

/**
 * `keccak256(abi.encode(chainid, registry, underlying, wrapper))` — the id `queueRegistration`
 * computes on chain.
 *
 * Built with viem's encoder rather than by hand. A hand-rolled concatenation is correct right up
 * until one argument's type changes, and then it produces a plausible id that matches nothing.
 */
function encodeRegistrationId(
  chainId: number,
  registry: Address,
  underlying: Address,
  wrapper: Address,
): Hex {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }],
    [BigInt(chainId), registry, underlying, wrapper],
  );
}

/** `keccak256(abi.encode(chainid, base, quote, pool))` — `routeIdFor` on chain. */
function encodeRouteId(chainId: number, base: Address, quote: Address, pool: Address): Hex {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }],
    [BigInt(chainId), base, quote, pool],
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
