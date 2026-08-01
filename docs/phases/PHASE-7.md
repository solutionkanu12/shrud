# Phase 7 — TypeScript packages

**Status:** complete
**Evidence:**

```
pnpm exec tsc --build --force                       clean across all 9 packages
node --test packages/clearing-math/test/*.test.ts   14 passing, 0 failing
```

---

## What this phase was for

Three things the contracts do that something off chain has to be able to do independently:

1. **Predict a handle.** A verifier that reads the handle back from the contract it is checking has
   checked nothing.
2. **Reproduce the clearing maths.** The engine's arithmetic runs on ciphertexts, so nobody can look
   at an epoch and see whether the crossed amount was right.
3. **Size an epoch against the gas cap before sealing it.** Sealing locks capital; discovering the
   2^24 limit afterwards means an epoch that cannot complete.

## What was built

| Package | Role |
|---|---|
| `@shrud/shared` | constants, types and the privacy vocabulary. Zero dependencies |
| `@shrud/clearing-math` | the clearing maths in plaintext, plus the gas budget |
| `@shrud/nox-client` | the **only** package permitted to import iExec Nox |
| `@shrud/safe-client` | Safe reads, shrud's digests, signature packing |
| `@shrud/verification` | the checks, as data, so web and CLI cannot disagree |
| `@shrud/sdk` | the public surface from PRD §26.1 |
| `@shrud/adapter-sdk` | the registration gate for a new adapter |
| `@shrud/contracts-generated` | ABIs and deployments, generated, never hand-edited |
| `@shrud/ui` | shared interface primitives (Phase 9) |

## The decisions worth reading

### One Nox import site, enforced rather than agreed

Nox is version-skewed across four surfaces: the JS SDK (`0.1.0-beta.13`, which says it is unstable),
the Hardhat plugin, the published Solidity contracts, and two testnets running different contract
versions with different KMS keys. Letting each package import it directly spreads that skew
everywhere and makes a version bump a repository-wide change.

`@shrud/nox-client` is the only importer, and `scripts/verify-live/import-boundary.ts` fails the
build if anything else reaches around it.

The client also declares the SDK's four methods as a local `NoxSdkLike` interface rather than
importing its types. A breaking change in a beta SDK then surfaces at one adapter instead of as a
type error in six packages.

### `deriveHandle` refuses the case it cannot compute, rather than guessing

An all-public operand set makes the handle depend on a NoxCompute storage counter this package
cannot see. `AllPublicOperandsError` is thrown rather than an approximation returned.

That matters because of what "approximate" would do here. A verifier whose derivation is nearly
right reports a binding failure on **every honest epoch** — and the natural response, relaxing the
check until it passes, leaves a verifier that checks nothing while appearing to.

`ShrudHandleIsolation._requireConfidential` asserts the same property on chain, from the other side.
The two halves were found together in Phase 6.

### The polling policy is a stated choice, not a default

The Nox SDK's own retry gives up after roughly seven seconds — three attempts at 1s, 2s, 4s. That is
not a policy a keeper can adopt: the runner's hosted-testnet latency is not a number this project has
enough samples to bound, and a settlement that abandons a ready epoch because it waited seven seconds
strands capital.

`DEFAULT_POLL_POLICY` uses five minutes with real backoff, and the header says it is a shrud choice
rather than a protocol limit. The costs of the two errors are not symmetric.

The response parser is the other trap. The status endpoint is undocumented, so the obvious guesses —
`{state}`, `{status}`, `{ready}` — all look plausible and none is what a live gateway returns. The
measured shape goes first; the guesses stay as fallbacks. A parser that silently falls through to
"unknown" makes every wait run to timeout while looking like latency.

### `decrypt` retries on refusal, and the chain is what makes that safe

The gateway authorises from its own indexed view of ACL state, which is eventually consistent with
the chain. So a refusal means either "you may not read this" or "the gateway has not caught up".

