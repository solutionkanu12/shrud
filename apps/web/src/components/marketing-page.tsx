import type { ReactNode } from "react";

import { Pill } from "@/components/primitives";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

/** The shared frame for every public page that is mostly prose. */
export function MarketingPage({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow: string;
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <>
      {/* Same reason as the landing page: the gradient contains the header, so nothing offsets
          against a hardcoded header height. */}
      <div className="atmos-sky">
        <SiteHeader />
        <section>
          <div className="shell py-[64px] text-center">
            <Pill tone="neutral">{eyebrow}</Pill>
            <h1 className="type-heading-lg mx-auto mt-5 max-w-[20ch]">{title}</h1>
            <p className="type-lead mx-auto mt-5 max-w-[56ch]">{lead}</p>
          </div>
        </section>
      </div>
      <main>
        <section className="shell pb-[80px] pt-10">{children}</section>
      </main>
      <SiteFooter />
    </>
  );
}
