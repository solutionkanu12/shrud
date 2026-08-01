/**
 * Deploys and registers the three settlement adapters.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THREE ADAPTERS AND NOT ONE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * An adapter's input token, output token, venue and recipient are constructor IMMUTABLES — there is
 * no `bytes data`, no target parameter and no direction flag, because a settlement path that takes
 * any of those from its caller is a general-purpose call from a vault holding several treasuries'
 * pooled residual.
 *
 * So each direction needs its own contract:
 *
 *   net buy      spend USDC, receive WETH   through SwapRouter02
 *   net sell     spend WETH, receive USDC   through SwapRouter02
 *   supply       spend USDC, receive aUSDC  through the Aave pool
 *
 * Their route ids are direction-specific for the same reason: `ShrudAdapterRegistry` keys one
 * adapter per route id, so three adapters sharing the price route's id would collide on the second
 * registration.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * SEPARATE FROM `deploy.ts` BECAUSE THE ADAPTERS NEED A REGISTERED ROUTE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The reference-price route has to exist before an adapter can name it, and the route is subject to
 * the same governance delay as everything else. Running this after `apply-registrations.ts` is not a
 * convenience — it is the order the timelock imposes.
 */

import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  type Hex,
  http,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import {
  ADAPTER_ROUTE_SUFFIX,
  GOVERNANCE_DELAY_SECONDS,
  MAX_DEADLINE_WINDOW,
  POOL_FEE,
  PROTOCOL_ID,
  SEPOLIA,
} from "../lib/constants.js";
import { artifact, readManifest, writeManifest } from "../lib/deployment.js";
import { assertBroadcastAllowed, deployerPrivateKey, localRpcUrl, rpcUrl, say } from "../lib/env.js";

