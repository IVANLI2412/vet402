"use client";

import { useEffect, useState } from "react";
import type { FixFirstBoardPayload } from "@/app/api/v1/sellers/fix-first-board/route";
import { FixFirstView, SellersNotice } from "@/components/site/sellers/SellersViews";

export function FixFirstBoardClient() {
  const [board, setBoard] = useState<FixFirstBoardPayload | null | undefined>(undefined);

  useEffect(() => {
    if (board !== undefined) {
      document.getElementById("fix-first-ssr")?.remove();
    }
  }, [board]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/v1/sellers/fix-first-board", { headers: { accept: "application/json" } });
        if (!res.ok) {
          if (!cancelled) setBoard(null);
          return;
        }
        const data = (await res.json()) as FixFirstBoardPayload;
        if (!cancelled) setBoard(data);
      } catch {
        if (!cancelled) setBoard(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (board === undefined) {
    return <p className="doc-p text-brand">Loading the ledger…</p>;
  }
  if (!board) {
    return <SellersNotice title="What to fix first">Reading the ledger failed. Please reload in a minute.</SellersNotice>;
  }
  return <FixFirstView board={board} />;
}