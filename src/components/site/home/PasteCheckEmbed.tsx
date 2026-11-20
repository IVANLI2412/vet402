"use client";

import s from "@/app/home.module.css";
import { PasteCheck } from "@/components/site/home/PasteCheck";

/** Same paste UI as the home page, for RFC pages that need an inline check. */
export function PasteCheckEmbed() {
  return (
    <div className={s.lp}>
      <PasteCheck cls={s} />
    </div>
  );
}