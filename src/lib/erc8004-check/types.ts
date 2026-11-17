export type Erc8004CheckVerdict =
  | "verified"
  | "verified_payment_unlinked_client"
  | "mismatch"
  | "no_proof"
  | "unreadable";

export type Erc8004CheckMismatchReason =
  | "feedback_hash"
  | "tx_not_found"
  | "recipient"
  | "amount"
  | "token";

export type Erc8004CheckTriState = "pass" | "fail" | "unknown";

export type Erc8004CheckChecks = {
  tx_exists: Erc8004CheckTriState;
  to_matches_agent_payTo_or_wallet: Erc8004CheckTriState;
  from_matches_client: Erc8004CheckTriState;
  amount: Erc8004CheckTriState;
  token: Erc8004CheckTriState;
  block_time: Erc8004CheckTriState;
  feedback_hash: Erc8004CheckTriState;
};

export type Erc8004CheckSource = {
  kind: "reputation_registry" | "new_feedback_log" | "feedback_uri" | "payment_chain" | "vet402_erc8004_match" | "identity_registry";
  detail: string;
};

export type Erc8004FeedbackOnChain = {
  chain: string;
  chainId: number;
  agentId: string;
  clientAddress: string;
  feedbackIndex: string;
  value: string;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
  blockNumber: string | null;
  txHash: string | null;
  isRevoked: boolean;
};

export type Erc8004CheckResult = {
  verdict: Erc8004CheckVerdict;
  /** Present when verdict is mismatch — which check failed. */
  reasons?: Erc8004CheckMismatchReason[];
  chain: string;
  agentId: string;
  clientAddress: string;
  feedbackIndex: string;
  feedback: Pick<
    Erc8004FeedbackOnChain,
    "value" | "valueDecimals" | "tag1" | "tag2" | "endpoint" | "feedbackURI" | "feedbackHash"
  >;
  proofOfPayment: Record<string, unknown> | null;
  checks: Erc8004CheckChecks;
  sources: Erc8004CheckSource[];
  as_of: string;
};