import type { Metadata, Viewport } from "next";

import { Providers } from "./providers";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "shrud — confidential treasury clearing",
    template: "%s — shrud",
  },
  description:
    "Treasuries submit encrypted orders. Matching opposites cross privately. Only the unmatched " +
    "remainder reaches Uniswap, aggregated across everyone. Built on iExec Nox. Live on Sepolia.",
  metadataBase: new URL("https://shrud.xyz"),
  openGraph: {
    title: "shrud — confidential treasury clearing",
    description:
      "Hide the order. Settle the net. Confidential clearing for Safe, Uniswap and Aave.",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Nunito is design.md's named substitute for SF Pro Rounded, which is Apple-only. The
            rounded letterforms are the brand voice rather than a preference, so this is preloaded
            rather than left to a late swap. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Nunito:wght@500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
