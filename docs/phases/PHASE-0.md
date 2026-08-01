# Phase 0 — Ground truth and scaffold

**Status:** complete
**Evidence:** `npx hardhat compile` succeeds at solc 0.8.36 / evm osaka; `source-lock.json`
reproduces from the commands in this log.

---

## What this phase was for

Nothing in the PRD can be built on an assumption about an external system. Phase 0 replaced every
"presumably" with a measurement, and the measurements changed the design in four places before a
single contract was written. That is the point of doing it first: each of these would have been a
late, expensive discovery.

## What was verified, and how

### iExec Nox — the confidential compute layer

Read from package source, not documentation prose.

| Fact | Source |
|---|---|
| The complete Solidity surface | `nox-protocol-contracts@0.2.4/contracts/sdk/Nox.sol`, read in full |
| Handle derivation and the unique seed | `contracts/modules/Compute.sol::_generateHandle` |
| What `validateInputProof` actually checks | `contracts/modules/Compute.sol::validateInputProof` |
| ERC-7984 and the ERC-20 wrapper | `nox-confidential-contracts@0.2.2`, all 14 sources |
| Sepolia deployment | `eth_getCode` on `0x24Ef36Ec…`; `eth_call gateway()` returned `0xE13191F5…` |
| Gateway is live | `POST https://gateway-testnets.noxprotocol.dev/v0/public/handles/status` answered 400 for a malformed handle — reachable and parsing |
| Default network config | `@iexec-nox/handle@0.1.0-beta.13/src/config/networks.ts` |

**Four findings that shaped the design:**

1. **There is no boolean algebra.** No `and`, `or`, `not`, `xor`, and `select` has no `ebool`
   overload. PRD §10.2's `v_i AND isBuy_i AND buyLimitPass_i` cannot be written as it stands.
   → delta D-3, and the chained-`select` form the engine uses instead.
2. **Safe operations fail silently into encrypted zero.** `safeSub` returns
   `(ebool success, T result)` and on failure `result` is encrypted zero while the transaction
   succeeds. The flag is a ciphertext, so nothing can branch on it. → delta D-4.
3. **Input proofs carry no nonce and no consumption marker.** Replay protection is entirely the
   application's job. → delta D-6, discharged by `ShrudConfidentialBase`.
4. **Handles are deterministic in their operands.** Two identical computations are one handle with
   one permanent ACL entry, and there is no `removeViewer`. → delta D-5, discharged by
   `ShrudHandleIsolation`.

### Safe — the account adapter

**The finding that moved the launch target:** `setModuleGuard` and the `IModuleGuard` hook pair
exist only from **Safe 1.5.0**. `grep -rn setModuleGuard` over `safe-contracts@1.4.1-2` returns
nothing; `safe-smart-account@1.5.0/contracts/base/ModuleManager.sol` has it at line 258. Safe
1.4.1's guard covers `execTransaction` and never `execTransactionFromModule` — a shrud module
installed on 1.4.1 would run completely unguarded, which is the precise risk PRD §20.2 exists to
control.

Safe 1.5.0 **is** deployed on Sepolia. From `@safe-global/safe-deployments@1.37.60`, singleton
`0xFf51A5898e281Db6DfC7855790607438dF2ca44b` and proxy factory
`0x14F2982D601c9458F93bd70B218933A6f8165e7b`, both confirmed by `eth_getCode` (21,451 bytes and
3,321 bytes). → delta D-1.

A second finding on the same path: `checkSignatures` takes an `executor` in 1.5.0, and a `v == 1`
approved-hash signature is accepted when `executor == currentOwner` **with no on-chain approval**.
The legacy form forwards `msg.sender`, so a module using it would let a relayer who is also an owner
satisfy one signature for free. shrud passes `address(0)`. → delta D-2.

### Uniswap and Aave — the settlement venues

Every candidate pool was measured rather than assumed. The full table is in delta D-8; the
conclusion is that exactly one combination on Sepolia works:

- **WETH9 `0xfff99767…6b14` / USDC `0x94a9D9AC…`, fee 500, pool `0xba57efa1…`** — liquidity
  179,828,542,016,647, observation cardinality **100**, oldest observation 2026-06-23, and
  `observe()` executed successfully at 1800 s, 600 s, 300 s and 60 s.
- That same USDC is an Aave V3 Sepolia reserve: `Pool.getReserveData` returned aToken
  `0x16dA4541…`.

Everything else fails one of the two tests. The two deepest pools have **observation cardinality
zero**, so `observe()` reverts and no TWAP exists at all. The one pool with better cardinality pairs
a USDC that Aave does not list, so a single order family could not both cross on Uniswap and supply
to Aave with the same confidential asset.

**Honest note carried forward:** the observed tick is 120,482, a testnet price with no relationship
to the real WETH/USDC market. shrud proves the price was *fixed, sourced and sealed*. It does not
claim the level means anything on a testnet, and the UI says so.

## What was built

```
shrud/
├── package.json           pnpm workspace root, every dependency pinned exactly
├── pnpm-workspace.yaml
├── hardhat.config.ts      solc 0.8.36, evm osaka, Nox plugin, L1-at-osaka local node
├── foundry.toml           the deterministic half only — see below
├── remappings.txt
├── source-lock.json       every external fact, with its reproduction method
├── PHASES.md
└── docs/PRD-DELTA.md      twelve recorded deltas
```

**Why two build systems, and what each is for.** Every Nox primitive is an external call into
NoxCompute whose result is computed off chain by the KMS, ingestor and TDX runner. Foundry cannot
drive that, and `vm.etch`-ing a fake NoxCompute would be a *mocked confidentiality path* — evidence
of nothing. So Hardhat with the Nox plugin builds and tests everything, against the real stack in
Docker. Foundry covers the deterministic, Nox-free contracts — registries, guard, price registry,
adapters, plaintext maths — where its fuzzer and invariant runner are worth having and where there
is nothing to fake.

**Three configuration choices that are load-bearing, not preferences:**

- `evmVersion: "osaka"` everywhere, and `chainType: "l1", hardfork: "osaka"` on the local node. The
  Nox plugin's default node is an OP chain at Isthmus, where CLZ (EIP-7939, which solc emits at
  Osaka) is an **invalid opcode**. Everything deploys, every constructor runs, every view returns,
  and then one execution path dies with a bare `invalid opcode` naming nothing.
- `allowUnlimitedContractSize: true` stays, because with it false the node cannot deploy NoxCompute
  itself. EIP-170 therefore cannot be enforced inside the node and is enforced by
  `pnpm verify:contract-size` outside it.
- `allowBlocksWithSameTimestamp: true`. A Hardhat node advances `block.timestamp` at least a second
  per block and a full epoch mines hundreds. `validateInputProof` compares the gateway's real-clock
  `createdAt` against `block.timestamp`, so once the chain runs ahead every proof looks expired —
  late in a long run, and looking like a protocol failure.

## Open items handed to later phases

| Item | Owner phase |
|---|---|
| Docker daemon is not running on this machine, so the real local Nox stack has not been booted yet. The Sepolia NoxCompute and gateway *are* live and were reached. | 6 |
| The measured per-stage gas budget for the clearing graph, against the 2^24 cap | 3, then 6 |
| Four real Safe 1.5.0 accounts with different owner sets and thresholds | 11 |
