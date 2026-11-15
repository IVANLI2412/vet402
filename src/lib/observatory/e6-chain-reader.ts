// ============================================================
// E6 用のチェーン読み取り（支払いと E4 エスクロー）。お金は動かさない。
// ============================================================
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  http,
  parseAbiItem,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { base, baseSepolia } from "viem/chains";

export type E6PaymentState = { collected: boolean; capturable: string; refundable: string };

export type EscrowCall = { from: string; selector: string; input: string };

const PAYMENT_INFO_COMPONENTS = [
  { name: "operator", type: "address" },
  { name: "payer", type: "address" },
  { name: "receiver", type: "address" },
  { name: "token", type: "address" },
  { name: "maxAmount", type: "uint120" },
  { name: "preApprovalExpiry", type: "uint48" },
  { name: "authorizationExpiry", type: "uint48" },
  { name: "refundExpiry", type: "uint48" },
  { name: "minFeeBps", type: "uint16" },
  { name: "maxFeeBps", type: "uint16" },
  { name: "feeReceiver", type: "address" },
  { name: "salt", type: "uint256" },
] as const;

export type EscrowCallRead = EscrowCall | "rejected" | "unavailable" | "not_found";

export type TxFacts = {
  from: string;
  to: string;
  status: "success" | "reverted";
  input: string;
};

export type TxFactsRead = TxFacts | "not_found" | "unavailable";

export type AuthorizeAtBlock = {
  hash: string;
  blockNumber: number;
  blockTimestamp: number;
  status: "success" | "reverted";
  input: string;
  paymentInfo: unknown | null;
};

export type AuthorizeAtBlockRead = AuthorizeAtBlock | "not_found" | "rejected" | "unavailable";

export type E6ChainReader = {
  readPaymentState(escrow: string, paymentInfoHash: string): Promise<E6PaymentState | "unavailable">;
  readPaymentStateAtBlock(
    escrow: string,
    paymentInfoHash: string,
    blockNumber: number,
  ): Promise<E6PaymentState | "unavailable">;
  getPaymentInfoHash(escrow: string, paymentInfo: unknown): Promise<string | "unavailable">;
  getEscrowCall(txHash: string, escrow: string): Promise<EscrowCallRead>;
  getTxFacts(txHash: string): Promise<TxFactsRead>;
  getLatestBlockTimestamp(): Promise<number | "unavailable">;
  getLatestBlockNumber(): Promise<number | "unavailable">;
  readAuthorizeAtBlock(txHash: string, escrow: string, blockNumber: number): Promise<AuthorizeAtBlockRead>;
  paymentTxPaysTo(input: {
    txHash: string;
    payer: string;
    payTo: string;
    chain: string;
    minUsdcUnits?: bigint;
  }): Promise<boolean | "unavailable">;
};

export const USDC_BY_CHAIN: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/** 試験向け純粋関数: USDC の Transfer ログだけを支払いとみなす。 */
export function erc20UsdcTransferPaysTo(input: {
  chain: string;
  logAddress: string;
  receiptSuccess: boolean;
  transferFrom: string;
  transferTo: string;
  transferValue?: bigint;
  minValue?: bigint;
  payer: string;
  payTo: string;
}): boolean {
  if (!input.receiptSuccess) return false;
  const usdc = USDC_BY_CHAIN[input.chain];
  if (!usdc || usdc.toLowerCase() !== input.logAddress.toLowerCase()) return false;
  const wantFrom = input.payer.toLowerCase();
  const wantTo = input.payTo.toLowerCase();
  if (input.transferFrom.toLowerCase() !== wantFrom || input.transferTo.toLowerCase() !== wantTo) return false;
  if (input.transferValue !== undefined && input.transferValue <= 0n) return false;
  if (input.minValue !== undefined && input.minValue > 0n) {
    if (input.transferValue === undefined) return false;
    if (input.transferValue < input.minValue) return false;
  }
  return true;
}

/** voided のとき、outcome tx が escrow の reclaim で当該 paymentInfoHash なら reclaimed。 */
export function classifyEscrowCall(input: {
  receipt: { status: string } | null | undefined;
  tx: { to?: string | null; from: string; input?: string } | null | undefined;
  escrow: string;
}): EscrowCall | "rejected" {
  if (!input.tx || !input.receipt) return "rejected";
  if (input.receipt.status !== "success") return "rejected";
  if (input.tx.to?.toLowerCase() !== input.escrow.toLowerCase()) return "rejected";
  const rawInput = input.tx.input ?? "0x";
  const selector = rawInput.length >= 10 ? rawInput.slice(0, 10) : "0x";
  return { from: input.tx.from.toLowerCase(), selector: selector.toLowerCase(), input: rawInput };
}

