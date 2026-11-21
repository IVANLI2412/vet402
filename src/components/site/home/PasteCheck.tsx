"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { reasonTextOf } from "@/lib/decision/reason-text";
import { NO_RECORD_NEXT, verdictNextStep } from "@/lib/decision/verdict-next-step";
import { mcpCheckPromptForUrl } from "@/lib/docs/mcp-first-prompts";
import { beforePaySnippets, BEFORE_PAY_MCP_LINE } from "@/lib/find/snippets";
import { HOME_PASTE_EXAMPLE_URL } from "@/lib/site/paste-example-url";
import { isPublicExplorerTxUrl } from "@/lib/observatory/chains";

type CheckBody = {
  recommendation?: string | null;
  reason_codes?: string[];
  reasons?: Array<{ code: string; text: string }>;
  evidence_age?: {
    last_delivered_at?: string | null;
  } | null;
  delivery?: {
    paid_attempts?: number;
    delivered?: number;
    window_days?: number;
    last_attempt_at?: string | null;
  };
  l1_purchases?: Array<{
    attempted_at?: string;
    network?: string;
    status?: string;
    tx_hash?: string | null;
    explorer_url?: string | null;
  }>;
  not_in_catalog?: boolean;
  record_url?: string;
  same_host_listings?: Array<{
    url: string;
    method?: string;
    record_url?: string;
    catalog_status?: string;
  }>;
};

type FindAlt = {
  url: string;
  seller_description?: string | null;
  delivered_30d: number;
  paid_attempts_30d: number;
  last_paid_test_at?: string | null;
  price_usd?: number | null;
  record_url: string;
};

type FindBody = {
  alternatives?: FindAlt[];
};

function utcStamp(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${h}:${mi} UTC`;
}

function utcDay(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso.slice(0, 10);
  return iso.slice(0, 10);
}

function shortTx(tx: string): string {
  if (tx.length <= 20) return tx;
  return `${tx.slice(0, 10)}…${tx.slice(-6)}`;
}

function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function listingPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function pathFilterTerms(raw: string): string[] {
  try {
    return new URL(raw).pathname.split("/").filter((p) => p.length >= 3);
  } catch {
    return [];
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function filterAlternativesByPath(alts: FindAlt[], raw: string): FindAlt[] {
  const terms = pathFilterTerms(raw);
  if (terms.length === 0) return [];
  const termSet = new Set(terms.map((t) => t.toLowerCase()));
  return alts.filter((alt) => {
    try {
      const segments = pathSegments(new URL(alt.url).pathname.toLowerCase());
      return segments.some((seg) => termSet.has(seg));
    } catch {
      return false;
    }
  });
}

const DIAGNOSE_EXTRA_ENCODE = new Set(["!", "'", "(", ")", "*"]);

const EXAMPLE_X402_URL = HOME_PASTE_EXAMPLE_URL;
const HINT_ID = "lp-paste-hint";

function deliveredRate(alt: FindAlt): number | null {
  if (alt.paid_attempts_30d <= 0) return null;
  return alt.delivered_30d / alt.paid_attempts_30d;
}

function filterAlternativesHigherDelivery(alts: FindAlt[], check: CheckBody): FindAlt[] {
  const paid = check.delivery?.paid_attempts ?? 0;
  const delivered = check.delivery?.delivered ?? 0;
  const currentRate = paid > 0 ? delivered / paid : null;
  if (currentRate === null) return alts;
  return alts.filter((alt) => {
    const rate = deliveredRate(alt);
    return rate !== null && rate > currentRate;
  });
}

const RECORD_UPDATE_NOTE =
  "The record updates after each purchase. Open it to get an email when it changes.";

function encodeDiagnoseQueryComponent(raw: string): string {
  const enc = encodeURIComponent(fetchQueryUrl(raw));
  let out = "";
  for (const c of enc) {
    if (DIAGNOSE_EXTRA_ENCODE.has(c)) {
      out += `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
    } else {
      out += c;
    }
  }
  return out;
}

function diagnoseCurlLine(raw: string): string {
  return `curl -s "https://vet402.com/api/v1/diagnose?url=${encodeDiagnoseQueryComponent(raw)}"`;
}

type PasteOutcome = "record" | "same_host" | "none";

export function recordedListingsLine(count: number): string {
  const noun = count === 1 ? "listing" : "listings";
  return `This host has ${count} recorded ${noun}.`;
}

