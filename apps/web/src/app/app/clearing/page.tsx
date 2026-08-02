"use client";

import { useQuery } from "@tanstack/react-query";
import { type Address, type Hex } from "viem";
import { usePublicClient } from "wagmi";

import { Note, PageHeader } from "@/components/app-shell";
import { Card, Empty, Pill } from "@/components/primitives";
import { useActiveSafe } from "@/lib/active-safe";
import { CHAIN_ID, contractAddress, ROUTE } from "@/lib/deployment";
import { usePrivacyFloors } from "@/lib/hooks";
import { intentBookAbi } from "@/lib/orders";

/** `ShrudIntentBook.EpochStatus`. */
const EPOCH_STATUS = [
  "None", "Open", "Sealed", "Price fixed", "Computing",
  "Residual ready", "No public residual", "Settling", "Settled", "Timed out", "Recoverable",
] as const;

interface EpochRecord {
  readonly status: number;
  readonly candidateCount: number;
  readonly sealedAtBlock: bigint;
  readonly settledAtBlock: bigint;
  readonly priceSnapshotId: Hex;
  readonly referencePrice: bigint;
}

/**
 * The epochs THIS treasury is in, found through its own orders.
 *
 * There is no enumeration of epochs on chain and no `currentEpoch()` getter, and scanning
 * `EpochOpened` logs is not viable from a browser on a rate-limited RPC — the provider caps
 * `eth_getLogs` to a handful of blocks. Every order header carries its `epochId`, so the treasury's
 * own orders name exactly the epochs worth showing it, and nothing else.
 */
function useEpochs(safe: Address | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });

  return useQuery<{ id: Hex; record: EpochRecord }[]>({
    queryKey: ["shrud", "epochs", safe],
    enabled: safe !== undefined && client !== undefined,
    refetchInterval: 15_000,
    queryFn: async () => {
      const book = contractAddress("ShrudIntentBook");
      const ids = (await client!.readContract({
        address: book, abi: intentBookAbi, functionName: "intentsOfSafe", args: [safe as Address],
      })) as Hex[];

      const epochIds = new Set<Hex>();
      for (const id of ids) {
        const header = (await client!.readContract({
          address: book, abi: intentBookAbi, functionName: "headerOf", args: [id],
        })) as { epochId: Hex };
        epochIds.add(header.epochId);
      }

      const records = await Promise.all(
        [...epochIds].map(async (id) => ({
          id,
          record: (await client!.readContract({
            address: book, abi: intentBookAbi, functionName: "epochOf", args: [id],
          })) as EpochRecord,
        })),
      );
      return records.sort((a, b) => b.record.status - a.record.status);
    },
  });
}

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
  const { safe } = useActiveSafe();
  const epochs = useEpochs(safe);

  return (
    <>
      <PageHeader
        title="Epochs"
        description="Clearing runs in epochs rather than continuously, because a continuous match is a stream of observable events and a batch is one."
        badge={<Pill tone="public">Public</Pill>}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {epochs.data !== undefined && epochs.data.length > 0 ? (
          <div className="flex flex-col gap-3">
            {epochs.data.map(({ id, record }) => (
              <Card key={id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={record.status >= 5 ? "settled" : "public"}>
                    {EPOCH_STATUS[record.status] ?? record.status}
                  </Pill>
                  <Pill tone="neutral">
                    {record.candidateCount} candidate{record.candidateCount === 1 ? "" : "s"}
                  </Pill>
                  {record.candidateCount >= 3 && <Pill tone="settled">meets k = 3</Pill>}
                </div>

                <dl className="mt-4 flex flex-col gap-2">
                  <ERow label="Epoch" value={`${id.slice(0, 22)}…`} />
                  {record.referencePrice > 0n && (
                    <ERow label="Reference price" value={`${record.referencePrice} raw USDC per raw WETH x1e18`} />
                  )}
                  {record.sealedAtBlock > 0n && (
                    <ERow label="Sealed at block" value={record.sealedAtBlock.toString()} />
                  )}
                  {record.priceSnapshotId !== "0x0000000000000000000000000000000000000000000000000000000000000000" && (
                    <ERow label="Price snapshot" value={`${record.priceSnapshotId.slice(0, 22)}…`} />
                  )}
                </dl>

                <p className="mt-3 text-caption text-stone">
                  The direction, the aggregate and whether the floors passed are all still handles on
                  chain. This epoch completed and published nothing anyone can decompose.
                </p>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <Empty title={epochs.isLoading ? "Reading the intent book…" : "No epochs yet"}>
              {safe === undefined
                ? "Connect a Safe and the epochs its orders joined will appear here."
                : "An epoch opens when orders exist to clear. Epochs this treasury has joined appear here as they open, seal and settle."}
            </Empty>
          </Card>
        )}

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

function ERow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-caption text-stone">{label}</dt>
      <dd className="truncate font-mono text-caption">{value}</dd>
    </div>
  );
}
