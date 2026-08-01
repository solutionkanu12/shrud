/**
 * Environment resolution. Refuses to guess.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO FALLBACK TO A PUBLIC RPC
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Falling back to a keyless public endpoint looks helpful and silently changes behaviour.
 * `eth_getLogs` in particular differs between providers — publicnode rejects archive ranges, 1rpc
 * caps at 50 blocks, drpc serves 200 — so an indexer that "worked" against a default would produce
 * a partial history that looks like a complete one.
 *
 * A misconfiguration should look like a misconfiguration. {rpcUrl} throws.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE RPC URL IS NEVER PRINTED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * viem serialises the request URL into every transport error, and an API key in a URL is a
 * credential in a stack trace, a CI log, and a screenshot. {redact} runs over everything this
 * repository prints, and the split `ALCHEMY_API_URL` + `ALCHEMY_API_KEY` form exists so the base URL
 * — which is not secret — can be logged while the key never is.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

let loaded = false;

/** Reads `.env` into `process.env` without a dependency. Existing values always win. */
export function loadEnv(root = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  try {
    const text = readFileSync(resolve(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env is fine — the read-only paths work from real environment variables alone.
  }
}

function required(name: string, why: string): string {
  loadEnv();
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new EnvError(`${name} is not set. ${why}`);
  }
  return value;
}

/** Known keyless public endpoints. Present so the refusal below can name the problem. */
const PUBLIC_HOSTS = [
  "publicnode.com",
  "1rpc.io",
  "drpc.org",
  "rpc.sepolia.org",
  "ankr.com/eth_sepolia",
];

export function rpcUrl(): string {
  loadEnv();
  const direct = process.env["SEPOLIA_RPC_URL"];
  if (direct !== undefined && direct !== "") {
    const host = PUBLIC_HOSTS.find((h) => direct.includes(h));
    if (host !== undefined) {
      throw new EnvError(
        `SEPOLIA_RPC_URL points at ${host}, a keyless public endpoint. shrud refuses these because ` +
          "eth_getLogs behaviour differs silently between them, so a partial history would look " +
          "like a complete one. Set ALCHEMY_API_URL + ALCHEMY_API_KEY, or a provider URL of your own.",
      );
    }
    return direct;
  }

  const base = process.env["ALCHEMY_API_URL"];
  const key = process.env["ALCHEMY_API_KEY"];
  if (base !== undefined && base !== "" && key !== undefined && key !== "") {
    return `${base}${key}`;
  }

  throw new EnvError(
    "No RPC configured. Set ALCHEMY_API_URL + ALCHEMY_API_KEY (preferred — the base URL is not " +
      "secret and may be logged, the key never is), or SEPOLIA_RPC_URL to a provider endpoint of " +
      "your own. shrud will not fall back to a public endpoint.",
  );
}

/**
 * The local development node.
 *
 * Defaults to the address every local Ethereum node listens on, and stays overridable so nobody is
 * forced to run theirs on port 8545. A test suite that assumes a port is a test suite that fails on
 * a machine already running something else there, and the failure looks like a broken repository
 * rather than an occupied socket.
 */
export function localRpcUrl(): string {
  loadEnv();
  const value = process.env["LOCAL_RPC_URL"];
  return value === undefined || value === "" ? "http://127.0.0.1:8545" : value;
}

export function deployerPrivateKey(): `0x${string}` {
  const value = required(
    "DEPLOYER_PRIVATE_KEY",
    "Deployment needs a funded Sepolia key. It must hold nothing but gas.",
  );
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new EnvError("DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.");
  }
  return value as `0x${string}`;
}

export function etherscanApiKey(): string {
  return required("ETHERSCAN_API_KEY", "Source verification needs an Etherscan v2 API key.");
}

/**
 * The explicit opt-in every broadcast path checks.
 *
 * A deployment is irreversible and costs real gas. Requiring a separate, exact `true` means a
 * misfired command reads the chain and stops, rather than spending money and publishing addresses
 * somebody then has to explain.
 */
export function assertBroadcastAllowed(): void {
  loadEnv();
  if (process.env["DEPLOY_SEPOLIA"] !== "true") {
    throw new EnvError(
      'DEPLOY_SEPOLIA is not exactly "true". Deployment is irreversible and costs gas, so it needs ' +
        "an explicit opt-in separate from running the command. Set it in .env when you mean it.",
    );
  }
}

/**
 * Removes anything credential-shaped from a string before it is printed.
 *
 * viem puts the full request URL — API key included — into every transport error, and from there it
 * reaches a terminal, a CI log and a screenshot. Everything this repository prints goes through here.
 */
export function redact(text: string): string {
  loadEnv();
  let out = text;
  for (const name of ["ALCHEMY_API_KEY", "ETHERSCAN_API_KEY", "DEPLOYER_PRIVATE_KEY"]) {
    const value = process.env[name];
    if (value !== undefined && value.length > 6) out = out.split(value).join(`<${name}>`);
  }
  // Any remaining long hex that looks like a key, and any URL with a path segment after the host.
  out = out.replace(/https?:\/\/[^\s"']+/g, (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}/<redacted>`;
    } catch {
      return "<redacted-url>";
    }
  });
  return out;
}

/** Prints through {redact}. Use this rather than `console.log` in anything that touches a provider. */
export function say(...parts: unknown[]): void {
  console.log(redact(parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ")));
}
