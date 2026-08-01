"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Link from "next/link";
import { useEffect, useState } from "react";

import { DEPLOYED_AT, TOTAL_CONTRACTS, contractAddress, explorerUrl } from "@/lib/deployment";
import { REOWN_CONFIGURED } from "@/lib/wagmi";

import { RainbowMark } from "./primitives";

const NAV = [
  { href: "/network", label: "Network" },
  { href: "/verify", label: "Verify" },
  { href: "/security", label: "Security" },
  { href: "/developers", label: "Developers" },
] as const;

/**
 * The top bar.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT DOES NOT KNOW ITS OWN HEIGHT, AND THAT IS THE FIX
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The first version was transparent at rest and translucent once scrolled, with each page pulling
 * its hero up by `-mt-[72px]` to sit the gradient behind it. That works exactly while the header is
 * 72px tall.
 *
 * It is not, whenever the configuration banner appears. The banner added roughly 40px, the hero kept
 * offsetting by 72, and a band of white page background showed above the gradient — which then
 * turned translucent blue on scroll and read as a colour-changing bug.
 *
 * A component that publishes a magic number every caller must match will drift the first time
 * anything changes. So the gradient now lives on a wrapper CONTAINING the header, no caller offsets
 * anything, and the header may be any height it likes.
 */
export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 24);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <header
      className="sticky top-0 z-50 transition-[background-color,backdrop-filter] duration-200"
      style={
        scrolled
          ? { backgroundColor: "rgba(255,255,255,0.82)", backdropFilter: "blur(14px)" }
          : { backgroundColor: "rgba(255,255,255,0)" }
      }
    >
      <div className="shell flex h-[72px] items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2.5" aria-label="shrud home">
          <RainbowMark size={34} />
          <span className="font-display text-[1.35rem] font-black tracking-[-0.03em]">shrud</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-[50px] px-4 py-2 text-body font-semibold text-ink transition-colors hover:bg-white/60"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link href="/app" className="btn btn-ghost hidden text-[0.9rem] sm:inline-flex">
            Open app
          </Link>
          <ConnectButton
            showBalance={false}
            accountStatus={{ smallScreen: "avatar", largeScreen: "address" }}
            chainStatus="icon"
          />
        </div>
      </div>

      {!REOWN_CONFIGURED && <ReownWarning />}
    </header>
  );
}

/**
 * Shown only when the Reown project id is missing.
 *
 * Injected wallets still connect without it, so this is a degraded state rather than a broken one,
 * and saying which part is missing is more useful than a connect modal that silently offers fewer
 * options than the user expects.
 */
function ReownWarning() {
  return (
    <div className="bg-[#fff0e0] px-6 py-2 text-center text-caption font-semibold text-[#9c5500]">
      NEXT_PUBLIC_REOWN_PROJECT_ID is not set. Browser wallets still connect. WalletConnect and the
      mobile QR flow will not, until a project id from dashboard.reown.com is configured.
    </div>
  );
}

export function SiteFooter() {
  const deployedOn = new Date(DEPLOYED_AT).toISOString().slice(0, 10);

  return (
    <footer className="mt-[80px] bg-cloud pt-[64px] pb-10">
      <div className="shell">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="flex items-center gap-2.5">
              <RainbowMark size={30} />
              <span className="font-display text-[1.2rem] font-black tracking-[-0.03em]">
                shrud
              </span>
            </Link>
            <p className="mt-3 max-w-[24ch] text-body text-stone">
              Confidential treasury clearing. Hide the order, settle the net.
            </p>
          </div>

          <FooterColumn
            title="Product"
            links={[
              { href: "/app", label: "Open app" },
              { href: "/network", label: "Network activity" },
              { href: "/verify", label: "Verify a deployment" },
              { href: "/status", label: "Status" },
            ]}
          />
          <FooterColumn
            title="Learn"
            links={[
              { href: "/security", label: "Security model" },
              { href: "/developers", label: "Developers" },
              { href: "/docs", label: "Documentation" },
            ]}
          />
          <FooterColumn
            title="Contracts"
            links={[
              {
                href: explorerUrl(contractAddress("ShrudIntentBook")),
                label: "Intent book",
                external: true,
              },
              {
                href: explorerUrl(contractAddress("ShrudClearingEngine")),
                label: "Clearing engine",
                external: true,
              },
              {
                href: explorerUrl(contractAddress("ShrudSettlementEngine")),
                label: "Settlement engine",
                external: true,
              },
            ]}
          />
        </div>

        <div className="mt-12 flex flex-col gap-3 text-caption text-stone sm:flex-row sm:items-center sm:justify-between">
          <p>
            {TOTAL_CONTRACTS} contracts on Ethereum Sepolia, deployed {deployedOn}.
            Nothing is seeded.
          </p>
          <p>
            Not audited. Testnet only.{" "}
            <span className="font-bold text-ink">GPL-3.0-or-later</span>
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: readonly { href: string; label: string; external?: boolean }[];
}) {
  return (
    <div>
      <p className="text-caption font-bold uppercase tracking-wider text-stone">{title}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {links.map((link) => (
          <li key={link.href}>
            {link.external === true ? (
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-body font-semibold transition-opacity hover:opacity-60"
              >
                {link.label}
              </a>
            ) : (
              <Link
                href={link.href}
                className="text-body font-semibold transition-opacity hover:opacity-60"
              >
                {link.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
