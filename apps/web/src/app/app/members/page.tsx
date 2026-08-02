"use client";

import { Note, PageHeader, RequiresConnection, RequiresSafe } from "@/components/app-shell";
import { Card, Empty, Pill } from "@/components/primitives";
import { useActiveSafe } from "@/lib/active-safe";
import { useModuleOf } from "@/lib/hooks";

export default function MembersPage() {
  // Keyed by Safe, not by the connected wallet. See the note on `useModuleOf`.
  const { safe } = useActiveSafe();
  const module = useModuleOf(safe);
  const hasModule =
    module.data !== undefined && module.data !== "0x0000000000000000000000000000000000000000";

  return (
    <>
      <PageHeader
        title="Members"
        description="The Safe owners who may authorise orders, and who may decrypt this treasury's results."
        badge={<Pill tone="neutral">From your Safe</Pill>}
      />
      <RequiresConnection>
        {hasModule ? (
          <>
            <Card>
              <Empty title="Owners are read from your Safe">
                shrud does not keep its own member list. The owners are whoever your Safe says they
                are, and the threshold is whatever your Safe enforces.
              </Empty>
            </Card>
            <Note title="Changing owners rotates who can read what">
              Nox grants cannot be revoked, so removing an owner does not remove their access to
              handles already granted. Rotating live-state viewers issues fresh handles under a new
              domain for everything current, which is the only mechanism that actually works.
            </Note>
          </>
        ) : (
          <RequiresSafe />
        )}
      </RequiresConnection>
    </>
  );
}
