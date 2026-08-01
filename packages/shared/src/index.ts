/**
 * `@shrud/shared` — the constants and types every other package agrees on.
 *
 * WHAT BELONGS HERE: values that must be identical across the contracts, the services, the web app
 * and the verifier. A number that appears in two places and can drift is a defect waiting for a
 * refactor, and `scripts/verify-live/constants.ts` compares every value below against the deployed
 * Solidity so a drift fails a check rather than a settlement.
 *
 * WHAT DOES NOT BELONG HERE: anything that reads chain state, anything that touches Nox, and
 * anything with a dependency. This package has none, deliberately — it is imported by the browser
 * bundle and by a Worker runtime, and a transitive Node built-in in either would be a build failure
 * discovered late.
 */

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Chain
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const ETHEREUM_SEPOLIA = 11_155_111 as const;
export const HARDHAT_LOCAL = 31_337 as const;

export type SupportedChainId = typeof ETHEREUM_SEPOLIA | typeof HARDHAT_LOCAL;

/**
 * NoxCompute, per chain.
 *
 * Read from `sdk/Nox.sol::noxComputeContract`, which HARDCODES these. If one ever moved, every
 * shrud contract would break at once and there is no configuration that fixes it — which is why
 * `test/fork/LiveProtocols.t.sol` asserts the Sepolia one answers `gateway()` on every run.
 */
export const NOX_COMPUTE: Record<SupportedChainId, `0x${string}`> = {
  [ETHEREUM_SEPOLIA]: "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF",
  [HARDHAT_LOCAL]: "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685",
};

/** The hosted handle gateway. Local stacks publish theirs on a Docker-assigned port instead. */
export const NOX_GATEWAY_URL = "https://gateway-testnets.noxprotocol.dev" as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// External protocols, Ethereum Sepolia
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Safe 1.5.0, and ONLY 1.5.0 — delta D-1.
 *
 * `setModuleGuard` does not exist before it, and 1.4.1 does not even refuse the call: its fallback
 * handler swallows the unknown selector and reports success, so an installer checking only for a
 * revert would report a guard that is not there.
 */
export const SAFE_VERSION_REQUIRED = "1.5.0" as const;

export const SAFE_SEPOLIA = {
  singleton: "0xFf51A5898e281Db6DfC7855790607438dF2ca44b",
  singletonL2: "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e",
  proxyFactory: "0x14F2982D601c9458F93bd70B218933A6f8165e7b",
  fallbackHandler: "0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4",
} as const satisfies Record<string, `0x${string}`>;

/** `keccak256("module_manager.module_guard.address")`, from `ModuleManager.sol` 1.5.0 line 65. */
export const MODULE_GUARD_STORAGE_SLOT =
  "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947" as const;

