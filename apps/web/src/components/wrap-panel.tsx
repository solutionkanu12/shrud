"use client";

import { useEffect, useState } from "react";
import { type Address, formatUnits, parseUnits } from "viem";
import {
  useReadContract,
  useSignTypedData,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { CHAIN_ID, explorerUrl } from "@/lib/deployment";
import {
  explainWriteError,
  safeModuleAbi,
  SHIELD_TYPES,
  shieldDomain,
  WRAPPABLE,
} from "@/lib/onboarding";

/** Only the one ERC-20 getter this needs, to keep a full ABI out of the bundle. */
const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Wrapping, through the module's `shield` rather than the wrapper directly.
 *
 * `shield` verifies an EIP-712 authorisation and then makes the SAFE approve, wrap and set the
 * operator in one transaction. Calling the wrapper directly would wrap to whoever sent the
 * transaction, which is the connected wallet and not the treasury.
 */
export function WrapPanel({
  safe,
  module,
  safeNonce,
  canSign,
  onDone,
}: {
  safe: Address;
  module: Address;
  safeNonce: bigint;
  canSign: boolean;
  onDone: () => void;
}) {
  const [token, setToken] = useState<(typeof WRAPPABLE)[number]>(WRAPPABLE[0]);
  const [amount, setAmount] = useState("");
  const [failure, setFailure] = useState<string | undefined>();

  const { signTypedDataAsync, isPending: signing } = useSignTypedData();
  const { data: hash, writeContractAsync, isPending: sending } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  const balance = useReadContract({
    address: token.address,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [safe],
    chainId: CHAIN_ID,
  });

  useEffect(() => {
    if (receipt.isSuccess) {
      onDone();
      void balance.refetch();
    }
  }, [receipt.isSuccess, onDone, balance.refetch]);

  const held = balance.data as bigint | undefined;
  let units: bigint | undefined;
  try {
    units = amount === "" ? undefined : parseUnits(amount, token.decimals);
  } catch {
    units = undefined;
  }
  const overBalance = units !== undefined && held !== undefined && units > held;
  const busy = signing || sending || receipt.isLoading;

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {WRAPPABLE.map((option) => (
          <button
            key={option.symbol}
            type="button"
            onClick={() => {
              setToken(option);
              setAmount("");
            }}
            aria-pressed={token.symbol === option.symbol}
            className={`rounded-[40px] px-4 py-2.5 text-body font-bold transition-colors ${
              token.symbol === option.symbol
                ? "bg-ink text-white"
                : "bg-cloud text-ink hover:bg-mist/40"
            }`}
          >
            {option.symbol}
          </button>
        ))}
      </div>

      <p className="text-caption text-stone">
        Safe holds{" "}
        {held === undefined ? "…" : `${formatUnits(held, token.decimals)} ${token.symbol}`}. This is
        the plaintext balance, and it is public.
      </p>

      <div className="flex flex-wrap gap-2">
        <input
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value.trim());
            setFailure(undefined);
          }}
          inputMode="decimal"
          placeholder={`Amount in ${token.symbol}`}
          className="min-w-0 flex-1 rounded-[20px] bg-cloud px-4 py-3 font-mono text-caption outline-none focus:ring-2 focus:ring-[#5c3fa8]"
        />
        <button
          type="button"
          className="btn btn-tangerine text-[0.9rem]"
          disabled={busy || !canSign || units === undefined || units === 0n || overBalance}
          onClick={() => {
            void (async () => {
              setFailure(undefined);
              try {
                if (units === undefined) return;
                // Thirty days. The operator grant is what lets the module move the wrapped balance
                // into a clearing epoch later; without it, wrapping produces a balance nothing can use.
                // uint48, which viem represents as a number rather than a bigint.
                const operatorUntil = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

                const signature = await signTypedDataAsync({
                  domain: shieldDomain(module),
                  types: SHIELD_TYPES,
                  primaryType: "ShrudShield",
                  message: {
                    safe,
                    underlying: token.address,
                    amount: units,
                    operatorUntil,
                    safeNonce,
                  },
                });

                await writeContractAsync({
                  address: module,
                  abi: safeModuleAbi,
                  functionName: "shield",
                  args: [token.address, units, operatorUntil, signature],
                });
              } catch (caught) {
                setFailure(explainWriteError(caught));
              }
            })();
          }}
        >
          {signing ? "Sign in wallet…" : busy ? "Wrapping…" : "Sign and wrap"}
        </button>
      </div>

      {overBalance && (
        <p className="text-caption text-[#9c5500]">
          The Safe does not hold that much {token.symbol}. Fund it from the Aave faucet first.
        </p>
      )}

      {!canSign && (
        <p className="text-caption text-[#9c5500]">
          Wrapping needs an owner signature this page cannot collect for a multi-signature Safe.
        </p>
      )}

      {hash !== undefined && (
        <p className="text-caption text-stone">
          {receipt.isLoading ? "Waiting for confirmation… " : "Wrapped. The balance is a handle now. "}
          <a
            href={explorerUrl(hash, "tx")}
            target="_blank"
            rel="noreferrer"
            className="font-bold text-[#5c3fa8] underline-offset-4 hover:underline"
          >
            View on Etherscan
          </a>
        </p>
      )}

      {failure !== undefined && (
        <p className="rounded-[20px] bg-[#fff0e0] p-4 text-caption text-[#9c5500]">{failure}</p>
      )}
    </div>
  );
}
