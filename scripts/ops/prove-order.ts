/**
 * Proves the whole order path against live Sepolia, end to end.
 *
 * Creates a Safe 1.5.0, installs the module, funds and wraps, then submits and activates one real
 * confidential order. It is the only way to find out whether the browser submission path works,
 * because every step before the gateway call can pass while the gateway itself refuses.
 *
 * RESUMABLE. Each stage reads chain state first and skips what is already done, so a failure at
 * stage 6 does not throw away the five transactions before it. State lives in .prove-order.json,
 * which is gitignored.
 *
 *   DEPLOY_SEPOLIA=true pnpm tsx scripts/ops/prove-order.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  type Hex,
  http,
  parseUnits,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { assertBroadcastAllowed, deployerPrivateKey, loadEnv, rpcUrl, say } from "../lib/env.js";

const STATE = ".prove-order.json";
const manifest = JSON.parse(readFileSync("deployments/11155111.json", "utf8"));
const lock = JSON.parse(readFileSync("source-lock.json", "utf8")).safe.sepolia;

const artifact = (path: string, name: string) =>
  JSON.parse(readFileSync(`artifacts/contracts/${path}/${name}.json`, "utf8"));

const factoryAbi = artifact("accounts/ShrudModuleFactory.sol", "ShrudModuleFactory").abi;
const moduleAbi = artifact("accounts/ShrudSafeModule.sol", "ShrudSafeModule").abi;

const SAFE_ABI = [
  {
    type: "function",
    name: "setup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
  { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "isModuleEnabled",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
  },
  { type: "function", name: "enableModule", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  {
    type: "function",
    name: "setModuleGuard",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const PROXY_FACTORY_ABI = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    type: "event",
    name: "ProxyCreation",
    inputs: [
      { name: "proxy", type: "address", indexed: true },
      { name: "singleton", type: "address", indexed: false },
    ],
  },
] as const;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Aave's Sepolia faucet. `mint` is permissionless and capped per call. */
const FAUCET = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D" as Address;
const FAUCET_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

