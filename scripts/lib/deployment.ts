/**
 * Reading and writing the deployment manifest, and loading artifacts.
 *
 * The manifest is the deliverable: everything a reviewer needs to check a deployment against a build
 * of this repository. It is written by `deploy.ts`, extended by `adapters.ts`, and read by every
 * verification script and by the web app.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Address, Hex } from "viem";

export const ROOT = resolve(import.meta.dirname, "../..");

export interface DeployedContract {
  readonly address: Address;
  /**
   * Mutable, because `apply-adapters.ts` rewrites it with the hash the REGISTRY captured.
   *
   * The registry re-checks this on every settlement, so the manifest must carry the value the
   * contract will compare against — not the one a script computed earlier from a local artifact.
   * Those differ the moment a build is not reproducible, and the manifest's job is to make that
   * visible rather than to assert it away.
   */
  runtimeCodeHash: Hex;
  /**
   * Mutable for the same reason as `runtimeCodeHash`: `rebuild-manifest.ts` fills these in after
   * every address has been confirmed to hold code, because an argument list is only meaningful once
   * the contract it describes is known to exist.
   */
  constructorArgs: readonly unknown[];
}

export interface Manifest {
  chainId: number;
  deployedAt: string;
  deployer: Address;
  compiler: Record<string, unknown>;
  governance: Record<string, unknown>;
  external: Record<string, Address>;
  route: Record<string, unknown>;
  registrationIds: Record<string, Hex>;
  contracts: Record<string, DeployedContract>;
  adapters?: Record<string, DeployedContract & { routeId: Hex }>;
  seeded: boolean;
  [key: string]: unknown;
}

export interface Artifact {
  readonly abi: readonly unknown[];
  readonly bytecode: Hex;
  readonly deployedBytecode: Hex;
}

/** Loads a compiled artifact by its path under `contracts/` and its contract name. */
export function artifact(path: string, name: string): Artifact {
  const file = resolve(ROOT, "artifacts/contracts", path, `${name}.json`);
  const json = JSON.parse(readFileSync(file, "utf8")) as {
    abi: readonly unknown[];
    bytecode: Hex | { object: Hex };
    deployedBytecode: Hex | { object: Hex };
  };
  const unwrap = (v: Hex | { object: Hex }): Hex => (typeof v === "string" ? v : v.object);
  return {
    abi: json.abi,
    bytecode: unwrap(json.bytecode),
    deployedBytecode: unwrap(json.deployedBytecode),
  };
}

export function manifestPath(chainId: number): string {
  return resolve(ROOT, "deployments", `${chainId}.json`);
}

export function readManifest(chainId: number): Manifest {
  try {
    return JSON.parse(readFileSync(manifestPath(chainId), "utf8")) as Manifest;
  } catch {
    throw new Error(
      `No deployment manifest for chain ${chainId}. Run \`pnpm deploy:sepolia\` first — every ` +
        "verification script re-derives its claims from the manifest, so there is nothing to check " +
        "against until one exists.",
    );
  }
}

/**
 * Serialises the manifest, rendering `bigint` as a decimal string.
 *
 * `JSON.stringify` THROWS on a bigint rather than coercing it, and constructor arguments are full of
 * them — supply ceilings, governance delays. Without this the manifest write fails AFTER fourteen
 * contracts are already on chain, which is the worst possible moment: the deployment succeeded and
 * the record of it did not.
 */
export function writeManifest(manifest: Manifest): void {
  const json = JSON.stringify(
    manifest,
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
  writeFileSync(manifestPath(manifest.chainId), `${json}\n`);
}
