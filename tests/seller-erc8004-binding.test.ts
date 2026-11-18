import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeSellerErc8004Agents,
  erc8004WeeklyHref,
  lastCompleteIsoWeek,
  type SellerErc8004RawMatch,
} from "@/lib/sellers/erc8004-binding";

const PAY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function row(
  agentId: string,
  matchKind: SellerErc8004RawMatch["matchKind"],
  purchases = 1,
  settled = 1,
): SellerErc8004RawMatch {
  return { matchKind, agentId, payTo: PAY, purchases, settled };
}

test("finalizeSellerErc8004Agents prefers wallet_confirmed over owner for the same agent and payTo", () => {
  const { agents, totalAgents } = finalizeSellerErc8004Agents([row("7", "owner"), row("7", "agent_wallet")]);
  assert.equal(totalAgents, 1);
  assert.equal(agents[0]!.matchedBy, "wallet_confirmed");
});

test("finalizeSellerErc8004Agents orders wallet_confirmed before owner_only", () => {
  const { agents } = finalizeSellerErc8004Agents([
    row("2", "owner", 5, 3),
    row("1", "agent_wallet", 1, 1),
    row("3", "owner", 10, 10),
    row("4", "agent_wallet", 2, 2),
  ]);
  assert.deepEqual(
    agents.map((a) => [a.agentId, a.matchedBy]),
    [
      ["4", "wallet_confirmed"],
      ["1", "wallet_confirmed"],
      ["3", "owner_only"],
      ["2", "owner_only"],
    ],
  );
});

test("finalizeSellerErc8004Agents caps at 20 and reports the true total", () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(String(i + 1), i % 2 === 0 ? "agent_wallet" : "owner", 1, 0));
  const { agents, totalAgents } = finalizeSellerErc8004Agents(rows);
  assert.equal(totalAgents, 25);
  assert.equal(agents.length, 20);
});

test("check and weekly hrefs use the public API parameter shapes", () => {
  assert.equal(erc8004WeeklyHref("7", "2026-W46"), "/api/v1/observatory/erc8004/weekly/7?week=2026-W46");
});

test("lastCompleteIsoWeek is the ISO week before the current one (UTC)", () => {
  assert.equal(lastCompleteIsoWeek(new Date("2026-11-18T12:00:00.000Z")), "2026-W46");
  assert.equal(lastCompleteIsoWeek(new Date("2026-11-17T00:00:00.000Z")), "2026-W46");
});