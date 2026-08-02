/**
 * Drives a full clearing epoch on live Sepolia, from three treasuries to a published residual.
 *
 * WHY THREE. `EPOCH_FLOOR_K` is 3. An epoch below the floor computes normally and then refuses to
 * publish its aggregate, because an aggregate over one or two participants is those participants'
 * orders in plain sight. Demonstrating clearing therefore needs three, and this script creates the
 * two that `prove-order.ts` did not.
 *
 * ALL THREE ARE OWNED BY ONE KEY. That is a property of this rehearsal, not of the protocol. Three
 * addresses controlled by one signer are not three independent treasuries, and anyone presenting
 * this should say so rather than imply otherwise.
 *
 * RESUMABLE. State is in .prove-clearing.json, which is gitignored.
 *
 *   DEPLOY_SEPOLIA=true pnpm tsx scripts/ops/prove-clearing.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  type Hex,
  http,
  keccak256,
  parseUnits,
  toBytes,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { assertBroadcastAllowed, deployerPrivateKey, loadEnv, rpcUrl, say } from "../lib/env.js";

const STATE = ".prove-clearing.json";
const manifest = JSON.parse(readFileSync("deployments/11155111.json", "utf8"));
const lock = JSON.parse(readFileSync("source-lock.json", "utf8")).safe.sepolia;
const artifact = (p: string, n: string) =>
  JSON.parse(readFileSync(`artifacts/contracts/${p}/${n}.json`, "utf8"));

const factoryAbi = artifact("accounts/ShrudModuleFactory.sol", "ShrudModuleFactory").abi;
const moduleAbi = artifact("accounts/ShrudSafeModule.sol", "ShrudSafeModule").abi;
const engineAbi = artifact("clearing/ShrudClearingEngine.sol", "ShrudClearingEngine").abi;
const bookAbi = artifact("intents/ShrudIntentBook.sol", "ShrudIntentBook").abi;

const SAFE_ABI = [
  { type: "function", name: "setup", stateMutability: "nonpayable", inputs: [ { name: "_owners", type: "address[]" }, { name: "_threshold", type: "uint256" }, { name: "to", type: "address" }, { name: "data", type: "bytes" }, { name: "fallbackHandler", type: "address" }, { name: "paymentToken", type: "address" }, { name: "payment", type: "uint256" }, { name: "paymentReceiver", type: "address" } ], outputs: [] },
  { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isModuleEnabled", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "enableModule", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "setModuleGuard", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "execTransaction", stateMutability: "payable", inputs: [ { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "signatures", type: "bytes" } ], outputs: [{ type: "bool" }] },
] as const;

const PROXY_FACTORY_ABI = [
  { type: "function", name: "createProxyWithNonce", stateMutability: "nonpayable", inputs: [ { name: "_singleton", type: "address" }, { name: "initializer", type: "bytes" }, { name: "saltNonce", type: "uint256" } ], outputs: [{ name: "proxy", type: "address" }] },
  { type: "event", name: "ProxyCreation", inputs: [ { name: "proxy", type: "address", indexed: true }, { name: "singleton", type: "address", indexed: false } ] },
] as const;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const FAUCET = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D" as Address;
const FAUCET_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [ { name: "token", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" } ], outputs: [{ type: "uint256" }] },
] as const;

const ORDER_FAMILY = keccak256(toBytes("shrud.family.USDC_WETH_ALLOCATION_V1"));

interface Treasury { safe: Address; module: Address; guard: Address; intentId?: Hex }
interface State { epochId?: Hex; treasuries: Treasury[]; sealed?: boolean }
const load = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { treasuries: [] });
const save = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2));

async function main(): Promise<void> {
  loadEnv();
  assertBroadcastAllowed();

  const account = privateKeyToAccount(deployerPrivateKey());
  const transport = http(rpcUrl());
  const pub = createPublicClient({ chain: sepolia, transport });
  const wallet = createWalletClient({ account, chain: sepolia, transport });
  const state = load();

  const spend = async (label: string, hash: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash });
    say(`    ${label}: ${r.status}`);
    if (r.status !== "success") throw new Error(`${label} reverted`);
    return r;
  };

  say(`deployer ${account.address}`);
  say(`balance  ${formatEther(await pub.getBalance({ address: account.address }))} ETH`);

  // Everything joins ONE epoch. The hourly bucket is only a default for the app; here it is fixed
  // so three treasuries provably land together rather than straddling an hour boundary.
  if (state.epochId === undefined) {
    state.epochId = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "string" }, { type: "uint256" }],
        [ORDER_FAMILY, "prove-clearing", BigInt(Math.floor(Date.now() / 1000))],
      ),
    );
    save(state);
  }
  const epochId = state.epochId;
  say(`epoch    ${epochId}`);

  const book = manifest.contracts.ShrudIntentBook.address as Address;
  const engine = manifest.contracts.ShrudClearingEngine.address as Address;
  const usdc = manifest.external.usdc as Address;

  const record = (await pub.readContract({ address: book, abi: bookAbi, functionName: "epochOf", args: [epochId] })) as { status: number };
  if (record.status === 0) {
    say("\nopening the epoch");
    await spend("openEpoch", await wallet.writeContract({
      address: engine, abi: engineAbi, functionName: "openEpoch",
      args: [epochId, ORDER_FAMILY, manifest.contracts.ShrudWrappedWETH.address, manifest.contracts.ShrudWrappedUSDC.address],
    }));
  }

  // ── three treasuries ──────────────────────────────────────────────────────────────────────────
  for (let i = state.treasuries.length; i < 3; i++) {
    say(`\n── treasury ${i + 1} ──`);
    const initializer = encodeFunctionData({
      abi: SAFE_ABI, functionName: "setup",
      args: [[account.address], 1n, zeroAddress, "0x", lock.CompatibilityFallbackHandler as Address, zeroAddress, 0n, zeroAddress],
    });
    const created = await spend("createProxy", await wallet.writeContract({
      address: lock.SafeProxyFactory as Address, abi: PROXY_FACTORY_ABI,
      functionName: "createProxyWithNonce", args: [lock.Safe as Address, initializer, BigInt(Date.now()) + BigInt(i)],
    }));
    let safe: Address | undefined;
    for (const log of created.logs) {
      try {
        const d = decodeEventLog({ abi: PROXY_FACTORY_ABI, data: log.data, topics: log.topics });
        if (d.eventName === "ProxyCreation") safe = (d.args as { proxy: Address }).proxy;
      } catch { /* not ours */ }
    }
    if (safe === undefined) throw new Error("no ProxyCreation event");

    const [module, guard] = (await pub.readContract({ address: manifest.contracts.ShrudModuleFactory.address, abi: factoryAbi, functionName: "predictAddresses", args: [safe] })) as [Address, Address];
    await spend("deployModule", await wallet.writeContract({ address: manifest.contracts.ShrudModuleFactory.address, abi: factoryAbi, functionName: "deployModule", args: [safe] }));

    const ownerSig = `0x${account.address.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}01` as Hex;
    const selfCall = async (label: string, data: Hex) => spend(label, await wallet.writeContract({
      address: safe!, abi: SAFE_ABI, functionName: "execTransaction",
      args: [safe!, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, ownerSig],
    }));
    await selfCall("enableModule", encodeFunctionData({ abi: SAFE_ABI, functionName: "enableModule", args: [module] }));
    await selfCall("setModuleGuard", encodeFunctionData({ abi: SAFE_ABI, functionName: "setModuleGuard", args: [guard] }));

    await spend("faucet", await wallet.writeContract({ address: FAUCET, abi: FAUCET_ABI, functionName: "mint", args: [usdc, safe, parseUnits("1000", 6)] }));

    const safeNonce = (await pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "nonce" })) as bigint;
    const operatorUntil = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const shieldSig = await account.signTypedData({
      domain: { name: "shrud", version: "1", chainId: 11155111, verifyingContract: module },
      types: { ShrudShield: [ { name: "safe", type: "address" }, { name: "underlying", type: "address" }, { name: "amount", type: "uint256" }, { name: "operatorUntil", type: "uint48" }, { name: "safeNonce", type: "uint256" } ] },
      primaryType: "ShrudShield",
      message: { safe, underlying: usdc, amount: parseUnits("500", 6), operatorUntil, safeNonce },
    });
    await spend("shield", await wallet.writeContract({ address: module, abi: moduleAbi, functionName: "shield", args: [usdc, parseUnits("500", 6), operatorUntil, shieldSig] }));

    state.treasuries.push({ safe, module, guard });
    save(state);
    say(`    safe ${safe}`);
  }

  // ── one order each, all into the same epoch ───────────────────────────────────────────────────
  const { createShrudClient } = await import("../../packages/sdk/dist/index.js");
  const { createViemHandleClient } = await import("@iexec-nox/handle");
  const noxSdk = await createViemHandleClient(wallet as never);
  const deployment = {
    moduleFactory: manifest.contracts.ShrudModuleFactory.address,
    intentBook: book, assetRegistry: manifest.contracts.ShrudAssetRegistry.address,
    clearingEngine: engine, clearingVault: manifest.contracts.ShrudClearingVault.address,
    settlementEngine: manifest.contracts.ShrudSettlementEngine.address,
    priceRegistry: manifest.contracts.ShrudReferencePriceRegistry.address,
    adapterRegistry: manifest.contracts.ShrudAdapterRegistry.address,
    positionLedger: manifest.contracts.ShrudPositionLedger.address,
    capsuleFactory: manifest.contracts.ShrudCapsuleFactory.address,
    emergencyExit: manifest.contracts.ShrudEmergencyExit.address,
    pauseController: manifest.contracts.ShrudPauseController.address,
  };
  const client = createShrudClient({ publicClient: pub as never, walletClient: wallet as never, noxSdk: noxSdk as never, chainId: 11155111, deployment });

  for (const [i, t] of state.treasuries.entries()) {
    if (t.intentId !== undefined) { say(`\ntreasury ${i + 1}: order already submitted`); continue; }
    say(`\ntreasury ${i + 1}: submitting an order`);
    const nonce = (await pub.readContract({ address: t.module, abi: moduleAbi, functionName: "nextNonce", args: [account.address] })) as bigint;
    const draft = {
      safe: t.safe, module: t.module, orderFamily: ORDER_FAMILY, inputAsset: usdc, epochId,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 7200), nonce,
      action: 1, amount: parseUnits("100", 6), limit: 10n ** 30n,
      salt: keccak256(toBytes(`clearing-${i}-${Date.now()}`)),
    };
    const { inputs, commitment, intentId } = await client.encryptOrder(draft);
    say(`    encrypted, intentId ${intentId}`);
    await spend("submitIntent", await wallet.writeContract({
      address: t.module, abi: moduleAbi, functionName: "submitIntent",
      args: [ { orderFamily: ORDER_FAMILY, inputAsset: usdc, epochId, expiry: draft.expiry, nonce, commitment },
        inputs[0]!.handle, inputs[0]!.proof, inputs[1]!.handle, inputs[1]!.proof, inputs[2]!.handle, inputs[2]!.proof ],
    }));
    const sig = await account.signTypedData({
      domain: { name: "shrud", version: "1", chainId: 11155111, verifyingContract: t.module },
      types: { ShrudIntent: [ { name: "safe", type: "address" }, { name: "intentId", type: "bytes32" }, { name: "commitment", type: "bytes32" }, { name: "orderFamily", type: "bytes32" }, { name: "epochId", type: "bytes32" }, { name: "inputAsset", type: "address" }, { name: "nonce", type: "uint64" }, { name: "expiry", type: "uint64" }, { name: "schemaVersion", type: "uint16" } ] },
      primaryType: "ShrudIntent",
      message: { safe: t.safe, intentId, commitment, orderFamily: ORDER_FAMILY, epochId, inputAsset: usdc, nonce, expiry: draft.expiry, schemaVersion: 1 },
    });
    await spend("activateIntent", await wallet.writeContract({ address: t.module, abi: moduleAbi, functionName: "activateIntent", args: [intentId, sig] }));
    t.intentId = intentId;
    save(state);
  }

  // ── seal, then run every stage ────────────────────────────────────────────────────────────────
  // STRICTLY SORTED. `ShrudIntentBook.sealEpoch` refuses an unsorted or duplicated set.
  const ids = state.treasuries.map((t) => t.intentId as Hex).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  say(`\nsealing with ${ids.length} candidates`);

  if (state.sealed !== true) {
    await spend("sealEpoch", await wallet.writeContract({
      address: engine, abi: engineAbi, functionName: "sealEpoch",
      args: [epochId, ids, manifest.route.routeId],
    }));
    state.sealed = true;
    save(state);
  } else {
    say("    already sealed");
  }

  const stages: [string, unknown[]][] = [
    ["runClassification", [epochId, 16]],
    ["runAccumulation", [epochId, 16]],
    ["runCrossing", [epochId]],
    ["runAllocation", [epochId, 16]],
    ["runResidual", [epochId, 16]],
    ["publishResidual", [epochId]],
  ];
  for (const [fn, args] of stages) {
    say(`\n${fn}`);
    await spend(fn, await wallet.writeContract({ address: engine, abi: engineAbi, functionName: fn, args }));
    const e = (await pub.readContract({ address: engine, abi: engineAbi, functionName: "epochOf", args: [epochId] })) as { stage: number };
    say(`    stage now ${e.stage}`);
  }

  say("\nEPOCH CLEARED.");
  for (const [i, t] of state.treasuries.entries()) say(`  treasury ${i + 1}: ${t.safe}`);
  say(`  epoch ${epochId}`);
}

main().catch((error: unknown) => {
  console.error("\nFAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
