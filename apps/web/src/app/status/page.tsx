"use client";

import { MarketingPage } from "@/components/marketing-page";
import { Card, Pill } from "@/components/primitives";
import { DEPLOYED_AT, GOVERNANCE_DELAY_SECONDS, TOTAL_CONTRACTS } from "@/lib/deployment";
import { usePrivacyFloors, useSafeCount } from "@/lib/hooks";

export default function StatusPage() {
  const safeCount = useSafeCount();
  const floors = usePrivacyFloors();

  const chainReachable = !safeCount.isError && !floors.epoch.isError;
  const loading = safeCount.isLoading || floors.epoch.isLoading;

  return (
    <MarketingPage
      eyebrow="Status"
      title="What is up, checked live."
      lead="Each row is a real read against Sepolia performed by your browser as this page loaded."
    >
      <Card>
        <div className="flex flex-col">
          <StatusRow
            name="Sepolia RPC"
            ok={chainReachable}
            loading={loading}
            detail="Public endpoint, read only"
          />
          <StatusRow
            name="Intent book"
            ok={chainReachable}
            loading={loading}
            detail="Responding to calls"
          />
          <StatusRow
            name="Clearing engine"
            ok={!floors.epoch.isError}
            loading={floors.epoch.isLoading}
            detail={
              floors.epoch.data === undefined
                ? "Reading privacy floors"
                : `Epoch floor k = ${String(floors.epoch.data)}`
            }
          />
          <StatusRow
            name="Module factory"
            ok={!safeCount.isError}
            loading={safeCount.isLoading}
            detail={
              safeCount.data === undefined
                ? "Reading treasury count"
                : `${String(safeCount.data)} treasuries onboarded`
            }
          />
        </div>
      </Card>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Card tone="cloud">
          <p className="text-caption font-bold uppercase tracking-wider text-stone">Deployed</p>
          <p className="type-subheading mt-1">
            {new Date(DEPLOYED_AT).toISOString().slice(0, 10)}
          </p>
        </Card>
        <Card tone="cloud">
          <p className="text-caption font-bold uppercase tracking-wider text-stone">Contracts</p>
          <p className="type-subheading mt-1">{TOTAL_CONTRACTS}</p>
        </Card>
        <Card tone="cloud">
          <p className="text-caption font-bold uppercase tracking-wider text-stone">
            Governance delay
          </p>
          <p className="type-subheading mt-1">{GOVERNANCE_DELAY_SECONDS / 60} min</p>
        </Card>
      </div>

      <Card className="mt-4">
        <div className="flex items-start gap-3">
          <Pill tone="warn">Note</Pill>
          <p className="text-body text-stone">
            This page reports whether the contracts respond, which is a different question from
            whether a clearing epoch would succeed. An epoch needs three participating treasuries,
            and this deployment currently has{" "}
            <strong className="text-ink">{String(safeCount.data ?? 0n)}</strong>.
          </p>
        </div>
      </Card>
    </MarketingPage>
  );
}

function StatusRow({
  name,
  ok,
  loading,
  detail,
}: {
  name: string;
  ok: boolean;
  loading: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-cloud py-4 first:border-t-0">
      <span
        className={`size-3 shrink-0 rounded-full ${
          loading ? "animate-pulse bg-mist" : ok ? "bg-[#2d7a4d]" : "bg-[#c0392b]"
        }`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-body font-bold">{name}</p>
        <p className="text-caption text-stone">{detail}</p>
      </div>
      <span className="text-caption font-bold text-stone">
        {loading ? "checking" : ok ? "operational" : "unreachable"}
      </span>
    </div>
  );
}
