import Link from "next/link";

import { Card, Pill, PublicPrivateRow, RainbowMark, Sparkle } from "@/components/primitives";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { TOTAL_CONTRACTS, contractAddress, explorerUrl, shortAddress } from "@/lib/deployment";

export default function LandingPage() {
  return (
    <>
      {/* The atmosphere wraps the header rather than the hero reaching up behind it. The header can
          then be any height, including when the configuration banner is showing. */}
      <div className="atmos-sky">
        <SiteHeader />
        <Hero />
      </div>
      <main>
        <TheProblem />
        <HowItWorks />
        <WhatIsPublic />
        <BuiltOn />
        <VerifyIt />
        <ClosingCta />
      </main>
      <SiteFooter />
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   1 · Hero
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Decorative only. Hidden from assistive technology and pinned so it never affects layout. */}
      <Sparkle size={46} className="absolute left-[7%] top-[22%] hidden lg:block" />
      <Sparkle size={30} className="absolute right-[11%] top-[16%] hidden lg:block" />
      <Sparkle size={22} className="absolute left-[16%] bottom-[24%] hidden lg:block" />

      <div className="shell relative flex flex-col items-center py-[80px] text-center md:py-[110px]">
        <Pill tone="settled">Live on Ethereum Sepolia</Pill>

        <h1 className="type-display mt-6 max-w-[13ch]">Hide the order. Settle the net.</h1>

        <p className="type-lead mt-6 max-w-[54ch] text-ink">
          Treasuries submit encrypted orders. Matching opposites cross privately at a reference
          price. Only the unmatched remainder reaches Uniswap, aggregated across everyone, and only
          when enough treasuries contributed to hide its parts.
        </p>

        <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
          <Link href="/app" className="btn btn-tangerine">
            Open the app
            <RainbowMark size={26} />
          </Link>
          <Link href="/verify" className="btn btn-pink">
            Verify the deployment
            <RainbowMark size={26} />
          </Link>
        </div>

        <p className="mt-5 text-caption text-stone">
          Not audited. Testnet only. No demo data, and the verifier proves it.
        </p>

        <HeroLedger />
      </div>
    </section>
  );
}

/**
 * The hero's product surface.
 *
 * Shows a real order the way the protocol shows one: the pair and the status are public, the side,
 * the amount and the limit are not. This is the entire argument of the product, so it appears
 * before any prose explaining it.
 */
function HeroLedger() {
  const rows = [
    { safe: "0x7a3f…2b91", pair: "USDC / WETH", status: "Authorised" },
    { safe: "0xc1e0…8d44", pair: "USDC / WETH", status: "Authorised" },
    { safe: "0x4b82…f0a7", pair: "USDC / WETH", status: "Submitted" },
  ];

  return (
    <div className="surface-glass mt-14 w-full max-w-[860px] overflow-hidden p-2 text-left">
      <div className="rounded-[26px] bg-white p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="type-subheading">Epoch 0x9c4a</p>
            <p className="text-caption text-stone">
              What every observer sees. Nothing below is decryptable by anyone but the owning Safe.
            </p>
          </div>
          <Pill tone="public">Sealing in 04:12</Pill>
        </div>

        <div className="mt-6 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0 sm:grid-cols-[1.1fr_1fr_auto_auto]">
          <HeaderCell>Safe</HeaderCell>
          <HeaderCell className="hidden sm:block">Pair</HeaderCell>
          <HeaderCell className="hidden sm:block">Side</HeaderCell>
          <HeaderCell className="text-right sm:text-left">Status</HeaderCell>

          {rows.map((row) => (
            <Row key={row.safe} {...row} />
          ))}
        </div>

        <p className="mt-6 rounded-[18px] bg-cloud px-4 py-3 text-caption text-stone">
          <span className="font-bold text-ink">Side reads Encrypted for every row.</span> An order
          that filled completely and an order that was underfunded produce byte-identical public
          traces. Same status, same events, same ordering.
        </p>
      </div>
    </div>
  );
}

function HeaderCell({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`pb-2 text-caption font-bold uppercase tracking-wider text-stone ${className}`}
    >
      {children}
    </div>
  );
}

function Row({ safe, pair, status }: { safe: string; pair: string; status: string }) {
  return (
    <>
      <div className="type-mono border-t border-cloud py-3.5 text-ink">{safe}</div>
      <div className="hidden border-t border-cloud py-3.5 text-body font-semibold sm:block">
        {pair}
      </div>
      <div className="hidden border-t border-cloud py-3.5 sm:block">
        <span className="inline-flex items-center gap-1.5 text-body font-bold text-[#5c3fa8]">
          <LockGlyph />
          Encrypted
        </span>
      </div>
      <div className="border-t border-cloud py-3.5 text-right sm:text-left">
        <Pill tone={status === "Authorised" ? "settled" : "neutral"}>{status}</Pill>
      </div>
    </>
  );
}

function LockGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="3" fill="currentColor" />
      <path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   2 · The problem
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

function TheProblem() {
  return (
    <section className="shell py-[80px]">
      <div className="grid gap-10 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
        <div>
          <Pill tone="warn">The problem</Pill>
          <h2 className="type-heading-lg mt-5 max-w-[16ch]">
            A public order is a published strategy.
          </h2>
          <p className="type-lead mt-5 max-w-[46ch]">
            A treasury moving two million dollars from USDC into ETH has a problem that has nothing
            to do with execution quality. The moment the order is public, so is the intent. Size,
            direction, and the wallet behind it are readable before the trade fills.
          </p>
          <p className="type-lead mt-4 max-w-[46ch]">
            This is not a flaw in Uniswap. Public order flow is what makes these protocols work. It
            just means any treasury large enough to matter cannot use them without leaking.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <ProblemCard
            title="Front running"
            body="An observable order is an observable opportunity. The treasury pays the difference."
            fill="#ff8a00"
          />
          <ProblemCard
            title="Strategy disclosure"
            body="A sequence of public trades is a public thesis. Competitors read it for free."
            fill="#ff54bb"
          />
          <ProblemCard
            title="Counterparty pricing"
            body="Anyone quoting you can see your position first, and quote accordingly."
            fill="#0f101a"
          />
          <ProblemCard
            title="Governance exposure"
            body="A DAO debating a reallocation announces it long before it executes."
            fill="#777885"
          />
        </div>
      </div>
    </section>
  );
}

