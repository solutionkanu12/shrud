# Phase 4 — Residual settlement and the public boundary

**Status:** complete
**Evidence:** `npx hardhat compile` clean; all 17 deployable contracts within EIP-170, the largest
being `ShrudModuleFactory` at 20,912 bytes.

---

## What this phase was for

Everything up to here has been confidential. Phase 4 is the one place where a plaintext amount
exists, and it exists for exactly as long as one call to an unchanged public protocol takes.

The design question is not "how do we call Uniswap" — that is four lines. It is: given that this
contract holds the aggregate residual of several treasuries at the moment a plaintext exists, what
is the smallest set of things it is allowed to do?

## What was built

| Contract | Role |
|---|---|
| `interfaces/IShrudSettlementAdapter.sol` | the narrow, fixed-target adapter shape |
| `adapters/ShrudAdapterRegistry.sol` | reviewed adapters, code-hash bound, delayed governance |
| `adapters/UniswapResidualAdapter.sol` | one aggregate exact-input swap |
| `adapters/AaveSupplyAdapter.sol` | one aggregate supply; withdrawal is a separate function |
| `settlement/ShrudPositionLedger.sol` | public pooled position, confidential ownership |
| `settlement/ShrudSettlementEngine.sol` | proof verification, the venue call, reconciliation |

## The decisions worth reading

### The adapter interface has no `bytes data`, and that is the entire security model

There is no calldata parameter, no target address in `SettleParams`, no command array, no route
encoding, no fee recipient, no callback registration. An adapter's venue, permitted selectors and
recipient are constructor immutables checked against the registry before it is called.

This is not defensive tidiness. A `bytes data` parameter on a function called by a contract holding
several treasuries' aggregate residual, at the one moment a plaintext exists, is a general-purpose
call from a vault.

The recipient is named in `SettleParams` so the engine's intent appears in the trace, and every
adapter then refuses any value that disagrees with its own immutable. A caller-chosen recipient is
the whole exploit: a correctly priced, correctly bounded swap whose output goes somewhere else.

### `amountIn == 0` is refused, and the reason is a documented SwapRouter02 behaviour

SwapRouter02's own documentation: *"Setting `amountIn` to 0 will cause the contract to look up its
own balance, and swap the entire amount."* A zero-input settlement would therefore not be a no-op —
it would sweep whatever the adapter happened to be holding.

PRD invariant 21.3.8 says a public venue is never called for an encrypted-zero residual. The
settlement engine enforces that upstream; the adapter's own refusal is what makes the invariant hold
even if a caller reached there anyway. The adapter also sweeps any leftover input back to the vault
in the same transaction, so there is never a balance for that behaviour to find.

### `ExactInputSingleParams` has no `deadline` field

SwapRouter02 dropped it when it replaced SwapRouter. Passing the old seven-field struct with a
deadline silently misaligns every argument after `recipient` — `amountIn` becomes the minimum,
the minimum becomes the price limit. Verified against `swap-router-contracts@1.3.1`. The deadline is
still checked, by the adapter, against the registry's `maxDeadlineWindow`.

### The output is measured, never reported

`settle` returns what the adapter believes it produced. The engine discards it and takes the
recipient's balance delta across the call.

A returned number is a claim by the adapter. A balance delta is a fact about the chain. They differ
when a token takes a fee on transfer, when a venue partially fills, when an adapter has a defect in
its own accounting, and when a rebasing token accrues mid-transaction. Allocating against the claim
is how a vault ends up owing more than it holds.

Aave makes this unavoidable rather than merely correct: `supply` returns nothing at all, and aTokens
rebase. A measured delta is the only number available, and it is the right one anyway.

### A valid decryption proof proves almost nothing on its own

`validateDecryptionProof` is a pure EIP-712 signature check. No ACL, no nonce, no expiry, no caller
binding. A valid proof attests that the gateway decrypted *some* handle to *some* value — forever,
replayable by anyone. It says nothing about which epoch that handle belonged to.

The binding is `ShrudIntentBook.publishedHandlesOf(epochId)`, committed by the clearing engine in
the same transaction that published those five handles. Every proof is checked against the handle
this sealed epoch committed to *for that role*. Without the second half, an attacker could settle
epoch A against epoch B's aggregate — both proofs valid, both values real, and the wrong amount
leaving the vault.

