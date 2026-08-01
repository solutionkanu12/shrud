# Phase 3 — The confidential clearing core

**Status:** complete
**Evidence:** `npx hardhat compile` clean; every deployable artifact measured against EIP-170 (the
largest, `ShrudModuleFactory`, is 19,557 bytes with 5,019 to spare; `ShrudClearingEngine` is 13,100
with 11,476 to spare). The TickMath port was cross-checked against the live Sepolia pool.

---

## What this phase was for

This is the mechanism. Everything before it moves value into a place where it can be cleared;
everything after it settles what could not be. Phase 3 is where a buy and a sell from two treasuries
that have never met cancel each other out at a price neither of them chose, without either amount,
side, limit or identity reaching a public venue.

## What was built

| Contract | Role |
|---|---|
| `clearing/ShrudReferencePriceRegistry.sol` | one fixed, auditable price method per pair; the sealed snapshot |
| `clearing/ShrudClearingVault.sol` | custody, the lock callback, four exits and no fifth |
| `clearing/ShrudClearingEngine.sol` | the staged encrypted operation graph |
| `libraries/uniswap/TickMath.sol` | `getSqrtRatioAtTick`, vendored with provenance |
| `interfaces/IUniswapV3Pool.sol` | the four pool methods used, declared not imported |

## The decisions worth reading

### The price registry carries more risk than its size suggests

Internal crossing moves value between treasuries at a price nobody outside can see. If the price is
wrong, the transfer is still confidential — it just moves the wrong amount, from a Safe that cannot
tell, to a Safe that cannot tell either. There is no slippage check to catch it, because the entire
point of crossing is that it never touches a public venue.

Four controls, each stopping something specific:

1. **A time-weighted mean, not a spot price.** `slot0().tick` is whatever the last swap left behind
   and costs one flash-loaned trade to move.
2. **Minimum observation history, read from the ring buffer directly.** `observe()` reverts with a
   bare `OLD` when the window predates the oldest observation, and a pool with
   `observationCardinality == 0` — the **default** for a freshly created pool, and true of three of
   the four Sepolia candidates in delta D-8 — has no history at all. shrud reads the oldest
   observation itself so the refusal names the cause.
3. **A bound on spot-versus-mean, expressed in ticks.** A basis-point bound needs a price to compare
   against, which means an extra `getSqrtRatioAtTick` per side and a division whose rounding then
   has to be argued about. Ticks are what the pool stores, the relationship is exact, and the
   comparison is one subtraction.
4. **Staleness checked at USE, not at capture.** A snapshot taken correctly and settled against ten
   minutes later is a stale price with a valid provenance record.

There is one more line worth calling out. Solidity's integer division truncates toward zero;
Uniswap's own `consult()` floors. For negative mean ticks they differ by one tick. One tick on a
crossed amount is still a value transfer between two treasuries, so the correction is applied rather
than waved away.

### `price` is raw-quote-per-raw-base, and the decimal gap is absorbed exactly once

`price = getQuoteAtTick(meanTick, 1e18, base, quote)` — the quote received for `PRICE_SCALE` raw base
units. Keeping raw units on both sides means the 6-versus-18 decimal gap between USDC and WETH is
resolved here, in plaintext, where it can be tested — and never appears again inside the encrypted
arithmetic. A misplaced decimal factor in the engine would be an encrypted, unobservable value
transfer between crossed participants: the single worst place in this system for one to hide.

**Cross-checked against reality.** Replaying the vendored TickMath algorithm on the live pool's TWAP
tick of 120,482 reproduces `sqrtPriceX96 = 32732725556913782187452051720199` against the pool's own
spot `32733565127528925963355307765615` — a 0.01 % difference, which is exactly the mean-versus-spot
gap and not an implementation error. The resulting price is 5,858,613.24 USDC per WETH. That is a
testnet number with no relationship to any real market, and the UI says so: shrud proves the price
was fixed, sourced and sealed, not that the level means anything.

### The vault has no owner withdrawal function, and never will

Value leaves in exactly four ways, each triggered by a contract fixed at deployment: allocation by
the engine, residual release to the settlement engine, a Safe-authorised cancellation refund, and
the emergency exit under a halted network. No admin, no governor, no pause-privileged sweep, no
rescue function. A rescue function is how a vault with correct accounting loses its assets anyway,
and every argument for adding one is an argument for a key that can take the money.

### The lock callback assumes nothing, and it cannot compute on the amount it is given

`onConfidentialTransferReceived` can be called by anyone. Three checks, none skippable: the sender
must be a wrapper the registry currently recognises *including its runtime code hash*; the operator
must be the shrud module bound to `from`; and the callback data must name an intent whose header
agrees with the sender, the operator and the epoch. A correct transfer credited to the wrong intent
is a theft with a valid receipt.

**A finding for `feedback.md`:** `IERC7984Receiver`'s documentation states *"The `amount` handle is
accessible to this contract via the ACL."* It is not. `ERC7984Base._transferAndCall` grants transient
access to `msg.sender` — the operator — and never to the receiver. A receiver following the
documentation would write code that is refused inside NoxCompute. shrud works with the
implementation: the callback records that a credit is expected, and the module (which does hold the
grant) isolates the transferred handle and hands it back through `confirmLock`.

### There is no boolean algebra, and shrud does not simulate any

PRD §10.2 writes `eligibleBuy_i = v_i AND isBuy_i AND buyLimitPass_i`. Nox has no `and`, no `or`, no
`not`, no `xor`, and `select` has no `ebool` overload. That line cannot be written.

The obvious workaround is to arithmetise: map each predicate to a 0/1 indicator, multiply, compare.
Four operations. shrud instead gates the **amount**:

