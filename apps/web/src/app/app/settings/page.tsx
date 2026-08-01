"use client";

import { PageHeader, RequiresConnection } from "@/components/app-shell";
import { AddressLink, Card } from "@/components/primitives";
import {
  CHAIN_ID,
  CONTRACTS,
  DEPLOYED_AT,
  DEPLOYER,
  GOVERNANCE_DELAY_SECONDS,
  IS_SEEDED,
  TOTAL_CONTRACTS,
} from "@/lib/deployment";
import { REOWN_CONFIGURED } from "@/lib/wagmi";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="What this build is connected to. Every value comes from the deployment manifest compiled into the page."
      />

      <RequiresConnection>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <p className="type-subheading">Deployment</p>
            <dl className="mt-4 flex flex-col gap-3">
              <Row label="Chain" value={`Ethereum Sepolia (${CHAIN_ID})`} />
              <Row label="Deployed" value={new Date(DEPLOYED_AT).toISOString().slice(0, 10)} />
              <Row label="Contracts" value={String(TOTAL_CONTRACTS)} />
              <Row
                label="Governance delay"
                value={`${GOVERNANCE_DELAY_SECONDS / 60} minutes`}
              />
              <Row label="Seeded" value={IS_SEEDED ? "yes" : "no, deliberately"} />
              <div className="flex items-center justify-between gap-2">
                <dt className="text-caption font-bold uppercase tracking-wider text-stone">
                  Deployer
                </dt>
                <dd>
                  <AddressLink address={DEPLOYER} />
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-caption text-stone">
              The deployer is the governor of the registries and cannot write intents. Chain id 1
              would enforce a seven day minimum delay on chain regardless of the value above.
            </p>
          </Card>

          <Card>
            <p className="type-subheading">This build</p>
            <dl className="mt-4 flex flex-col gap-3">
              <Row
                label="Wallet relay"
                value={REOWN_CONFIGURED ? "Reown configured" : "not configured"}
              />
              <Row label="Reads" value="Public Sepolia RPC" />
              <Row label="Writes" value="Your wallet only" />
            </dl>
            <p className="mt-4 text-caption text-stone">
              This application holds no keys and signs nothing. Every transaction is signed by your
              wallet, and every read is a public call anyone can repeat.
            </p>
          </Card>
        </div>

        <Card tone="cloud" className="mt-4">
          <p className="type-subheading">Every deployed contract</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {Object.entries(CONTRACTS).map(([name, entry]) => (
              <div
                key={name}
                className="flex items-center justify-between gap-3 rounded-[20px] bg-white px-4 py-3"
              >
                <span className="truncate text-body font-semibold">{name}</span>
                <AddressLink address={entry.address} />
              </div>
            ))}
          </div>
        </Card>
      </RequiresConnection>
    </>
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
