"use client";

import { useState } from "react";
import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";
import { track } from "@/lib/analytics";

export function WatchSellersInterest({ recordId }: { recordId: string | null }) {
  const [pressed, setPressed] = useState(false);

  if (pressed) {
    return (
      <p className="doc-p mt-4 text-sm text-brand-lift" aria-live="polite">
        Thanks. Until then, each{" "}
        {recordId ? (
          <Link href={`/observatory/e/${recordId}`} className="underline">
            record page
          </Link>
        ) : (
          "record page"
        )}{" "}
        has a free email alert.
      </p>
    );
  }

  return (
    <section className="mt-4 max-w-[62ch] text-sm text-brand-lift">
      <p className="doc-p text-sm text-brand-lift">
        Watching several sellers you pay? A paid plan that watches all of them (webhook and a weekly summary) is not
        built yet. Press if you would use it.
      </p>
      <button
        type="button"
        className={buttonClass({ variant: "secondary", size: "sm", className: "mt-2 min-h-11" })}
        onClick={() => {
          track("watch_sellers_interest", { r: "seller_page" });
          setPressed(true);
        }}
      >
        I would use this
      </button>
    </section>
  );
}