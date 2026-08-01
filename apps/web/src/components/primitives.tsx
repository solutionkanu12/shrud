/**
 * Design primitives.
 *
 * Small on purpose. Every one of these exists because the same shape appears in three or more
 * places and getting it wrong in one of them would break the visual system. Anything used once
 * lives at its call site.
 */

import type { ReactNode } from "react";

import { explorerUrl, shortAddress } from "@/lib/deployment";

/**
 * The rainbow mark. Five bands, always the same order, always on a white tile.
 *
 * The spec is explicit that the logo never sits directly on a chromatic background, so the white
 * stage is part of the component rather than something a caller remembers to add.
 */
export function RainbowMark({ size = 32 }: { size?: number }) {
  const bands = ["#ff3b6b", "#ff8a00", "#fae300", "#3ecf8e", "#5b7cfa"];
  return (
    <span
      className="inline-flex shrink-0 items-end justify-center overflow-hidden bg-white"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        padding: size * 0.16,
      }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 40 22" width="100%" height="100%" role="presentation">
        {bands.map((color, index) => (
          <path
            key={color}
            d={`M ${2 + index * 3.4} 21 A ${18 - index * 3.4} ${18 - index * 3.4} 0 0 1 ${
              38 - index * 3.4
            } 21`}
            fill="none"
            stroke={color}
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        ))}
      </svg>
    </span>
  );
}

/** A 4-pointed sparkle. Decorative atmosphere only, so it is hidden from assistive technology. */
export function Sparkle({
  size = 40,
  className = "",
  style,
}: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path
        d="M12 0c.6 6.3 5.1 10.8 12 12-6.9 1.2-11.4 5.7-12 12-.6-6.3-5.1-10.8-12-12C6.9 10.8 11.4 6.3 12 0Z"
        fill="#fae300"
      />
    </svg>
  );
}

type PillTone = "confidential" | "public" | "settled" | "neutral" | "warn";

const PILL_TONES: Record<PillTone, { bg: string; fg: string }> = {
  confidential: { bg: "#f0ebff", fg: "#5c3fa8" },
  public: { bg: "#e6f1fd", fg: "#2c5f96" },
  settled: { bg: "#e0f5e9", fg: "#1f6640" },
  neutral: { bg: "#f1f3f6", fg: "#5c5d69" },
  warn: { bg: "#fff0e0", fg: "#9c5500" },
};

/**
 * A status pill.
 *
 * The tone vocabulary is closed. `confidential`, `public` and `settled` are the three states this
 * product ever needs to distinguish, and adding a fourth colour is how a narrow palette stops being
 * narrow.
 */
export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: PillTone;
  children: ReactNode;
}) {
  const { bg, fg } = PILL_TONES[tone];
  return (
    <span className="pill" style={{ background: bg, color: fg }}>
      {children}
    </span>
  );
}

/** An address that links to Etherscan and shows its ends, which is what people actually compare. */
export function AddressLink({
  address,
  label,
  kind = "address",
}: {
  address: string;
  label?: string;
  kind?: "address" | "tx";
}) {
  return (
    <a
      href={explorerUrl(address, kind)}
      target="_blank"
      rel="noreferrer noopener"
      className="type-mono inline-flex items-center gap-1 rounded-[10px] px-1.5 py-0.5 text-stone transition-colors hover:bg-cloud hover:text-ink"
      title={address}
    >
      {label ?? shortAddress(address)}
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M7 17 17 7M17 7H9m8 0v8"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </a>
  );
}

/**
 * A card. No border, no drop shadow, 32px radius.
 *
 * The spec forbids 1px borders for separation and forbids outer shadows on cards. Separation comes
 * from a surface shift, which is why `tone` exists and `border` does not.
 */
export function Card({
  tone = "canvas",
  className = "",
  children,
}: {
  tone?: "canvas" | "cloud" | "glass";
  className?: string;
  children: ReactNode;
}) {
  const surface =
    tone === "glass" ? "surface-glass p-6" : tone === "cloud" ? "surface-cloud" : "surface-card";
  return <div className={`${surface} ${className}`}>{children}</div>;
}

/**
 * The honest empty state.
 *
 * This product ships with nothing in it on purpose, so an empty list is the common case rather than
 * an error. Saying so plainly, and saying what would fill it, is more useful than a spinner that
 * never resolves or a zero that looks like a failure.
 */
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="surface-cloud flex flex-col items-center gap-3 px-6 py-14 text-center">
      <RainbowMark size={44} />
      <p className="type-subheading mt-1">{title}</p>
      <p className="max-w-md text-body text-stone">{children}</p>
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * A labelled statistic.
 *
 * `confidential` renders the value as a lock rather than a number. That distinction is the entire
 * product, so it is a property of the component rather than something each screen decides.
 */
export function Stat({
  label,
  value,
  hint,
  confidential = false,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  confidential?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption font-bold uppercase tracking-wider text-stone">{label}</span>
      {confidential ? (
        <span className="flex items-center gap-1.5 text-subheading font-extrabold text-[#5c3fa8]">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="4" y="10" width="16" height="11" rx="3" fill="currentColor" />
            <path
              d="M8 10V7a4 4 0 1 1 8 0v3"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
          Encrypted
        </span>
      ) : (
        <span className="text-subheading font-extrabold">{value}</span>
      )}
      {hint !== undefined && <span className="text-caption text-stone">{hint}</span>}
    </div>
  );
}

/**
 * A row that states one thing that is public and one that is not.
 *
 * Used wherever the product explains itself. Keeping the two columns adjacent is the point: the
 * distinction only means something when both halves are visible at once.
 */
export function PublicPrivateRow({
  publicFact,
  privateFact,
}: {
  publicFact: string;
  privateFact: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 border-0 sm:grid-cols-2 sm:gap-6">
      <div className="flex items-start gap-2">
        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[#3d7ab8]" aria-hidden="true" />
        <span className="text-body">{publicFact}</span>
      </div>
      <div className="flex items-start gap-2">
        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[#7c5cbf]" aria-hidden="true" />
        <span className="text-body text-stone">{privateFact}</span>
      </div>
    </div>
  );
}
