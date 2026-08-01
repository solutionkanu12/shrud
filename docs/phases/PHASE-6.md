# Phase 6 — Test suites

**Status:** complete for the layers built so far
**Evidence:**

```
npx hardhat test                                    66 passing (59 solidity, 7 nodejs), 0 failing
forge test                                          59 passing, 0 failed
forge test --match-path 'test/fork/*' --fork-url …  10 passing, 0 failed  (live Ethereum Sepolia)
```

The seven Node tests ran against the **real** iExec Nox stack in Docker — real handles, real gateway
proofs, real ACL decisions. Nothing on the confidentiality path is mocked.

---

## What this phase was for

Every claim in phases 1 through 5 was an argument. This phase turns the load-bearing ones into
passing or failing tests — and, as it turned out, corrects three of them.

## The split, and why it is drawn where it is

| Suite | Runner | Covers | Why there |
|---|---|---|---|
| `test/unit`, `test/fuzz` | Foundry | registries, guard, price maths, intent book | thousands of fuzz runs; nothing to fake |
| `test/fork` | Foundry + Sepolia fork | every external address and selector | a declared interface is a claim about someone else's contract |
| `test/integration` | Hardhat + Docker | Nox primitives, handles, ACL, proofs | Foundry cannot drive NoxCompute, and a faked one proves nothing |

A `vm.etch`-ed NoxCompute would return numbers this repository chose. That is evidence about the
mock, not about a confidentiality boundary.

## Three things the tests found

### 1 · Safe 1.4.1 does not refuse `setModuleGuard` — it silently accepts it

`test_safe141SilentlyAcceptsSetModuleGuardAndIsThereforeRefused` was originally written to assert
the call would fail. **It does not.** Safe's `FallbackManager` catches every unknown selector, and
with no fallback handler configured it returns empty data and reports success:

```
1.4.1:  safe.setModuleGuard(guard)  ->  succeeds, returns nothing, no guard exists
1.5.0:  safe.setModuleGuard(guard)  ->  reverts GS031 for a non-self caller (the real function)
```

An installer that checked only "did the transaction revert" would report a successful guard
installation on 1.4.1 and leave the module running with unlimited authority over the Safe and no
boundary at all. That is a far sharper argument for delta D-1 than "the function is missing", and it
is why `ShrudModuleFactory` refuses on the `VERSION()` string rather than on a probe of behaviour.

### 2 · The handle-collision rule has a second half that points the opposite way

`computeTwiceIdentically` computed `add(add(toEuint256(a), toEuint256(b)), toEuint256(a))` twice and
expected identical handles. They came back **different**.

`toEuint256` produces a *public* handle, and `_generateHandleUniqueSeed` uses `++storageCounter`
when **every** operand is public. So the inner `add` was unpredictable on each call.

| Operands | Seed | Consequence |
|---|---|---|
| any confidential | `0` | deterministic — handles collide, so anything granted must be isolated |
| all public | `++storageCounter` | unpredictable — handles cannot be reproduced off chain |

The first half is why `ShrudHandleIsolation` exists. The second is why `_requireConfidential`
rejects a public handle before isolating it: an all-public operand set produces a handle no
off-chain verifier can predict, so the graph binding would be decorative rather than checkable.
Both are now asserted, in the same file, against the real stack — and the negative is asserted
beside the positive so removing the defence makes a test fail rather than making a comment stale.

### 3 · `network.connect()` gives you a chain with no NoxCompute on it

Every Nox call reverted with `Transaction reverted without a reason string`, including
`Nox.toEuint256(5)` — a call with no arguments to get wrong.

The cause: `network.connect()` creates a **fresh** in-process chain. The Nox plugin injected
NoxCompute into the node **it** started, so the tests were calling address
`0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685` on a chain where nothing was deployed there. Contracts
deployed, views returned, and every confidential call died with no reason.

`nox.connect()` — the plugin's own, with no arguments — returns the connection to the node holding
NoxCompute. Bisecting from `toEuint256` upward is what located it; the stack trace pointed at the
wrong line and the error named nothing.

## What is asserted, by area

**Vendored TickMath (9 tests).** Uniswap's own `MIN_SQRT_RATIO` and `MAX_SQRT_RATIO` constants, tick
0 exactly `2^96`, strict monotonicity across the full range, and no revert anywhere in range — which
is the assertion that the `unchecked` wrapper is *required* and not merely tidy.