type State = { safe?: Address; module?: Address; guard?: Address };
const load = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
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
    say(`  ${label}: ${r.status} — https://sepolia.etherscan.io/tx/${hash}`);
    if (r.status !== "success") throw new Error(`${label} reverted`);
    return r;
  };

  say(`deployer ${account.address}`);
  say(`balance  ${formatEther(await pub.getBalance({ address: account.address }))} ETH`);

  // ── 1 · a Safe 1.5.0, threshold 1 ─────────────────────────────────────────────────────────────
  if (state.safe === undefined) {
    say("\n1 · creating a Safe 1.5.0");
    const initializer = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "setup",
      args: [
        [account.address],
        1n,
        zeroAddress,
        "0x",
        lock.CompatibilityFallbackHandler as Address,
        zeroAddress,
        0n,
        zeroAddress,
      ],
    });
    const hash = await wallet.writeContract({
      address: lock.SafeProxyFactory as Address,
      abi: PROXY_FACTORY_ABI,
      functionName: "createProxyWithNonce",
      args: [lock.Safe as Address, initializer, BigInt(Date.now())],
    });
    const receipt = await spend("createProxyWithNonce", hash);
    for (const log of receipt.logs) {
      try {
        const d = decodeEventLog({ abi: PROXY_FACTORY_ABI, data: log.data, topics: log.topics });
        if (d.eventName === "ProxyCreation") state.safe = (d.args as { proxy: Address }).proxy;
      } catch {
        /* not ours */
      }
    }
    if (state.safe === undefined) throw new Error("no ProxyCreation event");
    save(state);
  }
  const safe = state.safe as Address;
  const version = await pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "VERSION" });
  say(`\nsafe     ${safe}  (VERSION ${version})`);
  if (version !== "1.5.0") throw new Error(`created a ${version} Safe; the module will refuse it`);

  // ── 2 · module + guard ────────────────────────────────────────────────────────────────────────
  const [predModule, predGuard] = (await pub.readContract({
    address: manifest.contracts.ShrudModuleFactory.address,
    abi: factoryAbi,
    functionName: "predictAddresses",
    args: [safe],
  })) as [Address, Address];
  state.module = predModule;
  state.guard = predGuard;
  save(state);

  const deployed = (await pub.readContract({
    address: manifest.contracts.ShrudModuleFactory.address,
    abi: factoryAbi,
    functionName: "moduleOf",
    args: [safe],
  })) as Address;

  if (deployed === zeroAddress) {
    say("\n2 · deployModule");
    await spend(
      "deployModule",
      await wallet.writeContract({
        address: manifest.contracts.ShrudModuleFactory.address,
        abi: factoryAbi,
        functionName: "deployModule",
        args: [safe],
      }),
    );
  } else {
    say("\n2 · module already deployed");
  }
  say(`module   ${predModule}`);
  say(`guard    ${predGuard}`);

  // The caller-is-owner signature. Valid only because THIS account sends the transaction.
  const ownerSig = `0x${account.address.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}01` as Hex;
  const selfCall = async (label: string, data: Hex) =>
    spend(
      label,
      await wallet.writeContract({
        address: safe,
        abi: SAFE_ABI,
        functionName: "execTransaction",
        args: [safe, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, ownerSig],
      }),
    );

  const enabled = (await pub.readContract({
    address: safe,
    abi: SAFE_ABI,
    functionName: "isModuleEnabled",
    args: [predModule],
  })) as boolean;
  if (!enabled) {
    say("\n3 · enableModule");
    await selfCall(
      "enableModule",
      encodeFunctionData({ abi: SAFE_ABI, functionName: "enableModule", args: [predModule] }),
    );
  } else {
    say("\n3 · module already enabled");
  }

  const installed = (await pub.readContract({
    address: manifest.contracts.ShrudModuleFactory.address,
    abi: factoryAbi,
    functionName: "isFullyInstalled",
    args: [safe],
  })) as boolean;
  if (!installed) {
    say("\n4 · setModuleGuard");
    await selfCall(
      "setModuleGuard",
      encodeFunctionData({ abi: SAFE_ABI, functionName: "setModuleGuard", args: [predGuard] }),
    );
  } else {
    say("\n4 · guard already set");
  }

  say(
    `\nfully installed: ${await pub.readContract({
      address: manifest.contracts.ShrudModuleFactory.address,
      abi: factoryAbi,
      functionName: "isFullyInstalled",
      args: [safe],
    })}`,
  );

  // ── 5 · fund the Safe with test USDC ──────────────────────────────────────────────────────────
  const usdc = manifest.external.usdc as Address;
  let held = (await pub.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [safe] })) as bigint;
  if (held === 0n) {
    say("\n5 · minting test USDC from the Aave faucet");
    await spend(
      "faucet mint",
      await wallet.writeContract({
        address: FAUCET,
        abi: FAUCET_ABI,
        functionName: "mint",
        args: [usdc, safe, parseUnits("1000", 6)],
      }),
    );
    held = (await pub.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [safe] })) as bigint;
  }
  say(`safe holds ${held} raw USDC`);

  // ── 6 · wrap, through the module's shield ─────────────────────────────────────────────────────
  const wrapper = manifest.contracts.ShrudWrappedUSDC.address as Address;
  const readBacking = async () =>
    (await pub.readContract({
      address: usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wrapper],
    })) as bigint;

  if ((await readBacking()) === 0n) {
    say("\n6 · shield — approve, wrap and setOperator, all from the Safe");
    const safeNonce = (await pub.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: "nonce",
    })) as bigint;
    const operatorUntil = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    const signature = await account.signTypedData({
      domain: { name: "shrud", version: "1", chainId: 11155111, verifyingContract: predModule },
      types: {
        ShrudShield: [
          { name: "safe", type: "address" },
          { name: "underlying", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "operatorUntil", type: "uint48" },
          { name: "safeNonce", type: "uint256" },
        ],
      },
      primaryType: "ShrudShield",
      message: { safe, underlying: usdc, amount: parseUnits("500", 6), operatorUntil, safeNonce },
    });

    await spend(
      "shield",
      await wallet.writeContract({
        address: predModule,
        abi: moduleAbi,
        functionName: "shield",
        args: [usdc, parseUnits("500", 6), operatorUntil, signature],
      }),
    );
  } else {
    say("\n6 · wrapper already backed, skipping shield");
  }
  say(`wrapper backing ${await readBacking()} raw USDC`);

  // ── 7 · one real confidential order ───────────────────────────────────────────────────────────
  const { createShrudClient } = await import("../../packages/sdk/dist/index.js");
  const { createViemHandleClient } = await import("@iexec-nox/handle");
  const { keccak256, encodeAbiParameters, toBytes } = await import("viem");

  const ORDER_FAMILY = keccak256(toBytes("shrud.family.USDC_WETH_ALLOCATION_V1"));
  const bucket = BigInt(Math.floor(Date.now() / 1000 / 3600));
  const epochId = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [ORDER_FAMILY, 11155111n, bucket],
    ),
  );
  say(`\n7 · order — epoch ${epochId}`);

  const bookAbi = artifact("intents/ShrudIntentBook.sol", "ShrudIntentBook").abi;
  const engineAbi = artifact("clearing/ShrudClearingEngine.sol", "ShrudClearingEngine").abi;
  const record = (await pub.readContract({
    address: manifest.contracts.ShrudIntentBook.address,
    abi: bookAbi,
    functionName: "epochOf",
    args: [epochId],
  })) as { status: number };

  if (record.status === 0) {
    say("  opening the epoch");
    await spend(
      "openEpoch",
      await wallet.writeContract({
        address: manifest.contracts.ShrudClearingEngine.address,
        abi: engineAbi,
        functionName: "openEpoch",
        args: [
          epochId,
          ORDER_FAMILY,
          manifest.contracts.ShrudWrappedWETH.address,
          manifest.contracts.ShrudWrappedUSDC.address,
        ],
      }),
    );
  } else {
    say("  epoch already open");
  }

  say("  building the Nox handle client");
  const noxSdk = await createViemHandleClient(wallet as never);
  say("  handle client ready");

  const client = createShrudClient({
    publicClient: pub as never,
    walletClient: wallet as never,
    noxSdk: noxSdk as never,
    chainId: 11155111,
    deployment: {
      moduleFactory: manifest.contracts.ShrudModuleFactory.address,
      intentBook: manifest.contracts.ShrudIntentBook.address,
      assetRegistry: manifest.contracts.ShrudAssetRegistry.address,
      clearingEngine: manifest.contracts.ShrudClearingEngine.address,
      clearingVault: manifest.contracts.ShrudClearingVault.address,
      settlementEngine: manifest.contracts.ShrudSettlementEngine.address,
      priceRegistry: manifest.contracts.ShrudReferencePriceRegistry.address,
      adapterRegistry: manifest.contracts.ShrudAdapterRegistry.address,
      positionLedger: manifest.contracts.ShrudPositionLedger.address,
      capsuleFactory: manifest.contracts.ShrudCapsuleFactory.address,
      emergencyExit: manifest.contracts.ShrudEmergencyExit.address,
      pauseController: manifest.contracts.ShrudPauseController.address,
    },
  });

  // Sequential per owner, read from the module. A timestamp here reverts WrongNonce.
  const nonce = (await pub.readContract({
    address: predModule,
    abi: moduleAbi,
    functionName: "nextNonce",
    args: [account.address],
  })) as bigint;
  say(`  next nonce for ${account.address} is ${nonce}`);

  const draft = {
    safe,
    module: predModule,
    orderFamily: ORDER_FAMILY,
    inputAsset: usdc,
    epochId,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce,
    action: 1, // BUY_BASE
    amount: parseUnits("100", 6),
    limit: 10n ** 30n,
    salt: keccak256(toBytes(`prove-${Date.now()}`)),
  };

  say("  encrypting amount, action and limit against the gateway (three round trips)");
  const { inputs, commitment, intentId } = await client.encryptOrder(draft);
  say(`  encrypted. intentId ${intentId}`);
  for (const [i, input] of inputs.entries()) {
    say(`    handle ${i}: ${input.handle} (proof ${(input.proof.length - 2) / 2} bytes)`);
  }

  say("  submitIntent");
  await spend(
    "submitIntent",
    await wallet.writeContract({
      address: predModule,
      abi: moduleAbi,
      functionName: "submitIntent",
      args: [
        {
          orderFamily: draft.orderFamily,
          inputAsset: draft.inputAsset,
          epochId: draft.epochId,
          expiry: draft.expiry,
          nonce: draft.nonce,
          commitment,
        },
        inputs[0]!.handle,
        inputs[0]!.proof,
        inputs[1]!.handle,
        inputs[1]!.proof,
        inputs[2]!.handle,
        inputs[2]!.proof,
      ],
    }),
  );

  say("  activateIntent");
  const activationSig = await account.signTypedData({
    domain: { name: "shrud", version: "1", chainId: 11155111, verifyingContract: predModule },
    types: {
      ShrudIntent: [
        { name: "safe", type: "address" },
        { name: "intentId", type: "bytes32" },
        { name: "commitment", type: "bytes32" },
        { name: "orderFamily", type: "bytes32" },
        { name: "epochId", type: "bytes32" },
        { name: "inputAsset", type: "address" },
        { name: "nonce", type: "uint64" },
        { name: "expiry", type: "uint64" },
        { name: "schemaVersion", type: "uint16" },
      ],
    },
    primaryType: "ShrudIntent",
    message: {
      safe,
      intentId,
      commitment,
      orderFamily: draft.orderFamily,
      epochId: draft.epochId,
      inputAsset: draft.inputAsset,
      nonce: draft.nonce,
      expiry: draft.expiry,
      schemaVersion: 1,
    },
  });

  await spend(
    "activateIntent",
    await wallet.writeContract({
      address: predModule,
      abi: moduleAbi,
      functionName: "activateIntent",
      args: [intentId, activationSig],
    }),
  );

  const header = await pub.readContract({
    address: manifest.contracts.ShrudIntentBook.address,
    abi: bookAbi,
    functionName: "headerOf",
    args: [intentId],
  });
  say(`\nORDER IS LIVE. Public header: ${JSON.stringify(header, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);

  say("\nAll stages complete.");
  say(`safe   ${safe}`);
  say(`module ${predModule}`);
}

main().catch((error: unknown) => {
  console.error("\nFAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
