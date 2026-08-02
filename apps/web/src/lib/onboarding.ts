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

import { CHAIN_ID, contractAddress } from "./deployment";
import { moduleFactoryAbi } from "./hooks";

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
