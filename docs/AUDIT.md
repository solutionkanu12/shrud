# Pre-deployment audit

**Run:** 2026-07-31, before any Sepolia broadcast.
**Question asked:** was everything in the PRD done well, or at least done right — and do the current
docs say anything that contradicts what was built from package source?

This is a self-audit and says so. It is not a substitute for an external review.

---

## 1 · Documentation re-verification

Everything load-bearing was originally read from **package source**, on the principle that source
outranks prose. This pass re-read the published docs to find any place where the docs are more
current than the package, or where the package's behaviour is not what the docs promise.

| Claim | Package source | Current docs | Verdict |
|---|---|---|---|
| No `and` / `or` / `not` / `xor` | absent from `sdk/Nox.sol@0.2.4` | comparisons page lists exactly `eq ne lt le gt ge`; no logical operators anywhere | **agree** |
| `select` has no `ebool` overload | four overloads, none returning `ebool` | select page documents one overload returning `euint256`; notes `euint16/euint256/eint16/eint256` | **agree** |
| Grants are permanent | no `removeViewer`, `removeAdmin`, or un-publish | *"This permission is permanent and cannot be revoked."* — stated three times | **agree, and docs are more explicit** |
| Recommended workaround for revocation | — | docs name the **"new-handle isolation pattern"** | **agrees with `ShrudHandleIsolation` and `ShrudCapsuleFactory`** |
| Package versions | `nox-protocol-contracts@0.2.4`, `nox-confidential-contracts@0.2.2`, `handle@0.1.0-beta.13` | npm latest is identical for all three | **current** |

**One package moved.** `@iexec-nox/nox-hardhat-plugin` is at 0.2.0; shrud pins 0.1.0. That plugin is
test infrastructure — it boots the local Docker stack and ships in nothing — and the pinned version
drives the real stack correctly on every run. Recorded rather than bumped mid-audit, because a
toolchain change immediately before a deployment is the kind of thing that turns a green suite red
for a reason nobody has time to investigate.

**Nothing in the docs contradicted the source.** Where they differ it is in the docs being *more*
emphatic about permanence, which strengthens the case for the isolation design rather than weakening
it.

## 2 · One real gap, found and fixed

**The Aave leg was classified and accumulated but never settled.**

`ShrudClearingEngine` classified `ACTION_SUPPLY_QUOTE` and summed it into `grossSupplyQuote`.
Nothing then read that value. `AaveSupplyAdapter` and `ShrudPositionLedger` were both **dead code** —
compiled, tested for their own logic, and unreachable from any settlement path.

That is a claim the PRD makes (§9.12, §11.9, §27.6) that the product did not deliver, and it would
have shipped as an Aave integration that never touches Aave.

**What was added:**

- `EpochPublishedHandles` gained `meetsSupplyFloor` and `supplyAggregateInput`. The published set is
  now **seven** handles rather than five, and the two routes are independent: an epoch can produce
  both, one, or neither.
- Each route carries **its own floor**. Sharing one would let a two-contributor swap route authorise
  a one-contributor supply — which is that contributor's amount in plaintext with a privacy story
  attached.
- `ShrudSettlementEngine` gained `verifyAggregateSupply`, `settleAggregateSupply` and
  `reconcileSupply`. The supply's output is the aToken balance delta at the position ledger, because
  `Pool.supply` returns nothing at all and aTokens rebase.
- `sharesPerAsset` is read from the ledger **before** the principal moves. Reading it afterwards
  would price this epoch's entrants at the position they had just enlarged.

## 3 · A second gap, found by trying to deploy

**`ShrudIntentBook` had one immutable `registrar`, and four contracts need to write to it.**

The single-registrar design reads as the tighter one and is unbuildable: `ShrudSafeModule`,
`ShrudClearingEngine`, `ShrudSettlementEngine` and one module per Safe all write. It compiled, passed
every test, and would have failed at the first line of the deploy script.

Collapsing them behind one address would mean routing every write through a hub — a contract with
authority over the whole book and no purpose except to hold it.

**What was added:** a writer set, **closed** at wiring. Three addresses fixed in one transaction,
plus modules that only `ShrudModuleFactory` may add. No function removes a writer and none re-opens
the wiring. `test/fork/Deployment.t.sol` asserts both halves.

## 4 · Governance delays became deployment parameters

