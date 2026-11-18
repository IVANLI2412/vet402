import Link from "next/link";
import { publicEnglishFaults } from "@/lib/diagnose/copy";
import {
  erc8004WeeklyHref,
  lastCompleteIsoWeek,
  type SellerErc8004Binding,
  type SellerErc8004BindingRow,
} from "@/lib/sellers/erc8004-binding";
import { getSellerErc8004BindingCached } from "@/lib/sellers/cached";

export const ERC8004_SECTION_DEFINITION =
  "These rows list ERC-8004 Identity Registry agents on Base whose indexed owner or agentWallet address exactly equals a payTo address from vet402 purchase rows on this seller. An address match does not show that the agent operator runs this seller. wallet_confirmed means the indexed agentWallet equals the payTo. owner_only means the owner address matches without a matching agentWallet, which is a weaker bind than wallet_confirmed. Purchase and settled counts are for this seller.";

export function erc8004SectionLines(
  binding: Exclude<SellerErc8004Binding, { status: "none" }>,
  week: string,
): string[] {
  const lines: string[] = [`${ERC8004_SECTION_DEFINITION} The match rule is on the methodology page.`];
  if (binding.status === "unavailable") {
    lines.push("ERC-8004 binding counts could not be read from the database. Please reload in a minute.");
    return lines;
  }
  if (binding.totalAgents > binding.agents.length) {
    lines.push(
      `Showing ${binding.agents.length} of ${binding.totalAgents} matched agents. wallet_confirmed rows are listed first.`,
    );
  }
  for (const row of binding.agents) {
    lines.push(erc8004AgentLine(row, week));
  }
  return lines;
}

function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function erc8004AgentLine(row: SellerErc8004BindingRow, week: string): string {
  const bind = row.matchedBy === "wallet_confirmed" ? "wallet_confirmed" : "owner_only";
  return `Agent ${row.agentId} matched payTo ${shortAddress(row.payTo)} (${bind}): ${row.purchases} purchase rows, ${row.settled} settled. Weekly evidence ${erc8004WeeklyHref(row.agentId, week)}.`;
}

export function SellerErc8004SectionView({
  binding,
  week = lastCompleteIsoWeek(),
}: {
  binding: SellerErc8004Binding;
  week?: string;
}) {
  if (binding.status === "none") return null;
  if (binding.status === "unavailable") {
    return (
      <section className="mx-auto mt-8 max-w-[70ch]">
        <h2 className="doc-h2">ERC-8004 agents matching this seller&apos;s payTo</h2>
        <p className="doc-note">ERC-8004 binding counts could not be read from the database. Please reload in a minute.</p>
      </section>
    );
  }
  return (
    <section className="mx-auto mt-8 max-w-[70ch]">
      <h2 className="doc-h2">ERC-8004 agents matching this seller&apos;s payTo</h2>
      <p className="doc-p">
        {ERC8004_SECTION_DEFINITION}
{" "}
        The match rule is on{" "}
        <Link className="underline" href="/observatory/methodology#erc8004">
          the methodology page
        </Link>
        . The{" "}
        <Link className="underline" href="/docs/api">
          ERC-8004 check API
        </Link>{" "}
        tests the payment proof on a feedback entry from any client.
      </p>
      <>
        {binding.totalAgents > binding.agents.length ? (
            <p className="doc-note mt-3">
              Showing {binding.agents.length} of {binding.totalAgents} matched agents. wallet_confirmed rows are listed first.
            </p>
          ) : null}
          <ul className="mt-3 list-disc pl-6">
            {binding.agents.map((row) => (
              <li key={`${row.agentId}:${row.payTo}`} className="doc-p">
                Agent{" "}
                <span className="font-mono text-sm">{row.agentId}</span> matched payTo{" "}
                <span className="font-mono text-sm">{shortAddress(row.payTo)}</span> (
                <span className="font-mono text-sm">{row.matchedBy}</span>): {row.purchases} purchase rows, {row.settled}{" "}
                settled.{" "}
                <a className="underline" href={erc8004WeeklyHref(row.agentId, week)}>
                  Weekly evidence ({week})
                </a>
              </li>
            ))}
        </ul>
      </>
    </section>
  );
}

export default async function SellerErc8004Section({ host }: { host: string }) {
  const binding = await getSellerErc8004BindingCached(host);
  return <SellerErc8004SectionView binding={binding} />;
}

/** Tests: every exported line must pass public English rules. */
export function assertErc8004SectionCopySafe(lines: string[]): void {
  for (const line of lines) {
    const faults = publicEnglishFaults(line);
    if (faults.length > 0) throw new Error(`${faults.join(",")}: ${line}`);
  }
}