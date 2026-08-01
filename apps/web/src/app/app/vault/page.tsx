"use client";

import { ConfidentialValue, Note, PageHeader, RequiresConnection, RequiresSafe } from "@/components/app-shell";
import { AddressLink, Card, Pill, Stat } from "@/components/primitives";
import { EXTERNAL, contractAddress } from "@/lib/deployment";
import { useConnection, useModuleOf } from "@/lib/hooks";

export default function VaultPage() {
  const { address } = useConnection();
  const module = useModuleOf(address);
  const hasModule =
    module.data !== undefined && module.data !== "0x0000000000000000000000000000000000000000";

  return (
    <>
      <PageHeader
        title="Vault"
        description="Wrap plaintext tokens into confidential ones. A wrapped balance is a Nox handle, decryptable only by this Safe's owners."
        badge={<Pill tone="confidential">Confidential</Pill>}
      />

      <RequiresConnection>
        {hasModule ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <AssetCard
                symbol="USDC"
                wrapped="cUSDC"
                underlying={EXTERNAL["usdc"]!}
                wrapper={contractAddress("ShrudWrappedUSDC")}
              />
              <AssetCard
                symbol="WETH"
                wrapped="cWETH"
                underlying={EXTERNAL["weth"]!}
                wrapper={contractAddress("ShrudWrappedWETH")}
              />
            </div>

            <Note title="Unwrapping is two steps, and the delay is the mechanism">
              A confidential balance cannot be checked by reading it, so an unwrap requests a
              decryption first and completes only once the gateway has served a proof for that exact
              handle. Collapsing it into one call would mean trusting the caller's claim about how
              much they hold.
            </Note>
          </>
        ) : (
          <RequiresSafe />
        )}
      </RequiresConnection>
    </>
  );
}

function AssetCard({
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

      <div className="mt-5 grid grid-cols-2 gap-4">
        <div>
          <span className="text-caption font-bold uppercase tracking-wider text-stone">
            Your balance
          </span>
          <div className="mt-1">
            <ConfidentialValue note="Owners only" />
          </div>
        </div>
        <Stat label="Wrapper supply" value="" confidential hint="Also a handle" />
      </div>

      <div className="mt-5 flex gap-2">
        <button type="button" className="btn btn-tangerine flex-1 text-[0.9rem]">
          Wrap
        </button>
        <button type="button" className="btn btn-quiet flex-1 text-[0.9rem]">
          Unwrap
        </button>
      </div>

      <dl className="mt-5 flex flex-col gap-2 border-t border-cloud pt-4">
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
