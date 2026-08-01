import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { NextConfig } from "next";

/**
 * Loads the MONOREPO ROOT `.env`, which Next.js does not.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS HERE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Next.js reads `.env` relative to its own project root, which in this workspace is `apps/web/`.
 * The repository keeps ONE `.env` at the top so the deploy scripts, the indexer and the app all read
 * the same credentials, and the consequence is that Next silently sees none of them.
 *
 * Silently is the problem. A missing `NEXT_PUBLIC_` variable is not an error, it is an empty string,
 * so the app renders a "not configured" banner while the value sits correctly in a file three
 * directories up. That is a confusing ten minutes for anyone setting this up.
 *
 * Values already in the environment always win, so a platform like Vercel or Render still overrides
 * this.
 */
function loadRootEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(resolve(import.meta.dirname, "../../.env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      // Only public variables reach the browser bundle. A secret in this object would be shipped
      // to every visitor, so the prefix check is a boundary rather than a convention.
      if (!key.startsWith("NEXT_PUBLIC_")) continue;
      if (process.env[key] === undefined || process.env[key] === "") out[key] = value;
    }
  } catch {
    // No root .env is fine. Platform environment variables cover a deployed build.
  }
  return out;
}

/**
 * `@rainbow-me/rainbowkit`'s barrel statically imports every connector it ships, so Base Account
 * arrives whether or not it is offered. Base Account optionally imports the `@x402/*` payment
 * packages, which are not installed and are unreachable from any shrud code path: the connector
 * list in `src/lib/wagmi.ts` never instantiates Base Account.
 *
 * These aliases resolve them to an empty module. See `src/lib/stubs/unused-module.ts` for why that
 * is preferable to installing a payments SDK and a Solana signer stack to satisfy an import nothing
 * calls.
 *
 * Every subpath has to be listed. Both bundlers match an alias key exactly rather than by prefix,
 * so aliasing `@x402/evm` leaves `@x402/evm/exact/client` unresolved.
 *
 * Turbopack resolves its alias values relative to the project root and rejects an absolute path.
 * Webpack wants an absolute one. Hence the two forms below.
 */
const STUB_RELATIVE = "./src/lib/stubs/unused-module.ts";
const STUB_ABSOLUTE = resolve(import.meta.dirname, "src/lib/stubs/unused-module.ts");

const UNUSED_MODULES = [
  "@x402/core",
  "@x402/core/client",
  "@x402/evm",
  "@x402/evm/exact/client",
  "@x402/evm/upto/client",
  "@x402/svm",
  "@x402/svm/exact/client",
] as const;

const aliasTo = (target: string): Record<string, string> =>
  Object.fromEntries(UNUSED_MODULES.map((name) => [name, target]));

const config: NextConfig = {
  reactStrictMode: true,
  env: loadRootEnv(),
  transpilePackages: [
    "@shrud/contracts-generated",
    "@shrud/shared",
    "@shrud/clearing-math",
    "@shrud/sdk",
  ],
  turbopack: {
    resolveAlias: aliasTo(STUB_RELATIVE),
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.alias = {
      ...webpackConfig.resolve.alias,
      ...aliasTo(STUB_ABSOLUTE),
    };
    return webpackConfig;
  },
  // The deployment manifest is imported at build time rather than fetched, so the addresses a user
  // signs against are a property of the build they loaded.
  outputFileTracingIncludes: { "/**": ["../../deployments/*.json"] },
};

export default config;
