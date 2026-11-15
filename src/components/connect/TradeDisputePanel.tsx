"use client";

import { Fragment, useState } from "react";
import { tradeDisputeDisplayRows, type TradeDisputePanelJson } from "@/components/connect/trade-dispute-display";

type DisputeJson = TradeDisputePanelJson & { draft?: boolean };

export function TradeDisputePanel() {
  const [tradeId, setTradeId] = useState("");
  const [data, setData] = useState<DisputeJson | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    setData(null);
    const id = tradeId.trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(id)) {
      setError("vet402 reads a trade id as 0x plus 64 hex digits.");
      return;
    }
    try {
      const r = await fetch(`/api/v1/observatory/disputes?tradeId=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (r.status === 404) {
        setError("No record for this trade id yet.");
        return;
      }
      if (!r.ok) {
        setError("vet402 could not load this trade record yet.");
        return;
      }
      setData((await r.json()) as DisputeJson);
    } catch {
      setError("vet402 could not load this trade record yet.");
    }
  }

  return (
    <section>
      <h2>Look up a trade</h2>
      <label>
        Trade id
        <input
          value={tradeId}
          onChange={(e) => setTradeId(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          data-clarity-mask="true"
        />
      </label>
      <button type="button" onClick={() => void load()}>
        Load public record
      </button>
      {error ? <p>{error}</p> : null}
      {data ? (
        <dl>
          {tradeDisputeDisplayRows(data).map(({ label, value }) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
