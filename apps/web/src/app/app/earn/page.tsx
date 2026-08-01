"use client";

import { Note, PageHeader, RequiresConnection } from "@/components/app-shell";
import { AddressLink, Card, Pill, Stat } from "@/components/primitives";
import { ADAPTERS, EXTERNAL, contractAddress } from "@/lib/deployment";

export default function EarnPage() {
  const aave = ADAPTERS["AaveSupplyAdapter"];

  return (
    <>
      <PageHeader
        title="Earn"
        description="Idle confidential USDC can join a pooled Aave position. Your contribution stays encrypted; the pool's totals are public and reconcilable by anyone."
        badge={<Pill tone="confidential">Confidential contribution</Pill>}
      />

      <RequiresConnection>
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <Card>
            <div className="flex items-baseline justify-between gap-2">
              <p className="type-subheading">Aave v3 USDC</p>
              <Pill tone="settled">Registered</Pill>
            </div>
            <p className="mt-1 text-body text-stone">
              Supply is aggregated across every contributing treasury and sent as one transaction.
              Nobody learns who supplied what.
            </p>

            <div className="mt-6 grid grid-cols-2 gap-5">
              <Stat label="Your shares" value="" confidential hint="Owners only" />
              <Stat label="Pool principal" value="0" hint="No supply yet" />
              <Stat label="Pool shares" value="0" hint="Public by construction" />
              <Stat label="Shares per asset" value="—" hint="Set at the first supply" />
            </div>

            <div className="mt-6 flex gap-2">
              <button type="button" className="btn btn-tangerine flex-1 text-[0.9rem]" disabled>
                Supply
              </button>
              <button type="button" className="btn btn-quiet flex-1 text-[0.9rem]" disabled>
                Withdraw
              </button>
            </div>
            <p className="mt-3 text-caption text-stone">
              Supply joins the next epoch's aggregate. It settles only once the supply floor is met.
            </p>
          </Card>

          <div className="flex flex-col gap-4">
            <Card tone="cloud">
              <p className="type-subheading">How the ratio works</p>
              <p className="mt-2 text-body text-stone">
                Your shares are <strong className="text-ink">your contribution multiplied by a
                public ratio</strong>. One operand is confidential and one is public, which is the
                whole design: an auditor can reconcile the pool from two public numbers, and nobody
                learns whose contribution is whose.
              </p>
              <p className="mt-3 text-body text-stone">
                The ratio is read before the principal moves. Reading it afterwards would price this
                epoch's entrants at the position they had just enlarged.
              </p>
            </Card>

            <Card>
              <p className="text-body font-bold">Contracts</p>
              <dl className="mt-3 flex flex-col gap-2">
                <Row label="Position ledger" value={contractAddress("ShrudPositionLedger")} />
                {aave !== undefined && <Row label="Aave adapter" value={aave.address} />}
                <Row label="aUSDC" value={EXTERNAL["aUsdc"]!} />
              </dl>
            </Card>
          </div>
        </div>

        <Note title="Output is measured, never reported">
          Aave's `supply` returns nothing at all, and aTokens rebase. The only number available is
          the aToken balance delta at the position ledger, and it happens to be the right one anyway.
        </Note>
      </RequiresConnection>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-caption text-stone">{label}</dt>
      <dd>
        <AddressLink address={value} />
      </dd>
    </div>
  );
}
