"use client";

/**
 * Chain reads.
 *
 * Every hook here reads live Sepolia. None returns placeholder data, and none invents a number when
 * a read fails. The protocol ships empty on purpose, so "nothing here yet" is the correct answer
 * far more often than it is an error, and the two are distinguished rather than blended.
 */

import { useAccount, useReadContract } from "wagmi";

import assetRegistryArtifact from "../../../../artifacts/contracts/assets/ShrudAssetRegistry.sol/ShrudAssetRegistry.json";
import clearingEngineArtifact from "../../../../artifacts/contracts/clearing/ShrudClearingEngine.sol/ShrudClearingEngine.json";
import moduleFactoryArtifact from "../../../../artifacts/contracts/accounts/ShrudModuleFactory.sol/ShrudModuleFactory.json";
import priceRegistryArtifact from "../../../../artifacts/contracts/clearing/ShrudReferencePriceRegistry.sol/ShrudReferencePriceRegistry.json";
import wrapperArtifact from "../../../../artifacts/contracts/assets/wrappers/ShrudWrappedAsset.sol/ShrudWrappedAsset.json";
import { CHAIN_ID, contractAddress } from "./deployment";

const moduleFactoryAbi = moduleFactoryArtifact.abi;
const clearingEngineAbi = clearingEngineArtifact.abi;
const assetRegistryAbi = assetRegistryArtifact.abi;
const priceRegistryAbi = priceRegistryArtifact.abi;
const wrapperAbi = wrapperArtifact.abi;

export { assetRegistryAbi, clearingEngineAbi, moduleFactoryAbi, priceRegistryAbi, wrapperAbi };

/** How many Safes have onboarded. Zero is the expected answer on a fresh deployment. */
export function useSafeCount() {
  return useReadContract({
    address: contractAddress("ShrudModuleFactory"),
    abi: moduleFactoryAbi,
    functionName: "safeCount",
    chainId: CHAIN_ID,
  });
}

/**
 * The connected account's shrud module, if it has one.
 *
 * `moduleOf` is keyed by SAFE, not by owner. An EOA that owns a Safe is not the Safe, so this
 * returns nothing for a plain wallet and that is correct rather than a bug to work around.
 */
export function useModuleOf(safe: `0x${string}` | undefined) {
  return useReadContract({
    address: contractAddress("ShrudModuleFactory"),
    abi: moduleFactoryAbi,
    functionName: "moduleOf",
    args: safe === undefined ? undefined : [safe],
    chainId: CHAIN_ID,
    query: { enabled: safe !== undefined },
  });
}

/** The two privacy floors, read from the deployed engine rather than repeated in the UI. */
export function usePrivacyFloors() {
  const epoch = useReadContract({
    address: contractAddress("ShrudClearingEngine"),
    abi: clearingEngineAbi,
    functionName: "EPOCH_FLOOR_K",
    chainId: CHAIN_ID,
  });
  const residual = useReadContract({
    address: contractAddress("ShrudClearingEngine"),
    abi: clearingEngineAbi,
    functionName: "RESIDUAL_FLOOR_K",
    chainId: CHAIN_ID,
  });
  return { epoch, residual };
}

/** Whether an underlying token has a registered confidential wrapper. */
export function useRegisteredWrapper(underlying: `0x${string}`) {
  return useReadContract({
    address: contractAddress("ShrudAssetRegistry"),
    abi: assetRegistryAbi,
    functionName: "requireEnabledWrapper",
    args: [underlying],
    chainId: CHAIN_ID,
  });
}

/** A wrapper's confidential total supply handle. A handle, not a number. */
export function useConfidentialSupply(wrapper: `0x${string}`) {
  return useReadContract({
    address: wrapper,
    abi: wrapperAbi,
    functionName: "confidentialTotalSupply",
    chainId: CHAIN_ID,
  });
}

/** The plaintext backing a wrapper holds. Public by construction, and worth showing as such. */
export function useUnderlyingBalance(token: `0x${string}`, holder: `0x${string}`) {
  return useReadContract({
    address: token,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [holder],
    chainId: CHAIN_ID,
  });
}

/** The connected wallet, plus whether it is on the chain this build targets. */
export function useConnection() {
  const { address, isConnected, chain } = useAccount();
  return {
    address,
    isConnected,
    wrongNetwork: isConnected && chain !== undefined && chain.id !== CHAIN_ID,
  };
}