export const UNISWAP_SEPOLIA = {
  factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
  swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  quoterV2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const satisfies Record<string, `0x${string}`>;

export const AAVE_SEPOLIA = {
  pool: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
  poolAddressesProvider: "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A",
  dataProvider: "0x3e9708d80f7B3e43118013075F7e95CE3AB31F31",
} as const satisfies Record<string, `0x${string}`>;

/**
 * The launch pair, and it is not a free choice — delta D-8.
 *
 * On Sepolia this is the ONLY combination where a Uniswap V3 pool has both real liquidity AND a
 * non-zero observation cardinality (so `observe()` returns a TWAP), AND whose quote token Aave
 * actually lists as a reserve. Three of the four candidates measured had `observationCardinality`
 * of zero — including two with more liquidity than this one.
 *
 * The tick observed on 2026-07-31 was 120,482, which prices WETH at about 5,858,613 USDC. That is a
 * testnet number with no relationship to any real market. shrud proves the price was fixed, sourced
 * and sealed; it does not claim the level means anything, and the interface says so.
 */
export const LAUNCH_PAIR = {
  base: { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", symbol: "WETH", decimals: 18 },
  quote: { address: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8", symbol: "USDC", decimals: 6 },
  pool: "0xbA57Efa18073647E5269DB04Ff70B8e26Fd0BEaF",
  feeTier: 500,
  aToken: "0x16dA4541aD1807f4443d92D26044C1147406EB80",
  twapWindowSeconds: 1800,
} as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Protocol constants. Mirror `contracts/libraries/ShrudOrderFamily.sol` exactly.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Quote units per WHOLE base unit, scaled by this. Mirrors `ShrudOrderFamily.PRICE_SCALE`. */
export const PRICE_SCALE = 10n ** 18n;

/** PRD §9.7. A hard bound, not a target — see delta D-9 and `CLEARING_GAS_BUDGET`. */
export const MAX_CANDIDATES = 16;

/** PRD §6.3 defaults. */
export const EPOCH_FLOOR_K = 3;
export const RESIDUAL_FLOOR_K = 2;

/**
 * The actions inside `USDC_WETH_ALLOCATION_V1`. ENCRYPTED — never public, before or after
 * settlement. Contiguous from 1 so the family check is two comparisons rather than four equalities.
 */
export const ACTION = {
  NONE: 0,
  BUY_BASE: 1,
  SELL_BASE: 2,
  SUPPLY_QUOTE: 3,
  WITHDRAW_QUOTE: 4,
  HOLD: 5,
} as const;

export type ActionId = (typeof ACTION)[keyof typeof ACTION];

/** Decryptable only by the owning Safe's current owners. Never in an event, never in a log. */
export const PRIVATE_OUTCOME = {
  PENDING: 0,
  CROSSED_INTERNALLY: 1,
  CROSSED_PLUS_RESIDUAL: 2,
  RESIDUAL_ONLY: 3,
  AAVE_SUPPLIED: 4,
  HELD: 5,
  ZERO_INSUFFICIENT_BALANCE: 6,
  ZERO_LIMIT_FAILED: 7,
  ZERO_POLICY_FAILED: 8,
  DEFERRED_PRIVACY_FLOOR: 9,
  REFUNDED_VENUE_FAILURE: 10,
} as const;

/** Published, so a plain number rather than a handle once decrypted. */
export const RESIDUAL_DIRECTION = {
  NONE: 0,
  BUY_BASE: 1,
  SELL_BASE: 2,
  SUPPLY_QUOTE: 3,
  WITHDRAW_QUOTE: 4,
} as const;

/**
 * The five public intent states — and the seven that must NEVER exist.
 *
 * PRD §9.5 names the forbidden ones and each is a free oracle: `InsufficientBalance` alone turns
 * repeated oversized orders into a binary search over a confidential balance. `Processed` is where
 * every order that entered a sealed epoch ends up, indistinguishably.
 */
export const INTENT_STATUS = {
  NONE: 0,
  SUBMITTED: 1,
  AUTHORISED: 2,
  PROCESSED: 3,
  EXPIRED: 4,
  CANCELLED: 5,
} as const;

export const EPOCH_STATUS = {
  NONE: 0,
  OPEN: 1,
  SEALED: 2,
  PRICE_FIXED: 3,
  COMPUTING: 4,
  RESIDUAL_READY: 5,
  NO_PUBLIC_RESIDUAL: 6,
  SETTLING: 7,
  SETTLED: 8,
  TIMED_OUT: 9,
  RECOVERABLE: 10,
} as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Privacy classification — the vocabulary the interface is REQUIRED to use
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * PRD §17.1. Every value rendered anywhere carries exactly one of these.
 *
 * This is a closed union on purpose. A fourteenth ad-hoc label added inline would fail to compile,
 * which is the point: the classification is the product, and a value shown without one is a value
 * whose disclosure nobody decided.
 */
export type PrivacyLabel =
  | "public"
  | "encrypted"
  | "viewer-only"
  | "internal-cross"
  | "aggregate-reveal";

/**
 * PRD §16.4. The lifecycle of a private value in a client session.
 *
 * `no-access` and `pending-compute` are distinct and must stay so. "You are not a viewer" and "the
 * runner has not finished" look the same to a user and mean opposite things — one is a permanent
 * answer about authority, the other is a temporary answer about latency.
 */
export type PrivateValueState =
  | "sealed"
  | "requesting"
  | "revealed"
  | "no-access"
  | "pending-compute"
  | "public-residual";

/**
 * The words the interface may use about a permanent Nox grant.
 *
 * NOX HAS NO `removeViewer`. A capsule viewer keeps their snapshot forever, and archiving is
 * organisational rather than cryptographic. Saying "revoked" would tell a user something false
 * about their own confidentiality, so the permitted phrasings are a closed union and
 * `scripts/verify-live/copy.ts` greps the built bundle for the forbidden ones.
 */
export const END_OF_ACCESS_WORDING = [
  "live access ended",
  "future snapshots disabled",
  "this historical snapshot remains available",
] as const;

export const FORBIDDEN_ACCESS_WORDING = [
  "revoked",
  "access removed",
  "permission withdrawn",
] as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════════════════════

export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type Handle = `0x${string}`;

export interface IntentHeader {
  readonly module: Address;
  readonly safe: Address;
  readonly inputAsset: Address;
  readonly orderFamily: Hex;
  readonly epochId: Hex;
  readonly expiry: bigint;
  readonly nonce: bigint;
  readonly commitment: Hex;
  readonly createdAtBlock: bigint;
  readonly status: number;
}

export interface EpochRecord {
  readonly orderFamily: Hex;
  readonly baseAsset: Address;
  readonly quoteAsset: Address;
  readonly status: number;
  readonly candidateCount: number;
  readonly sealedAtBlock: bigint;
  readonly settledAtBlock: bigint;
  readonly priceSnapshotId: Hex;
  readonly referencePrice: bigint;
}

/** The five handles a sealed epoch commits to publishing. Exactly five, forever. */
export interface EpochPublishedHandles {
  readonly meetsEpochFloor: Handle;
  readonly meetsResidualFloor: Handle;
  readonly residualDirection: Handle;
  readonly residualAggregateInput: Handle;
  readonly residualAggregateMinimum: Handle;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Errors
// ═════════════════════════════════════════════════════════════════════════════════════════════

export class ShrudError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShrudError";
  }
}

/**
 * Raised when a chain is not one shrud supports.
 *
 * There is deliberately no fallback to "assume mainnet-like defaults". The two Nox testnets run
 * different contract versions and different KMS keys, and there is no Nox mainnet at all, so
 * guessing would produce a client that appears configured and fails at the first handle.
 */
export class UnsupportedChainError extends ShrudError {
  readonly chainId: number;

  constructor(chainId: number) {
    super(
      `chain ${chainId} is not supported. shrud runs on Ethereum Sepolia (${ETHEREUM_SEPOLIA}) and ` +
        `the local Nox stack (${HARDHAT_LOCAL}). There is no Nox mainnet.`,
    );
    this.chainId = chainId;
    this.name = "UnsupportedChainError";
  }
}

export function requireSupportedChain(chainId: number): SupportedChainId {
  if (chainId !== ETHEREUM_SEPOLIA && chainId !== HARDHAT_LOCAL) {
    throw new UnsupportedChainError(chainId);
  }
  return chainId;
}
