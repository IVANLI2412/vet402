// adversary-5: フィードバック本文が名乗った受取先は pass の根拠にしない（r3/adversary/a6）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVerdict, evaluateRecipientCheck, triFromMatchesClient } from "@/lib/erc8004-check/verdict";
import { declaredAgentPayees } from "@/lib/erc8004-check/feedback-uri";

const CLIENT = "0x00000000000000000000000000000000000000c1";
const Y = "0x00000000000000000000000000000000000000e2";

test("self-declared payee in feedback JSON does not pass recipient check", () => {
  const feedbackJson = { seller: { payTo: Y }, proofOfPayment: { txHash: "0x" + "ab".repeat(32), from: CLIENT, to: Y } };
  const declared = declaredAgentPayees(feedbackJson);
  assert.deepEqual(declared, [Y]);
  const recipient = evaluateRecipientCheck(Y, Y, "evm", () => false);
  assert.equal(recipient, "fail");
  const v = decideVerdict(
    {
      feedback_hash: "pass",
      tx_exists: "pass",
      to_matches_agent_payTo_or_wallet: recipient,
      amount: "pass",
      token: "pass",
      block_time: "pass",
      from_matches_client: triFromMatchesClient(CLIENT, CLIENT),
    },
    true,
  );
  assert.notEqual(v.verdict, "verified");
});