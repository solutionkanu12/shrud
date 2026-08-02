"use client";

/**
 * Submitting a confidential order from the browser.
 *
 * Three encrypted fields, two transactions and one signature:
 *
 *   1. encrypt amount, action and limit against the Nox gateway
 *   2. `submitIntent` writes the header and the three handles
 *   3. `activateIntent` locks the funds, against a Safe owner signature
 *
 * `submitIntent` alone does nothing but record. An order that is never activated holds no funds and
 * clears nothing, which is why the flow does not stop after the first transaction.
 */

import { createShrudClient, type OrderDraft } from "@shrud/sdk";
import { createViemHandleClient } from "@iexec-nox/handle";
import { type Address, encodeAbiParameters, type Hex, keccak256, zeroAddress } from "viem";

import intentBookArtifact from "../../../../artifacts/contracts/intents/ShrudIntentBook.sol/ShrudIntentBook.json";
import { CHAIN_ID, contractAddress, EXTERNAL, ROUTE } from "./deployment";

export const intentBookAbi = intentBookArtifact.abi;

/** Mirrors `ShrudOrderFamily`. Buy and sell are the only two this interface offers. */
export const ACTION = { BUY_BASE: 1, SELL_BASE: 2, HOLD: 5 } as const;

/** Quote units per WHOLE base unit, scaled. Mirrors `ShrudOrderFamily.PRICE_SCALE`. */
export const PRICE_SCALE = 10n ** 18n;

/** `keccak256("shrud.family.USDC_WETH_ALLOCATION_V1")`, the only family the module accepts. */
export const ORDER_FAMILY = keccak256(
  new TextEncoder().encode("shrud.family.USDC_WETH_ALLOCATION_V1"),
) as Hex;

/**
 * How long one epoch's window lasts, in seconds.
 *
 * THIS IS AN INTERFACE CONVENTION, NOT A PROTOCOL RULE. `openEpoch` takes any bytes32 the caller
 * chooses and there is no `currentEpoch()` getter, so something has to decide which epoch an order
 * joins. Orders that pick different ids never meet, and orders that pick the same one clear together
 * — so the choice has to be deterministic and shared, not random per submission.
 *
 * One hour, because `maxStaleness` on the reference price is one hour. An epoch wider than the price
 * it clears against could not be sealed with a fresh snapshot anyway.
 */
export const EPOCH_WINDOW_SECONDS = 3600;

/** The epoch a submission made now belongs to. Same input, same id, for every participant. */
export function currentEpochId(atSeconds: number = Math.floor(Date.now() / 1000)): Hex {
  const bucket = BigInt(Math.floor(atSeconds / EPOCH_WINDOW_SECONDS));
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [ORDER_FAMILY, BigInt(CHAIN_ID), bucket],
    ),
  );
}

export const EPOCH_STATUS = { None: 0, Open: 1 } as const;

/** The wrappers an epoch clears between, and the asset each side pays in. */
export const BASE_WRAPPER = () => contractAddress("ShrudWrappedWETH");
export const QUOTE_WRAPPER = () => contractAddress("ShrudWrappedUSDC");

/**
 * A buy pays quote (USDC), a sell pays base (WETH).
 *
 * `inputAsset` is the UNDERLYING, not the wrapper — `submitIntent` resolves the wrapper from the
 * asset registry itself, and handing it a wrapper address would fail that lookup.
 */
export function inputAssetFor(side: "buy" | "sell"): Address {
  const asset = side === "buy" ? EXTERNAL["usdc"] : EXTERNAL["weth"];
  if (asset === undefined) throw new Error("the manifest is missing a token address");
  return asset;
}

export interface BuiltOrder {
  readonly draft: OrderDraft;
  readonly intentId: Hex;
  readonly commitment: Hex;
  readonly inputs: readonly { handle: Hex; proof: Hex }[];
}

/**
 * Encrypts one order and returns everything `submitIntent` needs.
 *
 * ORDER OF ENCRYPTION IS FIXED — amount, action, limit. The module imports the three handles
 * positionally and consumes each as it goes, so a reordered set fails inside NoxCompute as a
 * proof/handle mismatch rather than as anything a caller could read. The SDK's `encryptOrder`
 * owns that ordering; this function does not reimplement it.
 */
export async function buildOrder(params: {
  walletClient: unknown;
  publicClient: unknown;
  safe: Address;
  module: Address;
  side: "buy" | "sell";
  amount: bigint;
  limit: bigint;
  epochId: Hex;
  expirySeconds: number;
  /** Sequential per owner, read from the module. A timestamp here reverts WrongNonce. */
  nonce: bigint;
}): Promise<BuiltOrder> {
  const noxSdk = await createViemHandleClient(params.walletClient as never);

  const client = createShrudClient({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: params.publicClient as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    walletClient: params.walletClient as any,
    noxSdk: noxSdk as never,
    chainId: CHAIN_ID,
    deployment: {
      moduleFactory: contractAddress("ShrudModuleFactory"),
      intentBook: contractAddress("ShrudIntentBook"),
      assetRegistry: contractAddress("ShrudAssetRegistry"),
      clearingEngine: contractAddress("ShrudClearingEngine"),
      clearingVault: contractAddress("ShrudClearingVault"),
      settlementEngine: contractAddress("ShrudSettlementEngine"),
      priceRegistry: contractAddress("ShrudReferencePriceRegistry"),
      adapterRegistry: contractAddress("ShrudAdapterRegistry"),
      positionLedger: contractAddress("ShrudPositionLedger"),
      capsuleFactory: contractAddress("ShrudCapsuleFactory"),
      emergencyExit: contractAddress("ShrudEmergencyExit"),
      pauseController: contractAddress("ShrudPauseController"),
    },
  });

  // Local randomness, so the commitment binds to THIS draft and nothing else. Two identical orders
  // from one Safe must not produce one commitment.
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const draft: OrderDraft = {
    safe: params.safe,
    module: params.module,
    orderFamily: ORDER_FAMILY,
    inputAsset: inputAssetFor(params.side),
    epochId: params.epochId,
    expiry: BigInt(Math.floor(Date.now() / 1000) + params.expirySeconds),
    nonce: params.nonce,
    action: params.side === "buy" ? ACTION.BUY_BASE : ACTION.SELL_BASE,
    amount: params.amount,
    limit: params.limit,
    salt: `0x${Array.from(salt, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex,
  };

  const { inputs, commitment, intentId } = await client.encryptOrder(draft);
  return {
    draft,
    intentId,
    commitment,
    inputs: inputs.map((i) => ({ handle: i.handle as Hex, proof: i.proof })),
  };
}

/** The header `submitIntent` takes. Every field here is public from the moment it is written. */
export function headerFor(built: BuiltOrder): {
  orderFamily: Hex;
  inputAsset: Address;
  epochId: Hex;
  expiry: bigint;
  nonce: bigint;
  commitment: Hex;
} {
  return {
    orderFamily: built.draft.orderFamily,
    inputAsset: built.draft.inputAsset,
    epochId: built.draft.epochId,
    expiry: built.draft.expiry,
    nonce: built.draft.nonce,
    commitment: built.commitment,
  };
}

/** Mirrors `ShrudSafeModule.SHRUD_INTENT_TYPEHASH`, for the activation signature. */
export const INTENT_TYPES = {
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
} as const;

export const SCHEMA_VERSION = 1;

export function intentDomain(module: Address) {
  return { name: "shrud", version: "1", chainId: CHAIN_ID, verifyingContract: module } as const;
}

export { ROUTE, zeroAddress };
