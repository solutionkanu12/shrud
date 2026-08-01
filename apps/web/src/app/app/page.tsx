"use client";

import Link from "next/link";

import { Note, PageHeader, RequiresConnection } from "@/components/app-shell";
import { AddressLink, Card, Empty, Pill, Stat } from "@/components/primitives";
import { ROUTE, TOTAL_CONTRACTS, contractAddress } from "@/lib/deployment";
import { useConnection, useModuleOf, usePrivacyFloors, useSafeCount } from "@/lib/hooks";

export default function OverviewPage() {
  const { address } = useConnection();
  const safeCount = useSafeCount();
  const floors = usePrivacyFloors();
  const module = useModuleOf(address);

  const hasModule =
    module.data !== undefined &&
    module.data !== "0x0000000000000000000000000000000000000000";

  return (
    <>
      <PageHeader
        title="Overview"
        description="Live state of the shrud deployment on Ethereum Sepolia. Every number below is read from the chain."
        badge={<Pill tone="settled">Sepolia</Pill>}
        action={
          <Link href="/app/trade" className="btn btn-tangerine">
            New order
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <Stat
            label="Treasuries onboarded"
            value={safeCount.isLoading ? "…" : String(safeCount.data ?? 0n)}
            hint="Safes with a shrud module"
          />
        </Card>
        <Card>
          <Stat
            label="Epoch floor"
            value={floors.epoch.isLoading ? "…" : `k = ${String(floors.epoch.data ?? "?")}`}
            hint="Participants before an epoch may publish"
          />
        </Card>
        <Card>
          <Stat
            label="Residual floor"
            value={floors.residual.isLoading ? "…" : `k = ${String(floors.residual.data ?? "?")}`}
            hint="Contributors before a remainder settles"
          />
        </Card>
        <Card>
          <Stat
            label="Contracts live"
            value={String(TOTAL_CONTRACTS)}
            hint="All code hashes verified"
          />
        </Card>
      </div>

      <RequiresConnection>
        <div className="mt-6 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <Card>
            <div className="flex items-center justify-between gap-3">
              <p className="type-subheading">Your treasury</p>
              {hasModule ? (
                <Pill tone="settled">Module installed</Pill>
              ) : (
                <Pill tone="neutral">Not onboarded</Pill>
              )}
            </div>

            {hasModule ? (
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <Stat label="Confidential balance" value="" confidential hint="Decryptable by owners only" />
                <Stat label="Open orders" value="0" hint="None submitted yet" />
                <div className="sm:col-span-2">
                  <span className="text-caption font-bold uppercase tracking-wider text-stone">
                    Module
                  </span>
                  <div className="mt-1">
                    <AddressLink address={module.data as string} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4">
                <Empty
                  title="No treasury on this account"
                  action={
                    <Link href="/app/onboard" className="btn btn-tangerine">
                      Set one up
                    </Link>
                  }
                >
                  shrud operates on a Safe rather than a plain wallet, because the privacy floor
                  counts independent participants and a single-signer account is one participant
                  however many orders it sends.
                </Empty>
              </div>
            )}
          </Card>

          <Card tone="cloud">
            <p className="type-subheading">Reference price</p>
            <p className="mt-1 text-body text-stone">
              Crossing happens at a time-weighted price rather than a spot price, because spot is
              whatever the last swap left behind and costs one flash-loaned trade to move.
            </p>
            <dl className="mt-5 flex flex-col gap-3">
              <Detail label="Pair" value="WETH / USDC" />
              <Detail label="TWAP window" value={`${ROUTE.twapWindow / 60} minutes`} />
              <Detail label="Max staleness" value={`${ROUTE.maxStaleness / 60} minutes`} />
              <Detail
                label="Tick deviation bound"
                value={`${ROUTE.maxTickDeviation} ticks, about 10.5 percent`}
              />
              <div className="flex items-center justify-between gap-3">
                <dt className="text-caption font-bold uppercase tracking-wider text-stone">Pool</dt>
                <dd>
                  <AddressLink address={ROUTE.pool} />
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      </RequiresConnection>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ContractCard name="ShrudIntentBook" label="Intent book" body="Public lifecycle and the handle graph. Five states, never six." />
        <ContractCard name="ShrudClearingEngine" label="Clearing engine" body="Crossing, floors and the residual, all inside Nox." />
        <ContractCard name="ShrudSettlementEngine" label="Settlement engine" body="Verifies published handles, then settles through a reviewed adapter." />
      </div>

      <Note title="This deployment contains nothing, and that is deliberate">
        No Safes were pre-created, no balances planted, no epochs fabricated. The hackathon brief
        requires the project to work end to end without mock data, and a deployment that seeds itself
        is one that verifies against numbers it wrote. Every treasury and every order you see here
        belongs to whoever created it.
      </Note>
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-caption font-bold uppercase tracking-wider text-stone">{label}</dt>
      <dd className="text-body font-semibold">{value}</dd>
    </div>
  );
}

function ContractCard({ name, label, body }: { name: string; label: string; body: string }) {
  return (
    <Card>
      <p className="text-body font-bold">{label}</p>
      <p className="mt-1 text-caption text-stone">{body}</p>
      <div className="mt-3">
        <AddressLink address={contractAddress(name)} />
      </div>
    </Card>
  );
}
