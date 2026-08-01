/**
 * `@shrud/safe-client` — reading a Safe, building shrud's digests, and packing signatures.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * WHY SIGNATURE PACKING IS ITS OWN PROBLEM
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Safe's `checkNSignatures` walks the packed blob assuming the recovered owners are in STRICTLY
 * ASCENDING address order:
 *
 *     if (currentOwner <= lastOwner || owners[currentOwner] == 0) revert GS026
 *
 * So a correct set of signatures from a sufficient number of real owners is REJECTED if they are
 * concatenated in the order they were collected. Collection order is whatever order humans signed
 * in, which is never sorted. This is the most common way a Safe integration fails, and the error
 * — `GS026` — names neither ordering nor the offending owner.
 *
 * {packSignatures} sorts. It is one function, used everywhere, so the ordering rule has exactly one
 * implementation and cannot be forgotten at one call site.
 */

import {
  type Address,
  type Hex,
  MODULE_GUARD_STORAGE_SLOT,
  SAFE_VERSION_REQUIRED,
  ShrudError,
} from "@shrud/shared";
import { encodeAbiParameters, encodePacked, keccak256, type PublicClient } from "viem";

export class SafeClientError extends ShrudError {
  constructor(message: string) {
    super(message);
    this.name = "SafeClientError";
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Signature packing
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface OwnerSignature {
  readonly owner: Address;
  /** 65 bytes: r ‖ s ‖ v. For an EIP-1271 owner, v is 0 and r carries the contract address. */
  readonly signature: Hex;
}

/**
 * Packs owner signatures in the order Safe requires.
 *
 * SORTS BY OWNER ADDRESS, ASCENDING. See the module header: this is not a convenience, it is the
 * difference between a valid authorisation and `GS026`.
 *
 * Duplicates are refused rather than silently deduplicated. Two signatures from one owner is either
 * a collection bug or an attempt to satisfy a threshold with one key, and both deserve to be loud.
 */
export function packSignatures(signatures: readonly OwnerSignature[]): Hex {
  if (signatures.length === 0) throw new SafeClientError("no signatures to pack");

  const sorted = [...signatures].sort((a, b) =>
    BigInt(a.owner.toLowerCase()) < BigInt(b.owner.toLowerCase()) ? -1 : 1,
  );

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous === undefined || current === undefined) continue;
    if (previous.owner.toLowerCase() === current.owner.toLowerCase()) {
      throw new SafeClientError(
        `owner ${current.owner} signed twice. Safe counts each owner once, so this either drops a ` +
          "signature silently or is an attempt to satisfy a threshold with one key.",
      );
    }
  }

  for (const entry of sorted) {
    const bytes = (entry.signature.length - 2) / 2;
    if (bytes !== 65) {
      throw new SafeClientError(
        `signature from ${entry.owner} is ${bytes} bytes; Safe reads fixed 65-byte slots and a ` +
          "short one silently misaligns every signature after it",
      );
    }
  }

  return `0x${sorted.map((s) => s.signature.slice(2)).join("")}` as Hex;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Digests — recomputed by Shrud Lens before anything is signed
// ═════════════════════════════════════════════════════════════════════════════════════════════

const EIP712_DOMAIN_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);

const SHRUD_INTENT_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "ShrudIntent(address safe,bytes32 intentId,bytes32 commitment,bytes32 orderFamily,bytes32 epochId,address inputAsset,uint64 nonce,uint64 expiry,uint16 schemaVersion)",
  ),
);

export const SHRUD_SCHEMA_VERSION = 1;

/** Mirrors `ShrudSafeModule.domainSeparator`, computed once at deployment. */
export function shrudDomainSeparator(chainId: number, module: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(new TextEncoder().encode("shrud")),
        keccak256(new TextEncoder().encode("1")),
        BigInt(chainId),
        module,
      ],
    ),
  );
}

export interface IntentDigestInput {
  readonly chainId: number;
  readonly module: Address;
  readonly safe: Address;
  readonly intentId: Hex;
  readonly commitment: Hex;
  readonly orderFamily: Hex;
  readonly epochId: Hex;
  readonly inputAsset: Address;
  readonly nonce: bigint;
  readonly expiry: bigint;
}

/**
 * The exact digest a Safe owner signs to activate an order.
 *
 * EVERY FIELD IS PART OF THE REPLAY BOUNDARY (PRD §20.7). Drop any one and a signature collected for
 * one order becomes reusable for another that differs only in that field. Shrud Lens recomputes this
 * locally and refuses to sign if it does not match what the chain holds — which is the check that
 * makes a compromised frontend unable to swap the order under a signer.
 */
