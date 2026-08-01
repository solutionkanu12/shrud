/**
 * `@shrud/nox-client` — the ONLY module in the workspace permitted to depend on iExec Nox.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * WHY A SINGLE IMPORT SITE, ENFORCED RATHER THAN AGREED
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Nox is version-skewed across four surfaces: the JS SDK (`0.1.0-beta.13`, explicitly unstable),
 * the Hardhat plugin, the published Solidity contracts, and two testnets running different contract
 * versions with different KMS keys. Letting each package import it directly would spread that skew
 * everywhere and make a version bump a repository-wide change.
 *
 * `scripts/verify-live/import-boundary.ts` fails the build if any other package, service or app
 * imports `@iexec-nox/*` or `encrypted-types`. That check is the enforcement half; this package is
 * the other.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * WHERE DECRYPTION IS ALLOWED TO HAPPEN
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Here, and only here, in a process the user controls — their browser, or a script they ran
 * themselves. No shrud server, indexer, coordinator, keeper, database, log line, metric label or
 * analytics event ever receives a decrypted value. Every function returns the plaintext to its
 * caller and writes it nowhere. PRD §20.8.
 */

export {
  AllPublicOperandsError,
  ATTR_IS_UNIQUE_HANDLE,
  chainIdOf,
  composeHandle,
  type DeriveHandleInput,
  deriveHandle,
  deriveIsolatedHandle,
  type EncryptedType,
  HandleDerivationError,
  isPublicHandle,
  NOX_OPERATOR,
  NOX_TEE_TYPE,
  type NoxOperator,
  teeTypeOf,
  zeroHandle,
} from "./handle-derivation.js";

export {
  backoffSchedule,
  classifyFailure,
  DEFAULT_POLL_POLICY,
  fetchTransport,
  HandleNotReadyError,
  type HandleState,
  type HandleStatus,
  NoxGatewayError,
  type PollPolicy,
  parseHandleState,
  type StatusTransport,
  statusUrl,
  type WaitOptions,
  waitForHandle,
} from "./runtime.js";

import type { Address, Handle, Hex, SupportedChainId } from "@shrud/shared";
import { NOX_COMPUTE, NOX_GATEWAY_URL, requireSupportedChain } from "@shrud/shared";

import { DEFAULT_POLL_POLICY, type WaitOptions, waitForHandle } from "./runtime.js";

/** The five encrypted types Nox supports. There are no others. */
export const ENCRYPTED_TYPES = ["ebool", "euint16", "euint256", "eint16", "eint256"] as const;

/**
 * Inclusive bounds per type.
 *
 * Checked LOCALLY, before anything is sent. Nox would wrap silently inside the TEE, so a value that
 * cannot fit `euint16` would become a different number with no error anywhere — and in shrud that
 * number would be an action id or an outcome code.
 */
export const TYPE_BOUNDS: Record<(typeof ENCRYPTED_TYPES)[number], { min: bigint; max: bigint }> = {
  ebool: { min: 0n, max: 1n },
  euint16: { min: 0n, max: 65_535n },
  euint256: { min: 0n, max: 2n ** 256n - 1n },
  eint16: { min: -32_768n, max: 32_767n },
  eint256: { min: -(2n ** 255n), max: 2n ** 255n - 1n },
};

export class NoxTypeError extends Error {
  constructor(value: bigint, type: string, bounds: { min: bigint; max: bigint }) {
    super(
      `${value} does not fit ${type} (${bounds.min}..${bounds.max}). Nox would wrap this silently ` +
        "inside the TEE, producing a different number with no error anywhere.",
    );
    this.name = "NoxTypeError";
  }
}

export function assertFitsType(value: bigint, type: (typeof ENCRYPTED_TYPES)[number]): void {
  const bounds = TYPE_BOUNDS[type];
  if (value < bounds.min || value > bounds.max) throw new NoxTypeError(value, type, bounds);
}

export interface NoxNetwork {
  readonly chainId: SupportedChainId;
  readonly noxCompute: Address;
  readonly gatewayUrl: string;
  readonly subgraphUrl?: string;
}

/**
 * Resolves the network configuration for a chain.
 *
 * @param overrides for a local stack, whose gateway port Docker assigns at run time and which no
 *        static table can know.
 */
export function resolveNetwork(chainId: number, overrides: Partial<NoxNetwork> = {}): NoxNetwork {
  const supported = requireSupportedChain(chainId);
  return {
    chainId: supported,
    noxCompute: overrides.noxCompute ?? NOX_COMPUTE[supported],
    gatewayUrl: overrides.gatewayUrl ?? NOX_GATEWAY_URL,
    ...(overrides.subgraphUrl !== undefined ? { subgraphUrl: overrides.subgraphUrl } : {}),
  };
}

