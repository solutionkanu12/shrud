"use client";

import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "@/lib/wagmi";

import "@rainbow-me/rainbowkit/styles.css";

/**
 * Provider order is fixed by RainbowKit: wagmi outermost, then query, then RainbowKit.
 *
 * The QueryClient is created inside a `useState` initialiser rather than at module scope. At module
 * scope it would be shared across every request during server rendering, which leaks one visitor's
 * cached chain reads into another's first paint.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain state changes on a block cadence. Refetching faster spends rate limit for
            // nothing; refetching slower makes a confirmed transaction look like it did not land.
            staleTime: 12_000,
            retry: 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={lightTheme({
            accentColor: "#ff54bb",
            accentColorForeground: "#ffffff",
            borderRadius: "large",
            fontStack: "system",
          })}
          appInfo={{ appName: "shrud" }}
          modalSize="compact"
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
