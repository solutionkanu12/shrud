/**
 * A deliberate stub for the `@x402/*` packages.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `@rainbow-me/rainbowkit`'s entry barrel statically imports every connector it ships, including
 * Base Account. Base Account reaches `@coinbase/cdp-sdk`, which imports the `@x402/*` stablecoin
 * payment packages and `@solana/kit`. None of those are installed, none is a peer dependency
 * anything here declares, and none is reachable at runtime: the connector list in
 * `src/lib/wagmi.ts` never instantiates Base Account.
 *
 * The bundler resolves the whole barrel regardless and fails on the missing imports.
 *
 * Installing `@x402/*` to satisfy imports nothing calls would add a payments SDK and a Solana
 * signer stack to a treasury application's dependency tree. That is a real supply-chain surface
 * accepted in exchange for a build error, which is a bad trade. This module resolves them to
 * nothing instead.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY EACH EXPORT THROWS RATHER THAN RETURNING A HARMLESS VALUE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Turbopack checks named exports statically, so the stub has to name them. Each one throws, so if
 * a future change ever does route through Base Account's payment path, it fails immediately and
 * says why. A stub that quietly returned `undefined` would let a payment flow half-execute against
 * a signer that does not exist.
 *
 * If a future RainbowKit tree-shakes its connectors, delete this file and the aliases in
 * `next.config.ts` together.
 */

function unreachable(name: string): never {
  throw new Error(
    `${name} was called from @x402, which shrud stubs out. Base Account is not an offered ` +
      "connector, so this path should be unreachable. See src/lib/stubs/unused-module.ts.",
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const toClientEvmSigner = (): never => unreachable("toClientEvmSigner");
export const wrapFetchWithPayment = (): never => unreachable("wrapFetchWithPayment");
export const registerExactEvmScheme = (): never => unreachable("registerExactEvmScheme");
export const paymentMiddlewareFromConfig = (): never => unreachable("paymentMiddlewareFromConfig");
export const paymentMiddlewareFromHTTPServer = (): never =>
  unreachable("paymentMiddlewareFromHTTPServer");
export const bazaarResourceServerExtension = (): never =>
  unreachable("bazaarResourceServerExtension");

export class x402Client {
  constructor() {
    unreachable("x402Client");
  }
}
export class x402ResourceServer {
  constructor() {
    unreachable("x402ResourceServer");
  }
}
export class x402HTTPResourceServer {
  constructor() {
    unreachable("x402HTTPResourceServer");
  }
}
export class HTTPFacilitatorClient {
  constructor() {
    unreachable("HTTPFacilitatorClient");
  }
}
export class ExactEvmScheme {
  constructor() {
    unreachable("ExactEvmScheme");
  }
}
export class ExactEvmSchemeV1 {
  constructor() {
    unreachable("ExactEvmSchemeV1");
  }
}
export class ExactSvmScheme {
  constructor() {
    unreachable("ExactSvmScheme");
  }
}
export class ExactSvmSchemeV1 {
  constructor() {
    unreachable("ExactSvmSchemeV1");
  }
}
export class UptoEvmScheme {
  constructor() {
    unreachable("UptoEvmScheme");
  }
}
export class BatchSettlementEvmScheme {
  constructor() {
    unreachable("BatchSettlementEvmScheme");
  }
}

export default {};