The three registries had a hard-coded seven-day delay. On Sepolia that means the protocol cannot
register its first asset for a week — which makes the deployment untestable and teaches a reviewer
nothing about the mechanism.

The obvious fix is to shorten the constant, which quietly weakens mainnet. Instead the delay is a
constructor parameter with `MAINNET_MINIMUM_DELAY` **enforced on chain for chain id 1**: a mainnet
deployment cannot choose a shorter one whatever its deploy script says. The value actually enforced
is recorded in the manifest, so it is a published fact rather than an assumption from reading
another deployment's source.

This deployment uses **six hours** — long enough to be a real timelock, short enough to be exercised
in a review. `test_assetRegistrationWaitsOutTheDelayAndThenApplies` proves the refusal and then the
acceptance.

## 5 · PRD coverage

| PRD section | Status |
|---|---|
| §9.1–§9.15 contract architecture | **complete** — 19 deployable contracts, all within EIP-170 |
| §10 clearing mathematics | **complete**, with §10.7's algebra simplified exactly (see below) |
| §12 state machines | **complete** — intent, epoch, position, capsule |
| §20 security model | **complete** |
| §21 invariants | asset, crossing, residual, pooled-position and governance invariants implemented; privacy invariants implemented and partly asserted |
| §22.1 test layers | unit, fuzz, fork and real-Nox integration **complete**; stateful invariants **not written** |
| §22.2 adversarial privacy | primitive-level defences asserted; the full suite needs a live epoch |
| §22.3–§22.4 verification commands | **not written** |
| §13 off-chain services | **not built** |
| §14–§19 clients | **in progress** |
| §24.3 demo topology | **deliberately not built** — see below |

**§10.7 simplifies, and the simplification is exact.** `requiredVenueTotal_i = ceil(remainingMinimum_i
× aggregate / residualInput_i)` reduces to `ceil(aggregate × S / l_i)` for a buyer — `residualInput_i`
cancels. That removes a per-candidate denominator from the encrypted graph and makes the meaning
plain: the aggregate minimum is set by the **strictest surviving limit**, and by nothing about how
large that participant was. Asserted in `packages/clearing-math/test`.

## 6 · What is deliberately not built, and why

**PRD §24.3 asks for four demo Safes holding real test tokens, seeded by the deployment.** shrud does
not do this, and the deploy script says so where somebody will read it.

The hackathon brief requires the project to *"work end to end without mock data"* (⭐⭐⭐, the highest
weighting it assigns). A deploy script that plants demo state is how a repository ends up with a
verifier that passes against numbers the repository wrote. What comes out of `pnpm deploy:sepolia` is
a protocol with **nothing in it** — no Safes, no orders, no balances, no epochs. Everything after
that belongs to whoever created it.

The cost is honest: a judge cannot open a pre-populated dashboard. The demo runbook walks through
creating a real Safe and submitting a real order instead, which is a slower story and a true one.

## 7 · What this audit did not check

- **No external security review.** This is the author auditing their own work.
- **No formal verification**, and no Slither run: `crytic-compile` does not drive solc 0.8.36.
- **The full epoch has never run end to end.** Every stage is tested; the composition is not, because
  it needs deployed Safes and a live Nox epoch on Sepolia.
- **Gas per clearing stage is estimated, not measured.** `PRIMITIVE_GAS_ESTIMATE` is deliberately
  conservative at 18,000 against a 6,000–16,000 observed range, and `planClearing` sizes batches
  against 80 % of the EIP-7825 cap. Under-estimating strands capital; over-estimating costs a
  transaction. Those are not symmetric, and the constant leans accordingly.

## 8 · Evidence

```
npx hardhat test                                             66 passing, 0 failing   (7 vs real Nox in Docker)
forge test                                                   61 passing, 0 failing
FOUNDRY_PROFILE=fork forge test --match-path test/fork/*      19 passing, 0 failing   (live Sepolia)
node --test packages/clearing-math/test/*.test.ts             14 passing, 0 failing
19 deployable contracts, 0 over EIP-170
```

The deployment fork test stands the entire protocol up against the real Uniswap pool, the real Aave
pool and the real tokens — both address cycles predicted and asserted, the wiring proven one-shot,
the timelock proven real, and the price fixed from live observations at tick **120,482**
(5,858,613 USDC per WETH, a testnet number this project describes as one).

**Verdict: ready to deploy.** Two real gaps were found and closed. Nothing in the current
documentation contradicts what was built.