```
amount = select(isBuy,     amount, ZERO)
amount = select(limitPass, amount, ZERO)
```

Two operations, arithmetically identical, and — the part that actually matters — there is no point
at which a combined boolean exists that could be granted, published, or accidentally decrypted.

### Every safe-op flag is threaded, through one helper

`safeMul`, `safeDiv`, `safeAdd` and `safeSub` return `(ebool success, T result)`. On failure the flag
is encrypted false **and the result is encrypted zero**, while the transaction succeeds. Unsafe `div`
by zero does not revert either — it saturates to the type maximum. The flag is a ciphertext, so
nothing can branch on it.

`_mulDiv` threads both flags through `select` before the result can become anything. One helper used
everywhere, rather than a pattern repeated and eventually missed. `_mulDivCeil` threads four.

This matters most at allocation, where `B` or `Q` is legitimately zero on a one-sided epoch.
`safeDiv` returns encrypted zero, `_mulDiv` gates it, the internal cross is zero, and everything
flows to the residual — with no public branch, and no way for an observer to tell a one-sided epoch
from a balanced one at that stage.

### The aggregate minimum simplifies, and the simplification is exact

PRD §10.7 gives `requiredVenueTotal_i = ceil(remainingMinimum_i * aggregate / residualInput_i)`. For
a buy contributor with private max price `l_i`, the minimum base its own residual quote must buy is
`residualInput_i * S / l_i`. Substituting:

```
ceil( (residualInput_i * S / l_i) * aggregate / residualInput_i )  ==  ceil(aggregate * S / l_i)
```

`residualInput_i` cancels. Worth stating plainly for two reasons. It removes a per-candidate
denominator from the encrypted graph. And it makes the meaning obvious: **the aggregate minimum is
set by the strictest surviving limit, and by nothing about how large that participant was.** The
mirror case for a sell contributor is `ceil(aggregate * l_i / S)`.

### The graph is staged because two hard limits say it must be

Nox has no batch entry point — every primitive is a separate external call, so cost is linear and
there is no amortisation to find. EIP-7825 caps one transaction at 2^24 gas. A sixteen-candidate
epoch is roughly 800 primitives and does not fit.

The local Nox node would never say so: it has no such cap. This is the same class of trap as the
unlimited contract size — a limit that exists on the real chain and not in the test environment.
Every stage is resumable through a cursor and takes a caller-sized `maxCandidates`.

The staging is exposed in the interface rather than hidden. An asynchronous confidential computation
that pretends to be instantaneous is a worse product than one that says where it is.

### `finaliseResidual` is separate from `runResidual`, and that separation is a bug fix

The aggregate minimum needs the **final** aggregate, which only exists once every candidate has been
through the contribution loop. Computing it inside the resumable loop would measure each candidate's
requirement against a partial aggregate — producing a plausible-looking minimum that was simply too
low, which would surface as a settlement that satisfied the aggregate check while shortchanging a
participant. Splitting the stage makes that impossible rather than merely unlikely.

### Exactly five handles ever become publicly decryptable

`allowPublicDecryption` is irreversible. `sdk/Nox.sol` has no counterpart — no un-publish, no expiry,
nothing. `publishResidual` is therefore the narrowest point in the system, and it publishes:

| Handle | What it says |
|---|---|
| `meetsEpochFloor` | was this a real multi-party set |
| `meetsResidualFloor` | does the public route have enough contributors |
| `residualDirection` | which way the net imbalance points |
| `residualAggregateInput` | how much goes to the venue |
| `residualAggregateMinimum` | what must come back |

Gross buy demand, gross sell supply, the crossed volume, the exact effective count, the exact
contributor count and every per-treasury value are **not** here. Adding one later would be
irreversible for every epoch it touched.

Committing the same five to `ShrudIntentBook` in the same transaction is what makes a decryption
proof mean anything at all. A proof is a pure signature check with no epoch binding (delta D-7); the
settlement engine matches the proof's handle against this commitment before acting on the value.

### Two isolation calls that are worth their cost

`_isolateBool` costs seven NoxCompute calls and is paid exactly twice per epoch, for the two floor
booleans. Both values are public either way, so a handle collision would leak nothing — but a
decryption proof issued for one epoch's floor would bind to another's, and a binding that is weaker
than it claims is a defect whether or not it is exploitable today.

## Measured contract sizes

| Contract | Runtime bytes | Headroom to EIP-170 |
|---|---|---|
| `ShrudModuleFactory` | 19,557 | 5,019 |
| `ShrudClearingEngine` | 13,100 | 11,476 |
| `ShrudSafeModule` | 12,544 | 12,032 |
| `ShrudReferencePriceRegistry` | 8,998 | 15,578 |
| `ShrudWrappedAsset` | 8,383 | 16,193 |

`ShrudModuleFactory` is largest because it embeds the module's creation code, which embeds the
guard's — the price of `predictAddresses` being exact. The `runs: 1` override on the clearing and
settlement engines is retained even though the engine currently fits comfortably: the operation
graph grows with every order family added, and discovering the limit at a Sepolia deployment is
exactly the failure mode `pnpm verify:contract-size` exists to prevent.

## What the next phase inherits

`ShrudSettlementEngine` (Phase 4) reads the five committed handles from `ShrudIntentBook`, verifies
each decryption proof **against that commitment**, and calls `grantSettlementAccess` to receive
compute rights on each candidate's residual contribution and internal-cross outputs. Reconciliation
— combining internal and external settlement into each Safe's final confidential balance — lives
there rather than here, because it needs the venue's actual output.