The launch pair's price is checked against a number computed **independently**, by replaying the
published algorithm in a separate implementation: `getQuoteAtTick(120482, 1e18, WETH, USDC)` =
`5,858,613,244,027`. Two implementations agreeing is evidence; one implementation being
self-consistent is not. Transposing base and quote must *invert* the price — the check that catches
the single worst error in that neighbourhood, a swapped pair that produces a plausible number and
moves value between crossed treasuries in the wrong direction.

**Pause controller (10 tests).** Mostly proving absences. `test_noSelectorEscapesHalted` calls every
state-changing entry point from the guardian in the halted state and asserts the state is unchanged —
a test that would fail the moment somebody adds an `unhalt()`. The two-gate asymmetry is asserted
directly: `Paused` stops new value and lets sealed epochs settle.

**Intent book (13 tests).** The central one is
`test_underfundedAndFundedOrdersAreIndistinguishable`: two orders, one that locked fully and one that
locked encrypted zero, must have identical public records in every readable field. The status enum is
checked to have exactly five reachable members, structurally, by casting past the last one.

`testFuzz_onlyStrictlySortedSetsSeal` runs 512 arrangements. The sorted-set requirement is what stops
a coordinator using ordering as a channel, and that only holds if *every* unsorted arrangement is
refused — a fuzz property, not a two-case example.

One test was corrected rather than made to pass: an intent cannot be consumed by a second epoch, and
the refusal is `CandidateEpochMismatch` raised **before** the consumed marker is reached. That is a
stronger property than the one being tested for — the header pins the epoch at submission — so the
test now asserts the ordering.

**Module guard (17 tests).** Every axis it is meant to close, attempted. The one that justifies
decoding arguments at all is `test_wrapToAThirdPartyIsRefused`: `wrap(to, amount)` on a properly
registered wrapper with an allowlisted selector is a completely legitimate call that mints a
confidential balance **to an arbitrary address**. A target allowlist alone permits it. A selector
allowlist alone permits it.

`test_pendingHashIsConsumedExactlyOnce` states its own limit rather than glossing it: Foundry cannot
exercise cross-transaction transient-storage clearing, because `vm.prank` changes the caller and not
the transaction. What is testable is the half that lives in shrud's code — the hash is cleared on
consumption. The EVM guarantee is exercised for real in `test/integration`.

**Live protocols (10 tests, against Sepolia).** Safe 1.5.0 and 1.4.1 both deployed and reporting
their versions; the three-argument `checkSignatures` selector resolving on the real singleton;
Uniswap's factory, router and launch pool; the launch pool holding exactly USDC/WETH at fee 500 with
observation cardinality above 1 and history covering the 1800-second window; `observe()` returning a
TWAP; the registry pricing that TWAP end to end; USDC being an Aave reserve and Uniswap's WETH not
being one; and NoxCompute answering `gateway()` with the address in `source-lock.json`.

The suite **skips cleanly** without a fork URL. A suite that silently passes without a fork would be
worse than one that is absent.

**Nox primitives (7 tests, against Docker).** CLZ executes and returns 255, which is the Osaka
assertion that runs first and fails in milliseconds. A failed `safeSub` returns encrypted zero
**without reverting** — the single most load-bearing behaviour in shrud, since it is what makes an
underfunded lock indistinguishable from a funded one. Handles collide when they should and separate
once isolated. And the same input proof is accepted **twice** at a contract with no consumption
marker, which is the gap `ShrudConfidentialBase._consumeHandle` fills.

## What is not covered yet, and why

| Gap | Reason |
|---|---|
| Full epoch flow: submit → activate → lock → seal → clear → settle | needs deployed Safes and the seed script (Phase 11) |
| Adversarial privacy suite (PRD §22.2) | some attacks need a live epoch; the primitive-level defences are covered above |
| Stateful invariants (PRD §22.1) | the Foundry-testable subset needs the deploy wiring from Phase 11 |
| Gas budget per clearing stage against the 2^24 cap | measured once a real epoch runs end to end |

Each is scheduled rather than skipped, and `PHASES.md` tracks them.

## What the next phase inherits

The TypeScript packages (Phase 7) must reproduce two things the contracts do, and be tested against
the contracts rather than against themselves: the handle derivation (so a verifier can predict a
handle and check the graph binding rather than take it on trust), and the clearing maths (so the
coordinator can size an epoch against the gas cap before sealing it).
