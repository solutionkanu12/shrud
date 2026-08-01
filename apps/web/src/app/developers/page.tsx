import type { Metadata } from "next";
import Link from "next/link";

import { MarketingPage } from "@/components/marketing-page";
import { AddressLink, Card, Pill } from "@/components/primitives";
import { CONTRACTS, ROUTE } from "@/lib/deployment";

export const metadata: Metadata = {
  title: "Developers",
  description: "Contracts, integration surface, and the four Nox behaviours this design depends on.",
};

const NOX_FACTS = [
  {
    fact: "No boolean algebra for ebool",
    consequence:
      "There is no and, or, not or xor, and select has no ebool overload. Every gate is arithmetised through select and mul, so a three-condition gate costs five confidential operations where a native and would cost one.",
  },
  {
    fact: "safeSub returns encrypted zero rather than reverting",
    consequence:
      "Exactly right for confidential arithmetic. A revert on underflow would publish the comparison it was hiding.",
  },
  {
    fact: "Identical computations produce identical handles",
    consequence:
      "The unique seed is zero whenever any operand is confidential, so a handle is a pure function of operator and operands. Two treasuries with the same number share one handle and one permanent access list.",
  },
  {
    fact: "An input proof is accepted twice",
    consequence:
      "validateDecryptionProof is a pure EIP-712 check with no nonce, no expiry and no caller binding. Replay protection has to be built, and shrud commits the exact publishable handles at seal time.",
  },
] as const;

export default function DevelopersPage() {
  return (
    <MarketingPage
      eyebrow="Developers"
      title="Everything you need to read the source with context."
      lead="The contracts are the specification. These are the four facts that explain why they look the way they do."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {NOX_FACTS.map((item) => (
          <Card key={item.fact}>
            <Pill tone="confidential">Nox behaviour</Pill>
            <p className="type-subheading mt-3">{item.fact}</p>
            <p className="mt-2 text-body text-stone">{item.consequence}</p>
          </Card>
        ))}
      </div>

      <Card tone="cloud" className="mt-4 p-6 sm:p-8">
        <p className="type-subheading">Run it locally</p>
        <p className="mt-2 text-body text-stone">
          Four independent test layers. The Nox suite runs against a real gateway in Docker, so the
          behaviours above are checked rather than assumed.
        </p>
        <div className="mt-4 overflow-x-auto rounded-[24px] bg-ink p-5">
          <pre className="type-mono text-[0.8rem] leading-relaxed text-white">
            <code>{`pnpm install && pnpm compile

pnpm test                                            # 51 unit and fuzz
FOUNDRY_PROFILE=fork forge test --fork-url "$RPC"    # 19 against live Sepolia
npx hardhat test                                     # 77, incl. 7 against real Nox
node --test packages/clearing-math/test/*.test.ts    # 14 clearing mathematics
pnpm verify:live                                     # 65 against the deployment`}</code>
          </pre>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card className="min-w-0">
          <p className="type-subheading">Deployed contracts</p>
          <p className="mt-1 text-caption text-stone">
            Every runtime code hash and constructor argument is recorded in the deployment manifest.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {Object.entries(CONTRACTS).map(([name, entry]) => (
              <div
                key={name}
                className="flex items-center justify-between gap-2 rounded-[20px] bg-cloud px-4 py-3"
              >
                <span className="truncate text-caption font-bold">{name}</span>
                <AddressLink address={entry.address} />
              </div>
            ))}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <p className="type-subheading">Integration surface</p>
            <dl className="mt-4 flex flex-col gap-3">
              <Row label="Safe" value="1.5.0, version gated" />
              <Row label="Uniswap v3" value={`${ROUTE.twapWindow / 60} min TWAP`} />
              <Row label="Aave v3" value="Pooled supply position" />
              <Row label="iExec Nox" value="0.2.4 contracts" />
            </dl>
            <p className="mt-4 text-caption text-stone">
              None of these protocols was modified. shrud composes with them as they are.
            </p>
          </Card>

          <Card tone="cloud">
            <p className="type-subheading">Read next</p>
            <ul className="mt-3 flex flex-col gap-2">
              <li>
                <Link href="/security" className="text-body font-bold underline underline-offset-4">
                  Security model
                </Link>
                <span className="text-caption text-stone"> — the privacy boundary and the trust assumptions</span>
              </li>
              <li>
                <Link href="/verify" className="text-body font-bold underline underline-offset-4">
                  Verify the deployment
                </Link>
                <span className="text-caption text-stone"> — public reads, in your browser</span>
              </li>
              <li>
                <Link href="/docs" className="text-body font-bold underline underline-offset-4">
                  Documentation
                </Link>
                <span className="text-caption text-stone"> — architecture and the audit</span>
              </li>
            </ul>
          </Card>
        </div>
      </div>
    </MarketingPage>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-caption font-bold uppercase tracking-wider text-stone">{label}</dt>
      <dd className="text-body font-semibold">{value}</dd>
    </div>
  );
}
