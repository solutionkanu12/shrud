"use client";

import Link from "next/link";
import { zeroAddress } from "viem";

import { Note, PageHeader, RequiresConnection } from "@/components/app-shell";
import { AddressLink, Card, Empty, Pill } from "@/components/primitives";
import { WrapPanel } from "@/components/wrap-panel";
import { useActiveSafe } from "@/lib/active-safe";
import { contractAddress, EXTERNAL } from "@/lib/deployment";
import { useModuleOf } from "@/lib/hooks";
import { useSafeStatus } from "@/lib/onboarding";

export default function VaultPage() {
  // The Safe, not the connected wallet. `moduleOf` is keyed by Safe, so passing an EOA here asks a
  // question whose answer is always "no module" — which is what this page used to do.
  const { safe } = useActiveSafe();
  const module = useModuleOf(safe);
  const status = useSafeStatus(safe ?? "");

  const installed = module.data !== undefined && module.data !== zeroAddress;

  return (
    <>
      <PageHeader
        title="Vault"
        description="Wrap plaintext tokens into confidential ones. A wrapped balance is a Nox handle, decryptable only by this Safe's owners."
        badge={<Pill tone="confidential">Confidential</Pill>}
      />

      <RequiresConnection>
        {safe === undefined ? (
          <Empty
            title="No treasury selected"
            action={
              <Link href="/app/onboard" className="btn btn-tangerine">
                Connect a Safe
              </Link>
            }
          >
            shrud operates on a Safe, not on a plain wallet. Name the Safe you control and this page
            will read its balances.
          </Empty>
        ) : !installed ? (
          <Empty
            title="This Safe has no shrud module"
            action={
              <Link href="/app/onboard" className="btn btn-tangerine">
                Install the module
              </Link>
            }
          >
            Wrapping goes through the module, so it has to be deployed, enabled and guarded first.
          </Empty>
        ) : (
          <>
            <Card>
              <div className="flex items-baseline justify-between gap-2">
                <p className="type-subheading">Wrap into a confidential balance</p>
                <AddressLink address={safe} />
              </div>
              <p className="mt-1 text-body text-stone">
                The deposit is public and the wrapper's backing is visible. Who holds how much of it
                is not.
              </p>

              <WrapPanel
                safe={safe}
                module={module.data as `0x${string}`}
                safeNonce={status.data?.scan.nonce ?? 0n}
                canSign={status.data !== undefined && status.data.scan.threshold === 1n}
                onDone={() => {
                  void status.refetch();
                }}
              />
            </Card>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <WrapperCard
                symbol="USDC"
                wrapped="cUSDC"
                underlying={EXTERNAL["usdc"] as `0x${string}`}
                wrapper={contractAddress("ShrudWrappedUSDC")}
              />
              <WrapperCard
                symbol="WETH"
                wrapped="cWETH"
                underlying={EXTERNAL["weth"] as `0x${string}`}
                wrapper={contractAddress("ShrudWrappedWETH")}
              />
            </div>

            <Note title="Unwrapping is two steps, and the delay is the mechanism">
              A confidential balance cannot be checked by reading it, so an unwrap requests a
              decryption first and completes only once the gateway has served a proof for that exact
              handle. Collapsing it into one call would mean trusting the caller's claim about how
              much they hold. That round trip is not built in this interface yet, which is why there
              is no unwrap button above rather than one that does nothing.
            </Note>
          </>
        )}
      </RequiresConnection>
    </>
  );
}

function WrapperCard({
  symbol,
  wrapped,
  underlying,
  wrapper,
}: {
  symbol: string;
  wrapped: string;
  underlying: `0x${string}`;
  wrapper: `0x${string}`;
}) {
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <p className="type-subheading">{wrapped}</p>
        <span className="text-caption text-stone">wraps {symbol}</span>
      </div>

      <dl className="mt-4 flex flex-col gap-2 border-t border-cloud pt-4">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-caption text-stone">Underlying</dt>
          <dd>
            <AddressLink address={underlying} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-caption text-stone">Wrapper</dt>
          <dd>
            <AddressLink address={wrapper} />
          </dd>
        </div>
      </dl>
    </Card>
  );
}
