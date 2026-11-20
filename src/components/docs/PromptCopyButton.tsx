"use client";

import { useCallback, useEffect, useState } from "react";
import { track } from "@/lib/analytics";
import codeStyles from "./CodeBlock.module.css";

export function PromptCopyButton({ prompt, label = "Copy prompt" }: { prompt: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "selected">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);

  const copy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
        setState("copied");
        track("snippet_copy");
        return;
      }
    } catch {
      /* fall through */
    }
    setState("selected");
  }, [prompt]);

  const live = state === "copied" ? "Copied" : state === "selected" ? "Selected, press Cmd+C or Ctrl+C" : "";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" onClick={copy} aria-label={label} className={codeStyles.copy}>
        {state === "idle" ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            className={codeStyles.icon}
          >
            <rect x="7" y="7" width="9" height="9" rx="1.5" />
            <path d="M13 4.5H5.5A1.5 1.5 0 0 0 4 6v7.5" />
          </svg>
        ) : (
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={codeStyles.icon}
          >
            <path d="M4 10.5 8 14.5 16 6" />
          </svg>
        )}
      </button>
      <span className="text-[0.8125rem] text-brand-lift">{state === "copied" ? "Copied" : label}</span>
      <span aria-live="polite" className="sr-only">
        {live}
      </span>
    </div>
  );
}