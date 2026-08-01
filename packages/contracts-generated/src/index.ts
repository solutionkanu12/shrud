/**
 * `@shrud/contracts-generated` — ABIs and deployment records, GENERATED. Never hand-edited.
 *
 * `pnpm generate` rewrites this directory from `artifacts/` and `deployments/`. A hand-edited ABI is
 * a claim about a deployed contract that nothing checks, and the first symptom is a decoded event
 * with the wrong field names — which reads as a data problem rather than a build problem.
 *
 * Until `pnpm generate` runs, the exports below are empty and typed as such, so a consumer that
 * imports one gets a compile error rather than an empty object at runtime.
 */

export type GeneratedAbi = readonly unknown[];

export interface DeploymentRecord {
  readonly chainId: number;
  readonly commit: string;
  readonly compiler: string;
  readonly optimizerRuns: number;
  readonly evmVersion: string;
  readonly contracts: Readonly<
    Record<string, { address: `0x${string}`; runtimeCodeHash: `0x${string}` }>
  >;
}

/** Populated by `pnpm generate`. */
export const ABIS: Readonly<Record<string, GeneratedAbi>> = {};

/** Populated by `pnpm generate` from `deployments/<chainId>.json`. */
export const DEPLOYMENTS: Readonly<Record<number, DeploymentRecord>> = {};