/** One encrypted input, ready to pass to a contract. Never contains the plaintext. */
export interface EncryptedInput {
  readonly handle: Handle;
  /** The 137-byte gateway proof: 20-byte owner, 20-byte app, 32-byte createdAt, 65-byte signature. */
  readonly proof: Hex;
  readonly type: (typeof ENCRYPTED_TYPES)[number];
}

export class NoxClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoxClientError";
  }
}

/**
 * Raised when a wallet asks for a value it holds no grant on.
 *
 * THIS IS THE EXPECTED, CORRECT OUTCOME OF AN UNAUTHORISED READ — not a fault. It is a distinct
 * error type so an interface can say "you are not authorised to decrypt this" rather than rendering
 * a raw gateway string, and so a test can assert a refusal rather than merely assert a failure.
 */
export class NotAuthorisedToDecryptError extends Error {
  readonly handle: Handle;
  readonly wallet: Address;

  constructor(handle: Handle, wallet: Address) {
    super(
      `${wallet} holds no grant on handle ${handle}, so the gateway refuses to decrypt it. Nox ` +
        "checks authorisation on chain before releasing any key material; nothing about the value " +
        "leaks from the refusal.",
    );
    this.handle = handle;
    this.wallet = wallet;
    this.name = "NotAuthorisedToDecryptError";
  }
}

/**
 * The client surface. Deliberately narrow.
 *
 * `viewACL` from the underlying SDK is NOT wrapped: it reads a subgraph, which does not exist on a
 * local stack and is a separate availability dependency on a testnet. shrud reads ACL state from the
 * chain instead, so an authorisation answer never depends on an indexer being up — and the direction
 * that would be wrong, "you cannot read this" when you can, is the one that misleads a user about
 * their own confidentiality.
 */
export interface ShrudHandleClient {
  readonly network: NoxNetwork;
  readonly account: Address;

  /**
   * Encrypts one plaintext for one application contract.
   *
   * DIRECT-CALLER RULE. The proof binds owner, application contract, chain id and a 3,600-second
   * expiry. The wallet that encrypts MUST be the direct caller of `applicationContract`. There is no
   * relayer, paymaster, Safe transaction, batch router or server signer that can sit in between:
   * `validateInputProof` would see `owner == the signer` and `msg.sender == the intermediary` and
   * refuse. Delta D-10 records the consequence for contract Safe owners.
   */
  encrypt(
    value: bigint,
    type: (typeof ENCRYPTED_TYPES)[number],
    applicationContract: Address,
  ): Promise<EncryptedInput>;

  /** Encrypts many values for the same contract, preserving order. */
  encryptAll(
    values: readonly { value: bigint; type: (typeof ENCRYPTED_TYPES)[number] }[],
    applicationContract: Address,
  ): Promise<EncryptedInput[]>;

  /**
   * Decrypts a value this wallet is authorised to read.
   *
   * Waits for the runner first, with real backoff. Throws {NotAuthorisedToDecryptError} when the
   * wallet holds no grant — which is the confidentiality model working, and is asserted as a
   * PASSING outcome in the suite.
   */
  decrypt(handle: Handle, options?: WaitOptions): Promise<bigint>;

  /** Waits for a handle to become computable without decrypting it. */
  waitReady(handle: Handle, options?: WaitOptions): Promise<import("./runtime.js").HandleStatus>;

  /**
   * Reads a handle that was deliberately published, and returns the gateway's proof with it.
   *
   * THE PROOF IS THE POINT, AND IT IS REPLAYABLE. `validateDecryptionProof` is a pure EIP-712
   * signature check — no ACL, no nonce, no expiry, no caller binding — so this proof attests that
   * the gateway decrypted SOME handle to SOME value and nothing more. Anyone may replay it, in any
   * contract, forever. It becomes a statement about an epoch only once `ShrudIntentBook` has
   * confirmed the handle is the one that sealed epoch committed to for that role. Delta D-7.
   */
  publicDecrypt(handle: Handle, options?: WaitOptions): Promise<{ value: bigint; proof: Hex }>;
}

/**
 * The underlying SDK surface shrud uses, declared rather than imported at the type level.
 *
 * `@iexec-nox/handle` is `0.1.0-beta.13` and says so. Declaring the four methods shrud calls means a
 * breaking change in the SDK surfaces here, at one adapter, instead of as a type error in six
 * packages.
 */
export interface NoxSdkLike {
  encryptInput(
    value: bigint | boolean,
    solidityType: string,
    applicationContract: Address,
  ): Promise<{ handle: string; handleProof: string }>;
  decrypt(handle: string): Promise<{ value: bigint | boolean }>;
  publicDecrypt(handle: string): Promise<{ value: bigint | boolean; decryptionProof: string }>;
}