/** `keccak256(abi.encode(priceRouteId, suffix))`. Direction-specific — see the header. */
function adapterRouteId(priceRouteId: Hex, suffix: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [priceRouteId, toHex(suffix, { size: 32 })],
    ),
  );
}

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

  const need = (name: string): Address => {
    const address = manifest.contracts[name]?.address;
    if (address === undefined) throw new Error(`the manifest is missing ${name}`);
    return address;
  };

  const settlementEngine = need("ShrudSettlementEngine");
  const clearingVault = need("ShrudClearingVault");
  const positionLedger = need("ShrudPositionLedger");
  const adapterRegistry = need("ShrudAdapterRegistry");
  const priceRouteId = manifest.route["routeId"] as Hex;

  const registryAbi = artifact("adapters/ShrudAdapterRegistry.sol", "ShrudAdapterRegistry").abi;
  const ledgerAbi = artifact("settlement/ShrudPositionLedger.sol", "ShrudPositionLedger").abi;

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
    if (address === null || address === undefined) throw new Error(`${label} produced no address`);
    say(`  ${label.padEnd(28)} ${address}`);
    return address;
  }

  // ── The three adapters ──────────────────────────────────────────────────────────────────
  const buyRoute = adapterRouteId(priceRouteId, ADAPTER_ROUTE_SUFFIX.buyBase);
  const sellRoute = adapterRouteId(priceRouteId, ADAPTER_ROUTE_SUFFIX.sellBase);
  const supplyRoute = adapterRouteId(priceRouteId, ADAPTER_ROUTE_SUFFIX.supplyQuote);

  // Net buy: the epoch's unmatched QUOTE goes to Uniswap and comes back as base.
  const buyAdapter = await deploy(
    "UniswapBuyBaseAdapter",
    "adapters/UniswapResidualAdapter.sol",
    "UniswapResidualAdapter",
    [
      buyRoute,
      SEPOLIA.swapRouter02,
      SEPOLIA.usdc,
      SEPOLIA.weth,
      clearingVault,
      POOL_FEE,
      settlementEngine,
    ],
  );

  // Net sell: the unmatched BASE goes to Uniswap and comes back as quote.
  const sellAdapter = await deploy(
    "UniswapSellBaseAdapter",
    "adapters/UniswapResidualAdapter.sol",
    "UniswapResidualAdapter",
    [
      sellRoute,
      SEPOLIA.swapRouter02,
      SEPOLIA.weth,
      SEPOLIA.usdc,
      clearingVault,
      POOL_FEE,
      settlementEngine,
    ],
  );

  // The pooled position: aggregate USDC into Aave, aTokens to the position ledger.
  const aaveAdapter = await deploy(
    "AaveSupplyAdapter",
    "adapters/AaveSupplyAdapter.sol",
    "AaveSupplyAdapter",
    [supplyRoute, SEPOLIA.aavePool, SEPOLIA.usdc, SEPOLIA.aUsdc, positionLedger, settlementEngine],
  );

  // ── Open the pooled position ────────────────────────────────────────────────────────────
  //
  // Opening records an adapter, an asset and an aToken. It grants nothing and holds nothing — every
  // path that moves value still runs through the settlement engine.
  const positionId = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }],
      [BigInt(chainId), SEPOLIA.usdc, SEPOLIA.aavePool],
    ),
  );
  await write("openPosition", positionLedger, ledgerAbi, "openPosition", [
    positionId,
    aaveAdapter,
    SEPOLIA.usdc,
    SEPOLIA.aUsdc,
  ]);

  // ── Queue the three manifests ───────────────────────────────────────────────────────────
  say("");
  say("Queueing adapter registrations. The governance delay applies here too.");

  const manifests = [
    {
      label: "UniswapBuyBaseAdapter",
      adapter: buyAdapter,
      routeId: buyRoute,
      protocolId: keccak256(toHex(PROTOCOL_ID.uniswapV3)),
      venue: SEPOLIA.swapRouter02,
      inputToken: SEPOLIA.usdc,
      outputToken: SEPOLIA.weth,
      fixedRecipient: clearingVault,
    },
    {
      label: "UniswapSellBaseAdapter",
      adapter: sellAdapter,
      routeId: sellRoute,
      protocolId: keccak256(toHex(PROTOCOL_ID.uniswapV3)),
      venue: SEPOLIA.swapRouter02,
      inputToken: SEPOLIA.weth,
      outputToken: SEPOLIA.usdc,
      fixedRecipient: clearingVault,
    },
    {
      label: "AaveSupplyAdapter",
      adapter: aaveAdapter,
      routeId: supplyRoute,
      protocolId: keccak256(toHex(PROTOCOL_ID.aaveV3)),
      venue: SEPOLIA.aavePool,
      inputToken: SEPOLIA.usdc,
      outputToken: SEPOLIA.aUsdc,
      fixedRecipient: positionLedger,
    },
  ] as const;

  const recorded: Record<
    string,
    { address: Address; runtimeCodeHash: Hex; constructorArgs: readonly unknown[]; routeId: Hex }
  > = {};

  for (const entry of manifests) {
    await write("queue " + entry.label, adapterRegistry, registryAbi, "queueAdapter", [
      {
        adapter: entry.adapter,
        // Read at apply time from the chain, so a zero here is correct and not a placeholder.
        codeHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        protocolId: entry.protocolId,
        routeId: entry.routeId,
        venue: entry.venue,
        inputToken: entry.inputToken,
        outputToken: entry.outputToken,
        fixedRecipient: entry.fixedRecipient,
        maxDeadlineWindow: MAX_DEADLINE_WINDOW,
        // Zero, and it is a statement. The aggregate minimum is composed from real private limits,
        // not from a tolerance — any tolerance would settle below a limit some treasury set, and
        // that treasury could never observe it.
        slippageToleranceBps: 0,
        enabled: false,
        registeredAtBlock: 0,
      },
    ]);

    const code = await publicClient.getCode({ address: entry.adapter });
    recorded[entry.label] = {
      address: entry.adapter,
      runtimeCodeHash: keccak256(code ?? "0x"),
      constructorArgs: [],
      routeId: entry.routeId,
    };
  }

  manifest.adapters = recorded;
  manifest["positionId"] = positionId;
  manifest["adapterRoutes"] = { buy: buyRoute, sell: sellRoute, supply: supplyRoute };
  writeManifest(manifest);

  say("");
  say(`Queued. Wait ${GOVERNANCE_DELAY_SECONDS} seconds, then:`);
  say("");
  say("    pnpm tsx scripts/deploy/apply-adapters.ts");
  say("");

  async function write(
    label: string,
    address: Address,
    abi: readonly unknown[],
    functionName: string,
    args: readonly unknown[],
  ): Promise<void> {
    const hash = await wallet.writeContract({
      address,
      abi,
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
