# Phase 2 — The Safe account adapter

**Status:** complete
**Evidence:** `npx hardhat compile` clean. Behavioural evidence is Phase 6, against a real Safe
1.5.0 on a Sepolia fork and against the real Nox stack.

---

## What this phase was for

PRD §5.5 is emphatic: *Safe is an account adapter, not the product category.* This phase builds that
adapter and nothing else. It knows how to prove a Safe authorised something, how to move that Safe's
confidential assets into escrow without leaking whether the balance covered it, and how to stop
itself doing anything else. It knows nothing about crossing, prices, residuals or venues.

## What was built

| Contract | Role |
|---|---|
| `accounts/ShrudSafeModule.sol` | submit, activate, lock, cancel, shield, rotate |
| `accounts/ShrudModuleGuard.sol` | the fixed execution boundary |
| `accounts/ShrudModuleFactory.sol` | one immutable module per Safe, at a predictable address |
| `accounts/ShrudSafeIntrospection.sol` | the two facts Safe does not expose |
| `interfaces/IShrudClearingVault.sol` | the vault surface the module needs, declared not imported |

## The decisions worth reading

### The guard is deployed by the module's constructor, and that resolves a real circularity

The guard must know its module immutably, or it is repointable — and a repointable guard is not a
boundary. The module must know its guard immutably, or `_assertInstalled` cannot check the boundary
is still there. Each needs the other's address at construction time, and CREATE2 prediction does not
help: each address depends on the other's constructor arguments.

Constructing the guard inside the module's constructor settles it in one direction. `address(this)`
is already known there. Both bindings are genuinely immutable, and the guard's address stays
deterministic — CREATE from the module at nonce 1 — so `predictAddresses` still answers "what am I
about to enable?" before anything exists.

The rejected alternative was a one-shot `bindModule` setter. It works, and it leaves a window in
which the guard answers for a zero module. A window that exists only because of how the contracts
were wired is the worst kind of window.

### `_assertInstalled` re-reads the guard slot on every privileged call

`setModuleGuard` is an ordinary Safe transaction, so a Safe can remove the guard at any time with its
own threshold. That is correct and must stay possible — it is part of the recovery story. What must
not happen is shrud continuing to operate as though a boundary existed after it was removed.

Reading `MODULE_GUARD_STORAGE_SLOT` on every entry point turns "the guard is installed" from an
installation-time claim into a live fact. It costs one `getStorageAt` call. `getModuleGuard()` is
`internal` in `ModuleManager`, so the raw slot read is the only way to ask.

### The guard's allowlist is (target, selector, **argument shape**)

A target allowlist alone is not enough. `wrap(to, amount)` on a properly registered wrapper is a
completely legitimate call that mints a confidential balance **to an arbitrary address**. A selector
allowlist alone fails for the mirror reason.

So each of the four permitted calls has its arguments decoded and checked:

| Call | Constraint |
|---|---|
| `approve(spender, amount)` | `spender` must be the wrapper registered for **this exact** underlying |
| `wrap(to, amount)` | `to` must be the bound Safe |
| `setOperator(operator, until)` | `operator` must be the bound module |
| `unwrap(from, to, amount)` | both must be the bound Safe |

The `approve` check is stricter than it first looks: accepting "spender is *some* registered wrapper"
would let a Safe approve the USDC wrapper to spend its WETH. No shrud flow needs that, and a mistake
could produce it.

### `checkAfterModuleExecution` reverting is the whole reason it is not a no-op

`execTransactionFromModule` does **not** revert when the inner call fails. It returns `false` and
emits `ExecutionFromModuleFailure`. A module that ignored the return value would proceed as though a
wrap had happened when it had not, and the mismatch would surface much later as a reserve
discrepancy nobody could trace back. Reverting in the post-hook makes the failure loud and local.

### The pending hash lives in transient storage

`checkModuleTransaction` and `checkAfterModuleExecution` are two calls inside one transaction and the
value must not outlive it. Persistent storage would leave a dangling pending hash if a later step
reverted in a way that skipped the post-hook, and the next transaction would inherit it. EIP-1153
transient storage is cleared by the EVM at end of transaction — exactly the lifetime needed. The
sequence counter that makes each hash unique **is** persistent, because an indexer has to reproduce
the hash from chain state afterwards.

