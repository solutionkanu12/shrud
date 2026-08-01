# Phase 1 — The confidential substrate

**Status:** complete
**Evidence:** `npx hardhat compile` — 9 sources, solc 0.8.36, evm target osaka, no errors.

---

## What this phase was for

Everything above this layer — the Safe adapter, the clearing engine, the settlement engine, the
capsules — assumes four properties hold. Phase 1 is where each becomes a single implementation that
cannot be forgotten:

1. A private failure never produces a public reason.
2. A Nox input proof cannot be replayed.
3. A handle granted to somebody is a handle nothing else could equal.
4. There is exactly one emergency switch, and it cannot walk backwards.

## What was built

| Contract | Discharges |
|---|---|
| `base/ShrudConfidentialBase.sol` | one-shot input handles, per-owner nonces, the exact ACL grant, the transient-recipient gate |
| `base/ShrudHandleIsolation.sol` | handle isolation — delta D-5 |
| `recovery/ShrudPauseController.sol` | the one-way pause/halt state machine |
| `assets/ShrudAssetRegistry.sol` | the finite asset set, delayed registration, per-call code-hash re-check |
| `assets/wrappers/ShrudWrappedAsset.sol` | the ERC-7984 wrapper, with a supply ceiling and a bounded operator lifetime |
| `intents/ShrudIntentBook.sol` | the uniform public lifecycle and the handle graph |
| `libraries/ShrudOrderFamily.sol` | the reviewed order families, action ids, outcome codes, price scale |
| `libraries/ShrudDecodedValue.sol` | natural-width plaintext decoding — delta D-12 |
| `interfaces/ISafe.sol` | the exact Safe 1.5.0 surface, plus `IModuleGuard` |

## The decisions worth reading

### There is no `msg.sender == tx.origin` check, and that is deliberate

The obvious way to enforce "the owner calls the module directly" is to refuse contract callers. It
would be redundant. `Nox.fromExternal` binds the proof to the address that called the contract, and
encryption is an EIP-712 signature by a key — a contract cannot mint a proof for itself. If an EOA
signs and a contract relays, `validateInputProof` sees `owner == the EOA`, `msg.sender == the
contract`, and refuses. The binding already forbids the pattern.

The honest consequence is recorded rather than hidden: an EIP-1271 contract owner can **authorise**
every shrud order, because that path is the Safe's own `checkSignatures` and is untouched — but it
cannot **originate** one. Delta D-10, surfaced in the onboarding scan and on the security page.

### `_isolateBool` costs seven NoxCompute calls, and is paid exactly twice per epoch

The cheap isolation `select(eq(v,v), v, tag)` works for `euint256`, where the tag carries a full
256-bit domain hash. It does **not** work for `euint16`: a 16-bit tag has 65,536 values, so two
epochs' floor handles could coincide and a decryption proof issued for one would bind to the other.
Both values are public either way, so nothing leaks — but the binding would be weaker than it
claims, which is the class of defect this project treats as a defect.

`ebool` has no `select` overload at all, so a boolean is isolated by carrying it through `euint256`
against three tags that are pairwise distinct by construction, then comparing back. Seven calls. It
is paid for `meetsEpochFloor` and `meetsResidualFloor` and nothing else — the only two `ebool`s
shrud ever publishes — so the price buys exactly the property that matters: a proof for one epoch's
floor cannot bind to another's.

### The pause controller has no way back, on purpose

`Halted` is terminal and no governance path exists to leave it. If a guardian key could both stop
and restart the network, a compromised guardian could stop it, restart it, and leave no evidence
that anything happened. A one-way halt turns a compromised guardian into a denial of service — bad,
visible, survivable — instead of a silent controller of the protocol.

The second half of that design is that `Paused` deliberately does **not** stop settlement of an
already-sealed epoch. An epoch frozen between "assets locked" and "assets allocated" strands every
participant's capital in escrow. Stranding capital is worse than letting a sealed, price-fixed epoch
finish, so `requireLive` gates new value entering and `requireNotHalted` gates finishing work
already begun. Two gates, and every call site picks the one that matches what it is doing.

### The operator lifetime bound is the sharpest edge in ERC-7984

An ERC-7984 operator has **no per-amount allowance**. `isOperator(holder, spender)` is a boolean
with an expiry, and the wrapper's `_unwrap` accepts `from == msg.sender || isOperator(from,
msg.sender)`. So an operator on a wrapper can unwrap a holder's entire confidential balance to any
address, in one call, with no further authorisation. The maintained base accepts any `until`,
including `type(uint48).max`.

`ShrudWrappedAsset.setOperator` refuses anything beyond 30 days, and refuses an operator that is not
a contract — shrud's operator is always the immutable Safe-bound module, never an EOA. Revocation
(`until = 0`) bypasses both checks, because a revocation must never be blocked by a rule meant to
constrain grants.

### The intent book has five public states and must never gain a sixth

`Processed` is where every order that entered a sealed epoch ends up: the one that crossed fully,
the one that crossed partially, the one whose limit failed, the underfunded one, the deferred one,
the one that held. Indistinguishable from outside.

PRD §9.5 names the states that must never exist, and each is a free oracle:
`InsufficientBalance` turns repeated oversized orders into a binary search over a treasury's
confidential balance. `Buy`/`Sell` publishes exactly what the product hides. `Excluded` identifies
who did not make the cut, which with a 16-candidate set identifies who did.

`recordLock` fires the same event whether the transfer moved the full amount or encrypted zero, and
that uniformity is asserted in `test/privacy/` rather than left to review.

### The candidate set is sorted for a privacy reason, not a tidiness one

PRD §11.6 asks for a deterministic set sorted by intent id. If a coordinator could choose the
*order*, the ordering would carry information — place the orders you expect to cross adjacently, or
the residual contributors last, and the public candidate list starts leaking the private
classification. Sorting by intent id, a hash binding Safe, module, nonce and commitment, makes the
ordering carry nothing. Duplicate rejection falls out of the strict `<=` check for free.

### Expiry is permissionless for the same reason

If only the owning Safe could expire its own orders, whether an order was cleaned up promptly would
itself be a signal: an owner who tidies immediately behaves differently from one who does not, and
the difference is observable. Permissionless expiry means expiry says nothing about the owner.

## Compilation notes worth keeping

Two build failures cost time and are recorded so they do not recur:

- **solc parses `@word` in a doc comment as a natspec tag.** A perfectly ordinary reference to a
  package like `` `@iexec-nox/nox-protocol-contracts@0.2.4` `` inside a `/** */` block fails the
  build with `DocstringParsingError: Documentation tag @0.2.4` not valid for contracts`. Comments
  now name packages without the leading `@`.
- **`at` is a future reserved keyword** in solc 0.8.36 and warns as an event parameter name.

## What the next phase inherits

`ShrudSafeModule` (Phase 2) extends `ShrudHandleIsolation`, calls `ISafe.checkSignatures` with
`executor = address(0)`, writes through `ShrudIntentBook`'s registrar, gates on
`ShrudPauseController`, and reads its wrapper through `ShrudAssetRegistry.requireEnabledWrapper` —
which re-checks the wrapper's runtime code hash on every call, not only at registration.
