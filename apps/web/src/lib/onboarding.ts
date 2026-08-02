"use client";

/**
 * The three transactions that install shrud on a Safe.
 *
 * `deployModule` is permissionless and deploys the module and its guard, but both stay inert until
 * the Safe's own owners sign `enableModule` and `setModuleGuard` — see ShrudModuleFactory §101. That
 * is three transactions, not one, and the flow says so rather than hiding two of them behind a
 * spinner.
 *
 * Reads reuse `@shrud/safe-client` rather than reimplementing the version check or the module-guard
 * storage slot. A second copy of either is a second thing to get wrong.
 */

import { isFullyInstalled, packSignatures, scanSafe, type SafeScan } from "@shrud/safe-client";
import { useQuery } from "@tanstack/react-query";
import { type Address, encodeFunctionData, type Hex, isAddress, zeroAddress } from "viem";
import { usePublicClient } from "wagmi";

import safeModuleArtifact from "../../../../artifacts/contracts/accounts/ShrudSafeModule.sol/ShrudSafeModule.json";
import sourceLock from "../../../../source-lock.json";
import { CHAIN_ID, contractAddress, EXTERNAL } from "./deployment";
import { moduleFactoryAbi } from "./hooks";

export const safeModuleAbi = safeModuleArtifact.abi;

/**
 * The 1.5.0 singleton, from source-lock rather than retyped.
 *
 * The onboarding copy has to name it, because the Safe interface still defaults to 1.4.1 on Sepolia
 * and a user who follows "create one at app.safe.global" gets a Safe this protocol refuses.
 */
export const SAFE_1_5_0 = {
  singleton: sourceLock.safe.sepolia.Safe as Address,
  proxyFactory: sourceLock.safe.sepolia.SafeProxyFactory as Address,
} as const;

/**
 * The two underlyings this deployment can wrap.
 *
 * Taken from the manifest rather than typed here, so the app cannot drift from the addresses the
 * registry actually enables.
 */
function externalAddress(name: string): Address {
  const found = EXTERNAL[name];
  if (found === undefined) {
    throw new Error(`${name} is not in the deployment manifest. This build cannot wrap it.`);
  }
  return found;
}

export const WRAPPABLE = [
  { symbol: "USDC", address: externalAddress("usdc"), decimals: 6 },
  { symbol: "WETH", address: externalAddress("weth"), decimals: 18 },
] as const;

/**
 * The struct `ShrudSafeModule.shield` verifies before it moves anything — module line 506.
 *
 * `safeNonce` binds the authorisation to the Safe's current nonce, so a signature collected for one
 * state cannot be replayed after the Safe has done something else.
 */
export const SHIELD_TYPES = {
  ShrudShield: [
    { name: "safe", type: "address" },
    { name: "underlying", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "operatorUntil", type: "uint48" },
    { name: "safeNonce", type: "uint256" },
  ],
} as const;

/** Mirrors `ShrudSafeModule.domainSeparator`: name "shrud", version "1", verified by the module. */
export function shieldDomain(module: Address) {
  return {
    name: "shrud",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: module,
  } as const;
}