function pasteOutcomeOf(check: CheckBody | null): PasteOutcome | null {
  if (!check) return null;
  if (!check.not_in_catalog) return "record";
  if ((check.same_host_listings?.length ?? 0) > 0) return "same_host";
  return "none";
}

function sameUtcSecond(a: string, b: string): boolean {
  const ta = Math.floor(new Date(a).getTime() / 1000);
  const tb = Math.floor(new Date(b).getTime() / 1000);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

export function formatPriceUsd(value: number): string {
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  const sig2 = Number(value.toPrecision(2));
  return `$${String(sig2)}`;
}

function vet402RecordHref(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "vet402.com") return null;
    if (u.username !== "" || u.password !== "") return null;
    return u.href;
  } catch {
    return null;
  }
}

function fetchQueryUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.href;
  } catch {
    return raw;
  }
}

function reasonLine(code: string, check: CheckBody): string {
  const fromApi = check.reasons?.find((r) => r.code === code)?.text;
  if (fromApi) return fromApi;
  return reasonTextOf(code) ?? code;
}

function purchaseAtDeliveredSecond(check: CheckBody) {
  const at = check.evidence_age?.last_delivered_at;
  if (!at) return null;
  for (const row of check.l1_purchases ?? []) {
    if (row.attempted_at && sameUtcSecond(row.attempted_at, at)) return row;
  }
  return null;
}

function lastDeliveredPaidTestLabel(check: CheckBody): string {
  const at = check.evidence_age?.last_delivered_at;
  if (at) return utcStamp(at);
  const attempts = check.delivery?.paid_attempts ?? 0;
  return attempts === 0 ? "No paid test yet" : "No delivered paid test yet";
}

function VerdictMark({ verdict, cls }: { verdict: string; cls: Record<string, string> }) {
  if (verdict === "ALLOW") {
    return <span className={cls.pasteVerdictMarkAllow} aria-hidden />;
  }
  if (verdict === "WARN") {
    return <span className={cls.pasteVerdictMarkWarn} aria-hidden />;
  }
  return (
    <span className={cls.pasteVerdictMarkBlock} aria-hidden>
      <span>×</span>
    </span>
  );
}

