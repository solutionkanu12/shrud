"use client";

import { useState } from "react";

import { PageHeader, RequiresConnection } from "@/components/app-shell";
import { AddressLink, Card, Pill, RainbowMark } from "@/components/primitives";
import { contractAddress } from "@/lib/deployment";

const STEPS = [
  {
    title: "Connect a Safe",
    body: "shrud operates on a Safe rather than a plain wallet. Bring one you already control, or create one at app.safe.global first. Safe 1.5.0 is required.",
    detail:
      "The version check reads the VERSION string rather than probing behaviour, because Safe 1.4.1 does not revert on setModuleGuard. It silently swallows the call and installs nothing, so a behavioural probe would report success on an account with no guard.",
  },
  {
    title: "Install the module",
    body: "One transaction from your Safe enables the shrud module and sets its guard. It adds a capability and removes nothing.",
    detail:
      "The module is bound to your Safe as a constructor immutable. It can only ever write intents whose owner is this Safe, and the factory is the only contract permitted to authorise it with the intent book.",
  },
  {
    title: "Set your order policy",
    body: "Choose which pairs this treasury may trade and which owners may authorise an order. Policy is public. What it governs is not.",
    detail:
      "An order family says USDC and WETH, never which side. Reviewing at the family level means the policy is auditable by your signers without publishing what any individual order does.",
  },
  {
    title: "Wrap what you want to trade",
    body: "Deposit USDC or WETH into their confidential wrappers. From that moment the balance is a Nox handle rather than a number.",
    detail:
      "Wrapping is a real deposit into a real contract. The plaintext backing is publicly visible at the wrapper; who holds how much of it is not.",
  },
] as const;

export default function OnboardPage() {
  const [expanded, setExpanded] = useState<number | null>(0);

  return (
    <>
      <PageHeader
        title="Set up a treasury"
        description="Four steps. Nothing is custodial, nothing is migrated, and every step is a transaction you sign from your own Safe."
        badge={<Pill tone="neutral">One time</Pill>}
      />

      <RequiresConnection>
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col gap-3">
            {STEPS.map((step, index) => (
              <Card key={step.title}>
                <div className="flex items-start gap-4">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink font-display text-body font-black text-white">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="type-subheading">{step.title}</p>
                    <p className="mt-1 text-body text-stone">{step.body}</p>

                    <button
                      type="button"
                      onClick={() => {
                        setExpanded(expanded === index ? null : index);
                      }}
                      aria-expanded={expanded === index}
                      className="mt-3 text-caption font-bold text-[#5c3fa8] underline-offset-4 hover:underline"
                    >
                      {expanded === index ? "Hide the reasoning" : "Why it works this way"}
                    </button>

                    {expanded === index && (
                      <p className="mt-2 rounded-[20px] bg-cloud p-4 text-caption text-stone">
                        {step.detail}
                      </p>
                    )}

                    <button
                      type="button"
                      className={`btn mt-4 text-[0.9rem] ${index === 0 ? "btn-tangerine" : "btn-quiet"}`}
                      disabled={index !== 0}
                    >
                      {index === 0 ? "Connect a Safe" : "Locked until the previous step"}
                    </button>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="flex flex-col gap-4">
            <Card tone="cloud">
              <div className="flex items-center gap-2.5">
                <RainbowMark size={30} />
                <p className="type-subheading">Before you start</p>
              </div>
              <ul className="mt-4 flex flex-col gap-3">
                <Requirement label="A Safe on Sepolia" body="Version 1.5.0. Create one at app.safe.global if you do not have one." />
                <Requirement label="Sepolia ETH" body="For gas on each setup transaction." />
                <Requirement label="Test USDC or WETH" body="From the Aave faucet, or by wrapping Sepolia ETH." />
                <Requirement
                  label="Two other treasuries, eventually"
                  body="The epoch floor is three participants. A single Safe can submit orders, but an epoch will not clear until three have."
                />
              </ul>
            </Card>

            <Card>
              <p className="text-body font-bold">What you are installing</p>
              <dl className="mt-3 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-caption text-stone">Module factory</dt>
                  <dd>
                    <AddressLink address={contractAddress("ShrudModuleFactory")} />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-caption text-stone">Intent book</dt>
                  <dd>
                    <AddressLink address={contractAddress("ShrudIntentBook")} />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-caption text-stone">Clearing vault</dt>
                  <dd>
                    <AddressLink address={contractAddress("ShrudClearingVault")} />
                  </dd>
                </div>
              </dl>
              <p className="mt-4 text-caption text-stone">
                Read the source before you sign. Every address above is verified on Etherscan and
                its runtime code hash is recorded in the deployment manifest.
              </p>
            </Card>
          </div>
        </div>
      </RequiresConnection>
    </>
  );
}

function Requirement({ label, body }: { label: string; body: string }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-tangerine" aria-hidden="true" />
      <div>
        <p className="text-body font-bold">{label}</p>
        <p className="text-caption text-stone">{body}</p>
      </div>
    </li>
  );
}
