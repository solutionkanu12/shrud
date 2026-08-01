/**
 * The deployment this build talks to.
 *
 * Imported at BUILD TIME rather than fetched. A runtime fetch would let a deployed page silently
 * start pointing at a different set of contracts, and the addresses a user is signing against
 * should be a property of the build they loaded.
 */

import manifest from "../../../../deployments/11155111.json";

export interface DeployedContract {
  readonly address: `0x${string}`;
  readonly runtimeCodeHash: `0x${string}`;
}

const contracts = manifest.contracts as unknown as Record<string, DeployedContract>;
const adapters = (manifest.adapters ?? {}) as unknown as Record<
  string,
  DeployedContract & { routeId: `0x${string}` }
>;

/**
 * Resolves a contract address, throwing rather than returning undefined.
 *
 * A missing address is a broken build, not a runtime condition to branch on. Failing at the call
 * site names the contract; returning undefined produces a wallet prompt to the zero address.
 */
export function contractAddress(name: string): `0x${string}` {
  const entry = contracts[name];
  if (entry === undefined) {
    throw new Error(
      `${name} is not in deployments/${manifest.chainId}.json. This build cannot talk to it.`,
    );
  }
  return entry.address;
}

export const CHAIN_ID = manifest.chainId;
export const DEPLOYER = manifest.deployer as `0x${string}`;
export const GOVERNANCE_DELAY_SECONDS = manifest.governance.delaySeconds;
export const EXTERNAL = manifest.external as Record<string, `0x${string}`>;
export const ROUTE = manifest.route as {
  routeId: `0x${string}`;
  pool: `0x${string}`;
  baseToken: `0x${string}`;
  quoteToken: `0x${string}`;
  twapWindow: number;
  maxStaleness: number;
  maxTickDeviation: number;
};

export const ADAPTERS = adapters;
export const CONTRACTS = contracts;
export const DEPLOYED_AT = manifest.deployedAt;

/**
 * Every contract this deployment put on chain, core and adapters together.
 *
 * The manifest keeps them in two objects because they are registered through different governance
 * paths, and counting only `contracts` was quietly under-reporting the deployment by three. A
 * single exported total means the landing page, the footer and the dashboard cannot disagree about
 * a number a reviewer will check against Etherscan.
 */
export const TOTAL_CONTRACTS = Object.keys(contracts).length + Object.keys(adapters).length;

/** Everything the protocol deliberately does not contain. Asserted by `pnpm verify:live`. */
export const IS_SEEDED = manifest.seeded;

export function explorerUrl(addressOrTx: string, kind: "address" | "tx" = "address"): string {
  return `https://sepolia.etherscan.io/${kind}/${addressOrTx}`;
}

/** Shortens an address for display without losing the ends people actually compare. */
export function shortAddress(address: string, chars = 4): string {
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`;
}
