"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { type Address, type Hex, zeroAddress } from "viem";
import { usePublicClient } from "wagmi";

import { ConfidentialValue, Note, PageHeader, RequiresConnection } from "@/components/app-shell";
import { Card, Empty, Pill } from "@/components/primitives";
import { useActiveSafe } from "@/lib/active-safe";
import { CHAIN_ID, contractAddress, explorerUrl } from "@/lib/deployment";
import { useModuleOf } from "@/lib/hooks";
import { intentBookAbi } from "@/lib/orders";

/** `ShrudIntentBook.IntentStatus`. Five reachable members, and Processed carries every outcome. */
const STATUS = ["None", "Submitted", "Authorised", "Processed", "Expired", "Cancelled"] as const;

interface Header {
  readonly safe: Address;
  readonly module: Address;
  readonly inputAsset: Address;
  readonly orderFamily: Hex;
  readonly epochId: Hex;
  readonly expiry: bigint;
  readonly nonce: bigint;
  readonly commitment: Hex;
  readonly createdAtBlock: bigint;
  readonly status: number;
}

/**
 * Every order this Safe has written, read from the intent book.
 *
 * This page previously rendered a fixed empty state whose own text said the list was read from the
 * chain. It was not read from anywhere. An interface that reports "nothing has been submitted" while
 * never asking is worse than one that reports an error, because it is confidently wrong.
 */
function useOrders(safe: Address | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });

  return useQuery<{ id: Hex; header: Header }[]>({
    queryKey: ["shrud", "orders", safe],
    enabled: safe !== undefined && client !== undefined,
    refetchInterval: 15_000,
    queryFn: async () => {
      const book = contractAddress("ShrudIntentBook");
      const ids = (await client!.readContract({
        address: book,
        abi: intentBookAbi,
        functionName: "intentsOfSafe",
        args: [safe as Address],
      })) as Hex[];

      const headers = await Promise.all(
        ids.map(async (id) => ({
          id,
          header: (await client!.readContract({
            address: book,
            abi: intentBookAbi,
            functionName: "headerOf",
            args: [id],
          })) as Header,
        })),
      );
      // Newest first: the order just submitted is the one being looked for.
      return headers.sort((a, b) => Number(b.header.createdAtBlock - a.header.createdAtBlock));
    },
  });
}

export default function OrdersPage() {
  // Keyed by Safe, not by the connected wallet. See the note on `useModuleOf`.
  const { safe } = useActiveSafe();
  const module = useModuleOf(safe);
  const hasModule = module.data !== undefined && module.data !== zeroAddress;
  const orders = useOrders(safe);

  return (
    <>
      <PageHeader
        title="Orders"
        description="Every order this treasury has submitted, with the public record on the left and what only you can read on the right."
        action={
          <Link href="/app/trade" className="btn btn-tangerine">
            New order
          </Link>
        }
      />

      <RequiresConnection>
        {!hasModule ? (
          <Empty
            title={safe === undefined ? "No treasury selected" : "This Safe has no shrud module"}
            action={
              <Link href="/app/onboard" className="btn btn-tangerine">
                {safe === undefined ? "Connect a Safe" : "Install the module"}
              </Link>
            }
          >
            Orders are written by the Safe's module, so there is nothing to list until one exists.
          </Empty>
        ) : orders.isLoading ? (
          <Card>
            <p className="text-body text-stone">Reading the intent book…</p>
          </Card>
        ) : orders.data === undefined || orders.data.length === 0 ? (
          <Card>
            <Empty title="No orders yet">
              Orders submitted by this treasury appear here. This list is read from the intent book on
              Sepolia, so it is empty because nothing has been submitted rather than because anything
              failed.
            </Empty>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {orders.data.map(({ id, header }) => (
              <Card key={id}>
                <div className="grid gap-5 sm:grid-cols-[1.3fr_1fr]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={header.status === 3 ? "settled" : "public"}>
                        {STATUS[header.status] ?? header.status}
                      </Pill>
                      <Pill tone="neutral">USDC / WETH</Pill>
                    </div>

                    <dl className="mt-4 flex flex-col gap-2">
                      <Row label="Expiry" value={new Date(Number(header.expiry) * 1000).toUTCString()} />
                      <Row label="Epoch" value={`${header.epochId.slice(0, 18)}…`} />
                      <Row label="Submitted at block" value={header.createdAtBlock.toString()} />
                      <Row label="Intent" value={`${id.slice(0, 18)}…`} />
                    </dl>

                    <p className="mt-3 text-caption text-stone">
                      That is the entire public record. Everything above is visible to anyone reading
                      the chain.
                    </p>
                    <a
                      href={explorerUrl(contractAddress("ShrudIntentBook"))}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-caption font-bold text-[#5c3fa8] underline-offset-4 hover:underline"
                    >
                      Read it on Etherscan
                    </a>
                  </div>

                  <div className="rounded-[20px] bg-cloud p-4">
                    <p className="text-caption font-bold uppercase tracking-wider text-stone">
                      Only you can read
                    </p>
                    <div className="mt-3 flex flex-col gap-3">
                      <Confidential label="Side" />
                      <Confidential label="Amount" />
                      <Confidential label="Private limit" />
                      <Confidential label="Outcome" />
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        <Note title="Five statuses, and one of them carries every outcome">
          An order ends at Processed whether it filled completely, failed its private limit, was
          underfunded, or simply held. A sixth status such as InsufficientBalance would turn repeated
          oversized orders into a binary search over your confidential balance, so it does not exist.
          Your real result is encrypted and readable only by this Safe&apos;s owners.
        </Note>
      </RequiresConnection>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-caption text-stone">{label}</dt>
      <dd className="truncate font-mono text-caption">{value}</dd>
    </div>
  );
}

function Confidential({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-caption text-stone">{label}</span>
      <ConfidentialValue />
    </div>
  );
}
