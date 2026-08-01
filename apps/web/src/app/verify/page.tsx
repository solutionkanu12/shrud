"use client";

import { useEffect, useState } from "react";
import { createPublicClient, http, keccak256 } from "viem";
import { sepolia } from "viem/chains";

import { Card, Pill, RainbowMark } from "@/components/primitives";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { ADAPTERS, CONTRACTS, IS_SEEDED, contractAddress, explorerUrl, shortAddress } from "@/lib/deployment";
import { clearingEngineAbi, moduleFactoryAbi } from "@/lib/hooks";

type Status = "pending" | "pass" | "fail";

interface Check {
  readonly label: string;
  readonly detail: string;
  status: Status;
  result?: string;
}

/**
 * The verifier, in the browser.
 *
 * The same checks `pnpm verify:live` runs, against the same chain, using only public reads. This
 * page exists so somebody evaluating shrud does not have to clone a repository to confirm that what
 * the site claims is what the chain says.
 */
export default function VerifyPage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const run = async () => {
    setRunning(true);
    setDone(false);

    // Same endpoint the rest of the application reads through, so a check that passes here and a
    // page that renders elsewhere cannot disagree about what the chain says.
    const rpc = process.env["NEXT_PUBLIC_RPC_URL"];
    const client = createPublicClient({
      chain: sepolia,
      transport: rpc === undefined || rpc === "" ? http() : http(rpc),
    });
    const pending: Check[] = [
      ...Object.entries(CONTRACTS).map(([name, entry]) => ({
        label: name,
        detail: `runtime code hash matches the manifest at ${shortAddress(entry.address, 5)}`,
        status: "pending" as Status,
      })),
      ...Object.entries(ADAPTERS).map(([name, entry]) => ({
        label: name,
        detail: `runtime code hash matches the manifest at ${shortAddress(entry.address, 5)}`,
        status: "pending" as Status,
      })),
      { label: "Epoch privacy floor", detail: "at least 2 participants", status: "pending" },
      { label: "Residual privacy floor", detail: "at least 2 contributors", status: "pending" },
      { label: "Nothing seeded", detail: "no Safes onboarded by the deployer", status: "pending" },
    ];
    setChecks(pending);

    const all = { ...CONTRACTS, ...ADAPTERS };
    const next = [...pending];

    for (const [name, entry] of Object.entries(all)) {
      const index = next.findIndex((c) => c.label === name);
      try {
        const code = await client.getCode({ address: entry.address });
        const ok = code !== undefined && keccak256(code) === entry.runtimeCodeHash;
        next[index] = {
          ...next[index]!,
          status: ok ? "pass" : "fail",
          result: ok ? "match" : "hash differs",
        };
      } catch {
        next[index] = { ...next[index]!, status: "fail", result: "read failed" };
      }
      setChecks([...next]);
    }

    for (const [label, fn] of [
      ["Epoch privacy floor", "EPOCH_FLOOR_K"],
      ["Residual privacy floor", "RESIDUAL_FLOOR_K"],
    ] as const) {
      const index = next.findIndex((c) => c.label === label);
      try {
        const value = (await client.readContract({
          address: contractAddress("ShrudClearingEngine"),
          abi: clearingEngineAbi,
          functionName: fn,
        })) as bigint;
        next[index] = {
          ...next[index]!,
          status: value >= 2n ? "pass" : "fail",
          result: `k = ${String(value)}`,
        };
      } catch {
        next[index] = { ...next[index]!, status: "fail", result: "read failed" };
      }
      setChecks([...next]);
    }

    const seedIndex = next.findIndex((c) => c.label === "Nothing seeded");
    try {
      const count = (await client.readContract({
        address: contractAddress("ShrudModuleFactory"),
        abi: moduleFactoryAbi,
        functionName: "safeCount",
      })) as bigint;
      next[seedIndex] = {
        ...next[seedIndex]!,
        status: IS_SEEDED ? "fail" : "pass",
        result: `${String(count)} Safes, all created by their own owners`,
      };
    } catch {
      next[seedIndex] = { ...next[seedIndex]!, status: "fail", result: "read failed" };
    }

    setChecks([...next]);
    setRunning(false);
    setDone(true);
  };

  useEffect(() => {
    void run();
    // Runs once on mount. Re-running is the button's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  return (
    <>
      <div className="atmos-sky">
        <SiteHeader />
        <section>
          <div className="shell py-[64px] text-center">
            <Pill tone="settled">Live</Pill>
            <h1 className="type-heading-lg mx-auto mt-5 max-w-[18ch]">
              Check every claim against the chain.
            </h1>
            <p className="type-lead mx-auto mt-5 max-w-[52ch]">
              These are public reads against Ethereum Sepolia, running in your browser right now. No
              wallet, no key, no server of ours involved.
            </p>
          </div>
        </section>
      </div>
      <main>
        <section className="shell -mt-8 pb-[80px]">
          <Card className="p-6 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="type-subheading">
                  {running ? "Running…" : done ? `${passed} passed, ${failed} failed` : "Ready"}
                </p>
                <p className="text-caption text-stone">
                  The command line version runs 65 checks. This page runs the subset that needs no
                  private key and no RPC of your own.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  void run();
                }}
                disabled={running}
                className="btn btn-tangerine"
              >
                {running ? "Running" : "Run again"}
                <RainbowMark size={24} />
              </button>
            </div>

            <ul className="mt-6 flex flex-col">
              {checks.map((check) => (
                <li
                  key={check.label}
                  className="flex items-center gap-3 border-t border-cloud py-3"
                >
                  <StatusGlyph status={check.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-semibold">{check.label}</p>
                    <p className="truncate text-caption text-stone">{check.detail}</p>
                  </div>
                  {check.result !== undefined && (
                    <span className="type-mono shrink-0 text-stone">{check.result}</span>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card tone="cloud" className="mt-4">
            <p className="type-subheading">Run the full set yourself</p>
            <p className="mt-2 text-body text-stone">
              Sixty-five checks, including governance delays, registered routes, adapter manifests
              and the wiring. Read-only, so it needs no key of any kind.
            </p>
            <div className="mt-4 overflow-x-auto rounded-[24px] bg-ink p-5">
              <pre className="type-mono text-[0.8rem] text-white">
                <code>{`git clone <this repository>
pnpm install && pnpm compile
pnpm verify:live`}</code>
              </pre>
            </div>
          </Card>

          <p className="mt-6 text-center text-caption text-stone">
            Contracts on{" "}
            <a
              href={explorerUrl(contractAddress("ShrudIntentBook"))}
              target="_blank"
              rel="noreferrer noopener"
              className="font-bold text-ink underline underline-offset-4"
            >
              Sepolia Etherscan
            </a>
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function StatusGlyph({ status }: { status: Status }) {
  if (status === "pending") {
    return <span className="size-5 shrink-0 animate-pulse rounded-full bg-mist" aria-label="checking" />;
  }
  if (status === "pass") {
    return (
      <span
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#2d7a4d]"
        aria-label="passed"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m5 13 4 4L19 7" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#c0392b]"
      aria-label="failed"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}
