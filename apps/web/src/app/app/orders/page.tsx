"use client";

import Link from "next/link";

import { Note, PageHeader, RequiresConnection, RequiresSafe } from "@/components/app-shell";
import { Card, Empty } from "@/components/primitives";
import { useActiveSafe } from "@/lib/active-safe";
import { useModuleOf } from "@/lib/hooks";

export default function OrdersPage() {
  // Keyed by Safe, not by the connected wallet. See the note on `useModuleOf`.
  const { safe } = useActiveSafe();
  const module = useModuleOf(safe);
  const hasModule =
    module.data !== undefined && module.data !== "0x0000000000000000000000000000000000000000";

  return (
    <>
      <PageHeader
        title="Orders"
        description="Every order this treasury has submitted, with the public record on the left and what only you can read on the right."
        action={
          <Link href="/app/trade" className="btn btn-tangerine">
            New order
          </Link>
        }
      />

      <RequiresConnection>
        {hasModule ? (
          <>
            <Card>
              <Empty title="No orders yet">
                Orders submitted by this treasury appear here. The list is read from the intent book
                on Sepolia, so it is empty because nothing has been submitted rather than because
                anything failed.
              </Empty>
            </Card>

            <Note title="Five statuses, and one of them carries every outcome">
              An order ends at Processed whether it filled completely, failed its private limit, was
              underfunded, or simply held. A sixth status such as InsufficientBalance would turn
              repeated oversized orders into a binary search over your confidential balance, so it
              does not exist. Your real result is encrypted and readable only by this Safe's owners.
            </Note>
          </>
        ) : (
          <RequiresSafe />
        )}
      </RequiresConnection>
    </>
  );
}
