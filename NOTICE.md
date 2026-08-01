# Third-party notices and attribution

shrud is licensed under **GPL-3.0-or-later**. See [LICENSE](LICENSE) for the full text.

This file records everything shrud builds on, what its licence is, and how it is used. It exists
because a project that composes with five open-source protocols owes each of them a clear statement
of what was taken and what was not.

---

## Code vendored into this repository

One file is copied source rather than a dependency, and it carries its own licence.

| File | Origin | Licence |
|---|---|---|
| [`contracts/libraries/uniswap/TickMath.sol`](contracts/libraries/uniswap/TickMath.sol) | `Uniswap/v3-core` 1.0.1, `contracts/libraries/TickMath.sol` | **GPL-2.0-or-later** |

**Why it is vendored rather than imported.** Uniswap v3-core targets Solidity 0.7.6. shrud compiles
at 0.8.36, where arithmetic is checked by default and the original's unchecked assembly would not
compile. The file is copied verbatim with its licence header intact and its provenance recorded in a
comment at the top, alongside a note on what changed for the compiler version.

**Licence compatibility.** GPL-2.0-**or-later** permits use under GPL-3.0, so a combined work
licensed GPL-3.0-or-later is compliant. The original file keeps its own SPDX identifier rather than
being relabelled, because relabelling somebody else's file misstates its terms.

`test/unit/TickMath.t.sol` checks the vendored constants against Uniswap's published values and
verifies output against the live Sepolia pool, so a transcription error is a failing test rather than
a silent pricing bug.

---

## Protocols shrud integrates with

**None of these was modified.** shrud composes with each as deployed and holds no privileged position
in any of them. Their addresses are pinned in [`source-lock.json`](source-lock.json), each
code-verified on Sepolia rather than copied from a documentation page.

| Protocol | Licence | How shrud uses it |
|---|---|---|
| **iExec Nox** | Apache-2.0 | Confidential computation. Encrypted inputs, handle arithmetic, and gateway decryption for the five values an epoch publishes. |
| **Safe** (Safe{Wallet} contracts) | LGPL-3.0-or-later | Every treasury is a standard Safe 1.5.0 with a shrud module and guard installed. shrud deploys no Safe code and modifies none. |
| **Uniswap v3** | GPL-2.0-or-later (core), BUSL/GPL (periphery) | Reference prices from a 30-minute TWAP on a v3 pool. Unmatched remainders settle through SwapRouter02. Read and call only. |
| **Aave v3** | BUSL-1.1 / AGPL-3.0 (varies by component) | Aggregate supply reaches a pooled position through `Pool.supply`. Call only, no forked code. |
| **OpenZeppelin Contracts** | MIT | `IERC20`, `SafeERC20`, `Math`, `ReentrancyGuard`. Imported as a dependency. |

**On Aave and BUSL.** Aave v3's core is under BUSL-1.1, which restricts *production deployment of the
protocol itself*. shrud does not fork, copy, or redeploy any Aave code. It calls a deployed Aave
instance through its public interface, which is ordinary composability and outside BUSL's scope. No
Aave source is vendored here.

**On Safe and LGPL.** LGPL permits linking from differently licensed work. shrud's module is a
separate contract that a Safe owner installs; no Safe source is copied or modified.

---

## Tooling

Development dependencies, none of which reach a deployed artifact.

| Tool | Licence |
|---|---|
| Hardhat 3, `@iexec-nox/nox-hardhat-plugin` | MIT |
| Foundry (`forge`, `anvil`) | MIT / Apache-2.0 |
| viem, wagmi | MIT |
| RainbowKit | MIT |
| Next.js | MIT |
| Tailwind CSS | MIT |
| Biome | MIT / Apache-2.0 |
| Nunito (typeface) | SIL Open Font License 1.1 |

Nunito is loaded from Google Fonts under the SIL OFL, which permits use and embedding. It stands in
for SF Pro Rounded, which is Apple-licensed and is **not** bundled or redistributed here.

---

## What is original to shrud

Everything in `contracts/` except the one vendored file above. Everything in `packages/`, `scripts/`,
`apps/`, `test/` and `docs/`. All of it written during the iExec WTF Hackathon.

No previous hackathon project was reused. The confidential clearing design, the handle isolation
scheme, the two-route publication model with separate privacy floors, and the deployment and
verification tooling are original work.

---

## Trademarks

Safe, Uniswap, Aave, iExec and Nox are trademarks of their respective owners. shrud is an independent
project and is **not** endorsed by, affiliated with, or sponsored by any of them. Their names appear
here to describe interoperability, which is nominative use.

---

## Reporting an attribution problem

If anything here is wrong or incomplete, open an issue. Attribution errors are corrected quickly and
without argument.
