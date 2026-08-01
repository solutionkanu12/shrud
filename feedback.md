# Feedback on the iExec Nox tooling

Required by the WTF Hackathon brief. Written after building a confidential treasury clearing
protocol on Nox, so every point below comes from something that actually happened during the build
rather than from reading the documentation.

Versions used:

| Package | Version |
|---|---|
| `@iexec-nox/nox-protocol-contracts` | 0.2.4 |
| `@iexec-nox/nox-confidential-contracts` | 0.2.2 |
| `@iexec-nox/nox-hardhat-plugin` | 0.1.0 |
| `@iexec-nox/handle` | 0.1.0-beta.13 |

---

## What worked well

**The local Docker stack is the strongest part of the toolkit.** `npx hardhat test` brings up a
Hardhat node, deploys `NoxCompute`, and starts the off-chain services with no configuration at all.
Being able to run confidential contracts against a real gateway on a laptop, offline, is the single
thing that made this project possible in a hackathon timeframe. Seven of our tests run against that
stack on every commit.

**The type system carries real weight.** `euint256`, `euint16`, `ebool` and `eaddress` are distinct
user-defined value types, so mixing a confidential quantity with a plaintext one is a compile error
rather than a silent leak. That caught mistakes early and often.

**Handle derivation is deterministic and readable from source.** Once we found
`Compute.sol::_generateHandle`, we could predict a handle off-chain and verify on-chain lineage
without decrypting anything. That property is load-bearing in our design and it exists because the
implementation is simple enough to reason about.

**`safeSub` returning encrypted zero rather than reverting** is exactly right for confidential
arithmetic. A revert on underflow would publish the comparison it was hiding. This is a small design
decision with large consequences and it was made correctly.

---

## What cost us the most time

### 1. The Solidity library has no boolean algebra

There is no `and`, `or`, `not` or `xor` for `ebool`, and `select` has no `ebool` overload. Both the
package source and the published documentation confirm this.

Every gate in our protocol combines several conditions. A treasury's order proceeds only when its
lock succeeded **and** its private limit is satisfied **and** the epoch met its privacy floor. With
no boolean operators we had to arithmetise all of it:

```solidity
// ebool -> euint256 -> multiply -> compare. Three operations where one should do.
euint256 a = Nox.select(condA, ONE, ZERO);
euint256 b = Nox.select(condB, ONE, ZERO);
ebool both = Nox.eq(Nox.mul(a, b), ONE);
```

This is correct and it is expensive. Each `select` is a full confidential operation, so a
three-condition gate costs five where a native `and` would cost one. In a system that must fit
inside a per-transaction gas cap, that difference decides how many participants an epoch can hold.

**Suggestion:** ship `Nox.and`, `Nox.or`, `Nox.not` for `ebool`, and a `select` overload returning
`ebool`. The TEE already computes on these values. The gap is in the Solidity surface, not in the
protocol.

### 2. Permissions are permanent, and the documentation says so only in passing

`allow`, `addViewer` and `allowPublicDecryption` cannot be undone. There is no `removeViewer`, no
`removeAdmin`, and no way to un-publish. The reference pages do state this, but the sentence sits
inside a method description rather than at the top of the access-control page where a developer
would meet it before designing around it.

This matters more than it first appears because of how handles are derived. From
`Compute.sol::_generateHandleUniqueSeed`, the unique seed is **zero** whenever any operand is
confidential, so the handle is a pure function of the operator and its operands. Two logically
different encrypted quantities computed identically from identical operands are **the same handle
sharing one permanent access list**.

In our system that is the common case rather than a corner case. Sixteen treasuries submitting round
numbers through the same three gates against the same epoch price produce byte-identical
intermediates at every stage. Granting one treasury its own result would have granted it another's.

We solved it by isolating every handle that crosses a trust boundary under a domain hash before
granting it. The documentation now names this the **new-handle isolation pattern**, which matches
what we arrived at independently.

**Suggestion:** put the permanence warning and the collision consequence at the **top** of the
access-control page, with the isolation pattern immediately beside it. A developer who learns this
after designing their permission model has to redesign it.

### 3. Decryption proofs attest less than they appear to

`validateDecryptionProof` is a pure EIP-712 signature check. No access list check, no nonce, no
expiry, no binding to the caller. A valid proof therefore attests that the gateway decrypted **some**
handle to **some** value, and nothing more.

That is a reasonable primitive, and it is easy to mistake for a stronger one. A contract that accepts
a proof without first checking the handle against something it committed to earlier has a replay
hole that will not show up in testing, because in testing the proof is always for the right handle.

We commit the exact handles an epoch will publish at seal time and refuse any proof for a handle
outside that set.

**Suggestion:** say plainly in the reference page what the proof does **not** cover, and show the
commitment pattern in the example. The current example verifies a proof in isolation, which is the
shape most likely to be copied.

### 4. Version drift between the plugin and the contracts

`nox-hardhat-plugin` is at 0.2.0 while the protocol contracts are at 0.2.4, and the version numbers
do not indicate which combinations are tested together. We pinned 0.1.0 of the plugin because it
worked and stopped touching it.

**Suggestion:** a compatibility table in the docs, or a peer dependency range in the plugin, would
remove the guesswork.

### 5. Small friction worth fixing

**`allowTransient` is easy to reach for and usually wrong.** The name suggests a scoped grant. It
grants for the transaction, which for any multi-transaction flow means the grant is gone by the time
it is needed. A sentence contrasting it with `allow` in the same paragraph would help.

**Gas costs are not documented.** We measured confidential operations at roughly 6,000 to 16,000 gas
depending on the operation and had to build our batching around a conservative estimate of 18,000. A
published table, even approximate, would let developers size their designs correctly the first time.

**Error messages from the gateway are terse.** A failed decryption returns little about why. During
development, the difference between a wrong handle, a missing grant and a malformed proof was several
hours of narrowing down.

---

## What we would tell the next team

**Read `Compute.sol` before you design your permission model.** Handle derivation is the single most
consequential behaviour in the system and the documentation describes it correctly without conveying
how much it constrains a design.

**Assume every grant is forever.** Build the isolation in from the start. Retrofitting it means
touching every handle that leaves your contract.

**Budget for arithmetised gating.** Whatever you think your conditional logic costs, multiply it.
The absence of boolean operators is the biggest single driver of gas in a confidential contract with
non-trivial conditions.

**Use the local Docker stack for everything you can.** It is fast, it is real, and it catches the
class of bug that only appears when a gateway is actually involved.

---

## Overall

Nox does the hard part well. Confidential computation with a clean Solidity surface, deterministic
handles, and a local stack that actually runs is a strong foundation, and the pieces that are missing
are additions to an existing design rather than corrections to it.

The two changes that would most improve the developer experience are **boolean operators for `ebool`**
and **moving the permanence warning to where developers will read it first**. Both are small relative
to what already exists, and both would have saved us days.
