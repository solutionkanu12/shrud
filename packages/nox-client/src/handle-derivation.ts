/**
 * The real Nox handle derivation, reproduced off chain.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS HAS TO BE EXACT, AND WHAT HAPPENS IF IT IS NOT
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A Nox decryption proof is a pure EIP-712 signature check — no ACL, no nonce, no expiry, no caller
 * binding (delta D-7). It attests that the gateway decrypted SOME handle to SOME value, forever,
 * replayable by anyone. It says nothing about which epoch that handle belonged to.
 *
 * `ShrudSettlementEngine` closes that gap on chain by comparing the proof's handle with the one the
 * sealed epoch committed to. A verifier has to be able to do the same thing INDEPENDENTLY — which
 * means predicting the handle from the operation graph rather than reading it back from the same
 * contract it is checking. That is what this file is for.
 *
 * If the derivation were approximate, the binding would be decorative: every honest epoch would
 * fail the check, and the natural response — relaxing the check until it passes — would leave a
 * verifier that checks nothing while appearing to.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE DERIVATION, READ FROM `modules/Compute.sol::_generateHandle` (0.2.4)
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 *     pre    = keccak256(abi.encode(operator, operands, noxCompute, uniqueSeed, outputIndex))
 *     handle = (pre >> 56)                  // 25 bytes of hash in bytes 7..31
 *            | (version  << 248)            // byte 0
 *            | (chainId  << 216)            // bytes 1..4
 *            | (teeType  << 208)            // byte 5
 *            | (attrs    << 200)            // byte 6
 *
 * and from `_generateHandleUniqueSeed`:
 *
 *     uniqueSeed = 0                  if ANY operand is confidential   -> DETERMINISTIC
 *                = ++storageCounter   if EVERY operand is public       -> NOT REPRODUCIBLE
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE LIMIT, STATED UP FRONT
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * An all-public operand set makes the handle depend on a NoxCompute storage counter this package
 * cannot see. {deriveHandle} REFUSES that case rather than guessing — see {AllPublicOperandsError}.
 *
 * shrud is built so it never occurs on a path whose handle must be predicted:
 * `ShrudHandleIsolation._requireConfidential` asserts the same property on chain, from the other
 * side. The two halves were found together — `test/integration/10-nox-primitives.ts` demonstrates
 * both, and the second half is why the on-chain assertion exists at all.
 */

import type { Address, Handle, Hex } from "@shrud/shared";
import { encodeAbiParameters, keccak256 } from "viem";

/** `INoxCompute.Operator`, in declaration order. Nothing outside this list exists. */
export const NOX_OPERATOR = {
  wrapAsPublicHandle: 0,
  add: 1,
  sub: 2,
  mul: 3,
  div: 4,
  safeAdd: 5,
  safeSub: 6,
  safeMul: 7,
  safeDiv: 8,
  select: 9,
  eq: 10,
  ne: 11,
  lt: 12,
  le: 13,
  gt: 14,
  ge: 15,
  transfer: 16,
  mint: 17,
  burn: 18,
} as const;

export type NoxOperator = keyof typeof NOX_OPERATOR;

/**
 * `TEEType`, for the five encrypted types shrud uses.
 *
 * The enum is over a hundred members wide — every uint width, every int width — and only these five
 * have Solidity SDK wrappers. The indexes are read from `utils/TypeUtils.sol` and are NOT guessable
 * from the type name: `Uint256` is 35, not 32, and `Int256` is 67.
 */
export const NOX_TEE_TYPE = {
  ebool: 0,
  euint16: 5,
  euint256: 35,
  eint16: 37,
  eint256: 67,
} as const;

export type EncryptedType = keyof typeof NOX_TEE_TYPE;

/** Bit 0 of the attribute byte. Set by every operation output; cleared by `wrapAsPublicHandle`. */
export const ATTR_IS_UNIQUE_HANDLE = 0x01;

export class HandleDerivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandleDerivationError";
  }
}

/**
 * Raised when every operand is a public handle.
 *
 * NOT A GAP TO BE PAPERED OVER. The seed is a NoxCompute storage counter, so the handle is genuinely
 * unpredictable off chain — there is no formula that would work. Guessing would produce a verifier
 * that reports a binding failure on every honest epoch.
 */
export class AllPublicOperandsError extends HandleDerivationError {
  readonly operator: NoxOperator;

