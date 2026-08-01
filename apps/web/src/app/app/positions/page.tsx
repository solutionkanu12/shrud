"use client";

import { Note, PageHeader, RequiresConnection } from "@/components/app-shell";
import { Card, Empty, Pill } from "@/components/primitives";

export default function PositionsPage() {
  return (
    <>
      <PageHeader
        title="Positions"
        description="Your encrypted share of every pooled position this treasury has joined."
        badge={<Pill tone="confidential">Confidential</Pill>}
      />
      <RequiresConnection>
        <Card>
          <Empty title="No positions yet">
            A position appears once this treasury supplies into a pooled route and the supply floor
            is met. Your share is minted as an encrypted value against a public ratio.
          </Empty>
        </Card>
        <Note title="The pool reconciles publicly, the shares do not">
          A position's principal and total shares are both public, so anyone can check the ratio and
          confirm the pool adds up. Which treasury holds which share is encrypted, so the audit is
          possible without the disclosure.
        </Note>
      </RequiresConnection>
    </>
  );
}
