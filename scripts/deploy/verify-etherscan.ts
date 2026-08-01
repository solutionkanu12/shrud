/**
 * Source verification on Etherscan, through the v2 API directly.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY NOT `npx hardhat verify`
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `@nomicfoundation/hardhat-verify` does not yet support Hardhat 3, and adding it would drag a
 * second toolchain into a build that already balances Hardhat 3 against the Nox plugin. The
 * Etherscan v2 API takes a standard-json input, which is exactly what solc already consumed to
 * produce these artifacts, so going direct is both smaller and more faithful: the bytes uploaded are
 * the bytes compiled.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE COMPILER SETTINGS ARE READ FROM THE BUILD, NOT RETYPED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Verification fails when the settings differ from the ones that produced the deployed bytecode, and
 * two of these contracts compile with `runs: 1` while the rest use 200. Retyping that into this file
 * would work until somebody changed `hardhat.config.ts` and not this, at which point verification
 * would fail with a bytecode mismatch that looks like a deployment problem.
 *
 * The build-info files hold the exact input solc received. This reads them.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { encodeAbiParameters, type Address } from "viem";

import { artifact, readManifest, ROOT, type Manifest } from "../lib/deployment.js";
import { etherscanApiKey, loadEnv, say } from "../lib/env.js";

const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";

/** Source path and contract name for each manifest entry, so the API can be told what to compile. */
const SOURCES: Record<string, { path: string; name: string }> = {
  ShrudPauseController: { path: "contracts/recovery/ShrudPauseController.sol", name: "ShrudPauseController" },
  ShrudAssetRegistry: { path: "contracts/assets/ShrudAssetRegistry.sol", name: "ShrudAssetRegistry" },
  ShrudAdapterRegistry: { path: "contracts/adapters/ShrudAdapterRegistry.sol", name: "ShrudAdapterRegistry" },
  ShrudReferencePriceRegistry: {
    path: "contracts/clearing/ShrudReferencePriceRegistry.sol",
    name: "ShrudReferencePriceRegistry",
  },
  ShrudIntentBook: { path: "contracts/intents/ShrudIntentBook.sol", name: "ShrudIntentBook" },
  ShrudPositionLedger: { path: "contracts/settlement/ShrudPositionLedger.sol", name: "ShrudPositionLedger" },
  ShrudClearingVault: { path: "contracts/clearing/ShrudClearingVault.sol", name: "ShrudClearingVault" },
  ShrudCapsuleFactory: { path: "contracts/disclosure/ShrudCapsuleFactory.sol", name: "ShrudCapsuleFactory" },
  ShrudClearingEngine: { path: "contracts/clearing/ShrudClearingEngine.sol", name: "ShrudClearingEngine" },
  ShrudSettlementEngine: { path: "contracts/settlement/ShrudSettlementEngine.sol", name: "ShrudSettlementEngine" },
  ShrudModuleFactory: { path: "contracts/accounts/ShrudModuleFactory.sol", name: "ShrudModuleFactory" },
  ShrudEmergencyExit: { path: "contracts/recovery/ShrudEmergencyExit.sol", name: "ShrudEmergencyExit" },
  ShrudWrappedUSDC: { path: "contracts/assets/wrappers/ShrudWrappedAsset.sol", name: "ShrudWrappedAsset" },
  ShrudWrappedWETH: { path: "contracts/assets/wrappers/ShrudWrappedAsset.sol", name: "ShrudWrappedAsset" },
  UniswapBuyBaseAdapter: { path: "contracts/adapters/UniswapResidualAdapter.sol", name: "UniswapResidualAdapter" },
  UniswapSellBaseAdapter: { path: "contracts/adapters/UniswapResidualAdapter.sol", name: "UniswapResidualAdapter" },
  AaveSupplyAdapter: { path: "contracts/adapters/AaveSupplyAdapter.sol", name: "AaveSupplyAdapter" },
};

interface BuildInfo {
  solcLongVersion: string;
  /**
   * Hardhat 3 maps every user-facing path to the name solc actually received.
   *
   * `contracts/x.sol` becomes `project/contracts/x.sol`, and dependencies become
   * `npm/@openzeppelin/contracts@5.6.1/...`. Etherscan compiles the standard-json input verbatim,
   * so the `contractname` it is given has to use the INTERNAL name. Passing the user-facing path
   * produces "Unable to locate ContractName", which reads like a missing contract rather than a
   * naming convention.
   */
  userSourceNameMap: Record<string, string>;
  input: { language: string; sources: Record<string, unknown>; settings: Record<string, unknown> };
}

/**
 * Finds the build-info that produced a specific artifact.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS READS `buildInfoId` RATHER THAN SEARCHING
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The first version of this searched `artifacts/build-info/` for the first file whose input
 * contained the source path, and four contracts failed verification with "compiled contract
 * deployment bytecode does NOT match".
 *
 * The cause: EIGHT build-infos contain `contracts/assets/ShrudAssetRegistry.sol`, one per
 * incremental compile since that file last changed. Most of them describe a version of the source
 * that no longer exists. Uploading one produces a genuine mismatch, reported in language that sends
 * somebody to look at the deployment rather than at which compilation they just uploaded.
 *
 * Every Hardhat 3 artifact carries `buildInfoId`, naming exactly the compilation that produced it.
 * That is not a heuristic, so it cannot pick the wrong one.
 */