/** Only the four Safe entry points this flow calls. */
export const SAFE_WRITE_ABI = [
  {
    type: "function",
    name: "enableModule",
    stateMutability: "nonpayable",
    inputs: [{ name: "module", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setModuleGuard",
    stateMutability: "nonpayable",
    inputs: [{ name: "moduleGuard", type: "address" }],
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

/**
 * The pre-validated signature Safe accepts when the OWNER IS THE CALLER.
 *
 * `v = 1` tells Safe to skip ecrecover and accept the signature if `msg.sender` is the owner named in
 * `r`. It is the only way to authorise a threshold-1 Safe from the browser without an off-chain
 * signing round, and it is why this flow refuses thresholds above one rather than pretending.
 */
export function callerIsOwnerSignature(owner: Address): Hex {
  const r = owner.slice(2).toLowerCase().padStart(64, "0");
  const s = "0".repeat(64);
  return `0x${r}${s}01` as Hex;
}

export interface ModulePair {
  readonly module: Address;
  readonly moduleGuard: Address;
}

/** Where this Safe's module and guard will live, whether or not they exist yet. CREATE2, so fixed. */
export function usePredictedAddresses(safe: string) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const valid = isAddress(safe);

  return useQuery<ModulePair>({
    queryKey: ["shrud", "predicted", safe],
    enabled: valid && client !== undefined,
    retry: false,
    queryFn: async () => {
      const [module, moduleGuard] = (await client!.readContract({
        address: contractAddress("ShrudModuleFactory"),
        abi: moduleFactoryAbi,
        functionName: "predictAddresses",
        args: [safe as Address],
      })) as [Address, Address];
      return { module, moduleGuard };
    },
  });
}

export interface SafeStatus {
  readonly scan: SafeScan;
  readonly predicted: ModulePair;
  /** Zero when the module has not been deployed yet. */
  readonly deployedModule: Address;
  readonly moduleDeployed: boolean;
  readonly guardInstalled: boolean;
  readonly fullyInstalled: boolean;
}

/**
 * Everything the flow needs about one Safe, in one read.
 *
 * `scanSafe` is given the PREDICTED module rather than the factory, because `isModuleEnabled` asks
 * about the module that will actually be enabled on this Safe. Asking about the factory would answer
 * a different question and always answer it "no".
 */
export function useSafeStatus(safe: string) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const valid = isAddress(safe);

  return useQuery<SafeStatus>({
    queryKey: ["shrud", "safe-status", safe],
    enabled: valid && client !== undefined,
    retry: false,
    queryFn: async () => {
      const factory = contractAddress("ShrudModuleFactory");

      const [module, moduleGuard] = (await client!.readContract({
        address: factory,
        abi: moduleFactoryAbi,
        functionName: "predictAddresses",
        args: [safe as Address],
      })) as [Address, Address];

      const deployedModule = (await client!.readContract({
        address: factory,
        abi: moduleFactoryAbi,
        functionName: "moduleOf",
        args: [safe as Address],
      })) as Address;

      const scan = await scanSafe(client!, safe as Address, module);

      return {
        scan,
        predicted: { module, moduleGuard },
        deployedModule,
        moduleDeployed: deployedModule !== zeroAddress,
        guardInstalled: scan.moduleGuard.toLowerCase() === moduleGuard.toLowerCase(),
        fullyInstalled: isFullyInstalled(scan, moduleGuard),
      };
    },
  });
}

/**
 * What each named revert actually means, in the words the user needs.
 *
 * The factory reverts with custom errors that carry the diagnosis. Rendering "transaction failed"
 * for ModuleAlreadyDeployed would send someone debugging a Safe that is already correct, and
 * ModuleAlreadyDeployed is the single most likely error on a second visit to this page.
 */
const REVERT_MEANING: Record<string, string> = {
  ModuleAlreadyDeployed:
    "This Safe already has a shrud module. There is nothing to deploy — continue to enabling it.",
  SafeIsNotAContract:
    "There is no contract at that address on Sepolia. It is probably an EOA, or a Safe on another network.",
  SafeVersionUnsupported:
    "This Safe is not version 1.5.0. Module guards do not exist before 1.5.0, and 1.4.1 accepts the call to install one without installing anything.",
  DeployedAddressMismatch:
    "The module deployed to an address the factory did not predict. This deployment is inconsistent; do not continue.",
  GS020: "The Safe rejected the signature. Its threshold is above one, or you are not an owner.",
  GS026: "The Safe rejected the signature ordering. This is a bug in how the signature was packed.",
};

/** Pulls a named revert out of a viem error, falling back to its first line. */
export function explainWriteError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  for (const [name, meaning] of Object.entries(REVERT_MEANING)) {
    if (text.includes(name)) return `${name} — ${meaning}`;
  }
  const firstLine = text.split("\n")[0];
  return firstLine === undefined || firstLine === "" ? "The transaction failed." : firstLine;
}

/** Calldata for the Safe to call on itself, wrapped in `execTransaction`. */
export function safeSelfCall(
  safe: Address,
  owner: Address,
  inner: Hex,
): {
  address: Address;
  abi: typeof SAFE_WRITE_ABI;
  functionName: "execTransaction";
  args: readonly [
    Address,
    bigint,
    Hex,
    number,
    bigint,
    bigint,
    bigint,
    Address,
    Address,
    Hex,
  ];
} {
  return {
    address: safe,
    abi: SAFE_WRITE_ABI,
    functionName: "execTransaction",
    args: [
      safe,
      0n,
      inner,
      0,
      0n,
      0n,
      0n,
      zeroAddress,
      zeroAddress,
      packSignatures([{ owner, signature: callerIsOwnerSignature(owner) }]),
    ] as const,
  };
}

export function enableModuleCall(module: Address): Hex {
  return encodeFunctionData({
    abi: SAFE_WRITE_ABI,
    functionName: "enableModule",
    args: [module],
  });
}

export function setModuleGuardCall(moduleGuard: Address): Hex {
  return encodeFunctionData({
    abi: SAFE_WRITE_ABI,
    functionName: "setModuleGuard",
    args: [moduleGuard],
  });
}

/**
 * Whether this browser session can authorise the Safe on its own.
 *
 * A threshold above one needs signatures this page cannot collect. Saying so is better than
 * presenting a button that reverts with GS020 after the user pays gas.
 */
export function canSelfAuthorise(scan: SafeScan, account: Address | undefined): boolean {
  if (account === undefined) return false;
  if (scan.threshold !== 1n) return false;
  return scan.owners.some((owner) => owner.toLowerCase() === account.toLowerCase());
}
