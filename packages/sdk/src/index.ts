/**
 * `@shrud/sdk` — the public client surface from PRD §26.1.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE ONE RULE THIS PACKAGE ENFORCES
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every function that returns a PRIVATE value decrypts in the caller's process and returns the
 * plaintext to the caller. None of them writes it anywhere — no cache, no log, no telemetry, no
 * error message. Every function that returns a PUBLIC value reads it from the chain.
 *
 * There is deliberately no `getPortfolio()` that mixes the two behind one call. A single function
 * returning both is how a private value ends up in a response body that somebody later logs.
 */

import { type CandidateInput, clearEpoch, planClearing } from "@shrud/clearing-math";
import {
  createHandleClient,
  type EncryptedInput,
  type NoxNetwork,
  type NoxSdkLike,
  resolveNetwork,
  type ShrudHandleClient,
} from "@shrud/nox-client";
import {
  computeIntentId,
  intentDigest,
  packSignatures,
  type SafeScan,
  scanSafe,
} from "@shrud/safe-client";
import {
  type Address,
  type EpochRecord,
  type Handle,
  type Hex,
  type IntentHeader,
  type PrivacyLabel,
  ShrudError,
} from "@shrud/shared";
import { encodeAbiParameters, keccak256, type PublicClient, type WalletClient } from "viem";

export interface ShrudDeployment {
  readonly moduleFactory: Address;
  readonly intentBook: Address;
  readonly assetRegistry: Address;
  readonly clearingEngine: Address;
  readonly clearingVault: Address;
  readonly settlementEngine: Address;
  readonly priceRegistry: Address;
  readonly adapterRegistry: Address;
  readonly positionLedger: Address;
  readonly capsuleFactory: Address;
  readonly emergencyExit: Address;
  readonly pauseController: Address;
}

export interface ShrudClientConfig {
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly deployment: ShrudDeployment;
  readonly noxSdk: NoxSdkLike;
  readonly chainId: number;
  readonly networkOverrides?: Partial<NoxNetwork>;
}

/**
 * One order, before encryption.
 *
 * `action`, `amount` and `limit` become ciphertexts. Everything else is public from submission and
 * the interface says so at the point of entry — PRD §11.3 step 2.
 */
export interface OrderDraft {
  readonly safe: Address;
  readonly module: Address;
  readonly orderFamily: Hex;
  readonly inputAsset: Address;
  readonly epochId: Hex;
  readonly expiry: bigint;
  readonly nonce: bigint;
  /** ENCRYPTED. One of `ACTION.*`. */
  readonly action: number;
  /** ENCRYPTED. Raw units of `inputAsset`. */
  readonly amount: bigint;
  /** ENCRYPTED. Buyer: maximum price. Seller: minimum. Quote-per-base scaled by `PRICE_SCALE`. */
  readonly limit: bigint;
  /** Local randomness. Binds the commitment to this draft and to nothing else. */
  readonly salt: Hex;
}

/** What is public, what is encrypted, and when each changes — rendered before the user signs. */
export interface DisclosurePreview {
  readonly field: string;
  readonly label: PrivacyLabel;
  readonly becomesPublic: "never" | "at-settlement-if-residual" | "immediately";
  readonly note: string;
}

export class ShrudSdkError extends ShrudError {
  constructor(message: string) {
    super(message);
    this.name = "ShrudSdkError";
  }
}

export interface ShrudClient {
  readonly deployment: ShrudDeployment;
  readonly handles: ShrudHandleClient;

  scanSafe(safe: Address): Promise<SafeScan>;
  encryptOrder(
    draft: OrderDraft,
  ): Promise<{ inputs: EncryptedInput[]; commitment: Hex; intentId: Hex }>;
  disclosurePreview(draft: OrderDraft): DisclosurePreview[];
  buildSafeSignatureDigest(draft: OrderDraft, intentId: Hex): Hex;
  decryptPrivateOutcome(handle: Handle): Promise<bigint>;
  previewClearing(
    candidates: readonly CandidateInput[],
    price: bigint,
  ): ReturnType<typeof clearEpoch>;
  planEpoch(candidateCount: number): ReturnType<typeof planClearing>;
}

