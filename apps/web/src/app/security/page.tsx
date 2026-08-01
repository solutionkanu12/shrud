import type { Metadata } from "next";

import { MarketingPage } from "@/components/marketing-page";
import { Card, Pill } from "@/components/primitives";

export const metadata: Metadata = {
  title: "Security",
  description: "The privacy boundary, the trust assumptions, and what shrud does not protect against.",
};

export default function SecurityPage() {
  return (
    <MarketingPage
      eyebrow="Security"
      title="What is guaranteed, and what is assumed."
      lead="A security page that omits the assumptions is marketing. These are stated first."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <p className="type-subheading">You must trust</p>
          <ul className="mt-4 flex flex-col gap-3">
            <Assumption
              name="The iExec Nox TEE"
              body="It computes on plaintext inside the enclave. A broken TEE reveals everything."
            />
            <Assumption
              name="The Nox gateway"
              body="It performs decryptions. It cannot forge a proof, but it can decline to serve one."
            />
            <Assumption
              name="Your Safe's owners"
              body="The threshold is your security. shrud adds no protection against your own signers."
            />
            <Assumption
              name="Uniswap v3 and Aave v3"
              body="Remainders settle through them. shrud re-checks their code hashes on every use and cannot make them correct."
            />
            <Assumption
              name="The reference price"
              body="A thirty minute TWAP with a tick bound. Moving it costs sustained price impact across the window, which is a cost rather than an impossibility."
            />
          </ul>
        </Card>

        <Card>
          <p className="type-subheading">shrud does not protect against</p>
          <ul className="mt-4 flex flex-col gap-3">
            <Assumption
              name="Timing analysis"
              body="Submission times are public. Submitting alone, immediately before a seal, is identifying whatever the protocol encrypts."
            />
            <Assumption
              name="A Safe with one owner"
              body="The privacy floor counts participants, not signatures."
            />
            <Assumption
              name="Off-chain correlation"
              body="If you announce your trade, the protocol cannot unannounce it."
            />
            <Assumption
              name="A compromised owner key"
              body="Nothing here helps."
            />
          </ul>
        </Card>
      </div>

      <Card tone="cloud" className="mt-4 p-6 sm:p-8">
        <p className="type-subheading">The five public states, and the six that must never exist</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {["Submitted", "Authorised", "Processed", "Expired", "Cancelled"].map((state) => (
            <span key={state} className="pill bg-white text-ink">
              {state}
            </span>
          ))}
        </div>
        <p className="mt-4 text-body text-stone">
          <strong className="text-ink">Processed</strong> carries every outcome an order can have.
          Each state below is a free oracle, and a pull request adding any of them should be rejected
          on sight.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {[
            ["Rejected", "That something went wrong, and roughly what"],
            ["InsufficientBalance", "Turns repeated oversized orders into a binary search over a confidential balance"],
            ["Buy or Sell", "Exactly what the product exists to hide"],
            ["Crossed", "Which orders found counterparties"],
            ["LimitFailed", "The relationship between a private limit and a public price"],
            ["Excluded", "Who did not make the cut, which with a small set identifies who did"],
          ].map(([name, leak]) => (
            <div key={name} className="rounded-[20px] bg-white p-4">
              <p className="text-body font-bold text-[#c0392b]">{name}</p>
              <p className="mt-1 text-caption text-stone">{leak}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <Pill tone="warn">Status</Pill>
          <p className="type-subheading mt-3">Not audited. Testnet only.</p>
          <p className="mt-2 text-body text-stone">
            This software has not been through an external security review. It is deployed on
            Ethereum Sepolia and must not be used on a network holding real value.
          </p>
        </Card>
        <Card>
          <Pill tone="settled">Reporting</Pill>
          <p className="type-subheading mt-3">Private advisory, not a public issue</p>
          <p className="mt-2 text-body text-stone">
            Open a private security advisory on the repository, under Security then Report a
            vulnerability. Please do not open a public issue for anything affecting funds, privacy or
            access control. There is no bug bounty, and saying so is better than implying one.
          </p>
        </Card>
      </div>
    </MarketingPage>
  );
}

function Assumption({ name, body }: { name: string; body: string }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-stone" aria-hidden="true" />
      <div>
        <p className="text-body font-bold">{name}</p>
        <p className="text-caption text-stone">{body}</p>
      </div>
    </li>
  );
}
