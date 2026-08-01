"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAccount, useChainId } from "wagmi";

import { Pill, RainbowMark } from "@/components/primitives";
import { CHAIN_ID } from "@/lib/deployment";

/**
 * Routes, grouped the way a treasurer thinks about them rather than the way the contracts are laid
 * out. `Clearing` and `Positions` are separate groups because one is an activity you watch and the
 * other is a balance you hold.
 */
const GROUPS = [
  {
    label: "Treasury",
    items: [
      { href: "/app", label: "Overview", exact: true },
      { href: "/app/vault", label: "Vault" },
      { href: "/app/orders", label: "Orders" },
    ],
  },
  {
    label: "Clearing",
    items: [
      { href: "/app/trade", label: "New order" },
      { href: "/app/clearing", label: "Epochs" },
      { href: "/app/earn", label: "Earn" },
      { href: "/app/positions", label: "Positions" },
    ],
  },
  {
    label: "Governance",
    items: [
      { href: "/app/members", label: "Members" },
      { href: "/app/capsules", label: "Disclosure" },
      { href: "/app/settings", label: "Settings" },
    ],
  },
] as const;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();

  return (
    <div className="min-h-dvh bg-cloud">
      <header className="sticky top-0 z-40 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex h-[68px] max-w-[1400px] items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setNavOpen((open) => !open);
              }}
              className="rounded-[14px] p-2 lg:hidden"
              aria-label="Toggle navigation"
              aria-expanded={navOpen}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 7h16M4 12h16M4 17h16"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <Link href="/" className="flex items-center gap-2.5">
              <RainbowMark size={30} />
              <span className="font-display text-[1.2rem] font-black tracking-[-0.03em]">
                shrud
              </span>
            </Link>
          </div>

          <div className="flex items-center gap-2">
            <NetworkBadge />
            <ConnectButton
              showBalance={false}
              accountStatus={{ smallScreen: "avatar", largeScreen: "address" }}
              chainStatus="none"
            />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1400px] gap-6 px-4 py-6 sm:px-6">
        <aside
          className={`${
            navOpen ? "block" : "hidden"
          } fixed inset-x-4 top-[76px] z-30 lg:sticky lg:top-[84px] lg:block lg:h-fit lg:w-[220px] lg:shrink-0`}
        >
          <nav className="flex flex-col gap-5 rounded-[32px] bg-white p-4 lg:bg-transparent lg:p-0">
            {GROUPS.map((group) => (
              <div key={group.label}>
                <p className="px-3 pb-1.5 text-caption font-bold uppercase tracking-wider text-stone">
                  {group.label}
                </p>
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const active =
                      "exact" in item && item.exact === true
                        ? pathname === item.href
                        : pathname.startsWith(item.href);
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => {
                            setNavOpen(false);
                          }}
                          aria-current={active ? "page" : undefined}
                          className={`block rounded-[50px] px-3.5 py-2 text-body font-semibold transition-colors ${
                            active ? "bg-ink text-white" : "text-ink hover:bg-white"
                          }`}
                        >
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 pb-16">{children}</main>
      </div>
    </div>
  );
}

/**
 * Network state, stated rather than assumed.
 *
 * A wallet on the wrong chain is the single most common reason a transaction fails here, and the
 * failure surfaces as an opaque wallet error. Naming it in the header costs one badge.
 */
function NetworkBadge() {
  const chainId = useChainId();
  const { isConnected } = useAccount();

  if (!isConnected) return <Pill tone="neutral">Not connected</Pill>;
  if (chainId !== CHAIN_ID) return <Pill tone="warn">Wrong network</Pill>;
  return <Pill tone="settled">Sepolia</Pill>;
}
