// adversary-5: フィードバック本文が名乗った受取先は pass の根拠にしない（r3/adversary/a6）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRecipient, decideVerdict, evaluateRecipientCheck, triFromMatchesClient } from "@/lib/erc8004-check/verdict";
import { declaredAgentPayees } from "@/lib/erc8004-check/feedback-uri";

const CLIENT = "0x00000000000000000000000000000000000000c1";
const Y = "0x00000000000000000000000000000000000000e2";

test("recipient is unknown when vet402 purchase index has no row", () => {
  const recipient = evaluateRecipientCheck(
    "0x1111111111111111111111111111111111111111",
    null,
    "evm",
    () => false,
    { vet402IndexedPayTo: false },
  );
  assert.equal(recipient, "unknown");
});

test("self-declared payee in feedback JSON does not pass recipient check", () => {
  const feedbackJson = { seller: { payTo: Y }, proofOfPayment: { txHash: "0x" + "ab".repeat(32), from: CLIENT, to: Y } };
  const declared = declaredAgentPayees(feedbackJson);
  assert.deepEqual(declared, [Y]);
  const recipient = evaluateRecipientCheck(Y, Y, "evm", () => false, { vet402IndexedPayTo: true });
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
// 11/22 証明の監査 whitehat-R5-3 / adversary-N3: 対応表に行が無く、宛先が owner でも agentWallet でもない支払いを
// 「verified」の語で通さない。mismatch（非難）にもしない。
test("payment to neither owner nor agentWallet, no index row → payment_recipient_unverified (not verified, not mismatch)", () => {
  const C = "0x00000000000000000000000000000000000000c3";
  const recipient = classifyRecipient(C, null, "evm", () => false, { vet402IndexedPayTo: false });
  assert.equal(recipient, "unconfirmed");
  const checks = {
    feedback_hash: "pass",
    tx_exists: "pass",
    to_matches_agent_payTo_or_wallet: "unknown",
    amount: "pass",
    token: "pass",
    block_time: "pass",
    from_matches_client: triFromMatchesClient(CLIENT, "0x00000000000000000000000000000000000000a1"),
  } as const;
  const v = decideVerdict(checks, true, { recipientUnconfirmed: true });
  assert.equal(v.verdict, "payment_recipient_unverified");
  assert.ok(!v.verdict.includes("verified_payment"));
  // 対照: 宛先が分からない理由が「別の網の記録」など unconfirmed でなければ、従来どおり unlinked_client。
  assert.equal(decideVerdict(checks, true).verdict, "verified_payment_unlinked_client");
});

test("classifyRecipient: with an index row the same payment is a fail (mismatch), as before", () => {
  const C = "0x00000000000000000000000000000000000000c3";
  assert.equal(classifyRecipient(C, null, "evm", () => false, { vet402IndexedPayTo: true }), "fail");
  assert.equal(evaluateRecipientCheck(C, null, "evm", () => false, { vet402IndexedPayTo: false }), "unknown");
});
