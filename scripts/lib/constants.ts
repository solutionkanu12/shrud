/**
 * Deployment constants, in one place so the deploy script, the registration script and the adapter
 * script cannot disagree about what is being deployed.
 *
 * Every address is from `source-lock.json` and was code-verified on Sepolia on 2026-07-31.
 * `test/fork/LiveProtocols.t.sol` re-verifies them on every fork run, so a drift is a failing test
 * rather than a stale constant.
 */

import type { Address } from "viem";

export const SEPOLIA = {
  usdc: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
  weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  aUsdc: "0x16dA4541aD1807f4443d92D26044C1147406EB80",
  uniswapPool: "0xbA57Efa18073647E5269DB04Ff70B8e26Fd0BEaF",
  swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  aavePool: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
} as const satisfies Record<string, Address>;

/** The launch pool's fee tier. Delta D-8 records why this pool and no other. */
export const POOL_FEE = 500;
export const TWAP_WINDOW = 1800;
/** About 10.5 percent — the registry's own ceiling. */
export const MAX_TICK_DEVIATION = 1000;
/** One hour. A snapshot older than this cannot settle. */
export const MAX_STALENESS = 3600;

/**
 * Governance delay for a testnet deployment.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TEN MINUTES, AND THE NUMBER IS ARGUED FOR RATHER THAN CONVENIENT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Chain id 1 enforces seven days ON CHAIN regardless of this value — see `MAINNET_MINIMUM_DELAY` in
 * each registry. A short delay here cannot weaken a mainnet deployment; it is not reachable from one.
 *
 * On Sepolia, seven days would mean the protocol cannot register its first asset until next week.
 * That does not make the timelock stronger, it makes it unobserved: nobody re-deploying this
 * repository would ever watch a registration be refused and then accepted, which is the only way a
 * timelock is ever actually checked rather than assumed.
 *
 * Ten minutes is long enough that `applyRegistration` genuinely reverts on the first attempt — the
 * mechanism runs, and `test_assetRegistrationWaitsOutTheDelayAndThenApplies` proves both halves —
 * and short enough that a reviewer sees the whole cycle in one sitting.
 */
export const GOVERNANCE_DELAY_SECONDS = 10n * 60n;

/**
 * Wrapper supply ceilings.
 *
 * Not about scarcity. A confidential balance cannot be audited by summing it, so a ceiling is the
 * difference between a bounded incident and an unbounded one if a wrapper ever goes wrong.
 */
export const MAX_WRAPPED_USDC = 10n ** 6n * 10n ** 9n;
export const MAX_WRAPPED_WETH = 10n ** 18n * 10n ** 6n;

/**
 * Adapter route ids.
 *
 * DIRECTION-SPECIFIC, and that is required rather than tidy. `ShrudAdapterRegistry` keys one adapter
 * per route id, and a net-buy residual spends USDC to receive WETH while a net-sell spends WETH to
 * receive USDC — two different adapters with two different token pairs. Sharing the price route's id
 * would let the second registration collide with the first.
 */
export const ADAPTER_ROUTE_SUFFIX = {
  buyBase: "BUY_BASE",
  sellBase: "SELL_BASE",
  supplyQuote: "SUPPLY_QUOTE",
} as const;

export const PROTOCOL_ID = {
  uniswapV3: "uniswap-v3",
  aaveV3: "aave-v3",
} as const;

/** Seconds beyond `block.timestamp` a settlement may specify as its deadline. */
export const MAX_DEADLINE_WINDOW = 900;
