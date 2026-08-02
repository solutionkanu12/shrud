"use client";

import { useState } from "react";

import Link from "next/link";
import { type Address, zeroAddress } from "viem";

import { Note, PageHeader, RequiresConnection } from "@/components/app-shell";
import { Card, Empty, Pill } from "@/components/primitives";
import { useActiveSafe } from "@/lib/active-safe";
import { explorerUrl } from "@/lib/deployment";
import { useModuleOf } from "@/lib/hooks";
import { useSubmitOrder } from "@/lib/use-submit-order";

type Side = "buy" | "sell";

export default function TradePage() {
  // Keyed by Safe, not by the connected wallet. See the note on `useModuleOf`.
  const { safe } = useActiveSafe();
  const module = useModuleOf(safe);
  const hasModule = module.data !== undefined && module.data !== zeroAddress;

  return (
    <>
      <PageHeader
        title="New order"
        description="Amount, side and limit are encrypted in your browser before anything is sent. The chain records that a Safe submitted an order for a pair, and nothing else."
        badge={<Pill tone="confidential">Confidential</Pill>}
      />
      <RequiresConnection>
        {hasModule && safe !== undefined ? (
          <OrderForm safe={safe} module={module.data as Address} />
        ) : (
          <Empty
            title={safe === undefined ? "No treasury selected" : "This Safe has no shrud module"}
            action={
              <Link href="/app/onboard" className="btn btn-tangerine">
                {safe === undefined ? "Connect a Safe" : "Install the module"}
              </Link>
            }
          >
            An order is written by the Safe's module, so the module has to exist before there is
            anything to submit.
          </Empty>
        )}
      </RequiresConnection>
    </>
  );
}

function OrderForm({ safe, module }: { safe: Address; module: Address }) {
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [limit, setLimit] = useState("");
  const submission = useSubmitOrder({ safe, module });

  const amountValid = amount !== "" && Number(amount) > 0;
  const limitValid = limit !== "" && Number(limit) > 0;
  const ready = amountValid && limitValid && !submission.busy;

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <Card>
        <p className="type-subheading">USDC / WETH</p>
        <p className="mt-1 text-body text-stone">
          The only reviewed pair on this deployment. An order family is broad on purpose: it says
          which pair, never which side.
        </p>

        <fieldset className="mt-6">
          <legend className="text-caption font-bold uppercase tracking-wider text-stone">
            Side
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(["buy", "sell"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setSide(option);
                }}
                aria-pressed={side === option}
                className={`rounded-[40px] px-4 py-3.5 text-body font-bold transition-colors ${
                  side === option ? "bg-ink text-white" : "bg-cloud text-ink hover:bg-mist/40"
                }`}
              >
                {option === "buy" ? "Buy WETH" : "Sell WETH"}
              </button>
            ))}
          </div>
          <p className="mt-2 text-caption text-stone">
            Encrypted before submission. The chain never learns which of these you picked.
          </p>
        </fieldset>

        <Field
          label={side === "buy" ? "Amount to spend (USDC)" : "Amount to sell (WETH)"}
          value={amount}
          onChange={setAmount}
          placeholder="50000"
          hint="Encrypted. Checked against your confidential balance inside Nox."
        />

        <Field
          label={side === "buy" ? "Maximum price (USDC per WETH)" : "Minimum price (USDC per WETH)"}
          value={limit}
          onChange={setLimit}
          placeholder="3200"
          hint="Encrypted. Composed into the epoch's aggregate minimum without ever being revealed."
        />

        <button
          type="button"
          className="btn btn-tangerine mt-6 w-full"
          disabled={!ready}
          onClick={() => {
            submission.run({ side, amount, limit });
          }}
        >
          {submission.busy
            ? submission.stage
            : submission.done
              ? "Submit another order"
              : ready
                ? "Encrypt and submit"
                : "Enter an amount and a limit"}
        </button>

        {submission.done && (
          <p className="mt-4 rounded-[20px] bg-[#e0f5e9] p-4 text-body font-bold text-[#1f6640]">
            Order submitted and activated. Whether it locked anything is encrypted — an
            underfunded order and a genuine zero are indistinguishable by design, including to you.
          </p>
        )}

        {submission.steps.length > 0 && (
          <ol className="mt-4 flex flex-col gap-2">
            {submission.steps.map((step) => (
              <li key={step.label} className="flex items-start gap-2 text-caption">
                <span aria-hidden="true">{step.done ? "✓" : step.active ? "•" : "·"}</span>
                <span className={step.done ? "text-stone" : "font-bold"}>
                  {step.label}
                  {step.hash !== undefined && (
                    <>
                      {" "}
                      <a
                        href={explorerUrl(step.hash, "tx")}
                        target="_blank"
                        rel="noreferrer"
                        className="font-bold text-[#5c3fa8] underline-offset-4 hover:underline"
                      >
                        Etherscan
                      </a>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}

        {submission.error !== undefined && (
          <p className="mt-3 rounded-[20px] bg-[#fff0e0] p-4 text-caption text-[#9c5500]">
            {submission.error}
          </p>
        )}

        <p className="mt-3 text-caption text-stone">
          Submitting requires a Safe owner signature over the intent digest. The commitment is
          recomputed from your plaintext before you sign, so the interface cannot show you one order
          and submit another.
        </p>
      </Card>

      <div className="flex flex-col gap-4">
        <Card tone="cloud">
          <p className="type-subheading">What becomes public</p>
          <ul className="mt-3 flex flex-col gap-2.5">
            <PublicItem>That your Safe submitted an order</PublicItem>
            <PublicItem>The pair, USDC and WETH</PublicItem>
            <PublicItem>The expiry you set</PublicItem>
            <PublicItem>The epoch it joins</PublicItem>
          </ul>
          <p className="mt-4 text-caption font-bold uppercase tracking-wider text-[#5c3fa8]">
            Stays confidential
          </p>
          <ul className="mt-2 flex flex-col gap-2.5">
            <PrivateItem>Which side you took</PrivateItem>
            <PrivateItem>The amount</PrivateItem>
            <PrivateItem>Your limit price</PrivateItem>
            <PrivateItem>Whether it crossed, partly crossed, or held</PrivateItem>
          </ul>
        </Card>

        <Note title="Your limit is never compared against a public price">
          The epoch composes an aggregate minimum from every surviving private limit, and the
          strictest one sets it. A settlement that would breach any participant's limit fails for
          everybody rather than filling some of you below your terms.
        </Note>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint: string;
}) {
  return (
    <label className="mt-5 block">
      <span className="text-caption font-bold uppercase tracking-wider text-stone">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder={placeholder}
        className="mt-2 w-full rounded-[24px] bg-cloud px-5 py-4 text-body-lg font-bold text-ink outline-none placeholder:text-pebble"
      />
      <span className="mt-1.5 block text-caption text-stone">{hint}</span>
    </label>
  );
}

function PublicItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-body">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[#3d7ab8]" aria-hidden="true" />
      {children}
    </li>
  );
}

function PrivateItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-body text-stone">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[#7c5cbf]" aria-hidden="true" />
      {children}
    </li>
  );
}
