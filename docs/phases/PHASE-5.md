# Phase 5 — Disclosure and recovery

**Status:** complete
**Evidence:** `npx hardhat compile` clean. `ShrudCapsuleFactory` 5,697 bytes, `ShrudEmergencyExit`
2,701 bytes.

---

## What this phase was for

Two surfaces that exist because the confidential ones do. A treasury that can prove nothing to its
board has traded one problem for another, and a treasury that cannot get its assets back when the
protocol stops has traded a smaller problem for a much larger one.

## What was built

| Contract | Role |
|---|---|
| `disclosure/ShrudCapsuleFactory.sol` | frozen selective disclosure — a dated snapshot, not a key |
| `recovery/ShrudEmergencyExit.sol` | two doors out, both needing the owning Safe's own threshold |
| `accounts/ShrudSafeModule.createCapsule` | the threshold-authorised entry point |

## The decisions worth reading

### The whole capsule design follows from one fact: Nox has no `removeViewer`

Verified against `sdk/Nox.sol` 0.2.4 — no `removeViewer`, no `removeAdmin`, no way to un-set
`allowPublicDecryption`. `disallowTransient` is the only revocation, and it only undoes a grant that
would have expired at the end of the transaction anyway.

So the obvious design — grant the auditor viewer rights on the Safe's live balance handle, revoke
when the engagement ends — is not merely bad practice. **It is impossible to undo.** The auditor
holds that grant for as long as the handle exists, and for a historical handle that is forever.

A capsule instead **copies** each value into a fresh handle and grants the viewer the copy. Same
plaintext, different lineage. The viewer decrypts the snapshot forever — that is the point of a
signed report — and learns nothing afterwards, because every subsequent value lives in handles they
hold no grant on.

### The recipient is mixed into the isolation domain, and without it the whole thing fails

Two capsules over the same balance, issued to two different auditors, would otherwise be
byte-identical handles. Handles are deterministic in their operands (delta D-5), so this is the
**default outcome**, not an edge case: one handle, one ACL entry, two auditors, each able to decrypt
anything the other was ever shown.

`keccak256(isolationDomain(capsuleId, ROLE_CAPSULE_FIELD, i), viewer)` makes the domain unique per
(capsule, viewer, field). The cost is one extra hash. The alternative is a disclosure system that
silently cross-links its own recipients.

### The interface is not allowed to say "revoked"

`archiveCapsule` hides a capsule from default navigation. It revokes nothing and cannot. PRD §20.9
is explicit, and a product that says "revoked" about a permanent grant has told its user something
false about their own confidentiality.

The permitted wording: **"live access ended"**, **"future snapshots disabled"**, **"this historical
snapshot remains available"**. This is carried into the web app's copy in Phase 9 and asserted by a
string check there, because the constraint lives in the words rather than in the bytecode.

### `_buildEpochCondition` refuses a public anchor, which catches a whole class of empty report

A capsule over a value that was never confidential would produce a snapshot that discloses nothing
and claims to. `_buildEpochCondition` requires a confidential anchor and reverts on a public handle,
so that report fails to issue rather than being issued and believed.

### Disclosure needs the Safe's threshold, at the same bar as moving assets

A single owner must not be able to hand a counterparty a solvency report. That is the same bar as a
transfer, deliberately: a report naming a treasury's positions is, to a counterparty, worth roughly
what the positions are.

The permanence warning belongs at the point of signing, not in a tooltip. Nox has no `removeViewer`,
so the viewer keeps this snapshot forever; the capsule builder says so before the first signature is
collected.

### The emergency exit is the most attractive contract here to compromise, so it holds nothing

Every function needs the **owning Safe's own** threshold signature. Not a guardian's, not a
governor's, not this contract's. Assets return to the Safe that locked them — there is no destination
parameter anywhere in the file. A fully compromised shrud deployment cannot exit a treasury that did
not sign.

`executor = address(0)` on the `checkSignatures` call, same as everywhere else in shrud (delta D-2).
An emergency path is the last place to relax it.

### Two doors, opening under different conditions

**Halted-network exit.** The guardian has halted shrud — terminal and one-way. Any confirmed,
unreleased escrow can be reclaimed. This is the path for "shrud itself has gone wrong".

**Timed-out-epoch exit.** An epoch was verified for settlement and no venue call succeeded within
600 blocks. Anyone may declare it recoverable, and each participating Safe reclaims its escrow. This
deliberately does **not** require the network to be halted: a treasury waiting on a stalled epoch
should not also have to wait for a guardian to decide the whole network is broken.

The ordering matters. `declareTimedOut` marks the epoch consumed *before* any exit, so a keeper that
comes back cannot settle an epoch whose participants have already left. Without that, the protocol
would pay the same escrow out twice.

### What the emergency exit deliberately cannot do

It cannot disable the module or remove the guard. Those are `execTransaction` on the Safe with the
Safe's own threshold — `disableModule` and `setModuleGuard(address(0))` — and routing them through
shrud would mean **the way to remove shrud goes through shrud**. A treasury's escape hatch must not
depend on the thing it is escaping from.

The runbook documents the two Safe transactions and the app builds them, but no shrud contract is on
that path. `pnpm verify:live` checks that a demo Safe can execute both.

### The pause controller has no way back, and that is finished here

`Halted` is terminal, with no governance path out. If a guardian key could both stop and restart the
network, a compromised guardian could stop it, restart it, and leave no evidence anything happened. A
one-way halt turns a compromised guardian into a denial of service — bad, visible, survivable —
instead of a silent controller of the protocol.

Recovery after `Halted` is per-Safe and runs through this contract. There is no global restart, and
adding one would undo the property.

## The complete contract set

Seventeen deployable contracts, all within EIP-170:

```
accounts/     ShrudModuleFactory 20,912 · ShrudSafeModule 13,774 · ShrudModuleGuard 2,331
clearing/     ShrudClearingEngine 13,100 · ShrudReferencePriceRegistry 8,998 · ShrudClearingVault 5,650
settlement/   ShrudSettlementEngine 10,368 · ShrudPositionLedger 4,636
assets/       ShrudWrappedAsset 8,383 · ShrudAssetRegistry 3,380
intents/      ShrudIntentBook 6,665
disclosure/   ShrudCapsuleFactory 5,697
adapters/     ShrudAdapterRegistry 4,636 · AaveSupplyAdapter 2,574 · UniswapResidualAdapter 2,186
recovery/     ShrudEmergencyExit 2,701 · ShrudPauseController 1,176
```

## What the next phase inherits

Phase 6 is where every claim above stops being an argument and becomes a passing or failing test.
The three that matter most, and that are asserted rather than reviewed:

1. An underfunded lock and a fully funded one produce **byte-identical public traces** — same status,
   same events, same ordering.
2. A capsule viewer holds **no** grant on any live handle, checked by attempting the decryption and
   asserting the refusal.
3. Two capsules over one balance, issued to two viewers, are **two** handles — verified by removing
   the recipient from the isolation domain and confirming the handles come back identical.
