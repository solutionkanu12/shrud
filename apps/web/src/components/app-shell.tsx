"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Card, Empty, Pill } from "@/components/primitives";
import { useConnection } from "@/lib/hooks";

/** Page header. One per route, so the title and its explanation never drift apart. */
export function PageHeader({
  title,
  description,
  action,
  badge,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="type-heading">{title}</h1>
          {badge}
        </div>
        <p className="mt-1.5 max-w-[64ch] text-body text-stone">{description}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * The wall every write path sits behind.
 *
 * Three failure modes, three different messages. A disconnected wallet, a wallet on the wrong
 * chain, and a connected wallet with no Safe are entirely different problems, and collapsing them
 * into one "connect your wallet" screen sends people to fix the wrong thing.
 */
export function RequiresConnection({ children }: { children: ReactNode }) {
  const { isConnected, wrongNetwork } = useConnection();

  if (!isConnected) {
    return (
      <Empty title="Connect a wallet to continue">
        This page reads and writes state that belongs to a specific treasury. Use the connect button
        in the header. Nothing is custodial and nothing is signed until you approve it.
      </Empty>
    );
  }

  if (wrongNetwork) {
    return (
      <Empty title="Switch to Ethereum Sepolia">
        This build talks to contracts on Sepolia. Your wallet is on a different network, so every
        read here would return nothing and every write would fail in your wallet rather than here.
      </Empty>
    );
  }

  return <>{children}</>;
}

/**
 * The empty state for a treasury that has not onboarded.
 *
 * Deliberately not a dead end. It says what is missing and links to the thing that fixes it.
 */
export function RequiresSafe() {
  return (
    <Empty
      title="No shrud module on this account"
      action={
        <Link href="/app/onboard" className="btn btn-tangerine">
          Set up a treasury
        </Link>
      }
    >
      shrud operates on a Safe, not on a plain wallet. Onboarding installs a module on a Safe you
      already control. It adds a capability and takes nothing away.
    </Empty>
  );
}

/**
 * A value the connected account is not entitled to read.
 *
 * Distinct from an empty state on purpose. Nothing is missing here, and the interface should not
 * imply it is: the value exists, it is encrypted, and this viewer is not an owner.
 */
export function ConfidentialValue({ note }: { note?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1.5 text-body font-bold text-[#5c3fa8]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4" y="10" width="16" height="11" rx="3" fill="currentColor" />
          <path
            d="M8 10V7a4 4 0 1 1 8 0v3"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </svg>
        Encrypted
      </span>
      {note !== undefined && <span className="text-caption text-stone">{note}</span>}
    </div>
  );
}

/** A short explanation attached to a screen, for the thing that screen keeps having to justify. */
export function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card tone="cloud" className="mt-6">
      <div className="flex items-start gap-3">
        <Pill tone="confidential">Why</Pill>
        <div className="min-w-0">
          <p className="text-body font-bold">{title}</p>
          <p className="mt-1 text-body text-stone">{children}</p>
        </div>
      </div>
    </Card>
  );
}
