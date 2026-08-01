"use client";

/**
 * Wallet configuration.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE CONNECTOR LIST IS EXPLICIT RATHER THAN `getDefaultConfig`'s
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `getDefaultConfig` installs every wallet RainbowKit knows about, including Base Account, which
 * pulls in `@coinbase/cdp-sdk`, which pulls in a Solana signer stack that does not resolve under
 * Next.js server rendering. The build fails on a module nothing in this application uses.
 *
 * Choosing the list is the better answer regardless of the bundling problem. This is a treasury
 * product operated from a Safe, so the wallets that matter are the ones a Safe signer actually
 * holds, and offering a wall of options a treasurer will never pick is noise in the one modal that
 * has to feel trustworthy.
 *
 * Safe Wallet is first because it is the intended path: a Safe app runs inside the Safe interface
 * and connects through this connector without a separate approval.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ABOUT THE VERSION PINS
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * RainbowKit 2.2.11 peers on `wagmi ^2.9.0`, so wagmi is pinned to 2.x deliberately. wagmi 3 is
 * released and would fall outside that range, which surfaces as a connect modal that renders and
 * then does nothing rather than as an install error.
 */

import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";

/**
 * The Reown project id, formerly WalletConnect Cloud, from https://dashboard.reown.com.
 *
 * Public by design: it identifies the dApp to the relay and grants nothing. Missing it degrades
 * rather than crashes, because injected wallets need no relay at all and a build without an id
 * still connects MetaMask. Throwing here would make an unset environment variable look like a
 * broken application.
 */
const projectId = process.env["NEXT_PUBLIC_REOWN_PROJECT_ID"] ?? "";

export const REOWN_CONFIGURED = projectId !== "";

const connectors = connectorsForWallets(
  [
    {
      groupName: "Treasury",
      wallets: [safeWallet, metaMaskWallet, rainbowWallet],
    },
    {
      groupName: "More",
      // WalletConnect needs a real project id. Listing it without one produces a QR that never
      // pairs, so it is offered only when the relay is actually configured.
      wallets: REOWN_CONFIGURED ? [walletConnectWallet, injectedWallet] : [injectedWallet],
    },
  ],
  {
    appName: "shrud",
    projectId: REOWN_CONFIGURED ? projectId : "00000000000000000000000000000000",
  },
);

/**
 * The read endpoint.
 *
 * Overridable, and the default is deliberate rather than lazy. The build scripts in `scripts/`
 * REFUSE keyless public endpoints, because `eth_getLogs` behaviour differs silently between them
 * and a partial history would look like a complete one. This application never paginates logs. It
 * makes `eth_getCode` and `eth_call` reads, which every endpoint serves identically, so viem's
 * default is correct here and would not be there.
 *
 * Set `NEXT_PUBLIC_RPC_URL` to a dedicated endpoint for a deployment expecting real traffic. Note
 * that anything in a `NEXT_PUBLIC_` variable ships to the browser, so use an endpoint whose key is
 * domain-restricted rather than one that grants archive access to anyone who reads the bundle.
 */
const rpcUrl = process.env["NEXT_PUBLIC_RPC_URL"];

export const wagmiConfig = createConfig({
  connectors,
  chains: [sepolia],
  transports: {
    [sepolia.id]: rpcUrl === undefined || rpcUrl === "" ? http() : http(rpcUrl),
  },
  ssr: true,
});
