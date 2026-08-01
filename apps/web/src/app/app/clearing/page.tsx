"use client";

import { Note, PageHeader } from "@/components/app-shell";
import { Card, Empty, Pill } from "@/components/primitives";
import { ROUTE } from "@/lib/deployment";
import { usePrivacyFloors } from "@/lib/hooks";

const STAGES = [
  { name: "Open", body: "The epoch accepts candidates. Orders join by being authorised." },
  { name: "Sealed", body: "The candidate set is fixed and sorted. No order can be added or moved." },
  { name: "Price fixed", body: "A TWAP snapshot is captured from the pool, with its block and cardinality recorded." },
  { name: "Computing", body: "Locking, gating, crossing and residual accumulation, all inside Nox." },
  { name: "Residual ready", body: "The floors are met and the published handles are committed." },
  { name: "Settling", body: "The aggregate reaches a reviewed adapter, then allocations reconcile." },
  { name: "Settled", body: "Every candidate holds an encrypted outcome only its Safe can read." },
] as const;

export default function ClearingPage() {
  const floors = usePrivacyFloors();

  return (
    <>
      <PageHeader
        title="Epochs"
        description="Clearing runs in epochs rather than continuously, because a continuous match is a stream of observable events and a batch is one."
        badge={<Pill tone="public">Public</Pill>}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <Empty title="No epochs yet">
            An epoch opens when orders exist to clear. This deployment has none, because it was
            published with nothing in it. Epochs will appear here as they open, seal and settle.
          </Empty>
        </Card>

        <Card tone="cloud">
          <p className="type-subheading">Floors</p>
          <p className="mt-1 text-body text-stone">
            Read from the deployed engine, not repeated here.
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <FloorRow
              label="Epoch"
              value={floors.epoch.data}
              body="Participants before the epoch may publish anything at all"
            />
            <FloorRow
              label="Residual"
              value={floors.residual.data}
              body="Contributors before an unmatched remainder may reach Uniswap"
            />
            <FloorRow
              label="Supply"
              value={floors.residual.data}
              body="Contributors before an aggregate may reach the pooled Aave position"
            />
          </div>
          <p className="mt-4 text-caption text-stone">
            The residual and supply floors are counted separately. Sharing one would let a
            two-contributor swap authorise a one-contributor supply.
          </p>
        </Card>
      </div>

      <Card className="mt-4">
        <p className="type-subheading">What an epoch does</p>
        <ol className="mt-4 flex flex-col gap-3">
          {STAGES.map((stage, index) => (
            <li key={stage.name} className="flex gap-3">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-cloud text-caption font-black">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-body font-bold">{stage.name}</p>
                <p className="text-caption text-stone">{stage.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Note title="Why the price is time-weighted rather than spot">
        Internal crossing moves value between treasuries at a price nobody outside can see. A wrong
        price is still confidential, it just moves the wrong amount from a Safe that cannot tell to a
        Safe that cannot tell either. So the reference is a {ROUTE.twapWindow / 60} minute mean with
        a {ROUTE.maxTickDeviation} tick deviation bound, checked for staleness at settlement rather
        than at capture.
      </Note>
    </>
  );
}

function FloorRow({
  label,
  value,
  body,
}: {
  label: string;
  value: unknown;
  body: string;
}) {
  return (
    <div className="rounded-[20px] bg-white p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-body font-bold">{label}</span>
        <span className="font-display text-subheading font-black">
          {value === undefined ? "…" : `k = ${String(value)}`}
        </span>
      </div>
      <p className="mt-1 text-caption text-stone">{body}</p>
    </div>
  );
}
