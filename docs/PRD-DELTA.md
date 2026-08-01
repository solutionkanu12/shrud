# PRD delta

`shrud-production-prd-v1.1.md` is an **immutable source document**. It is never
edited. Where the PRD and verified reality disagree, reality wins and the disagreement is recorded
here — with the evidence that settled it and the decision taken.

Every entry has an id. Code and documentation cite the id rather than restating the argument.

---

## D-1 · Safe 1.4.1 has no module guard. shrud requires Safe 1.5.0.

**PRD**: §9.3 `ShrudModuleGuard.sol`, §11.1 step 4 ("attach the module guard"), §20.2 ("separate
module guard"), and the reference link to `setModuleGuard`.

**Reality**: `setModuleGuard`, `IModuleGuard.checkModuleTransaction` and
`checkAfterModuleExecution` exist **only from Safe 1.5.0**. Verified by reading
`@safe-global/safe-smart-account@1.5.0/contracts/base/ModuleManager.sol` (`setModuleGuard` at line
258, `MODULE_GUARD_STORAGE_SLOT` at line 65) and confirming `grep -rn setModuleGuard` finds nothing
anywhere in `@safe-global/safe-contracts@1.4.1-2`. Safe 1.4.1's `GuardManager` covers
`execTransaction` only, never `execTransactionFromModule` — so on 1.4.1 a shrud module would run
completely unguarded, which is the precise risk PRD §20.2 exists to control.

**What the fork test then found, and it is worse than "missing".** `test/fork/LiveProtocols.t.sol`
originally asserted that calling `setModuleGuard` on the 1.4.1 singleton would fail. **It does not.**
Safe's `FallbackManager` catches every unknown selector, and with no fallback handler configured it
returns empty data and reports **success**:

```
1.4.1:  safe.setModuleGuard(guard)  ->  succeeds, returns nothing, no guard exists
1.5.0:  safe.setModuleGuard(guard)  ->  reverts GS031 for a non-self caller (the real function)
```

So an installer that checked only "did the transaction revert" would report a successful guard
installation on 1.4.1 and leave the module running with unlimited authority over the Safe and no
boundary at all. This is a sharper argument for D-1 than the missing function was, and it is why the
refusal is on the `VERSION()` string in `ShrudModuleFactory` rather than on a probe of behaviour.

**Decision**: shrud installs on Safe **1.5.0** only. `ShrudModuleFactory` refuses any Safe whose
`VERSION()` is not `1.5.0`, and the onboarding compatibility scan says so before a user signs
anything. Safe 1.5.0 is deployed on Sepolia — singleton `0xFf51A5898e281Db6DfC7855790607438dF2ca44b`,
proxy factory `0x14F2982D601c9458F93bd70B218933A6f8165e7b`, both code-verified — so this costs the
launch nothing except honesty about the constraint.

---

## D-2 · `checkSignatures` changed shape in 1.5.0, and the `executor` argument is a security choice.

**PRD**: §9.2 "The module calls the Safe's current `checkSignatures`".

**Reality**: Safe 1.5.0's primary form is
`checkSignatures(address executor, bytes32 dataHash, bytes signatures)`. The legacy
`checkSignatures(bytes32, bytes, bytes)` still exists, ignores its `data` argument entirely, and
forwards `msg.sender` as the executor.

The `executor` argument is not cosmetic. Inside `checkNSignatures`, a `v == 1` "approved hash"
signature is accepted when `executor == currentOwner` **even with no on-chain approval**:

```solidity
if (executor != currentOwner && approvedHashes[currentOwner][dataHash] == 0) revertWithError("GS025");
```

Using the legacy form from a module would make the executor `msg.sender` — the relayer. A relayer
who happens to be a Safe owner could then satisfy one signature of the threshold for free.

**Decision**: `ShrudSafeModule` calls the three-argument form with `executor = address(0)`. Only
genuinely pre-approved hashes count, and activation cannot be cheapened by who happens to submit it.

---

## D-3 · Nox has no boolean algebra, so every `AND` in PRD §10 is arithmetised.

**PRD**: §10.2 writes `eligibleBuy_i = v_i AND isBuy_i AND buyLimitPass_i`.

**Reality**: verified against `@iexec-nox/nox-protocol-contracts@0.2.4/contracts/sdk/Nox.sol`, the
complete surface is `add sub mul div safeAdd safeSub safeMul safeDiv eq ne lt le gt ge select
transfer mint burn toEbool toEuint16 toEuint256 toEint16 toEint256 fromExternal publicDecrypt` plus
ACL. There is **no** `and`, `or`, `not` or `xor`, and `select` has **no `ebool` overload** — its
four overloads return `euint16`, `euint256`, `eint16`, `eint256`. Booleans cannot be combined
directly.

**Decision**: shrud never composes `ebool`s. It gates the *amount* instead, chaining `select` with
an encrypted zero:

```
amount = select(isBuy,     amount, ZERO)
amount = select(limitPass, amount, ZERO)
amount = select(valid,     amount, ZERO)
```

Three `select` calls, no boolean algebra, and the same result. Where a real boolean is needed — the
privacy floors, which must be published — the predicate is mapped to a `euint256` 0/1 indicator via
`select`, combined with `mul`, and compared with `eq`. `ShrudClearingMath` documents the cost of
each form. This is arithmetically identical to the PRD and cheaper than the obvious translation.

---

## D-4 · `safeSub` returning encrypted false also returns encrypted zero. The success flag must be threaded.

**PRD**: §10.5 `residualBaseDemand = safeSub(B, crossedBase)`.

**Reality**: Nox safe operations return `(ebool success, T result)`. On failure `success` is
encrypted `false` **and `result` is encrypted zero**, while the transaction succeeds normally. The
flag is a ciphertext, so Solidity cannot branch on it. Unsafe `div` by zero does not revert either
— it saturates to the type maximum.

**Decision**: every safe-op success flag is threaded through a `select` before its result can become
an allocation. A silent encrypted zero is never allowed to reach a balance. `ShrudClearingEngine`
carries one `_gate` helper and uses nothing else.

---

## D-5 · Nox handles are deterministic in their operands, so anything granted must be isolated first.

**PRD**: §6.4 and §9.14 assume a handle identifies a value belonging to one Safe.

**Reality**: from `modules/Compute.sol::_generateHandle`,

```
handle     = keccak256(abi.encode(operator, operands, noxCompute, uniqueSeed, outputIndex))
uniqueSeed = 0                  if ANY operand is confidential  -> DETERMINISTIC
           = ++storageCounter   if EVERY operand is public      -> unpredictable
```

Two logically distinct encrypted quantities computed identically from identical operands are **one
handle sharing one permanent ACL entry** — and Nox has no `removeViewer` and no `removeAdmin`. In a
16-candidate epoch this is the common case, not a corner case: two Safes submitting the same amount
on the same side at the same limit produce identical intermediates all the way down.

**The other half, found by the integration test rather than by reading.** The first version of
`NoxPrimitiveProbe.computeTwiceIdentically` computed `add(add(toEuint256(a), toEuint256(b)),
toEuint256(a))` twice and expected identical handles. They came back **different**, because
`toEuint256` produces a *public* handle and the seed is `++storageCounter` when every operand is
public. Both halves matter and they point opposite ways:

| Operands | Seed | Consequence |
|---|---|---|
| any confidential | `0` | deterministic — **handles collide**, so anything granted must be isolated |
| all public | `++storageCounter` | unpredictable — **handles cannot be reproduced off chain** |

The first half is why `ShrudHandleIsolation` exists. The second is why `_requireConfidential`
rejects a public handle before isolating it: an all-public operand set produces a handle no
off-chain verifier can predict, so the graph binding would be decorative rather than checkable.
Both are asserted in `test/integration/10-nox-primitives.ts` against the real stack.

**Decision**: `ShrudHandleIsolation` implements the rule — *never grant a user or the public a handle
that something else could equal*. Intermediates collide freely and harmlessly because nobody is
granted one. Every handle that crosses a boundary — a Safe's lock result, internal-cross allocation,
residual contribution, final allocation, position share, capsule field, and each published residual
value — passes through `_isolate` first, under a domain carrying chain id, contract, epoch, role and
subject.

---

## D-6 · Nox input proofs are replayable by their own owner. shrud supplies the missing half.

**PRD**: §20.7 requires replay protection but assumes the proof carries it.

**Reality**: `Compute.sol::validateInputProof` checks the handle's embedded chain id, the TEE type,
the 137-byte proof length, `createdAt + proofExpirationDuration`, `app == msg.sender`, `owner`, and
the gateway signature — **and nothing else**. There is no nonce and no consumption marker, so a
proof stays replayable by its own owner against its own app until it expires.

**Decision**: `ShrudConfidentialBase` consumes every input handle exactly once per contract and
enforces a strictly increasing per-owner nonce on every entry point. Replay is a public fault and
reverts publicly.

---

## D-7 · A valid decryption proof says nothing about which epoch a value belongs to.

**PRD**: §9.9 "public decryption proofs match stored handles".

**Reality**: `validateDecryptionProof` is a pure EIP-712 signature check — no ACL, no nonce, no
expiry, no caller binding. Once issued, a proof is replayable by anyone, in any contract, forever.
It attests that the gateway decrypted *some* handle to *some* value, and nothing more.

**Decision**: `ShrudSettlementEngine` verifies the proof **and** that the handle is the exact one the
sealed epoch committed to for that role, read from `ShrudIntentBook`'s epoch record. The PRD's
wording is right; this delta records that "matches stored handles" is doing all of the work and
cannot be relaxed to "a valid proof exists".

---

## D-8 · The launch pair is forced by what actually exists on Sepolia.

**PRD**: §9.7 names the order family `USDC_WETH_ALLOCATION_V1` with a Uniswap crossing pair and an
Aave supply leg sharing the same confidential USDC.

**Reality**, measured on Sepolia at block 11,389,757:

| Pair | Fee | Pool | Liquidity | Observation cardinality | Aave reserve? |
|---|---|---|---|---|---|
| WETH9 / USDC `0x94a9…` | 500 | `0xba57efa1…` | 179,828,542,016,647 | **100** | **yes**, aToken `0x16dA4541…` |
| WETH9 / USDC `0x94a9…` | 3000 | `0x9799b5ed…` | 688,603,749,971,085 | 0 | yes |
| WETH9 / USDC `0x1c7D…` | 3000 | `0x6ce0896e…` | 7,373,446,282,167,956 | 119 | **no** |
| AaveWETH / USDC `0x94a9…` | 3000 | `0x949c25ab…` | 656,778,577,162,370 | 0 | yes |

A zero observation cardinality means `observe()` reverts and there is no TWAP, so no reference price
can be fixed. A token Aave does not list cannot carry the Aave leg.

**Decision**: the launch family is base **WETH9 `0xfff99767…6b14`** / quote **USDC `0x94a9D9AC…`**,
crossing at Uniswap V3 pool `0xba57efa1…` fee 500 over a 1800-second TWAP window, with the Aave leg
supplying the same USDC to `Pool 0x6Ae43d32…`. It is the only combination on Sepolia that satisfies
both legs. `observe()` was executed at 1800 s, 600 s, 300 s and 60 s and all four returned; the
oldest observation is dated 2026-06-23, so the 1800-second window has ample history.

**Honest note carried into the UI**: the observed tick is 120,482, which is a testnet price with no
relationship to the real WETH/USDC market. shrud's reference-price registry proves the price was
fixed, sourced and sealed — it does not claim the level is economically meaningful on a testnet.

---

## D-9 · One transaction may not exceed 2^24 gas, and every Nox primitive is a separate call.

**PRD**: §9.7 sets the launch bound at 16 candidate orders per epoch "for a predictable Nox
operation graph", without sizing it.

**Reality**: EIP-7825 (Osaka, live on Sepolia) caps a single transaction at 2^24 = 16,777,216 gas.
Nox has no batch entry point, so cost scales linearly in the number of primitives. The local Nox
node has no such cap and will happily mine a transaction Sepolia refuses.

**Decision**: the clearing operation graph is split into explicitly staged transactions —
classification, accumulation, crossing, allocation, residual — each sized against the cap and each
resumable. `ShrudClearingEngine` exposes the stage boundary rather than hiding it, and
`packages/clearing-math` carries the measured per-stage budget so a candidate bound can be checked
before an epoch is sealed rather than discovered when it reverts.

---

## D-10 · Safe owners that are EIP-1271 contracts can authorise, but cannot submit.

**PRD**: §4.2 lists "an EOA or EIP-1271 contract owner", and §9.2 requires the encrypting owner to
call the module directly.

**Reality**: `Nox.fromExternal` binds the proof to `owner == the address that called the contract
calling fromExternal`. A contract owner cannot produce an encrypted input for itself without a
transaction from some EOA, and that EOA is what Nox would bind.

**Decision**: shrud states the split rather than papering over it. **Submission** of encrypted order
fields requires an EOA owner calling `submitIntent` directly. **Authorisation** is unchanged and
fully supports EIP-1271 contract owners, because it goes through the Safe's own `checkSignatures`.
A Safe whose owners are all contracts can authorise every shrud order but cannot originate one. The
onboarding scan reports this, and it is listed under known limitations on `/app/[safe]/security`.

---

## D-11 · The local Nox node is more permissive than any real chain, in two ways.

1. **Unlimited contract size**, and it cannot be made otherwise: NoxCompute itself exceeds EIP-170,
   so setting `allowUnlimitedContractSize: false` breaks the stack under test. The check therefore
   cannot live inside the node. `pnpm verify:contract-size` measures every compiled artifact, and
   `pnpm verify:bytecode` measures what the chain actually returned.
2. **Its clock outruns wall clock.** A Hardhat node advances `block.timestamp` by at least a second
   per mined block, and a full epoch mines hundreds. `validateInputProof` compares a `createdAt`
   stamped from the gateway's real clock against `block.timestamp`, so once the chain runs more than
   `proofExpirationDuration` ahead, every proof looks expired. `allowBlocksWithSameTimestamp: true`
   prevents it. The symptom appears only late in a long run and looks like a protocol failure.

---

## D-12 · The gateway returns plaintext at its natural width.

A published `euint16` comes back as **two bytes**, not an ABI-padded 32. `abi.decode` on it reverts
with no reason string. `ShrudDecodedValue` normalises width before any decoded value is used, and
`Nox.publicDecrypt`'s own overloads (which check `result.length` per type) are preferred wherever
the type is known at the call site.
