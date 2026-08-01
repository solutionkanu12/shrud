import type { Metadata } from "next";
import Link from "next/link";

import { MarketingPage } from "@/components/marketing-page";
import { Card } from "@/components/primitives";

export const metadata: Metadata = {
  title: "Documentation",
  description: "Everything written about shrud, and where to find it.",
};

const DOCS = [
  {
    name: "README",
    body: "What shrud is, how to run it, and what it deliberately does not do.",
    href: "https://github.com",
  },
  {
    name: "Security policy",
    body: "The privacy boundary, the trust assumptions, and how to report a vulnerability.",
    href: "/security",
    internal: true,
  },
  {
    name: "Pre-deployment audit",
    body: "A self-audit run before the Sepolia broadcast, including two real gaps found and closed.",
    href: "https://github.com",
  },
  {
    name: "iExec tooling feedback",
    body: "What worked, what cost the most time, and what we would tell the next team building on Nox.",
    href: "https://github.com",
  },
  {
    name: "Handoff guide",
    body: "Setting up, committing, deploying to Vercel and Render, and submitting.",
    href: "https://github.com",
  },
  {
    name: "Product requirements",
    body: "The full specification this was built against, including the invariants and the state machines.",
    href: "https://github.com",
  },
] as const;

export default function DocsPage() {
  return (
    <MarketingPage
      eyebrow="Documentation"
      title="Everything written down, and nothing hidden."
      lead="The contracts are the specification. These explain the reasoning behind them."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {DOCS.map((doc) => {
          const content = (
            <Card className="h-full transition-transform hover:-translate-y-1">
              <p className="type-subheading">{doc.name}</p>
              <p className="mt-2 text-body text-stone">{doc.body}</p>
            </Card>
          );

          return "internal" in doc && doc.internal === true ? (
            <Link key={doc.name} href={doc.href}>
              {content}
            </Link>
          ) : (
            <a key={doc.name} href={doc.href} target="_blank" rel="noreferrer noopener">
              {content}
            </a>
          );
        })}
      </div>

      <Card tone="cloud" className="mt-4 p-6 sm:p-8">
        <p className="type-subheading">A note on what is not finished</p>
        <p className="mt-2 text-body text-stone">
          A full clearing epoch has not run end to end on Sepolia. Every stage is tested in isolation
          and against the real Nox stack, but the composition needs three funded Safes, which this
          deployment does not create for you. Saying so here is more useful than a demo that quietly
          runs on planted data.
        </p>
      </Card>
    </MarketingPage>
  );
}