If the **chain** agrees the account holds no grant, the refusal is final — that is the
confidentiality model working, and every unauthorised-read test depends on it failing fast rather
than hanging. If the chain says the account is allowed, a refusal can only be lag. The chain is the
authority; the retry is bounded by the caller's own timeout.

### Signature packing sorts, and that is the difference between working and `GS026`

Safe's `checkNSignatures` requires recovered owners in **strictly ascending address order**. A
correct set of signatures from enough real owners is rejected if concatenated in collection order —
which is whatever order humans signed in, and is never sorted. The error names neither ordering nor
the offending owner.

One function, used everywhere. Duplicates are refused rather than deduplicated: two signatures from
one owner is either a collection bug or an attempt to satisfy a threshold with one key, and both
deserve to be loud. Short signatures are refused too, because Safe reads fixed 65-byte slots and a
short one silently misaligns every signature after it.

### A verdict has four values

`pass` / `warning` / `fail` / **`reported-not-verified`**.

The fourth is for things a record *asserts* and a run did not check — a compiler version from a
manifest, a verification status from a block explorer's API. Reporting those as `pass` misstates who
checked. Dropping them hides a claim the product is making. Its absence is how a verifier ends up
claiming to have checked things it read.

`LIVE_CHECKS` and `ADVERSARIAL_CHECKS` are **manifests**, not function calls, so the web verifier
renders the same set the CLI runs and a check cannot be silently dropped from one surface. Each
carries a `consequence` — what a failure would mean, in one sentence — which is what makes a red row
actionable rather than alarming.

### The adapter SDK is a gate, and the slippage tolerance is zero

Every item in `SETTLEMENT_ADAPTER_REVIEW` is a failure that has happened to somebody: arbitrary
calldata, a caller-chosen recipient, a standing approval, trusting an adapter's reported output.

`slippageToleranceBps` is capped at **zero**, and `SLIPPAGE_MUST_BE_ZERO` says why. The aggregate
minimum is not a tolerance — it is the maximum over the real private limits of the treasuries in the
epoch. A tolerance below it would settle at a price at least one participant explicitly refused, and
that participant could never find out: their limit is a ciphertext and so is their allocation.

"A few basis points of slippage" is a reasonable default where the person bearing it can see it.
Here they cannot.

### `erasableSyntaxOnly` forced a real improvement

Five classes used TypeScript parameter properties (`constructor(readonly x: T)`). Under
`erasableSyntaxOnly` they fail to compile, because they are syntax that emits code rather than syntax
that erases. Rewriting them as explicit fields is more verbose and strictly clearer about what the
constructor does — and it keeps the packages runnable by any runtime that strips types rather than
compiling them, which is what the Snap and the Workers need.

## What the tests assert

Fourteen tests over `clearing-math`, and three are worth naming:

**The aggregate minimum comes from the strictest limit, not the largest contributor.** A buyer
contributing 100,000 with a permissive limit and one contributing 1,000 with a demanding one — the
small, demanding buyer sets the minimum. This is the executable check that `residualInput_i` really
does cancel out of PRD §10.7.

**A one-sided epoch divides by zero and produces zeros, not errors.** `mulDivFloor` returns 0 for a
zero denominator exactly as a threaded `Nox.safeDiv` does, so nothing is a special case in the engine
either.

**A full 16-candidate epoch must NOT fit in one transaction.** The assertion is inverted on purpose:
if it ever fits, the staging machinery has stopped being load-bearing and should be reconsidered
rather than left in place.

## What the next phases inherit

The services (Phase 8) build on `planClearing` for sizing and on `@shrud/verification`'s manifests
for reporting. The web app (Phase 9) uses `disclosurePreview` to render the public/private boundary
before a user signs, and `PrivacyLabel` / `PrivateValueState` as closed unions so an unlabelled value
fails to compile. The Snap (Phase 10) uses `commitToDraft` and `intentDigest` — the same functions
the SDK uses, not its own copies, because two encoders that disagree about field order produce two
commitments from one order and the failure looks like tampering rather than an encoding difference.
