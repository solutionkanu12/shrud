# Submission pack

Everything needed to fill in the DoraHacks form and post on X. Copy the blocks directly.

Replace `YOUR_USERNAME`, the video link and the live URL before submitting.

---

## One-liner

Pick one. The first is the safest.

> **Confidential treasury clearing for Safe, Uniswap and Aave. Treasuries submit encrypted orders,
> matching opposites cross privately, and only the unmatched remainder reaches a public venue.**

> Hide the order. Settle the net. Confidential clearing on Nox for treasuries that cannot trade in
> public.

> A public order is a published strategy. shrud lets treasuries clear against each other privately
> and sends only the aggregate remainder to Uniswap.

---

## Short description

For the DoraHacks summary field. Around 60 words.

> A DAO treasury moving two million dollars cannot use Uniswap without publishing its strategy. shrud
> is a clearing layer built on iExec Nox that takes encrypted orders, matches opposing treasuries
> privately at a TWAP reference price, and sends only the unmatched aggregate to a public venue.
> Safe, Uniswap and Aave are used unmodified. Live on Ethereum Sepolia with 17 verified contracts.

---

## Full description

For the main DoraHacks description field.

> ### The problem
>
> A treasury moving two million dollars from USDC into ETH has a problem that has nothing to do with
> execution quality. The moment the order is public, so is the strategy. Size, direction and the
> wallet behind it are readable before the trade fills, and the treasury pays for being visible.
>
> This is not a flaw in Uniswap. Public order flow is what makes these protocols work. It just means
> any treasury large enough to matter cannot use them without leaking.
>
> ### What shrud does
>
> shrud is a confidential clearing layer that sits on top of protocols that are public by design and
> **modifies none of them**.
>
> Treasuries submit orders whose amount, side and limit price are encrypted in the browser before
> anything is sent. Every thirty minutes an epoch seals, and inside the iExec Nox trusted execution
> environment shrud matches opposing orders against each other at a time-weighted reference price
> from the Uniswap pool. Crossed volume never reaches a public venue at all, so there is no public
> order to front run.
>
> Only what does not match is aggregated into one net remainder and settled through Uniswap as a
> single unattributed transaction. Idle balances can join a pooled Aave position on the same terms.
>
> Nothing is published unless enough treasuries contributed to it. An aggregate from a single
> treasury is that treasury's order in plain sight, so shrud holds it back and rolls it into the next
> epoch. The swap route and the pooled-supply route carry separate floors, because sharing one would
> let a busy swap authorise a lonely supply.
>
> ### What stays private
>
> Public: that a Safe submitted an order, the trading pair, the expiry, the epoch it joined, and the
> final aggregate that reached Uniswap.
>
> Confidential: which side, the amount, the limit price, whether it crossed, and every individual
> allocation.
>
> The public order lifecycle has **exactly five states**, and `Processed` is where every order that
> entered a sealed epoch ends up, whether it filled completely, failed its private limit, or was
> underfunded. Those cases are byte-identical from outside. A sixth state such as
> `InsufficientBalance` would turn repeated oversized orders into a binary search over a confidential
> balance, so it does not exist.
>
> ### How Nox is used
>
> Every order value is an encrypted handle. Balance checks, limit gating, crossing arithmetic and
> residual accumulation all happen on encrypted data inside the TEE. The design is shaped by four
> Nox behaviours confirmed against the real stack rather than assumed:
>
> - There is no boolean algebra for `ebool`, so every gate is arithmetised through `select` and
>   `mul`.
> - `safeSub` returns encrypted zero rather than reverting, so an underflow does not publish the
>   comparison it was hiding.
> - Identical computations produce identical handles sharing one permanent access list, so every
>   handle crossing a trust boundary is isolated under a domain hash before it is granted.
> - A decryption proof is a pure signature check with no replay protection, so shrud commits the
>   exact publishable handles at seal time and refuses anything else.
>
> ### Verify it
>
> Nothing in this project asks to be believed. `pnpm verify:live` reads Sepolia and re-derives every
> claim: 65 checks, read-only, no private key required, so anyone can run it against a deployment
> they do not control. A subset also runs in the browser at `/verify`.
>
> The deployment contains **no seeded data**. No demo Safes, no planted balances, no fabricated
> epochs. The verifier asserts that absence.

---

## Tech stack

> Solidity 0.8.36, iExec Nox 0.2.4, Safe 1.5.0, Uniswap v3, Aave v3, Hardhat 3, Foundry, TypeScript,
> Next.js 16, React 19, wagmi 2, RainbowKit, viem, Tailwind CSS 4.

---

## Links

| Field | Value |
|---|---|
| GitHub | `https://github.com/YOUR_USERNAME/shrud` |
| Demo video | *your 3 minute video* |
| Live app | *your Vercel URL* |
| Network | Ethereum Sepolia (11155111) |
| Intent book | `0x45525d5625a3c0cbd79162035bca4a62d1855fc2` |
| Clearing engine | `0xcf30be6884105a27e54a342acd3e53dabdbc8e7c` |
| Settlement engine | `0x8b34e00c984c4e6d96e06c271ccbada1cd2af0f6` |
| Licence | GPL-3.0-or-later |

---

## Against the judging criteria

The brief weights these explicitly. Point to each.