  constructor(operator: NoxOperator) {
    super(
      `every operand of \`${operator}\` is a public handle, so NoxCompute seeds the output from a ` +
        "storage counter and the handle cannot be reproduced off chain. shrud never grants or " +
        "publishes such a handle — ShrudHandleIsolation._requireConfidential refuses it on chain.",
    );
    this.operator = operator;
    this.name = "AllPublicOperandsError";
  }
}

/** A handle is public when bit 0 of byte 6 is clear. Mirrors `HandleUtils.isPublicHandle`. */
export function isPublicHandle(handle: Handle): boolean {
  const byte6 = Number.parseInt(handle.slice(2 + 12, 2 + 14), 16);
  return (byte6 & ATTR_IS_UNIQUE_HANDLE) === 0;
}

export function chainIdOf(handle: Handle): number {
  return Number.parseInt(handle.slice(2 + 2, 2 + 10), 16);
}

export function teeTypeOf(handle: Handle): number {
  return Number.parseInt(handle.slice(2 + 10, 2 + 12), 16);
}

export interface DeriveHandleInput {
  readonly operator: NoxOperator;
  readonly operands: readonly Handle[];
  readonly noxCompute: Address;
  readonly resultType: EncryptedType;
  readonly outputIndex: number;
  readonly chainId: number;
}

/**
 * Derives the handle NoxCompute will return for one operation.
 *
 * @throws {AllPublicOperandsError} when no operand is confidential.
 */
export function deriveHandle(input: DeriveHandleInput): Handle {
  const { operator, operands, noxCompute, resultType, outputIndex, chainId } = input;

  if (operands.length === 0)
    throw new HandleDerivationError("an operation needs at least one operand");

  const anyConfidential = operands.some((h) => !isPublicHandle(h));
  if (!anyConfidential) throw new AllPublicOperandsError(operator);

  const pre = keccak256(
    encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "bytes32[]" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint8" },
      ],
      [NOX_OPERATOR[operator], operands as Hex[], noxCompute, 0n, outputIndex],
    ),
  );

  return composeHandle({
    hash: pre,
    version: 0,
    chainId,
    teeType: NOX_TEE_TYPE[resultType],
    attrs: ATTR_IS_UNIQUE_HANDLE,
  });
}

/**
 * Assembles the 32-byte handle from its parts.
 *
 * Byte layout, from `_generateHandle`: `[0]` version, `[1..4]` chain id, `[5]` TEE type, `[6]`
 * attributes, `[7..31]` the top 25 bytes of the hash. Every field is written explicitly rather than
 * by shifting a single number, because a misplaced shift produces a handle that is the right length,
 * the right shape and wrong — which is exactly the failure this file exists to make impossible.
 */
export function composeHandle(parts: {
  hash: Hex;
  version: number;
  chainId: number;
  teeType: number;
  attrs: number;
}): Handle {
  const hashBytes = parts.hash.slice(2);
  // `pre >> 56` in Solidity keeps the TOP 25 bytes and moves them into positions 7..31.
  const top25 = hashBytes.slice(0, 50);

  const version = parts.version.toString(16).padStart(2, "0");
  const chainId = parts.chainId.toString(16).padStart(8, "0");
  const teeType = parts.teeType.toString(16).padStart(2, "0");
  const attrs = parts.attrs.toString(16).padStart(2, "0");

  return `0x${version}${chainId}${teeType}${attrs}${top25}` as Handle;
}

/** The zero handle for a type — a PUBLIC handle with a zeroed hash. `HandleUtils.zeroHandle`. */
export function zeroHandle(type: EncryptedType, chainId: number): Handle {
  return composeHandle({
    hash: `0x${"00".repeat(32)}`,
    version: 0,
    chainId,
    teeType: NOX_TEE_TYPE[type],
    attrs: 0,
  });
}

/**
 * The handle `ShrudHandleIsolation._isolate` produces.
 *
 * `select(epochCondition, value, toEuint256(domain))` — the condition is confidential, so the seed
 * is 0 and this is reproducible. A verifier uses it to confirm that a handle granted to one Safe is
 * the one that Safe's isolation domain produces, and not another Safe's numerically identical value.
 */
export function deriveIsolatedHandle(args: {
  epochCondition: Handle;
  value: Handle;
  domainTagHandle: Handle;
  noxCompute: Address;
  chainId: number;
  resultType?: EncryptedType;
}): Handle {
  return deriveHandle({
    operator: "select",
    operands: [args.epochCondition, args.value, args.domainTagHandle],
    noxCompute: args.noxCompute,
    resultType: args.resultType ?? "euint256",
    outputIndex: 0,
    chainId: args.chainId,
  });
}