const SOLIDITY_TYPE: Record<(typeof ENCRYPTED_TYPES)[number], string> = {
  ebool: "bool",
  euint16: "uint16",
  euint256: "uint256",
  eint16: "int16",
  eint256: "int256",
};

export interface CreateClientOptions {
  readonly sdk: NoxSdkLike;
  readonly network: NoxNetwork;
  readonly account: Address;
  /** Reads `NoxCompute.isAllowed` from the chain. See {decrypt} for why this exists. */
  readonly isAllowedOnChain: (handle: Handle, account: Address) => Promise<boolean>;
}

export function createHandleClient(options: CreateClientOptions): ShrudHandleClient {
  const { sdk, network, account, isAllowedOnChain } = options;

  async function encrypt(
    value: bigint,
    type: (typeof ENCRYPTED_TYPES)[number],
    applicationContract: Address,
  ): Promise<EncryptedInput> {
    // Bound the plaintext locally, before it is sent anywhere. Nox would wrap silently.
    assertFitsType(value, type);

    const payload = type === "ebool" ? value !== 0n : value;
    const result = await sdk.encryptInput(payload, SOLIDITY_TYPE[type], applicationContract);
    return { handle: result.handle as Handle, proof: result.handleProof as Hex, type };
  }

  return {
    network,
    account,
    encrypt,

    async encryptAll(values, applicationContract) {
      // Sequential on purpose. Each call mints gateway key material, and issuing dozens
      // concurrently is how a local stack starts dropping them. Ordering is also part of the
      // submission contract — the module imports amount, action and limit in a fixed order.
      const out: EncryptedInput[] = [];
      for (const entry of values) {
        out.push(await encrypt(entry.value, entry.type, applicationContract));
      }
      return out;
    },

    async waitReady(handle, waitOptions) {
      return waitForHandle(network.gatewayUrl, handle, waitOptions ?? {});
    },

    async publicDecrypt(handle, waitOptions) {
      // Readiness first, with real backoff. The SDK's own retry gives up after roughly seven
      // seconds, which is not a policy a keeper can adopt.
      await waitForHandle(network.gatewayUrl, handle, waitOptions ?? {});
      const result = await sdk.publicDecrypt(handle);
      const value = typeof result.value === "boolean" ? (result.value ? 1n : 0n) : result.value;
      return { value, proof: result.decryptionProof as Hex };
    },

    /**
     * Decrypts, tolerating the gateway's authorisation view lagging the chain.
     *
     * THE CHAIN IS AUTHORITATIVE, AND THAT IS WHAT MAKES THE RETRY SAFE. The gateway authorises from
     * its own indexed view of ACL state, which is eventually consistent with the chain — so a
     * refusal can mean either "you may not read this" or "the gateway has not caught up".
     *
     * If the CHAIN agrees the account holds no grant, the refusal is final and correct: that is the
     * confidentiality model working, and every unauthorised-read test depends on it failing fast
     * rather than hanging. If the chain says the account IS allowed, a refusal can only be lag, so
     * it is retried until the caller's own timeout.
     */
    async decrypt(handle, waitOptions) {
      await waitForHandle(network.gatewayUrl, handle, waitOptions ?? {});

      const policy = { ...DEFAULT_POLL_POLICY, ...waitOptions?.policy };
      const deadline = Date.now() + policy.timeoutMs;
      let delay = policy.initialDelayMs;

      for (;;) {
        try {
          const { value } = await sdk.decrypt(handle);
          return typeof value === "boolean" ? (value ? 1n : 0n) : value;
        } catch (error) {
          if (!isAuthorisationRefusal(error)) throw error;

          const allowed = await isAllowedOnChain(handle, account);
          if (!allowed) throw new NotAuthorisedToDecryptError(handle, account);

          if (Date.now() >= deadline) {
            throw new NoxClientError(
              `the chain says ${account} may decrypt ${handle}, but the gateway still refuses after ` +
                `${policy.timeoutMs}ms. Its authorisation view is indexed and eventually consistent ` +
                "with the chain, so this is lag rather than a permission problem — the timeout is a " +
                "shrud policy choice, not a limit of the protocol.",
            );
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * policy.multiplier, policy.maxDelayMs);
        }
      }
    },
  };
}

/**
 * Distinguishes "you may not read this" from "something broke".
 *
 * The SDK signals the refusal with a plain `Error` whose message names the handle and the
 * unauthorised user, so string matching is the only option available. It is deliberately narrow: a
 * transport failure reported to a user as an authorisation refusal would teach them something false
 * about who can see their data.
 */
function isAuthorisationRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("not authorized to decrypt") || message.includes("is not a viewer");
}
