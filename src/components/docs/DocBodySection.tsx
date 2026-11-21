"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Collapsible docs section: h2 stays visible in the summary; body loads layout only when open.
 * Hash links from DocsToc open the matching section (#id on <details>).
 */
export default function DocBodySection({
  id,
  title,
  className = "space-y-3",
  defaultOpen = false,
  children,
}: {
  id: string;
  title: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const openFromHash = () => {
      const hash = window.location.hash.slice(1);
      if (hash === id && ref.current) ref.current.open = true;
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [id]);

  return (
    <details id={id} ref={ref} className="group scroll-mt-32 border-0" {...(defaultOpen ? { open: true } : {})}>
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <h2 className="sec-head">{title}</h2>
        <span className="mt-1 block text-xs text-brand-lift group-open:hidden">Expand this section</span>
      </summary>
      <div className={className}>{children}</div>
    </details>
  );
}