export function intentDigest(input: IntentDigestInput): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint16" },
      ],
      [
        SHRUD_INTENT_TYPEHASH,
        input.safe,
        input.intentId,
        input.commitment,
        input.orderFamily,
        input.epochId,
        input.inputAsset,
        input.nonce,
        input.expiry,
        SHRUD_SCHEMA_VERSION,
      ],
    ),
  );
  return keccak256(
    encodePacked(
      ["bytes2", "bytes32", "bytes32"],
      ["0x1901", shrudDomainSeparator(input.chainId, input.module), structHash],
    ),
  );
}

/** Mirrors `ShrudSafeModule.computeIntentId`. Derivable before submission, for Lens to check. */
export function computeIntentId(input: Omit<IntentDigestInput, "intentId">): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "uint16" },
      ],
      [
        BigInt(input.chainId),
        input.safe,
        input.module,
        input.orderFamily,
        input.epochId,
        input.inputAsset,
        input.nonce,
        input.expiry,
        input.commitment,
        SHRUD_SCHEMA_VERSION,
      ],
    ),
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Reads
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SAFE_ABI = [
  {
    type: "function",
    name: "VERSION",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getOwners",
    inputs: [],
    outputs: [{ type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getThreshold",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nonce",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isModuleEnabled",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
] as const;

export interface SafeScan {
  readonly address: Address;
  readonly version: string;
  readonly owners: readonly Address[];
  readonly threshold: bigint;
  readonly nonce: bigint;
  readonly moduleGuard: Address;
  readonly moduleEnabled: boolean;
  /** Every reason this Safe cannot host shrud, in plain words the onboarding flow renders verbatim. */
  readonly blockers: readonly string[];
}

/**
 * Reads everything the onboarding flow needs, and says plainly what would stop an installation.
 *
 * THE VERSION CHECK IS A BLOCKER, NOT A WARNING — delta D-1. And the reason is worse than "the
 * function is missing": Safe 1.4.1's fallback handler SWALLOWS `setModuleGuard` and reports success,
 * so an installer that watched for a revert would report a guard that is not there and leave a module
 * with unlimited authority over the Safe.
 */
export async function scanSafe(
  client: PublicClient,
  safe: Address,
  module?: Address,
): Promise<SafeScan> {
  const [version, owners, threshold, nonce] = await Promise.all([
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: "VERSION" }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: "getThreshold" }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: "nonce" }),
  ]);

  const moduleGuard = await readModuleGuard(client, safe);
  const moduleEnabled =
    module === undefined
      ? false
      : await client.readContract({
          address: safe,
          abi: SAFE_ABI,
          functionName: "isModuleEnabled",
          args: [module],
        });

  const blockers: string[] = [];
  if (version !== SAFE_VERSION_REQUIRED) {
    blockers.push(
      `This Safe is version ${version}. shrud requires ${SAFE_VERSION_REQUIRED}, because module ` +
        "guards do not exist before it — and Safe 1.4.1 does not refuse the call to install one, it " +
        "silently accepts it and installs nothing. A shrud module there would run with unlimited " +
        "authority over this Safe and no boundary at all.",
    );
  }
  if (owners.length === 0) blockers.push("This Safe has no owners.");
  if (threshold === 0n) blockers.push("This Safe has a threshold of zero.");

  return {
    address: safe,
    version,
    owners: owners as readonly Address[],
    threshold,
    nonce,
    moduleGuard,
    moduleEnabled,
    blockers,
  };
}

/**
 * Reads the installed module guard from raw storage.
 *
 * `ModuleManager.getModuleGuard()` is `internal`, so there is no getter and this is the only way to
 * ask on chain. The slot is `keccak256("module_manager.module_guard.address")`, quoted from Safe's
 * own source rather than recomputed — a recomputation in a second place is a second source of truth.
 */
export async function readModuleGuard(client: PublicClient, safe: Address): Promise<Address> {
  const word = await client.getStorageAt({ address: safe, slot: MODULE_GUARD_STORAGE_SLOT });
  if (word === undefined) return "0x0000000000000000000000000000000000000000";
  return `0x${word.slice(-40)}` as Address;
}

/**
 * Whether a shrud installation is COMPLETE.
 *
 * All three, because any two without the third is a broken installation that looks fine: a deployed
 * module that is not enabled does nothing; an enabled module with no guard has unlimited authority;
 * a guard with no module enabled guards nothing. The onboarding flow shows one verdict rather than
 * three checkboxes.
 */
export function isFullyInstalled(scan: SafeScan, expectedGuard: Address): boolean {
  return (
    scan.blockers.length === 0 &&
    scan.moduleEnabled &&
    scan.moduleGuard.toLowerCase() === expectedGuard.toLowerCase()
  );
}