export function PasteCheck({
  cls: s,
  timeoutMs = 10_000,
}: {
  cls: Record<string, string>;
  timeoutMs?: number;
}) {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "result">("idle");
  const [hint, setHint] = useState<string | null>(null);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckBody | null>(null);
  const [findErr, setFindErr] = useState(false);
  const [alts, setAlts] = useState<FindAlt[] | null>(null);
  const [findSettled, setFindSettled] = useState(false);
  const [codeTab, setCodeTab] = useState<"ts" | "curl" | "mcp">("ts");
  const [copied, setCopied] = useState(false);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [inputInvalid, setInputInvalid] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [submittedUrl, setSubmittedUrl] = useState("");

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const v = url.trim();
      let parsed: URL;
      try {
        parsed = new URL(v);
      } catch {
        setPhase("result");
        setInputInvalid(true);
        setHint(`Paste a full https URL, for example ${EXAMPLE_X402_URL}.`);
        setCheck(null);
        setCheckErr(null);
        setAlts(null);
        setFindSettled(false);
        setFindErr(false);
        return;
      }
      if (parsed.protocol !== "https:") {
        setPhase("result");
        setInputInvalid(true);
        setHint(`Paste a full https URL, for example ${EXAMPLE_X402_URL}.`);
        setCheck(null);
        setCheckErr(null);
        setAlts(null);
        setFindSettled(false);
        setFindErr(false);
        return;
      }

      setInputInvalid(false);
      track("home_paste_submit", { r: "internal" });

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      setSubmittedUrl(fetchQueryUrl(v));
      setPhase("loading");
      setHint(null);
      setCheck(null);
      setCheckErr(null);
      setAlts(null);
      setFindSettled(false);
      setFindErr(false);

      const enc = encodeURIComponent(fetchQueryUrl(v));
      const checkP = fetch(`/api/v1/check?url=${enc}`, { signal: ac.signal })
        .then(async (res) => {
          if (res.status === 400) return { err: "That is not an https URL vet402 can look up." as const, body: null };
          if (res.status === 429)
            return { err: "Too many checks from this network. Try again in a minute." as const, body: null };
          if (res.status === 503 || !res.ok)
            return { err: "vet402 could not read its records just now. Try again shortly." as const, body: null };
          return { err: null, body: (await res.json()) as CheckBody };
        })
        .catch(() => {
          if (ac.signal.aborted) {
            return {
              err: "The check took more than 10 seconds and was stopped. Try again." as const,
              body: null,
            };
          }
          return { err: "vet402 could not read its records just now. Try again shortly." as const, body: null };
        })
        .then((checkOut) => {
          if (abortRef.current !== ac) return checkOut;
          setCheck(checkOut.body);
          setCheckErr(checkOut.err);
          setPhase("result");
          if (!checkOut.err && checkOut.body) {
            const outcomeState = pasteOutcomeOf(checkOut.body);
            if (outcomeState) track("home_result_state", { r: outcomeState });
          }
          return checkOut;
        });

      const findP = fetch(`/api/v1/find?url=${enc}`, { signal: ac.signal })
        .then(async (res) => {
          if (abortRef.current !== ac) return;
          if (!res.ok) {
            setFindErr(true);
            setFindSettled(true);
            return;
          }
          const body = (await res.json()) as FindBody;
          setAlts(body.alternatives ?? []);
          setFindSettled(true);
        })
        .catch(() => {
          if (abortRef.current !== ac) return;
          setFindErr(true);
          setFindSettled(true);
        });

      await Promise.all([checkP, findP]);
      clearTimeout(timer);
    },
    [url, timeoutMs],
  );

  const snippets = submittedUrl ? beforePaySnippets(submittedUrl) : [];
  const activeSnippet = snippets.find((x) => x.id === codeTab) ?? snippets[0];

  const copyCode = () => {
    const text = activeSnippet?.code;
    if (!text || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(text).then(
      () => {
        track("home_snippet_copy", { r: "internal" });
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };

  const verdict = check?.recommendation ?? null;
  const deliveryPurchase = check ? purchaseAtDeliveredSecond(check) : null;
  const lastDeliveredAt = check?.evidence_age?.last_delivered_at ?? null;
  const recordHref = check ? vet402RecordHref(check.record_url) : null;

  const sameHostListings =
    check?.not_in_catalog && (check.same_host_listings?.length ?? 0) > 0 ? check.same_host_listings! : null;

  const outcome: PasteOutcome | null =
    phase === "result" && !hint && !checkErr && check
      ? check.not_in_catalog
        ? sameHostListings
          ? "same_host"
          : "none"
        : "record"
      : null;

  const recordAlts =
    outcome === "record" && alts && check
      ? filterAlternativesHigherDelivery(alts, check).slice(0, 3)
      : [];
  const sameHostAlts =
    outcome === "same_host" && submittedUrl && alts ? filterAlternativesByPath(alts, submittedUrl).slice(0, 3) : [];
  const displayAlts = outcome === "same_host" ? sameHostAlts : recordAlts;

  const showRecordCard = outcome === "record";
  const showAlternatives =
    (outcome === "record" && verdict !== "ALLOW") ||
    (outcome === "same_host" && sameHostAlts.length > 0);
  const showBeforePayCode = outcome === "record" && submittedUrl;
  const mcpPromptLine = submittedUrl ? mcpCheckPromptForUrl(submittedUrl) : "";

  const fillExample = () => {
    setUrl(EXAMPLE_X402_URL);
    setInputInvalid(false);
    setHint(null);
    setPhase("idle");
  };

  const retryCheck = () => {
    setCheckErr(null);
    setPhase("idle");
  };

  return (
    <div className={s.paste}>
      <form className={s.pasteForm} onSubmit={onSubmit} noValidate>
        <label className={s.pasteLabel} htmlFor="lp-paste-url">
          Paste an x402 URL
        </label>
        <div className={s.pasteRow}>
          <input
            id="lp-paste-url"
            className={s.pasteInput}
            type="url"
            name="url"
            inputMode="url"
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-clarity-mask="true"
            placeholder={EXAMPLE_X402_URL}
            value={url}
            aria-invalid={inputInvalid ? true : undefined}
            aria-describedby={hint && inputInvalid ? HINT_ID : undefined}
            onChange={(ev) => {
              setUrl(ev.target.value);
              if (inputInvalid) setInputInvalid(false);
            }}
          />
          <button type="submit" className={`${s.btn} ${s.pasteGo}`} aria-busy={phase === "loading" ? true : undefined}>
            Check
          </button>
        </div>
      </form>

      {phase === "result" && (
        <>
          <div className={s.pasteLive} aria-live="polite">
            {hint ? (
              <p id={HINT_ID} className={s.pasteHintId}>
                {hint}
              </p>
            ) : checkErr ? (
              <div className={s.pasteBlock}>
                <p className={s.pasteStatus}>{checkErr}</p>
                <button type="button" className={`${s.btn} ${s.pasteRetry}`} onClick={retryCheck}>
                  Try again
                </button>
              </div>
            ) : verdict && check && !check.not_in_catalog ? (
              <p className="sr-only" data-testid="paste-live-verdict">
                Verdict {verdict}
              </p>
            ) : outcome === "none" ? (
              <p className="sr-only" data-testid="paste-live-verdict">
                No record
              </p>
            ) : outcome === "same_host" && sameHostListings ? (
              <p className="sr-only" data-testid="paste-live-verdict">
                This host has {sameHostListings.length} recorded{" "}
                {sameHostListings.length === 1 ? "listing" : "listings"}.
              </p>
            ) : null}
          </div>
          <div className={s.pasteResult}>
            {phase === "result" && outcome === "same_host" && sameHostListings ? (
              <div className={s.pasteBlock} data-testid="paste-same-host">
                <p data-testid="paste-same-host-summary">
                  This host has{" "}
                  <span className={s.mono}>{sameHostListings.length}</span> recorded{" "}
                  {sameHostListings.length === 1 ? "listing" : "listings"}.
                </p>
                <ul className={s.pasteAltList}>
                  {sameHostListings.slice(0, 3).map((row) => {
                    const rowRecord = vet402RecordHref(row.record_url);
                    return (
                      <li key={row.url} className={s.pasteAlt}>
                        <span className={s.mono}>{listingPath(row.url)}</span>
                        {row.method ? <span className={s.pasteAltMeta}> · {row.method}</span> : null}
                        {rowRecord ? (
                          <>
                            {" "}
                            <a href={rowRecord} className={s.inlineLink}>
                              Record
                            </a>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {(() => {
                  const headRecord = vet402RecordHref(sameHostListings[0]?.record_url);
                  return (
                    <p className={s.pasteBlock}>
                      The record updates after each purchase.{" "}
                      {headRecord ? (
                        <>
                          <a href={headRecord} className={s.inlineLink}>
                            Open it
                          </a>
                          {" "}
                          to get an email when it changes.
                        </>
                      ) : (
                        "Open it to get an email when it changes."
                      )}
                    </p>
                  );
                })()}
              </div>
            ) : phase === "result" && outcome === "none" ? (
              <div className={s.pasteBlock} data-testid="paste-none">
                <p className={s.pasteStatus}>vet402 has no purchase record for this URL.</p>
                <p>{NO_RECORD_NEXT}</p>
                <pre className={s.pasteCode}>
                  <code>{submittedUrl ? diagnoseCurlLine(submittedUrl) : diagnoseCurlLine(url.trim())}</code>
                </pre>
                <p className={s.pasteBlock}>diagnose reads the 402 now. It does not pay.</p>
                <button type="button" className={s.btn} onClick={fillExample}>
                  Try the example URL
                </button>
              </div>
            ) : phase === "result" && showRecordCard && check ? (
              <dl className={s.recordRows}>
                {verdict ? (
                  <div className={s.pasteVerdict}>
                    <dt>Verdict</dt>
                    <dd>
                      <VerdictMark verdict={verdict} cls={s} />
                      {verdict}
                    </dd>
                    {verdict === "ALLOW" || verdict === "WARN" || verdict === "BLOCK" ? (
                      <dd className={s.pasteNextStep}>{verdictNextStep(verdict)}</dd>
                    ) : null}
                  </div>
                ) : null}
                <div>
                  <dt>Last delivered paid test</dt>
                  <dd>{lastDeliveredPaidTestLabel(check)}</dd>
                </div>
                <div>
                  <dt>Transaction</dt>
                  <dd className={s.mono}>
                    {lastDeliveredAt && deliveryPurchase?.tx_hash ? (
                      isPublicExplorerTxUrl(deliveryPurchase.explorer_url) ? (
                        <a
                          href={deliveryPurchase.explorer_url!}
                          className={s.inlineLink}
                          rel="noopener"
                          target="_blank"
                        >
                          {shortTx(deliveryPurchase.tx_hash)}
                        </a>
                      ) : (
                        shortTx(deliveryPurchase.tx_hash)
                      )
                    ) : lastDeliveredAt && recordHref ? (
                      <a href={recordHref} className={s.inlineLink}>
                        In the full record
                      </a>
                    ) : (
                      "None"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Delivered</dt>
                  <dd>
                    <span className={s.mono}>{check.delivery?.delivered ?? 0}</span> of{" "}
                    <span className={s.mono}>{check.delivery?.paid_attempts ?? 0}</span> paid calls in the last{" "}
                    <span className={s.mono}>{check.delivery?.window_days ?? 30}</span> days
                  </dd>
                </div>
                {(check.reason_codes ?? []).length > 0 ? (
                  <div>
                    <dt>Reasons</dt>
                    <dd>
                      <ul className={s.pasteReasons}>
                        {(check.reason_codes ?? []).slice(0, 4).map((code) => (
                          <li key={code}>
                            {reasonLine(code, check)}{" "}
                            <code className={s.mono}>{code}</code>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ) : null}
                {recordHref ? (
                  <div>
                    <dt>Record</dt>
                    <dd>
                      <a href={recordHref} className={s.inlineLink}>
                        Full record
                      </a>
                      <p className={s.pasteBlock}>{RECORD_UPDATE_NOTE}</p>
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}

            {showRecordCard && check && !check.not_in_catalog ? (
              <p className={s.pasteMeasurementFoot}>This is a measurement. It is not a guarantee.</p>
            ) : null}

            {showAlternatives && (
              <>
                <h2 className={s.pasteAltHead}>Alternatives that delivered more often</h2>
                {findErr ? (
                  <p className={s.pasteBlock}>Alternatives could not be read just now.</p>
                ) : displayAlts.length > 0 ? (
                  <ul className={s.pasteAltList}>
                    {displayAlts.map((alt) => {
                      const altRecordHref = vet402RecordHref(alt.record_url);
                      return (
                        <li key={alt.url} className={s.pasteAlt}>
                          {altRecordHref ? (
                            <a href={altRecordHref} className={`${s.inlineLink} ${s.mono}`}>
                              {hostPath(alt.url)}
                            </a>
                          ) : (
                            <span className={s.mono}>{hostPath(alt.url)}</span>
                          )}
                          {alt.seller_description ? (
                            <p className={s.pasteAltDesc}>{alt.seller_description}</p>
                          ) : null}
                          <p className={s.pasteAltMeta}>
                            <span className={s.mono}>{alt.delivered_30d}</span> of{" "}
                            <span className={s.mono}>{alt.paid_attempts_30d}</span> delivered
                            {alt.last_paid_test_at ? `, last paid test ${utcDay(alt.last_paid_test_at)}` : ""}
                            {alt.price_usd != null ? ` · ${formatPriceUsd(alt.price_usd)}` : ""}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                ) : findSettled && outcome === "record" ? (
                  <p className={s.pasteBlock}>
                    No listing for the same use passed the rule yet.{" "}
                    <Link href="/observatory/methodology#find-ranking" className={s.inlineLink}>
                      How alternatives are ranked
                    </Link>
                  </p>
                ) : null}

                {showBeforePayCode ? (
                  <div className={s.pasteCode}>
                    <p className={s.pasteCodeHead}>Check before paying, one line</p>
                    <div className={s.pasteTabs} role="group" aria-label="Code for">
                      {snippets.map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          className={s.pasteTab}
                          aria-pressed={codeTab === tab.id}
                          onClick={() => setCodeTab(tab.id)}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    <pre>
                      <code>{activeSnippet?.code ?? ""}</code>
                    </pre>
                    {codeTab === "mcp" && mcpPromptLine ? (
                      <>
                        <p className={s.pasteCodeHead}>First question</p>
                        <pre>
                          <code>{mcpPromptLine}</code>
                        </pre>
                        <button
                          type="button"
                          className={s.pasteCopy}
                          onClick={() => {
                            const text = mcpPromptLine;
                            if (!navigator.clipboard?.writeText) return;
                            void navigator.clipboard.writeText(text).then(
                              () => {
                                setMcpCopied(true);
                                setTimeout(() => setMcpCopied(false), 2000);
                              },
                              () => {},
                            );
                          }}
                        >
                          {mcpCopied ? "Copied" : "Copy prompt"}
                        </button>
                        <p className={s.pasteBlock}>
                          Connect: <code className={s.mono}>{BEFORE_PAY_MCP_LINE}</code>
                        </p>
                      </>
                    ) : null}
                    <button type="button" className={s.pasteCopy} onClick={copyCode}>
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}