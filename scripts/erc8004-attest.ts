// ============================================================
// ERC-8004 段階 D: 週次 giveFeedback の空実行または本送信（--send）。
//
// 既定は空実行（tx なし）。鍵は --send かつ ERC8004_ATTEST_ENABLED=1 のときだけ読む。
// DATABASE_URL が無ければ state API と export / weekly HTTP だけで計画を組む。
// ============================================================
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getDb } from "../src/lib/db/client";
import { fetchAgentIdentity } from "../src/lib/chain/erc8004";
import {
  ERC8004_ATTEST_MAX_AGENTS,
  ERC8004_ATTEST_MAX_GAS_WEI,
  REPUTATION_REGISTRY_ABI,
  attestRegistryAddress,
  ledgerHasAgent,
  planAttestAgent,
  selectAttestTargets,
  weeklyFeedbackUri,
  writerMustNotBeAgentOwner,
  writerMustNotBePurchasePayer,
  wouldExceedGasBudget,
  type AttestLedger,
  type AttestAgentPlan,
} from "../src/lib/observatory/erc8004-attest";
import { isoWeekUtcBounds } from "../src/lib/observatory/erc8004-feedback";
import type { Erc8004Match } from "../src/lib/observatory/erc8004-match";
import { readPurchasesForErc8004AgentWeek } from "../src/lib/observatory/erc8004-purchase-match";
import { DEFAULT_MAX_FEE_GWEI } from "../src/lib/chain/registry-dryrun";
import { parseGwei } from "viem";
import { fileURLToPath } from "node:url";

const DEFAULT_STATE_URL = "https://vet402.com/api/v1/observatory/state";
const DEFAULT_SITE_ORIGIN = "https://vet402.com";
const DEFAULT_KEY_FILE = path.join(process.env.HOME ?? "", ".vet402", "erc8004-writer.json");
const DRY_RUN_WRITER = "0x000000000000000000000000000000000000c0de" as Address;

const GIVE_FEEDBACK_FALLBACK_GAS = 180_000n;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  return path.resolve(SCRIPT_DIR, "..");
}

// 台帳は worktree の外（~/.vet402）に 1 つだけ置く。どの checkout から走らせても同じ台帳を見るので、
// 同じ週・同じ agent に 2 回書かない。送る前に pending を書き、落ちても次の走りで同じ agent を飛ばす。
function ledgerPath(week: string): string {
  const dir = process.env.ERC8004_ATTEST_LEDGER_DIR?.trim() || path.join(process.env.HOME ?? repoRoot(), ".vet402", "erc8004-attest");
  return path.join(dir, `${week}.json`);
}

function readLedger(week: string): AttestLedger | null {
  const p = ledgerPath(week);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as AttestLedger;
  } catch {
    return null;
  }
}

function writeLedger(week: string, ledger: AttestLedger): void {
  const p = ledgerPath(week);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, p);
}

type StateErc8004 = {
  status: string;
  matches?: Erc8004Match[];
};

async function fetchState(stateUrl: string): Promise<StateErc8004> {
  const res = await fetch(stateUrl, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`state_http_${res.status}`);
  const body = (await res.json()) as { erc8004?: StateErc8004 };
  if (!body.erc8004) throw new Error("state_missing_erc8004");
  return body.erc8004;
}

async function fetchWeeklyCanonical(siteOrigin: string, agentId: string, week: string): Promise<string> {
  const url = weeklyFeedbackUri(siteOrigin, agentId, week);
  // 公開の上限（429）に当たったら Retry-After（無ければ 15 秒）待って取り直す。11/17 の空実行で 89 件中 38 件が 429 だった。
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 429) {
      const wait = Math.min(Math.max(Number(res.headers.get("retry-after")) || 15, 1), 65);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`weekly_http_${res.status}`);
    return res.text();
  }
  throw new Error("weekly_http_429");
}

function makePublicClient(rpcUrl: string) {
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });
}

type BasePublicClient = ReturnType<typeof makePublicClient>;

async function estimateGiveFeedbackGas(
  client: BasePublicClient,
  from: Address,
  plan: AttestAgentPlan,
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: REPUTATION_REGISTRY_ABI,
    functionName: "giveFeedback",
    args: [
      plan.agentIdBigInt,
      plan.value,
      plan.valueDecimals,
      plan.tag1,
      plan.tag2,
      plan.endpoint,
      plan.feedbackURI,
      plan.feedbackHash,
    ],
  });
  try {
    return await client.estimateGas({
      account: from,
      to: attestRegistryAddress(),
      data,
    });
  } catch {
    return GIVE_FEEDBACK_FALLBACK_GAS;
  }
}

