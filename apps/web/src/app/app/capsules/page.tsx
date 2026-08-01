"use client";

import { Note, PageHeader, RequiresConnection } from "@/components/app-shell";
import { Card, Empty, Pill } from "@/components/primitives";

export default function CapsulesPage() {
  return (
    <>
      <PageHeader
        title="Disclosure"
        description="Grant a named auditor read access to specific values, without granting anything else."
        badge={<Pill tone="public">Selective</Pill>}
        action={
          <button type="button" className="btn btn-tangerine" disabled>
            New capsule
          </button>
        }
      />
      <RequiresConnection>
        <Card>
          <Empty title="No capsules issued">
            A capsule is a scoped, permanent grant to one viewer. Issue one when an auditor or a
            counterparty needs to verify a specific figure.
          </Empty>
        </Card>
        <Note title="A capsule re-derives every field before granting it">
          Nox derives a handle as a pure function of its operands, so two treasuries with the same
          number share one handle and one permanent access list. Granting the original handle would
          grant every other value that happens to equal it. A capsule computes a fresh handle under
          a capsule-specific domain first, which is why disclosure here is genuinely scoped.
        </Note>
      </RequiresConnection>
    </>
  );
}