function buildInfoFor(
  artifactPath: string,
  contractName: string,
  sourcePath: string,
): { info: BuildInfo; internalName: string } {
  const meta = JSON.parse(
    readFileSync(resolve(ROOT, "artifacts/contracts", artifactPath, `${contractName}.json`), "utf8"),
  ) as { buildInfoId?: string };

  if (meta.buildInfoId === undefined) {
    throw new Error(
      `${contractName} has no buildInfoId. Run \`pnpm compile\` — verification uploads the exact ` +
        "compilation that produced the deployed bytecode, and without that id it can only guess.",
    );
  }

  const file = resolve(ROOT, "artifacts/build-info", `${meta.buildInfoId}.json`);
  const info = JSON.parse(readFileSync(file, "utf8")) as BuildInfo;
  const internalName = info.userSourceNameMap[sourcePath];

  if (internalName === undefined) {
    throw new Error(`${meta.buildInfoId} does not map ${sourcePath}`);
  }
  return { info, internalName };
}

/** Encodes constructor arguments the way Etherscan expects them: ABI-encoded, no 0x prefix. */
function encodeConstructorArgs(
  contractName: string,
  sourcePath: string,
  args: readonly unknown[],
): string {
  if (args.length === 0) return "";

  const abi = artifact(sourcePath.replace("contracts/", ""), contractName).abi as {
    type: string;
    inputs?: { type: string; name: string }[];
  }[];
  const constructor = abi.find((item) => item.type === "constructor");
  if (constructor?.inputs === undefined) return "";

  const encoded = encodeAbiParameters(
    constructor.inputs.map((input) => ({ type: input.type, name: input.name })),
    args.map((arg) => (typeof arg === "string" && /^\d+$/.test(arg) ? BigInt(arg) : arg)) as never,
  );
  return encoded.slice(2);
}

async function submit(
  chainId: number,
  apiKey: string,
  address: Address,
  info: BuildInfo,
  sourcePath: string,
  contractName: string,
  constructorArgs: string,
): Promise<string> {
  const body = new URLSearchParams({
    module: "contract",
    action: "verifysourcecode",
    apikey: apiKey,
    contractaddress: address,
    sourceCode: JSON.stringify(info.input),
    codeformat: "solidity-standard-json-input",
    contractname: `${sourcePath}:${contractName}`,
    // Etherscan wants the long version, for example v0.8.36+commit.abcdef12.
    compilerversion: `v${info.solcLongVersion}`,
    constructorArguements: constructorArgs,
  });

  // `chainid` goes in the QUERY STRING even for a POST. Etherscan v2 routes on it before parsing
  // the body, so a chainid in the form data is reported as "missing or unsupported chainid".
  const response = await fetch(`${ETHERSCAN_V2}?chainid=${chainId}`, { method: "POST", body });
  const json = (await response.json()) as { status: string; message: string; result: string };

  if (json.status !== "1") {
    // "Already Verified" is a success from this script's point of view: the goal is verified source
    // at that address, not a receipt for having been the one to submit it.
    // Etherscan phrases this three different ways depending on the endpoint. All three mean the
    // goal is met: verified source at that address. Whether this script was the one to submit it
    // is not the thing being checked.
    const text = `${json.result} ${json.message}`.toLowerCase();
    if (text.includes("already verified")) return "already verified";
    throw new Error(json.result || json.message);
  }
  return json.result;
}

async function pollStatus(chainId: number, apiKey: string, guid: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    const url = `${ETHERSCAN_V2}?chainid=${chainId}&module=contract&action=checkverifystatus&guid=${guid}&apikey=${apiKey}`;
    const json = (await (await fetch(url)).json()) as { status: string; result: string };

    if (json.result === "Pending in queue") continue;
    if (json.status === "1") return "verified";
    if (json.result.includes("Already Verified")) return "already verified";
    return `failed: ${json.result}`;
  }
  return "timed out waiting for Etherscan";
}

async function main(): Promise<void> {
  loadEnv();
  const apiKey = etherscanApiKey();
  const manifest: Manifest = readManifest(11155111);
  const chainId = manifest.chainId;

  const only = process.argv.includes("--only")
    ? process.argv[process.argv.indexOf("--only") + 1]
    : undefined;

  const entries: [string, { address: Address; constructorArgs: readonly unknown[] }][] = [
    ...Object.entries(manifest.contracts),
    ...Object.entries(manifest.adapters ?? {}),
  ].filter(([name]) => only === undefined || name === only);

  say(`Verifying ${entries.length} contracts on chain ${chainId}.`);
  say("Compiler settings come from the build-info that actually compiled each file, not from a");
  say("constant in this script. Two contracts use runs: 1 and the rest use 200.");
  say("");

  let verified = 0;
  let failed = 0;

  for (const [name, entry] of entries) {
    const source = SOURCES[name];
    if (source === undefined) {
      say(`  ${name.padEnd(28)} skipped, no source mapping`);
      continue;
    }

    try {
      const { info, internalName } = buildInfoFor(
        source.path.replace("contracts/", ""),
        source.name,
        source.path,
      );
      const args = encodeConstructorArgs(source.name, source.path, entry.constructorArgs);
      const guid = await submit(
        chainId,
        apiKey,
        entry.address,
        info,
        internalName,
        source.name,
        args,
      );

      const result = guid === "already verified" ? guid : await pollStatus(chainId, apiKey, guid);
      const ok = result === "verified" || result === "already verified";
      if (ok) verified += 1;
      else failed += 1;
      say(`  ${name.padEnd(28)} ${result}`);
    } catch (error) {
      failed += 1;
      say(`  ${name.padEnd(28)} error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Etherscan's free tier is rate limited. Pacing beats retrying a 429.
    await new Promise((r) => setTimeout(r, 1_200));
  }

  say("");
  say(`${verified} verified, ${failed} failed.`);
  say(`https://sepolia.etherscan.io/address/${manifest.contracts["ShrudIntentBook"]?.address ?? ""}#code`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