export function createShrudClient(config: ShrudClientConfig): ShrudClient {
  const network = resolveNetwork(config.chainId, config.networkOverrides ?? {});
  const account = config.walletClient?.account?.address as Address | undefined;

  if (account === undefined) {
    throw new ShrudSdkError(
      "a wallet with an account is required. Every encrypted input binds to an owner address, and " +
        "there is no relayer or server signer that can stand in for one — see the direct-caller rule.",
    );
  }

  const handles = createHandleClient({
    sdk: config.noxSdk,
    network,
    account,
    isAllowedOnChain: async (handle, who) =>
      config.publicClient.readContract({
        address: network.noxCompute,
        abi: [
          {
            type: "function",
            name: "isAllowed",
            inputs: [{ type: "bytes32" }, { type: "address" }],
            outputs: [{ type: "bool" }],
            stateMutability: "view",
          },
        ] as const,
        functionName: "isAllowed",
        args: [handle, who],
      }),
  });

  return {
    deployment: config.deployment,
    handles,

    async scanSafe(safe) {
      return scanSafe(config.publicClient, safe, config.deployment.moduleFactory);
    },

    /**
     * Encrypts the three private fields and computes the commitment.
     *
     * ORDER MATTERS AND IS FIXED: amount, action, limit. `ShrudSafeModule.submitIntent` imports them
     * in that order and consumes each handle as it goes, so a reordered set produces a proof/handle
     * mismatch inside NoxCompute rather than a readable error here.
     */
    async encryptOrder(draft) {
      const inputs = await handles.encryptAll(
        [
          { value: draft.amount, type: "euint256" },
          { value: BigInt(draft.action), type: "euint16" },
          { value: draft.limit, type: "euint256" },
        ],
        draft.module,
      );

      const commitment = commitToDraft(draft);
      const intentId = computeIntentId({
        chainId: config.chainId,
        module: draft.module,
        safe: draft.safe,
        commitment,
        orderFamily: draft.orderFamily,
        epochId: draft.epochId,
        inputAsset: draft.inputAsset,
        nonce: draft.nonce,
        expiry: draft.expiry,
      });

      return { inputs, commitment, intentId };
    },

    /**
     * The exact disclosure boundary for this order — PRD §17.8.
     *
     * Rendered before the user signs, not in a help page. "Your side, amount and limit stay
     * encrypted; only the epoch's NET residual reaches Uniswap" is the product's central claim, and
     * a claim the user reads after signing is not a boundary they agreed to.
     */
    disclosurePreview(draft) {
      return [
        {
          field: "Safe address",
          label: "public",
          becomesPublic: "immediately",
          note: "Your Safe, its owners and its threshold are already public on chain.",
        },
        {
          field: "Order family",
          label: "public",
          becomesPublic: "immediately",
          note: `Entering ${draft.orderFamily.slice(0, 10)}… says only that you submitted something in this pair this epoch.`,
        },
        {
          field: "Side (buy, sell, supply, hold)",
          label: "encrypted",
          becomesPublic: "never",
          note: "Which of the four actions you chose is a ciphertext before and after settlement.",
        },
        {
          field: "Amount",
          label: "encrypted",
          becomesPublic: "never",
          note: "Your amount is never published. Only the epoch's net residual becomes public.",
        },
        {
          field: "Private limit",
          label: "encrypted",
          becomesPublic: "never",
          note: "Compared against the sealed price inside Nox. The comparison produces a ciphertext.",
        },
        {
          field: "Net residual sent to the venue",
          label: "aggregate-reveal",
          becomesPublic: "at-settlement-if-residual",
          note: "If both sides cross fully, no venue is called at all and nothing is revealed.",
        },
        {
          field: "Your final allocation",
          label: "viewer-only",
          becomesPublic: "never",
          note: "Readable by your Safe's current owners. Not by shrud, not by any server.",
        },
      ];
    },

    buildSafeSignatureDigest(draft, intentId) {
      return intentDigest({
        chainId: config.chainId,
        module: draft.module,
        safe: draft.safe,
        intentId,
        commitment: commitToDraft(draft),
        orderFamily: draft.orderFamily,
        epochId: draft.epochId,
        inputAsset: draft.inputAsset,
        nonce: draft.nonce,
        expiry: draft.expiry,
      });
    },

    async decryptPrivateOutcome(handle) {
      return handles.decrypt(handle);
    },

    previewClearing(candidates, price) {
      return clearEpoch(candidates, price);
    },

    planEpoch(candidateCount) {
      return planClearing(candidateCount);
    },
  };
}

export { packSignatures, type SafeScan };
export type { CandidateInput, EncryptedInput, EpochRecord, IntentHeader };

/**
 * The commitment Shrud Lens recomputes before signing.
 *
 * CANONICAL BYTES, NOT JSON. Two encoders that disagree about field order, number formatting or key
 * ordering produce two different commitments from one order — and the failure would look like a
 * tampered order rather than an encoding difference. `abi.encode` over a fixed tuple has exactly one
 * representation, and the Snap uses this same function rather than its own.
 */
export function commitToDraft(draft: OrderDraft): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint16" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        draft.safe,
        draft.module,
        draft.orderFamily,
        draft.epochId,
        draft.inputAsset,
        draft.nonce,
        draft.expiry,
        draft.action,
        draft.amount,
        draft.limit,
        draft.salt,
      ],
    ),
  );
}