async function simulateGiveFeedback(
  client: BasePublicClient,
  from: Address,
  plan: AttestAgentPlan,
): Promise<{ ok: boolean; error?: string }> {
  const data = encodeFunctionData({
    abi: REPUTATION_REGISTRY_ABI,
    functionName: "giveFeedback",
    args: [
      plan.agentIdBigInt,
      plan.value,
      plan.valueDecimals,
      plan.tag1,
      plan.tag2,
      plan.endpoint,
      plan.feedbackURI,
      plan.feedbackHash,
    ],
  });
  try {
    await client.call({
      account: from,
      to: attestRegistryAddress(),
      data,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

type WriterKeyFile = { address?: string; privateKey?: string };

function writerKeyFile(): string {
  return process.env.ERC8004_WRITER_KEY_FILE?.trim() || DEFAULT_KEY_FILE;
}

function readWriterAddress(send: boolean): Address {
  const keyFile = writerKeyFile();
  if (send) {
    if (!fs.existsSync(keyFile)) throw new Error("writer_key_missing");
    const parsed = JSON.parse(fs.readFileSync(keyFile, "utf8")) as WriterKeyFile;
    if (!parsed.address || !parsed.privateKey) throw new Error("writer_key_invalid");
    return parsed.address.toLowerCase() as Address;
  }
  const env = process.env.ERC8004_WRITER_ADDRESS?.trim();
  if (env) return env.toLowerCase() as Address;
  // 空実行でも鍵ファイルがあればその住所で eth_call する（秘密鍵は読まない）。
  if (fs.existsSync(keyFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(keyFile, "utf8")) as WriterKeyFile;
      if (parsed.address) return parsed.address.toLowerCase() as Address;
    } catch {
      /* 空実行は仮の住所で続ける */
    }
  }
  return DRY_RUN_WRITER;
}

/** 送信のときだけ秘密鍵を読む。住所が鍵ファイルの address と違えば止める。鍵は表示しない。 */
function loadWriterAccount(expected: Address) {
  const parsed = JSON.parse(fs.readFileSync(writerKeyFile(), "utf8")) as WriterKeyFile;
  const account = privateKeyToAccount(parsed.privateKey as Hex);
  if (account.address.toLowerCase() !== expected.toLowerCase()) throw new Error("writer_key_address_mismatch");
  return account;
}

async function main() {
  const week = arg("week");
  if (!week) {
    console.error("Usage: npm run erc8004:attest -- --week YYYY-Www [--send]");
    process.exit(1);
  }
  const bounds = isoWeekUtcBounds(week);
  if (!bounds) {
    console.error("invalid_week");
    process.exit(1);
  }

  const send = flag("send");
  const stateUrl = process.env.VET402_STATE_URL?.trim() || DEFAULT_STATE_URL;
  const siteOrigin = process.env.VET402_SITE_ORIGIN?.trim() || DEFAULT_SITE_ORIGIN;
  const rpcUrl = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
  const skipRpc = flag("skip-rpc") || process.env.ERC8004_ATTEST_SKIP_RPC === "1";

  let writer: Address;
  try {
    writer = readWriterAddress(send);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  if (writerMustNotBePurchasePayer(writer)) {
    console.error("abort: writer_is_purchase_payer");
    process.exit(1);
  }

  if (send && process.env.ERC8004_ATTEST_ENABLED !== "1") {
    console.error("abort: ERC8004_ATTEST_ENABLED is not 1");
    process.exit(1);
  }

  const state = await fetchState(stateUrl);
  if (state.status !== "ok" || !state.matches) {
    console.error("erc8004_unavailable");
    process.exit(1);
  }

  const targets = selectAttestTargets(state.matches).slice(0, ERC8004_ATTEST_MAX_AGENTS);
  const ledger = readLedger(week);

  console.log(
    JSON.stringify({
      mode: send ? "send" : "dry_run",
      week,
      period: { from: bounds.start.toISOString(), to: bounds.end.toISOString() },
      writer,
      targetAgents: targets.length,
    }),
  );

  if (targets.length === 0) {
    console.log(JSON.stringify({ planned: 0, message: "no_agent_wallet_targets" }));
    return;
  }

  const db = process.env.DATABASE_URL ? getDb() : null;
  const client = skipRpc ? null : makePublicClient(rpcUrl);
  const feeCeiling = parseGwei(String(process.env.REGISTRY_MAX_FEE_GWEI ?? DEFAULT_MAX_FEE_GWEI));
  // 予算と送信の上限は「今の gasPrice の 3 倍」と上限の小さい方（11/17 実測: Base 0.006 gwei に対し上限 0.5 gwei は 80 倍で、
  // 予算 0.0005 ETH が 4 件で尽きた）。
  const gasPriceNow = client ? await client.getGasPrice() : feeCeiling;
  const maxFee = gasPriceNow * 3n < feeCeiling ? gasPriceNow * 3n : feeCeiling;

  let gasBudget = ERC8004_ATTEST_MAX_GAS_WEI;
  const plans: AttestAgentPlan[] = [];
  const skipped: Record<string, number> = {};

  for (const match of targets) {
    if (ledgerHasAgent(ledger, match.agentId)) {
      skipped.already_written = (skipped.already_written ?? 0) + 1;
      continue;
    }

    let rows;
    if (db) {
      rows = await readPurchasesForErc8004AgentWeek(
        db,
        BigInt(match.agentId),
        8453,
        bounds.start,
        bounds.end,
      );
    } else {
      skipped.no_database = (skipped.no_database ?? 0) + 1;
      continue;
    }

    let canonical: string;
    try {
      canonical = await fetchWeeklyCanonical(siteOrigin, match.agentId, week);
    } catch {
      skipped.weekly_fetch = (skipped.weekly_fetch ?? 0) + 1;
      continue;
    }

    const planned = planAttestAgent({
      match,
      week,
      siteOrigin,
      rows,
      canonicalWeeklyBody: canonical,
      alreadyWritten: false,
    });

    if ("skipReason" in planned) {
      const reason = planned.skipReason;
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }

    if (client) {
      try {
        const identity = await fetchAgentIdentity(planned.agentIdBigInt);
        if (writerMustNotBeAgentOwner(writer, identity.owner)) {
          skipped.writer_is_owner = (skipped.writer_is_owner ?? 0) + 1;
          continue;
        }
      } catch {
        skipped.identity_unavailable = (skipped.identity_unavailable ?? 0) + 1;
        continue;
      }

      const gas = await estimateGiveFeedbackGas(client, writer, planned);
      const cost = gas * maxFee;
      if (wouldExceedGasBudget(gasBudget, cost)) {
        skipped.gas_budget = (skipped.gas_budget ?? 0) + 1;
        break;
      }
      gasBudget -= cost;

      const sim = await simulateGiveFeedback(client, writer, planned);
      if (!sim.ok) {
        skipped.eth_call_revert = (skipped.eth_call_revert ?? 0) + 1;
        continue;
      }
    }

    plans.push(planned);
  }

  for (const p of plans) {
    console.log(
      JSON.stringify({
        agentId: p.agentId,
        settled: p.population.settled,
        delivered: p.population.delivered,
        inconclusiveSettled: p.population.inconclusiveSettled,
        ratePercent: p.population.ratePercent,
        value: p.value.toString(),
        feedbackURI: p.feedbackURI,
        feedbackHash: p.feedbackHash,
        proofTxHash: p.proofTxHash,
        eth_call: skipRpc ? "skipped" : "ok",
      }),
    );
  }

  console.log(
    JSON.stringify({
      planned: plans.length,
      skipped,
      gasBudgetRemainingWei: gasBudget.toString(),
      gasBudgetUsedWei: (ERC8004_ATTEST_MAX_GAS_WEI - gasBudget).toString(),
      maxFeePerGasWei: maxFee.toString(),
      sendAttempted: send && !skipRpc,
    }),
  );

  if (!send) return;
  if (!client || skipRpc) {
    console.error("abort: send needs RPC (drop --skip-rpc)");
    process.exit(1);
  }
  if (plans.length === 0) return;

  const account = loadWriterAccount(writer);
  const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  const balance = await client.getBalance({ address: writer });
  console.log(JSON.stringify({ writerBalanceWei: balance.toString() }));

  const book: AttestLedger = ledger ?? { week, agents: [] };
  let sent = 0;
  for (const p of plans) {
    if (ledgerHasAgent(book, p.agentId)) continue;
    // 送る前に pending を残す。tx の結果が分からないまま落ちても、次の走りでこの agent に二度書かない。
    book.agents.push({ agentId: p.agentId, status: "pending" });
    writeLedger(week, book);
    const entry = book.agents[book.agents.length - 1]!;
    try {
      const hash = await wallet.writeContract({
        address: attestRegistryAddress(),
        abi: REPUTATION_REGISTRY_ABI,
        functionName: "giveFeedback",
        args: [p.agentIdBigInt, p.value, p.valueDecimals, p.tag1, p.tag2, p.endpoint, p.feedbackURI, p.feedbackHash],
        maxFeePerGas: maxFee,
      });
      entry.txHash = hash;
      writeLedger(week, book);
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      entry.status = receipt.status === "success" ? "written" : "reverted";
      book.writtenAt = new Date().toISOString();
      writeLedger(week, book);
      console.log(JSON.stringify({ agentId: p.agentId, txHash: hash, status: entry.status, url: `https://basescan.org/tx/${hash}` }));
      if (entry.status !== "written") {
        console.error("abort: reverted; stop the run and look before retrying");
        process.exit(1);
      }
      sent += 1;
    } catch (e) {
      // 送ったかどうか分からない失敗は pending のまま残す（手で basescan を見てから台帳を直す）。
      writeLedger(week, book);
      console.error(`abort: send_failed agent=${p.agentId} ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      process.exit(1);
    }
  }
  console.log(JSON.stringify({ sent, ledger: ledgerPath(week) }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});