The same reasoning drives `_residualWrapper`: the input asset is derived from the **published
direction**, not supplied by the caller, and the chosen wrapper is then required to agree with the
adapter about which ERC-20 it wraps. A caller who could pick the asset could settle a
quote-denominated residual out of the base escrow.

### There is no `try/catch` around the venue call, and removing it fixed a real bug

The first version caught adapter failures, wrote `Recoverable`, and reverted. That does not work: the
revert rolls the write back. Not reverting is worse — the unwrapped plaintext residual would sit on
the settlement engine with the epoch already consumed.

So a venue failure reverts the whole transaction. Nothing is consumed, nothing moves, and anyone can
retry. Recovery is a separate, time-bounded path: `declareTimedOut` moves a verified-but-unsettled
epoch to `Recoverable` after `SETTLEMENT_TIMEOUT_BLOCKS` (600, roughly two hours), and marks it
consumed so a keeper that comes back cannot settle an epoch whose participants have already exited.

That is also what PRD §9.15 actually describes — *recover a timed-out residual after proving no
public venue call succeeded* — rather than an exception handler.

### Reentrancy is handled by the state machine, not a guard modifier

`Settling` is written before any external call and `Executed` after, and every entry point checks
the status it requires. A reentrant call arrives in `Settling` and finds no function that accepts
it. This is stronger than a boolean lock because it also excludes the re-entry that arrives in a
*later transaction* — which a `nonReentrant` modifier does nothing about.

### The privacy floors are checked at settlement, not at display time

PRD invariant 21.6.5 forbids presenting a failed privacy floor as multi-party clearing. shrud goes
further and refuses to **settle** one. An epoch with two effective treasuries, or a residual route
with a single contributor, does not reach a public venue at all — because a residual with one
contributor is that contributor's order, in plaintext, with a privacy story attached.

Refusing is the honest failure. The epoch becomes recoverable and every participant gets their
escrow back. Worse for throughput; the only acceptable outcome for the claim on the tin.

A zero residual is different and is a complete, correct result: both sides crossed fully, no venue is
needed, and the residual floor is irrelevant because nothing is exposed. That path sets
`NoPublicResidual` and consumes the epoch without a venue call.

### The position ledger stores shares because aTokens rebase

If it stored each Safe's confidential *balance*, every interest accrual would need one encrypted
update per Safe — and Nox charges per primitive with no batch entry point, so cost would grow with
participants times blocks.

Shares make accrual free. The count does not change when interest accrues; the public position does,
and every share is worth proportionally more.

**The inflation attack does not apply here, for a reason worth naming rather than assuming:** there
is no public deposit function. Shares are minted only by the settlement engine, only against an
aggregate a sealed epoch produced. A donation to the ledger inflates the position for existing
holders and mints nothing to the donor. `INITIAL_SHARES_PER_ASSET` fixes the opening ratio at
deployment, so even the first epoch has no special case.

### One `select` branch that had to be `a`, not `zero`

`_subOrKeep(a, b)` returns `a - b` when the subtraction succeeds and **`a` unchanged** when it does
not. The obvious shape is to return zero on failure, and it is catastrophically wrong here: a single
underflowing burn would silently wipe the position's entire encrypted total-share count. Because the
value is a ciphertext, nothing would observe it until a reconciliation check failed several epochs
later with no way to say when it broke.

`select` on a failed subtraction means "no-op", which is what a failed subtraction is.

### `withdraw` is a separate function from `settle`

Folding both into one entry point behind a direction flag makes the flag the only thing standing
between "add to the position" and "take from it". Two functions, two caller checks, no flag. Aave's
`withdraw` also returns the amount *actually* withdrawn, which is less than requested when the
reserve is short of liquidity — everything downstream allocates against that, never against what was
asked for.

## A deployment cycle the next phase must resolve

`ShrudClearingEngine`'s constructor takes the settlement engine's address and
`ShrudSettlementEngine`'s takes the clearing engine's. The deploy script breaks it by predicting one
address from the deployer's nonce and asserting the prediction after deployment — the same pattern
`ShrudModuleFactory.predictAddresses` uses, and for the same reason: an assertion that fails loudly
beats a wiring step that silently points at the wrong contract.

## What the next phase inherits

`ShrudCapsuleFactory` (Phase 5) reads live handles and copies them. It needs the module to have
already checked the Safe's threshold, and it needs the recipient mixed into its isolation domain —
without that, two capsules over the same balance issued to two auditors are one handle with one ACL
entry.
