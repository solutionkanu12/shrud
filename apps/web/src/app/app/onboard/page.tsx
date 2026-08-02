"use client";

import { useEffect, useState } from "react";
import { type Address, formatUnits, isAddress, parseUnits } from "viem";
import {
  useAccount,
  useReadContract,
  useSignTypedData,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { PageHeader, RequiresConnection } from "@/components/app-shell";
import { AddressLink, Card, Pill, RainbowMark } from "@/components/primitives";
import { CHAIN_ID, contractAddress, explorerUrl } from "@/lib/deployment";
import { moduleFactoryAbi } from "@/lib/hooks";
import {
  canSelfAuthorise,
  enableModuleCall,
  safeModuleAbi,
  safeSelfCall,
  setModuleGuardCall,
  SHIELD_TYPES,
  shieldDomain,
  useSafeStatus,
  WRAPPABLE,
} from "@/lib/onboarding";

/** Only the one ERC-20 getter this page needs, to keep a full ABI out of the bundle. */
const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const REASONING = {
  connect:
    "The version check reads the VERSION string rather than probing behaviour, because Safe 1.4.1 does not revert on setModuleGuard. It silently swallows the call and installs nothing, so a behavioural probe would report success on an account with no guard.",
  install:
    "The module is bound to your Safe as a constructor immutable. It can only ever write intents whose owner is this Safe, and the factory is the only contract permitted to authorise it with the intent book.",
  policy:
    "An order family says USDC and WETH, never which side. Reviewing at the family level means the policy is auditable by your signers without publishing what any individual order does.",
  wrap: "Wrapping is a real deposit into a real contract. The plaintext backing is publicly visible at the wrapper; who holds how much of it is not.",
} as const;

export default function OnboardPage() {
  const { address } = useAccount();
  const [input, setInput] = useState("");
  const [safe, setSafe] = useState("");

  const status = useSafeStatus(safe);
  const { data: hash, writeContract, isPending, error, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  // A confirmed transaction changes what the next step should offer, so the scan is re-read rather
  // than assumed. Assuming is how a flow shows "enable" after the enable already landed.
  useEffect(() => {
    if (receipt.isSuccess) {
      void status.refetch();
      reset();
    }
  }, [receipt.isSuccess, status.refetch, reset]);

  const scan = status.data?.scan;
  const busy = isPending || receipt.isLoading;
  const selfAuthorise = scan !== undefined && canSelfAuthorise(scan, address);

  return (
    <>
      <PageHeader
        title="Set up a treasury"
        description="Four steps. Nothing is custodial, nothing is migrated, and every step is a transaction you sign from your own Safe."
        badge={<Pill tone="neutral">One time</Pill>}
      />

      <RequiresConnection>
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col gap-3">
            {/* ── 1 ─────────────────────────────────────────────────────────────── */}
            <Step index={0} title="Connect a Safe" reasoning={REASONING.connect}>
              <p className="mt-1 text-body text-stone">
                shrud operates on a Safe rather than a plain wallet. Bring one you already control,
                or create one at app.safe.global first. Safe 1.5.0 is required.
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                <input
                  value={input}
                  onChange={(event) => {
                    setInput(event.target.value.trim());
                  }}
                  placeholder="0x… your Safe address on Sepolia"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-[20px] bg-cloud px-4 py-3 font-mono text-caption outline-none focus:ring-2 focus:ring-[#5c3fa8]"
                />
                <button
                  type="button"
                  className="btn btn-tangerine text-[0.9rem]"
                  disabled={!isAddress(input) || status.isFetching}
                  onClick={() => {
                    setSafe(input);
                  }}
                >
                  {status.isFetching ? "Reading…" : "Connect a Safe"}
                </button>
              </div>

              {input !== "" && !isAddress(input) && (
                <p className="mt-2 text-caption text-[#9c5500]">That is not a valid address.</p>
              )}

              {status.isError && (
                <p className="mt-3 rounded-[20px] bg-[#fff0e0] p-4 text-caption text-[#9c5500]">
                  Could not read that address as a Safe. It may be an EOA, or a contract that is not
                  a Safe, or not deployed on Sepolia.
                </p>
              )}

              {scan !== undefined && (
                <div className="mt-3 rounded-[20px] bg-cloud p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={scan.blockers.length === 0 ? "settled" : "warn"}>
                      Safe {scan.version}
                    </Pill>
                    <Pill tone="neutral">
                      {scan.owners.length} owner{scan.owners.length === 1 ? "" : "s"}, threshold{" "}
                      {scan.threshold.toString()}
                    </Pill>
                    {status.data?.fullyInstalled === true && <Pill tone="settled">Installed</Pill>}
                  </div>

                  {scan.blockers.map((blocker) => (
                    <p key={blocker} className="mt-3 text-caption text-[#9c5500]">
                      {blocker}
                    </p>
                  ))}

                  {scan.blockers.length === 0 && !selfAuthorise && (
                    <p className="mt-3 text-caption text-[#9c5500]">
                      This page can only authorise a Safe whose threshold is 1 and whose owner is the
                      connected wallet. Yours needs {scan.threshold.toString()} signature
                      {scan.threshold === 1n ? "" : "s"}, which have to be collected in the Safe app.
                    </p>
                  )}
                </div>
              )}
            </Step>

            {/* ── 2 ─────────────────────────────────────────────────────────────── */}
            <Step index={1} title="Install the module" reasoning={REASONING.install}>
              <p className="mt-1 text-body text-stone">
                Three transactions. The factory deploys the module and its guard; your Safe then
                enables each one. They stay inert until it does.
              </p>

              {status.data === undefined ? (
                <p className="mt-4 text-caption text-stone">Connect a Safe first.</p>
              ) : status.data.fullyInstalled ? (
                <div className="mt-4 rounded-[20px] bg-[#e0f5e9] p-4">
                  <p className="text-body font-bold text-[#1f6640]">
                    Module deployed, enabled and guarded.
                  </p>
                  <div className="mt-2 flex flex-col gap-1">
                    <AddressLink address={status.data.deployedModule} />
                    <AddressLink address={status.data.predicted.moduleGuard} />
                  </div>
                </div>
              ) : (
                <div className="mt-4 flex flex-col gap-2">
                  <Action
                    done={status.data.moduleDeployed}
                    label="Deploy the module"
                    note="Permissionless. Anyone may call this; it grants nothing on its own."
                    disabled={busy || scan === undefined || scan.blockers.length > 0}
                    onClick={() => {
                      writeContract({
                        address: contractAddress("ShrudModuleFactory"),
                        abi: moduleFactoryAbi,
                        functionName: "deployModule",
                        args: [safe as Address],
                      });
                    }}
                  />
                  <Action
                    done={scan?.moduleEnabled === true}
                    label="Enable it on your Safe"
                    note="A transaction from the Safe to itself, authorised by you as its owner."
                    disabled={busy || !status.data.moduleDeployed || !selfAuthorise}
                    onClick={() => {
                      if (address === undefined) return;
                      writeContract(
                        safeSelfCall(
                          safe as Address,
                          address,
                          enableModuleCall(status.data.predicted.module),
                        ),
                      );
                    }}
                  />
                  <Action
                    done={status.data.guardInstalled}
                    label="Set the module guard"
                    note="Without this the module would have unlimited authority over the Safe."
                    disabled={busy || scan?.moduleEnabled !== true || !selfAuthorise}
                    onClick={() => {
                      if (address === undefined) return;
                      writeContract(
                        safeSelfCall(
                          safe as Address,
                          address,
                          setModuleGuardCall(status.data.predicted.moduleGuard),
                        ),
                      );
                    }}
                  />
                </div>
              )}

              {hash !== undefined && (
                <p className="mt-3 text-caption text-stone">
                  {receipt.isLoading ? "Waiting for confirmation… " : "Confirmed. "}
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

              {error !== null && (
                <p className="mt-3 rounded-[20px] bg-[#fff0e0] p-4 text-caption text-[#9c5500]">
                  {error.message.split("\n")[0]}
                </p>
              )}
            </Step>

            {/* ── 3 and 4 ───────────────────────────────────────────────────────── */}
            <Step index={2} title="Your order policy" reasoning={REASONING.policy}>
              <p className="mt-1 text-body text-stone">
                Nothing to configure. This deployment recognises exactly one order family, and the
                module refuses every other one.
              </p>
              <div className="mt-4 rounded-[20px] bg-cloud p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone="public">USDC_WETH_ALLOCATION_V1</Pill>
                  <Pill tone="neutral">fixed at deployment</Pill>
                </div>
                <p className="mt-3 text-caption text-stone">
                  The family is a compile-time constant in ShrudOrderFamily, and there is no setter
                  anywhere in the contracts. An order naming any other family reverts with
                  UnknownOrderFamily. Presenting a policy editor here would imply a choice the chain
                  does not offer.
                </p>
              </div>
            </Step>

            <Step index={3} title="Wrap what you want to trade" reasoning={REASONING.wrap}>
              <p className="mt-1 text-body text-stone">
                Deposit USDC or WETH into their confidential wrappers. From that moment the balance
                is a Nox handle rather than a number.
              </p>

              {status.data?.fullyInstalled === true ? (
                <WrapPanel
                  safe={safe as Address}
                  module={status.data.deployedModule}
                  safeNonce={scan?.nonce ?? 0n}
                  canSign={selfAuthorise}
                  onDone={() => {
                    void status.refetch();
                  }}
                />
              ) : (
                <p className="mt-4 text-caption text-stone">
                  Locked until the module is installed, enabled and guarded.
                </p>
              )}
            </Step>
          </div>

          <div className="flex flex-col gap-4">
            <Card tone="cloud">
              <div className="flex items-center gap-2.5">
                <RainbowMark size={30} />
                <p className="type-subheading">Before you start</p>
              </div>
              <ul className="mt-4 flex flex-col gap-3">
                <Requirement
                  label="A Safe on Sepolia"
                  body="Version 1.5.0. Create one at app.safe.global if you do not have one."
                />
                <Requirement label="Sepolia ETH" body="For gas on each setup transaction." />
                <Requirement
                  label="Test USDC or WETH"
                  body="From the Aave faucet, or by wrapping Sepolia ETH."
                />
                <Requirement
                  label="Two other treasuries, eventually"
                  body="The epoch floor is three participants. A single Safe can submit orders, but an epoch will not clear until three have."
                />
              </ul>
            </Card>

            <Card>
              <p className="text-body font-bold">What you are installing</p>
              <dl className="mt-3 flex flex-col gap-2">
                <Row label="Module factory" address={contractAddress("ShrudModuleFactory")} />
                <Row label="Intent book" address={contractAddress("ShrudIntentBook")} />
                <Row label="Clearing vault" address={contractAddress("ShrudClearingVault")} />
                {status.data !== undefined && (
                  <>
                    <Row label="Your module" address={status.data.predicted.module} />
                    <Row label="Your guard" address={status.data.predicted.moduleGuard} />
                  </>
                )}
              </dl>
              <p className="mt-4 text-caption text-stone">
                Read the source before you sign. Every address above is verified on Etherscan and its
                runtime code hash is recorded in the deployment manifest.
              </p>
            </Card>
          </div>
        </div>
      </RequiresConnection>
    </>
  );
}

function Step({
  index,
  title,
  reasoning,
  children,
}: {
  index: number;
  title: string;
  reasoning: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(index === 0);

  return (
    <Card>
      <div className="flex items-start gap-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink font-display text-body font-black text-white">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="type-subheading">{title}</p>
          {children}

          <button
            type="button"
            onClick={() => {
              setOpen(!open);
            }}
            aria-expanded={open}
            className="mt-3 text-caption font-bold text-[#5c3fa8] underline-offset-4 hover:underline"
          >
            {open ? "Hide the reasoning" : "Why it works this way"}
          </button>

          {open && (
            <p className="mt-2 rounded-[20px] bg-cloud p-4 text-caption text-stone">{reasoning}</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function Action({
  done,
  label,
  note,
  disabled,
  onClick,
}: {
  done: boolean;
  label: string;
  note: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-[20px] bg-cloud px-4 py-3">
      <div className="min-w-0">
        <p className="text-body font-bold">{label}</p>
        <p className="text-caption text-stone">{note}</p>
      </div>
      {done ? (
        <Pill tone="settled">Done</Pill>
      ) : (
        <button
          type="button"
          className="btn btn-tangerine text-[0.9rem]"
          disabled={disabled}
          onClick={onClick}
        >
          Sign
        </button>
      )}
    </div>
  );
}

/**
 * Wrapping, through the module's `shield` rather than the wrapper directly.
 *
 * `shield` verifies an EIP-712 authorisation and then makes the SAFE approve, wrap and set the
 * operator in one transaction. Calling the wrapper directly would wrap to whoever sent the
 * transaction, which is the connected wallet and not the treasury.
 */
function WrapPanel({
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
                setFailure(
                  caught instanceof Error ? caught.message.split("\n")[0] : "The wrap failed.",
                );
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

function Row({ label, address }: { label: string; address: `0x${string}` }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-caption text-stone">{label}</dt>
      <dd>
        <AddressLink address={address} />
      </dd>
    </div>
  );
}

function Requirement({ label, body }: { label: string; body: string }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-tangerine" aria-hidden="true" />
      <div>
        <p className="text-body font-bold">{label}</p>
        <p className="text-caption text-stone">{body}</p>
      </div>
    </li>
  );
}