function txReadRejected(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name ?? "";
  return name === "TransactionNotFoundError" || name === "TransactionReceiptNotFoundError";
}

export function e4OutcomeAfterVoidedTx(input: {
  call: EscrowCall | "unavailable";
  reclaimSelector: string;
  payerWallet: string;
  recordPaymentInfoHash: string | null;
  paymentInfoHashFromCallInput: (input: string) => string | null;
}): "reclaimed" | "voided" {
  if (input.call === "unavailable") return "voided";
  if (input.call.selector.toLowerCase() !== input.reclaimSelector.toLowerCase()) return "voided";
  if (input.call.from.toLowerCase() !== input.payerWallet.toLowerCase()) return "voided";
  if (!input.recordPaymentInfoHash) return "voided";
  const fromCall = input.paymentInfoHashFromCallInput(input.call.input);
  if (!fromCall) return "voided";
  if (fromCall.toLowerCase() !== input.recordPaymentInfoHash.toLowerCase()) return "voided";
  return "reclaimed";
}

const ESCROW_ABI = [
  {
    type: "function",
    name: "authorize",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentInfo", type: "tuple", components: PAYMENT_INFO_COMPONENTS },
      { name: "amount", type: "uint256" },
      { name: "token", type: "address" },
      { name: "collectorData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reclaim",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentInfo", type: "tuple", components: PAYMENT_INFO_COMPONENTS }],
    outputs: [],
  },
  {
    type: "function",
    name: "paymentState",
    stateMutability: "view",
    inputs: [{ name: "paymentInfoHash", type: "bytes32" }],
    outputs: [
      { name: "hasCollectedPayment", type: "bool" },
      { name: "capturableAmount", type: "uint120" },
      { name: "refundableAmount", type: "uint120" },
    ],
  },
  {
    type: "function",
    name: "getHash",
    stateMutability: "view",
    inputs: [
      {
        name: "paymentInfo",
        type: "tuple",
        components: PAYMENT_INFO_COMPONENTS,
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

export const AUTH_CAPTURE_ESCROW_ABI = ESCROW_ABI;
export const AUTH_CAPTURE_RECLAIM_SELECTOR = toFunctionSelector(
  ESCROW_ABI.find((x) => x.type === "function" && x.name === "reclaim")!,
);
export const AUTH_CAPTURE_AUTHORIZE_SELECTOR = toFunctionSelector(
  ESCROW_ABI.find((x) => x.type === "function" && x.name === "authorize")!,
);

export type E6TestChainReader = E6ChainReader;

export function decodeAuthorizePaymentInfo(input: string): unknown | null {
  try {
    const decoded = decodeFunctionData({
      abi: AUTH_CAPTURE_ESCROW_ABI,
      data: input as Hex,
    });
    if (decoded.functionName !== "authorize") return null;
    return decoded.args[0];
  } catch {
    return null;
  }
}

export function decodeAuthorizeAmount(input: string): string | null {
  try {
    const decoded = decodeFunctionData({
      abi: AUTH_CAPTURE_ESCROW_ABI,
      data: input as Hex,
    });
    if (decoded.functionName !== "authorize") return null;
    const amount = decoded.args[1];
    if (typeof amount === "bigint") return amount.toString();
    return null;
  } catch {
    return null;
  }
}

/** 買い手端の payment_tx が escrow の authorize で当該 tradeId を入金したか。 */
export async function validatePayerAuthorizeTx(
  reader: E6ChainReader,
  input: { tradeId: string; paymentTx: string; escrow: string },
): Promise<"ok" | "rejected" | "unavailable"> {
  const call = await reader.getEscrowCall(input.paymentTx, input.escrow);
  if (call === "unavailable") return "unavailable";
  if (call === "not_found" || call === "rejected") return "rejected";
  if (call.selector.toLowerCase() !== AUTH_CAPTURE_AUTHORIZE_SELECTOR.toLowerCase()) {
    return "rejected";
  }
  const paymentInfo = decodeAuthorizePaymentInfo(call.input);
  if (!paymentInfo) return "rejected";
  const hash = await reader.getPaymentInfoHash(input.escrow, paymentInfo);
  if (hash === "unavailable") return "unavailable";
  if (hash.toLowerCase() !== input.tradeId.toLowerCase()) return "rejected";
  const state = await reader.readPaymentState(input.escrow, input.tradeId);
  if (state === "unavailable") return "unavailable";
  if (!state.collected) return "rejected";
  return "ok";
}

/** 買い手の財布から送られた tx が、この取引を escrow に入金していないか（採掘済み・from が payer）。 */
export async function payerTxDoesNotFundTrade(
  reader: E6ChainReader,
  input: { tradeId: string; paymentTx: string; escrow: string; payer: string },
): Promise<boolean | "unavailable" | "not_found"> {
  const facts = await reader.getTxFacts(input.paymentTx);
  if (facts === "unavailable") return "unavailable";
  if (facts === "not_found") return "not_found";
  if (facts.from.toLowerCase() !== input.payer.toLowerCase()) return false;
  const funded = await validatePayerAuthorizeTx(reader, {
    tradeId: input.tradeId,
    paymentTx: input.paymentTx,
    escrow: input.escrow,
  });
  if (funded === "unavailable") return "unavailable";
  if (funded === "ok") return false;
  return true;
}

/** reclaim の calldata から PaymentInfo タプルを取り出す（試験とハッシュ照合用）。 */
export function decodeReclaimPaymentInfo(input: string): unknown | null {
  try {
    const decoded = decodeFunctionData({
      abi: AUTH_CAPTURE_ESCROW_ABI,
      data: input as Hex,
    });
    if (decoded.functionName !== "reclaim") return null;
    return decoded.args[0];
  } catch {
    return null;
  }
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

let readerOverride: E6ChainReader | null = null;

export function setE6ChainReaderForTests(reader: E6ChainReader | null): void {
  readerOverride = reader;
}

function rpcForChain(chain: string): string | null {
  // Base Sepolia は viem の既定の公開 RPC（sepolia.base.org）を使う。testnet だけなので env を増やさない。
  if (chain === "eip155:84532") return null;
  if (chain === "eip155:8453") {
    const url = process.env.BASE_RPC_URL?.trim();
    return url ? url : null;
  }
  return null;
}

function clientForChain(chain: string) {
  const viemChain = chain === "eip155:84532" ? baseSepolia : chain === "eip155:8453" ? base : null;
  if (!viemChain) return null;
  const rpc = rpcForChain(chain);
  if (chain === "eip155:8453" && !rpc) return null;
  const transport = rpc
    ? http(rpc, { timeout: 12_000, retryCount: 1 })
    : http(undefined, { timeout: 12_000, retryCount: 1 });
  return createPublicClient({ chain: viemChain, transport });
}

function blockNum(blockNumber: number): bigint {
  return BigInt(blockNumber);
}

/** ピンしたブロック N の時点で authorize tx が見えるか（未採掘または N より後なら不可）。 */
export function authorizeTxVisibleAtBlock(
  txBlock: bigint | null | undefined,
  pinnedBlock: number,
): boolean {
  if (txBlock === null || txBlock === undefined) return false;
  return txBlock <= BigInt(pinnedBlock);
}

async function readPaymentStateImpl(
  client: ReturnType<typeof createPublicClient>,
  escrow: string,
  paymentInfoHash: string,
  blockNumber?: number,
): Promise<E6PaymentState | "unavailable"> {
  try {
    const raw = await client.readContract({
      address: escrow as Address,
      abi: ESCROW_ABI,
      functionName: "paymentState",
      args: [paymentInfoHash as Hex],
      ...(blockNumber !== undefined ? { blockNumber: blockNum(blockNumber) } : {}),
    });
    const rec = raw as unknown as Record<string | number, unknown>;
    const collected = rec.hasCollectedPayment ?? rec[0];
    const capturable = rec.capturableAmount ?? rec[1];
    const refundable = rec.refundableAmount ?? rec[2];
    if (typeof collected !== "boolean") return "unavailable";
    const cap = asUnits(capturable);
    const ref = asUnits(refundable);
    if (!cap || !ref) return "unavailable";
    return { collected, capturable: cap, refundable: ref };
  } catch {
    return "unavailable";
  }
}

function asUnits(v: unknown): string | null {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return v;
  return null;
}

export function productionE6ChainReader(chain: string): E6ChainReader | null {
  const client = clientForChain(chain);
  if (!client) return null;
  return {
    async readPaymentState(escrow, paymentInfoHash) {
      return readPaymentStateImpl(client as ReturnType<typeof createPublicClient>, escrow, paymentInfoHash);
    },
    async readPaymentStateAtBlock(escrow, paymentInfoHash, blockNumber) {
      return readPaymentStateImpl(
        client as ReturnType<typeof createPublicClient>,
        escrow,
        paymentInfoHash,
        blockNumber,
      );
    },
    async getPaymentInfoHash(escrow, paymentInfo) {
      try {
        const hash = await client.readContract({
          address: escrow as Address,
          abi: ESCROW_ABI,
          functionName: "getHash",
          args: [paymentInfo] as never,
        });
        return String(hash).toLowerCase();
      } catch {
        return "unavailable";
      }
    },
    async getEscrowCall(txHash, escrow) {
      try {
        const tx = await client.getTransaction({ hash: txHash as Hex });
        const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
        return classifyEscrowCall({ receipt, tx, escrow });
      } catch (error) {
        if (txReadRejected(error)) return "not_found";
        return "unavailable";
      }
    },
    async getTxFacts(txHash) {
      try {
        const tx = await client.getTransaction({ hash: txHash as Hex });
        const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
        return {
          from: tx.from.toLowerCase(),
          to: (tx.to ?? "0x0000000000000000000000000000000000000000").toLowerCase(),
          status: receipt.status === "success" ? "success" : "reverted",
          input: tx.input,
        };
      } catch (error) {
        if (txReadRejected(error)) return "not_found";
        return "unavailable";
      }
    },
    async getLatestBlockTimestamp() {
      try {
        const block = await client.getBlock({ blockTag: "latest" });
        return Number(block.timestamp);
      } catch {
        return "unavailable";
      }
    },
    async getLatestBlockNumber() {
      try {
        const block = await client.getBlock({ blockTag: "latest" });
        return Number(block.number);
      } catch {
        return "unavailable";
      }
    },
    async readAuthorizeAtBlock(txHash, escrow, blockNumber) {
      try {
        const tx = await client.getTransaction({ hash: txHash as Hex });
        const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
        if (!authorizeTxVisibleAtBlock(tx.blockNumber, blockNumber)) return "not_found";
        if (receipt.blockNumber !== tx.blockNumber) return "unavailable";
        if (tx.to?.toLowerCase() !== escrow.toLowerCase()) return "rejected";
        const rawInput = tx.input ?? "0x";
        const selector = rawInput.length >= 10 ? rawInput.slice(0, 10) : "0x";
        if (selector.toLowerCase() !== AUTH_CAPTURE_AUTHORIZE_SELECTOR.toLowerCase()) {
          return "rejected";
        }
        const txBn = tx.blockNumber!;
        const block = await client.getBlock({ blockNumber: txBn });
        const paymentInfo = decodeAuthorizePaymentInfo(rawInput);
        return {
          hash: txHash.toLowerCase(),
          blockNumber: Number(txBn),
          blockTimestamp: Number(block.timestamp),
          status: receipt.status === "success" ? "success" : "reverted",
          input: rawInput,
          paymentInfo,
        };
      } catch (error) {
        if (txReadRejected(error)) return "not_found";
        return "unavailable";
      }
    },
    async paymentTxPaysTo({ txHash, payer, payTo, chain: c, minUsdcUnits }) {
      try {
        const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
        const receiptSuccess = receipt.status === "success";
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
            if (decoded.eventName !== "Transfer") continue;
            const args = decoded.args as { from?: string; to?: string; value?: bigint };
            if (
              erc20UsdcTransferPaysTo({
                chain: c,
                logAddress: log.address,
                receiptSuccess,
                transferFrom: args.from ?? "",
                transferTo: args.to ?? "",
                transferValue: args.value,
                minValue: minUsdcUnits,
                payer,
                payTo,
              })
            ) {
              return true;
            }
          } catch {
            continue;
          }
        }
        return false;
      } catch {
        return "unavailable";
      }
    },
  };
}

/** P2 の書き込みは Base Sepolia のみ。 */
export const E6_SUBMIT_CHAINS = new Set(["eip155:84532"]);

export function getE6ChainReader(chain: string): E6ChainReader | "unavailable" {
  if (readerOverride) return readerOverride;
  if (!E6_SUBMIT_CHAINS.has(chain)) return "unavailable";
  const prod = productionE6ChainReader(chain);
  return prod ?? "unavailable";
}

/** SDK と同じ規則（chain で読めたときだけ voided / not_authorized を言う）。 */
export function outcomeFromPaymentState(state: E6PaymentState): "captured" | "held" | "voided" | "not_authorized" {
  if (!state.collected) return "not_authorized";
  if (BigInt(state.refundable) > 0n) return "captured";
  if (BigInt(state.capturable) > 0n) return "held";
  return "voided";
}