| Criterion | Where it is met |
|---|---|
| **Creativity** (3 stars) | A clearing layer rather than a private wallet. Crossing means matched volume never reaches a public venue at all, which is a different mechanism from hiding a transaction. |
| **Works end to end without mock data** (3 stars) | Zero seeded state. `pnpm verify:live` asserts the *absence* of demo data as one of its 65 checks. |
| **Deployed on ETH Sepolia** (2 stars) | 17 contracts, all with verified source on Etherscan. Manifest at `deployments/11155111.json` records every runtime code hash. |
| **`feedback.md` on iExec tools** (2 stars) | [`feedback.md`](feedback.md) in the repository root. Five concrete findings from the build, with suggestions. |
| **Video, 4 min max** (2 stars) | 3 minute script at [`docs/demo-script.md`](docs/demo-script.md). |
| **Leverages Nox** (1 star) | Confidential arithmetic through the whole clearing path, plus handle isolation and commitment-bound decryption proofs. 7 tests run against the real Nox stack in Docker. |
| **UX** (1 star) | 19 routes, responsive at 390/768/1440, live chain reads throughout, honest empty states, and an in-browser verifier. |

---

## Originality statement

The brief asks you to state what existed before and what was built during the hackathon.

> Everything in this repository was written during the iExec WTF Hackathon. No previous hackathon
> project was reused and no code from the earlier VIBE Coding Hackathon appears here.
>
> One file is vendored from open source: `contracts/libraries/uniswap/TickMath.sol`, copied from
> Uniswap v3-core 1.0.1 under GPL-2.0-or-later, with its licence header intact and its provenance
> recorded in the file. It is vendored rather than imported because v3-core targets Solidity 0.7.6
> and this project compiles at 0.8.36.
>
> Safe, Uniswap v3, Aave v3 and iExec Nox are integrated as deployed and unmodified. No protocol was
> forked. Full attribution is in [`NOTICE.md`](NOTICE.md).

---

## X post

**Your post is the official submission. Without it the project is not entered.** It must include a
short description, the demo video, a link to the public GitHub repository, and it must tag
**@iEx_ec**.

### Option A: single post

Under 280 characters, so it posts as one tweet with the video attached.

> Treasuries can't trade on Uniswap without publishing their strategy.
>
> shrud fixes that with @iEx_ec Nox: encrypted orders, opposites cross privately, only the aggregate
> remainder hits the public venue.
>
> No protocol modified. 17 verified contracts on Sepolia.
>
> [github link]

Attach the demo video directly to this post rather than linking it. Native video autoplays in the
timeline; a link does not.

### Option B: thread

Better reach, and it gives each idea room. Post the video on tweet 1.

**1/5**

> Treasuries can't use Uniswap without publishing their strategy. Size, direction and the wallet are
> all readable before the trade fills.
>
> shrud is a confidential clearing layer built on @iEx_ec Nox that fixes this without modifying a
> single protocol. 🧵
>
> [attach demo video]

**2/5**

> Orders are encrypted in your browser before anything is sent.
>
> The chain records that a Safe submitted an order for a pair. Not the side. Not the amount. Not the
> limit.

**3/5**

> Every 30 minutes an epoch seals and opposing treasuries cross against each other inside the TEE, at
> a TWAP reference price.
>
> That volume never reaches a public venue at all. There's no order to front run because there's no
> public order.

**4/5**

> Only the unmatched remainder goes out, aggregated across everyone as one unattributed transaction.
>
> And only if enough treasuries contributed. A single-contributor aggregate is that treasury's order
> in plain sight, so shrud holds it back.

**5/5**

> Nothing here asks to be believed. One read-only command re-derives every claim from the chain, no
> key required.
>
> Safe, Uniswap v3 and Aave v3, all unmodified. Nothing seeded.
>
> [github link]
> [live app link]

### Getting the tags right

| Must include | Why |
|---|---|
| **@iEx_ec** | Required by the brief. Without the tag the submission may not be counted. |
| Demo video | Required. Attach natively rather than linking. |
| GitHub link | Required, and the repository must be **public** and the link must work. |
| Short description | Required. |

Optional, and worth adding: **@safe**, **@Uniswap**, **@aave**. Tagging the protocols you composed
with is accurate here because you genuinely integrated all three without forking any of them.

Hashtags: `#iExec #Nox #ConfidentialDeFi #WTFHackathon`

### Before you post

- [ ] The GitHub repository is **public**. Open the link in a private window and confirm.
- [ ] The video plays, is under 4 minutes, and shows the Etherscan moment.
- [ ] `@iEx_ec` is spelled exactly that way. It has an underscore.
- [ ] The live app URL loads.
- [ ] Post it, then paste the post URL into the DoraHacks form.

---

## Final checklist

- [ ] Public GitHub repository, working links, complete source
- [ ] `LICENSE` present (GPL-3.0) and matching the SPDX headers
- [ ] README with installation and usage
- [ ] `feedback.md` in the root
- [ ] Functional front end deployed and reachable
- [ ] Demo video, 4 minutes maximum
- [ ] Contracts on Sepolia with verified source
- [ ] `pnpm verify:live` passes on a fresh clone
- [ ] Joined the Discord
- [ ] Posted on X tagging @iEx_ec

---

## Two things to state plainly if asked

Being straight about these is worth more than hoping nobody notices.

**It has not been audited.** Testnet only. The README, the security page and the site footer all say
so.

**A full clearing epoch has not run end to end on Sepolia.** Every stage is tested in isolation and
against the real Nox stack in Docker, and the composition needs three funded Safes, which the
deployment deliberately does not create for you. The privacy floor is three participants, which is
the product refusing to publish an aggregate a smaller set would make identifying.
