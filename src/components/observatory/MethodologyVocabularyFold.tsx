"use client";

import { useState } from "react";

export default function MethodologyVocabularyFold({ termCount }: { termCount: number }) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onToggle = async (ev: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!(ev.currentTarget as HTMLDetailsElement).open || html || loading) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/observatory/methodology/vocabulary-html", { headers: { accept: "text/html" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHtml(await res.text());
    } catch {
      setErr("Could not load definitions. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <details className="mt-6 border-t border-hair pt-4" onToggle={onToggle}>
      <summary className="cursor-pointer text-brand-deep">
        Full definitions ({termCount} terms, one sentence each)
      </summary>
      {loading ? <p className="doc-p text-brand-lift">Loading definitions…</p> : null}
      {err ? <p className="doc-p text-brand-lift">{err}</p> : null}
      {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : null}
    </details>
  );
}