function ProblemCard({ title, body, fill }: { title: string; body: string; fill: string }) {
  return (
    <div className="rounded-[32px] p-6" style={{ background: fill }}>
      <p className="type-subheading text-white">{title}</p>
      <p className="mt-2 text-body text-white/80">{body}</p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   3 · How it works
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

function HowItWorks() {
  return (
    <section className="atmos-cotton py-[80px]">
      <div className="shell">
        <div className="text-center">
          <Pill tone="confidential">How it works</Pill>
          <h2 className="type-heading-lg mx-auto mt-5 max-w-[18ch]">
            Three phases. Two of them nobody can see.
          </h2>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          <PhaseCard
            index="01"
            title="Submit"
            tone="confidential"
            body="Amount, direction and limit are encrypted in the browser before anything is sent. The chain records that a Safe submitted an order for a pair, and nothing else."
            visible="The Safe, the pair, the expiry"
            hidden="Side, amount, limit"
          />
          <PhaseCard
            index="02"
            title="Cross"
            tone="confidential"
            body="Every thirty minutes an epoch seals. Opposing orders match against each other inside the encrypted computation, at a time-weighted price from the Uniswap pool."
            visible="That an epoch sealed"
            hidden="Who matched whom, and for how much"
          />
          <PhaseCard
            index="03"
            title="Settle the remainder"
            tone="public"
            body="Only what did not match is aggregated into one net figure and sent to Uniswap. One transaction, everybody's leftover combined, with no individual attribution."
            visible="The aggregate that reached the venue"
            hidden="Each treasury's share of it"
          />
        </div>

        <div className="surface-card mx-auto mt-12 max-w-[760px]">
          <p className="type-subheading">The floor is why this holds</p>
          <p className="mt-2 text-body text-stone">
            An aggregate contributed to by one treasury is that treasury's order in plain sight.
            shrud refuses to publish it. The epoch floor requires{" "}
            <strong className="text-ink">three participants</strong>, and the residual and supply
            routes each require <strong className="text-ink">two</strong>, counted separately so a
            busy swap route can never authorise a lonely supply. Anything that misses its floor rolls
            into the next epoch rather than settling.
          </p>
        </div>
      </div>
    </section>
  );
}

function PhaseCard({
  index,
  title,
  body,
  visible,
  hidden,
  tone,
}: {
  index: string;
  title: string;
  body: string;
  visible: string;
  hidden: string;
  tone: "confidential" | "public";
}) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between">
        <span className="font-display text-heading-sm font-black text-cloud">{index}</span>
        <Pill tone={tone}>{tone === "confidential" ? "Confidential" : "Public"}</Pill>
      </div>
      <p className="type-subheading mt-3">{title}</p>
      <p className="mt-2 flex-1 text-body text-stone">{body}</p>
      <dl className="mt-5 flex flex-col gap-2 rounded-[20px] bg-cloud p-4">
        <div className="flex gap-2">
          <dt className="shrink-0 text-caption font-bold uppercase tracking-wider text-[#2c5f96]">
            Public
          </dt>
          <dd className="text-caption text-stone">{visible}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-caption font-bold uppercase tracking-wider text-[#5c3fa8]">
            Hidden
          </dt>
          <dd className="text-caption text-stone">{hidden}</dd>
        </div>
      </dl>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   4 · What is public
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

function WhatIsPublic() {
  const rows = [
    ["That a Safe submitted an order", "Which side it is on"],
    ["The trading pair, for example USDC and ETH", "The amount"],
    ["The expiry", "The private limit price"],
    ["The epoch it joined", "Whether it crossed, partly crossed, or held"],
    ["The aggregate that reached Uniswap", "Each treasury's contribution to it"],
    ["That an epoch settled", "Every individual allocation"],
  ] as const;

  return (
    <section className="shell py-[80px]">
      <div className="mx-auto max-w-[820px] text-center">
        <Pill tone="public">The boundary</Pill>
        <h2 className="type-heading-lg mt-5">Stated precisely, because it is the product.</h2>
        <p className="type-lead mx-auto mt-5 max-w-[52ch]">
          A privacy claim that does not say what remains visible is not a claim. Here is the whole
          line.
        </p>
      </div>

      <Card tone="cloud" className="mx-auto mt-10 max-w-[900px] p-6 sm:p-8">
        <div className="mb-4 hidden grid-cols-2 gap-6 sm:grid">
          <span className="text-caption font-bold uppercase tracking-wider text-[#2c5f96]">
            Public
          </span>
          <span className="text-caption font-bold uppercase tracking-wider text-[#5c3fa8]">
            Confidential
          </span>
        </div>
        <div className="flex flex-col gap-4">
          {rows.map(([publicFact, privateFact]) => (
            <PublicPrivateRow key={publicFact} publicFact={publicFact} privateFact={privateFact} />
          ))}
        </div>
      </Card>

      <div className="mx-auto mt-8 max-w-[900px] rounded-[32px] bg-ink p-7 text-white sm:p-9">
        <p className="type-subheading text-white">
          The public lifecycle has exactly five states, and it must never gain a sixth.
        </p>
        <p className="mt-3 text-body text-white/70">
          <strong className="text-white">Processed</strong> is where every order that entered a
          sealed epoch ends up. The one that filled completely, the one whose private limit failed,
          the one that was underfunded, and the one that simply held. A sixth state such as{" "}
          <em>Rejected</em> or <em>InsufficientBalance</em> would turn repeated oversized orders into
          a binary search over a confidential balance.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {["Submitted", "Authorised", "Processed", "Expired", "Cancelled"].map((state) => (
            <span
              key={state}
              className="rounded-[50px] bg-white/10 px-4 py-2 text-caption font-bold text-white"
            >
              {state}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   5 · Built on
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

function BuiltOn() {
  return (
    <section className="atmos-prism py-[80px]">
      <div className="shell">
        <div className="mx-auto max-w-[760px] text-center">
          <Pill tone="neutral">Composability</Pill>
          <h2 className="type-heading-lg mt-5">Four protocols. None of them modified.</h2>
          <p className="type-lead mx-auto mt-5 max-w-[50ch]">
            shrud is a layer on top of infrastructure that is public by design. It adds
            confidentiality without asking anything underneath to change.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <IntegrationCard
            name="Safe"
            version="1.5.0"
            body="Every treasury is a standard Safe with a shrud module installed. Version-gated on the VERSION string, because 1.4.1 silently swallows setModuleGuard rather than reverting."
          />
          <IntegrationCard
            name="iExec Nox"
            version="0.2.4"
            body="Confidential computation inside a trusted execution environment. Handles are pointers to encrypted data, decryptable only by the Safe that owns them."
          />
          <IntegrationCard
            name="Uniswap v3"
            version="Sepolia"
            body="Reference prices come from a thirty minute TWAP with a tick deviation bound. Net remainders settle through SwapRouter02 as one unattributed transaction."
          />
          <IntegrationCard
            name="Aave v3"
            version="Sepolia"
            body="Aggregate supply reaches a pooled position. Output is measured as an aToken balance delta, because Pool.supply returns nothing and aTokens rebase."
          />
        </div>
      </div>
    </section>
  );
}

function IntegrationCard({
  name,
  version,
  body,
}: {
  name: string;
  version: string;
  body: string;
}) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-baseline justify-between gap-2">
        <p className="type-subheading">{name}</p>
        <span className="type-mono text-stone">{version}</span>
      </div>
      <p className="mt-2 text-body text-stone">{body}</p>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   6 · Verify it
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

function VerifyIt() {
  const headline = [
    { name: "ShrudIntentBook", label: "Intent book" },
    { name: "ShrudClearingEngine", label: "Clearing engine" },
    { name: "ShrudSettlementEngine", label: "Settlement engine" },
  ];

  return (
    <section className="shell py-[80px]">
      {/* `min-w-0` is required, not cosmetic. A grid child defaults to `min-width: auto`, so the
          code block below refuses to shrink and pushes the whole page into horizontal scroll on a
          narrow viewport. The `overflow-x-auto` on the block itself cannot help while its column
          is still sized to the content. */}
      <div className="grid gap-10 lg:grid-cols-[1fr_1fr] lg:gap-16">
        <div className="min-w-0">
          <Pill tone="settled">Verify</Pill>
          <h2 className="type-heading-lg mt-5 max-w-[16ch]">
            Nothing here asks to be believed.
          </h2>
          <p className="type-lead mt-5 max-w-[46ch]">
            One command reads Sepolia and re-derives every claim this site makes. It needs no private
            key, so you can run it against this deployment without asking anyone for anything.
          </p>

          <div className="mt-6 overflow-x-auto rounded-[24px] bg-ink p-5">
            <pre className="type-mono text-[0.8rem] leading-relaxed text-white">
              <code>{`$ pnpm verify:live

  ✓ 17 contracts, code hashes match
  ✓ wiring closed, deployer cannot forge intents
  ✓ governance delays as claimed
  ✓ assets, routes and adapters registered
  ✓ privacy floors at least 2
  ✓ nothing has been seeded

  65 checks passed, 0 failed.`}</code>
            </pre>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/verify" className="btn btn-tangerine">
              Run it in the browser
              <RainbowMark size={26} />
            </Link>
            <a
              href="https://github.com"
              target="_blank"
              rel="noreferrer noopener"
              className="btn btn-quiet"
            >
              Read the source
            </a>
          </div>
        </div>

        <Card tone="cloud" className="p-6 sm:p-8">
          <p className="type-subheading">{TOTAL_CONTRACTS} contracts, live</p>
          <p className="mt-2 text-body text-stone">
            Deployed to Ethereum Sepolia with no Safes, no orders, no balances and no epochs. The
            verifier asserts that absence, because a verifier that passes against seeded state is
            checking numbers the repository wrote itself.
          </p>

          <div className="mt-6 flex flex-col gap-2">
            {headline.map((item) => (
              <a
                key={item.name}
                href={explorerUrl(contractAddress(item.name))}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center justify-between gap-3 rounded-[20px] bg-white px-4 py-3 transition-transform hover:-translate-y-0.5"
              >
                <span className="text-body font-bold">{item.label}</span>
                <span className="type-mono text-stone">
                  {shortAddress(contractAddress(item.name), 5)}
                </span>
              </a>
            ))}
          </div>

          <p className="mt-5 text-caption text-stone">
            Full set with runtime code hashes and constructor arguments in the deployment manifest.
          </p>
        </Card>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   7 · Closing
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

function ClosingCta() {
  return (
    <section className="shell">
      <div className="atmos-cotton relative overflow-hidden rounded-[32px] px-6 py-[72px] text-center">
        <Sparkle size={34} className="absolute left-[12%] top-[18%] hidden sm:block" />
        <Sparkle size={24} className="absolute right-[14%] bottom-[22%] hidden sm:block" />

        <h2 className="type-heading-lg mx-auto max-w-[18ch]">
          Bring your Safe. Keep your strategy.
        </h2>
        <p className="type-lead mx-auto mt-4 max-w-[46ch]">
          Install the module on a Safe you already control. Nothing custodial, nothing to migrate.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href="/app/onboard" className="btn btn-tangerine">
            Connect a Safe
            <RainbowMark size={26} />
          </Link>
          <Link href="/developers" className="btn btn-pink">
            Read the docs
            <RainbowMark size={26} />
          </Link>
        </div>
        <p className="mt-6 text-caption text-stone">
          A full clearing epoch needs three participating Safes. That is the privacy floor, not a
          limitation.
        </p>
      </div>
    </section>
  );
}
