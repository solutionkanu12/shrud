"use client";

import { MarketingPage } from "@/components/marketing-page";
import { AddressLink, Card, Empty, Stat } from "@/components/primitives";
import { ROUTE, TOTAL_CONTRACTS } from "@/lib/deployment";
import { usePrivacyFloors, useSafeCount } from "@/lib/hooks";

export default function NetworkPage() {
  const safeCount = useSafeCount();
  const floors = usePrivacyFloors();

  return (
    <MarketingPage
      eyebrow="Network"
      title="Everything happening on shrud, publicly."
      lead="The aggregate view. Individual orders, sides and amounts are not here, because they are not anywhere."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <Stat
            label="Treasuries"
            value={safeCount.isLoading ? "…" : String(safeCount.data ?? 0n)}
            hint="Safes with a module"
          />
        </Card>
        <Card>
          <Stat label="Epochs settled" value="0" hint="None yet" />
        </Card>
        <Card>
          <Stat
            label="Epoch floor"
            value={floors.epoch.isLoading ? "…" : `k = ${String(floors.epoch.data ?? "?")}`}
            hint="Before anything publishes"
          />
        </Card>
        <Card>
          <Stat label="Contracts" value={String(TOTAL_CONTRACTS)} hint="All verified" />
        </Card>
      </div>

      <Card className="mt-4">
        <p className="type-subheading">Recent epochs</p>
        <div className="mt-4">
          <Empty title="No epochs yet">
            This deployment was published with nothing in it. Epochs appear here as they open, seal
            and settle, showing the pair, the candidate count and the aggregate that reached a public
            venue. Never who contributed what.
          </Empty>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card tone="cloud">
          <p className="type-subheading">Reference price route</p>
          <dl className="mt-4 flex flex-col gap-3">
            <Row label="Pair" value="WETH / USDC" />
            <Row label="TWAP window" value={`${ROUTE.twapWindow / 60} minutes`} />
            <Row label="Max staleness" value={`${ROUTE.maxStaleness / 60} minutes`} />
            <Row label="Tick bound" value={`${ROUTE.maxTickDeviation} ticks`} />
            <div className="flex items-center justify-between gap-2">
              <dt className="text-caption font-bold uppercase tracking-wider text-stone">Pool</dt>
              <dd>
                <AddressLink address={ROUTE.pool} />
              </dd>
            </div>
          </dl>
        </Card>

        <Card tone="cloud">
          <p className="type-subheading">What this page can never show</p>
          <ul className="mt-4 flex flex-col gap-2.5">
            {[
              "Which side any treasury took",
              "Any individual order amount",
              "Any private limit price",
              "Who crossed with whom",
              "Each treasury's share of an aggregate",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2 text-body text-stone">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[#7c5cbf]" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-caption text-stone">
            Not withheld by this interface. Not present in the chain data it reads.
          </p>
        </Card>
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
