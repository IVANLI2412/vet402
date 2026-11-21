/** 16px verdict shapes (ALLOW / WARN / BLOCK) for monochrome UI. Colour-independent. */

export function VerdictShapeMark({ verdict, className = "" }: { verdict: string; className?: string }) {
  const v = verdict.toUpperCase();
  if (v === "ALLOW") {
    return <span className={`inline-block h-4 w-4 bg-current ${className}`.trim()} aria-hidden />;
  }
  if (v === "WARN") {
    return (
      <span
        className={`inline-block box-border h-4 w-4 border-2 border-dashed border-current ${className}`.trim()}
        aria-hidden
      />
    );
  }
  if (v === "BLOCK") {
    return (
      <span
        className={`relative inline-block box-border h-4 w-4 border-2 border-solid border-current ${className}`.trim()}
        aria-hidden
      >
        <span className="absolute left-1/2 top-1/2 block h-[2px] w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current" />
        <span className="absolute left-1/2 top-1/2 block h-[2px] w-2.5 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current" />
      </span>
    );
  }
  return null;
}