### Locking cannot fail publicly, and the code has no branch that could

The module is the Safe's ERC-7984 operator, so it calls the wrapper directly rather than through the
Safe. `confidentialTransferFromAndCall` returns the amount **actually moved** — inside the token
that is `select(success, amount, 0)` — so an underfunded Safe produces encrypted zero and a
successful transaction, indistinguishable from a funded one.

There is no `if` in `_lock` that depends on the outcome, no event that fires on one path only, and no
revert reason that names a balance. That is PRD invariant 21.6.1, and Phase 6 asserts it by
comparing full public traces rather than by reading the code.

`lockSuccess` is `gt(lockedAmount, 0)`. A genuine zero-amount order and an underfunded one are
indistinguishable **even to the owner's own handle** — which matters, because an owner's handle can
later be copied into a capsule and shown to a third party.

### Owner grants are per-EOA, and rotation is not revocation

A Nox grant is to an address, and decryption needs a key. A Safe is a contract and holds no key, so
`allow(handle, safe)` would grant access to nobody. Every private value is granted to each **current
owner EOA** individually.

Those grants are permanent — Nox has no `removeViewer`. When an owner is removed they keep the
handles they already held, and no cryptography changes that. `rotateLiveStateViewers` is the honest
answer: live values move into fresh handles granted to the new owner set, so the removed owner's
access becomes access to a dated snapshot rather than to the treasury.

The interface must say "live access ended" / "future values are not shared" / "this historical
snapshot remains readable". It must never say "revoked".

Rotation is permissionless and gated only on the owner set having actually changed. Requiring a
threshold would mean a Safe that just removed a compromised owner needs a second signing round before
its future values stop being shared with that owner.

### `revokeOperator` is deliberately not gated on `requireLive`

Withdrawing authority from shrud has to work when shrud is paused. That is precisely the moment a
treasury is most likely to want it. Every other privileged path gates on the pause controller; this
one gates on nothing but the Safe's own threshold.

### `executor = address(0)` on every `checkSignatures` call

Delta D-2. Inside `checkNSignatures`, a `v == 1` approved-hash signature is accepted when
`executor == currentOwner` with **no on-chain approval**. The legacy `checkSignatures(bytes32,bytes,
bytes)` form forwards `msg.sender`, so a module using it would let a relayer who is also an owner
satisfy one signature of the threshold for free. Passing `address(0)` means only genuinely
pre-approved hashes count, and activation cannot be cheapened by who submits it.

### The intent id binds the commitment, which makes the sorted candidate set carry no information

`ShrudIntentBook.sealEpoch` requires candidates sorted by intent id, so a coordinator cannot use
ordering as a channel. That only holds if the id cannot be ground cheaply. Binding the commitment
means a submitter cannot choose where their order lands without also changing the plaintext order
their own owners are about to verify in Shrud Lens.

## What the next phase inherits

`ShrudClearingEngine` (Phase 3) receives permanent grants on each candidate's `lockedAmount`,
`lockSuccess`, `actionId` and `limit` at activation time — permanent by necessity, because the
clearing graph spans several transactions and Nox has no callback. Those grants are made only after
the Safe's threshold has actually authorised, never at submission.

`IShrudClearingVault.confirmLock` is the handoff. The vault's `onConfidentialTransferReceived`
callback must validate that `msg.sender` is a registered wrapper and that the callback data binds
this intent and epoch.

**One finding for `feedback.md`:** `IERC7984Receiver`'s documentation states *"The `amount` handle is
accessible to this contract via the ACL"*, but `ERC7984Base._transferAndCall` grants transient access
only to `msg.sender` (the operator), never to the receiver. A receiver therefore cannot compute on
the amount it was just handed. shrud works within this — the vault's callback records the pending
credit and the module grants the vault access to the isolated handle after the call returns — but the
interface documentation and the implementation disagree, and an integrator following the docs would
write code that reverts inside NoxCompute.
