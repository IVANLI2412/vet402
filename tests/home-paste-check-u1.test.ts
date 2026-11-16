import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { REASON_TEXT, reasonTextOf } from "@/lib/decision/reason-text";
import { formatPriceUsd } from "@/components/site/home/PasteCheck";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://vet402.com/",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.self = dom.window;
g.MouseEvent = dom.window.MouseEvent;
g.IS_REACT_ACT_ENVIRONMENT = true;

let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let PasteCheck: typeof import("@/components/site/home/PasteCheck").PasteCheck;

const css = readFileSync("src/app/home.module.css", "utf8");
const cls: Record<string, string> = {};
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)\s*\{/g)) {
  cls[m[1]!] = m[1]!;
}

const CHECK_URL = "https://api.example.com/v1/quote";
const EXPLORER = "https://basescan.org/tx/0xabc";
const TX = "0x" + "a".repeat(62);

before(async () => {
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ PasteCheck } = await import("@/components/site/home/PasteCheck"));
});

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let fetchCalls: string[];
let originalFetch: typeof fetch;

beforeEach(() => {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo) => {
    const u = String(input);
    fetchCalls.push(u);
    if (u.includes("/api/v1/check")) {
      if (u.includes("fail503")) {
        return Promise.resolve(new Response(JSON.stringify({ error: "x" }), { status: 503 }));
      }
      if (u.includes("rate429")) {
        return Promise.resolve(new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }));
      }
      if (u.includes("not-in-catalog")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              not_in_catalog: true,
              same_host_listings: [
                {
                  url: "https://api.example.com/v1/quote",
                  method: "GET",
                  record_url: "https://vet402.com/observatory/e/1",
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      if (u.includes("catalog-none")) {
        return Promise.resolve(
          new Response(JSON.stringify({ not_in_catalog: true, same_host_listings: [], record_url: null }), {
            status: 200,
          }),
        );
      }
      if (u.includes("no-delivery-evidence")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              recommendation: "WARN",
              reason_codes: ["l1_stale"],
              reasons: [{ code: "l1_stale", text: reasonTextOf("l1_stale")!, effect: "caps_at_warn", max_recommendation: "WARN", evidence_status: "record", evidence: [] }],
              evidence_age: { last_delivered_at: null, days_since_last_delivery: null, last_paid_test_at: "2026-11-01T09:00:00.000Z", tier: "stale", max_recommendation: "WARN", waived_by_caller: false, fresh_within_days: 7, stale_after_days: 30, text: "x" },
              delivery: { delivered: 0, paid_attempts: 2, window_days: 30, last_attempt_at: "2026-11-01T09:00:00.000Z" },
              l1_purchases: [
                { attempted_at: "2026-11-01T09:00:00.000Z", tx_hash: TX, explorer_url: EXPLORER, status: "settled" },
              ],
              record_url: "https://vet402.com/observatory/e/99",
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            recommendation: "ALLOW",
            reason_codes: ["l0_pass"],
            reasons: [{ code: "l0_pass", text: reasonTextOf("l0_pass")!, effect: "none", max_recommendation: "ALLOW", evidence_status: "none", evidence: [] }],
            evidence_age: {
              last_delivered_at: "2026-11-01T09:30:00.000Z",
              days_since_last_delivery: 1,
              last_paid_test_at: "2026-11-01T09:30:00.000Z",
              tier: "fresh",
              max_recommendation: "ALLOW",
              waived_by_caller: false,
              fresh_within_days: 7,
              stale_after_days: 30,
              text: "x",
            },
            delivery: { delivered: 8, paid_attempts: 10, window_days: 30, last_attempt_at: "2026-11-01T09:00:00.000Z" },
            l1_purchases: [
              {
                attempted_at: "2026-11-01T09:30:00.000Z",
                tx_hash: TX,
                explorer_url: EXPLORER,
                status: "settled",
              },
            ],
            record_url: "https://vet402.com/observatory/e/99",
          }),
          { status: 200 },
        ),
      );
    }
    if (u.includes("/api/v1/find")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            alternatives: [
              {
                url: "https://alt.example/search",
                delivered_30d: 20,
                paid_attempts_30d: 20,
                last_paid_test_at: "2026-11-05",
                record_url: "https://vet402.com/observatory/e/2",
                price_usd: 0.01,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

function unmount() {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
}

async function submit(url: string) {
  const input = dom.window.document.querySelector('input[name="url"]') as HTMLInputElement;
  const form = dom.window.document.querySelector("form") as HTMLFormElement;
  const setVal = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setVal.call(input, url);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await act(async () => {
    form.requestSubmit();
    await new Promise((r) => setTimeout(r, 80));
  });
}

test("invalid http URL shows guidance without fetch", async () => {
  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit("http://api.example.com/v1/quote");
  const live = dom.window.document.querySelector("[aria-live]");
  assert.match(live?.textContent ?? "", /Paste a full https URL/);
  assert.equal(fetchCalls.length, 0);
  unmount();
});

test("ALLOW verdict, tx link, and reason text appear", async () => {
  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit(CHECK_URL);
  const text = dom.window.document.body.textContent ?? "";
  assert.match(text, /ALLOW/);
  assert.match(text, /l0_pass/);
  assert.ok(text.includes(reasonTextOf("l0_pass")!));
  assert.match(text, /Last delivered paid test/);
  assert.match(text, /2026-11-01 09:30 UTC/);
  const link = dom.window.document.querySelector(`a[href="${EXPLORER}"]`);
  assert.ok(link);
  assert.match(link!.textContent ?? "", /\.\.\.|…/);
  assert.ok(fetchCalls.some((c) => c.includes("/api/v1/check")));
  assert.ok(fetchCalls.some((c) => c.includes("/api/v1/find")));
  unmount();
});

test("verdict appears while find is still pending", async () => {
  let resolveFind: (res: Response) => void = () => {};
  const heldFind = new Promise<Response>((r) => {
    resolveFind = r;
  });
  globalThis.fetch = ((input: RequestInfo) => {
    const u = String(input);
    fetchCalls.push(u);
    if (u.includes("/api/v1/check")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            recommendation: "ALLOW",
            reason_codes: ["l0_pass"],
            evidence_age: { last_delivered_at: "2026-11-01T09:30:00.000Z", tier: "fresh", max_recommendation: "ALLOW", waived_by_caller: false, fresh_within_days: 7, stale_after_days: 30, text: "x" },
            delivery: { delivered: 8, paid_attempts: 10, window_days: 30, last_attempt_at: "2026-11-01T09:00:00.000Z" },
            l1_purchases: [
              {
                attempted_at: "2026-11-01T09:30:00.000Z",
                tx_hash: TX,
                explorer_url: EXPLORER,
                status: "settled",
              },
            ],
            record_url: "https://vet402.com/observatory/e/99",
          }),
          { status: 200 },
        ),
      );
    }
    if (u.includes("/api/v1/find")) return heldFind;
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls, timeoutMs: 60_000 }));
  });
  await submit(CHECK_URL);
  const mid = dom.window.document.body.textContent ?? "";
  assert.match(mid, /ALLOW/);
  assert.match(mid, /2026-11-01 09:30 UTC/);
  assert.doesNotMatch(mid, /alt\.example/);
  assert.doesNotMatch(mid, /Alternatives could not be read/);

  await act(async () => {
    resolveFind(
      new Response(
        JSON.stringify({
          alternatives: [
            {
              url: "https://alt.example/search",
              delivered_30d: 20,
              paid_attempts_30d: 20,
              record_url: "https://vet402.com/observatory/e/2",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await new Promise((r) => setTimeout(r, 80));
  });
  assert.match(dom.window.document.body.textContent ?? "", /alt\.example/);
  unmount();
});

test("find timeout yields alternatives read error", async () => {
  globalThis.fetch = ((input: RequestInfo, init?: RequestInit) => {
    const u = String(input);
    fetchCalls.push(u);
    if (u.includes("/api/v1/check")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            recommendation: "ALLOW",
            reason_codes: ["l0_pass"],
            evidence_age: { last_delivered_at: "2026-11-01T09:30:00.000Z", tier: "fresh", max_recommendation: "ALLOW", waived_by_caller: false, fresh_within_days: 7, stale_after_days: 30, text: "x" },
            delivery: { delivered: 8, paid_attempts: 10, window_days: 30 },
            l1_purchases: [
              { attempted_at: "2026-11-01T09:30:00.000Z", tx_hash: TX, explorer_url: EXPLORER, status: "settled" },
            ],
            record_url: "https://vet402.com/observatory/e/99",
          }),
          { status: 200 },
        ),
      );
    }
    if (u.includes("/api/v1/find")) {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new dom.window.DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new dom.window.DOMException("Aborted", "AbortError"));
        });
      });
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls, timeoutMs: 40 }));
  });
  await submit(CHECK_URL);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
  assert.match(dom.window.document.body.textContent ?? "", /Alternatives could not be read/);
  unmount();
});

test("not_in_catalog and 503 and 429 messages", async () => {
  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit("https://api.example.com/not-in-catalog");
  const notCat = dom.window.document.body.textContent ?? "";
  assert.match(notCat, /This host has 1 recorded listing\b/);
  assert.doesNotMatch(notCat, /This host has 1 recorded listings/);
  assert.match(notCat, /\/v1\/quote/);
  assert.doesNotMatch(notCat, /No record yet/);
  assert.doesNotMatch(notCat, /Check before paying, one line/);
  assert.doesNotMatch(notCat, /alt\.example/);

  await submit("https://api.example.com/catalog-none");
  assert.match(dom.window.document.body.textContent ?? "", /api\/v1\/diagnose\?url=/);

  await submit("https://api.example.com/fail503");
  assert.match(dom.window.document.body.textContent ?? "", /could not read its records/);

  await submit("https://api.example.com/rate429");
  assert.match(dom.window.document.body.textContent ?? "", /Too many checks/);
  unmount();
});

test("form uses noValidate so http URL is caught without browser validation", async () => {
  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  const form = dom.window.document.querySelector("form") as HTMLFormElement;
  assert.equal(form.noValidate, true);
  await submit("http://api.example.com/v1/quote");
  assert.equal(fetchCalls.length, 0);
  unmount();
});

test("formatPriceUsd", () => {
  assert.equal(formatPriceUsd(0.01), "$0.01");
  assert.equal(formatPriceUsd(1.234), "$1.23");
  assert.equal(formatPriceUsd(0.001), "$0.001");
  assert.equal(formatPriceUsd(0.0025), "$0.0025");
});
test("the copied line does not carry userinfo from the pasted URL", () => {
  const src = readFileSync("src/components/site/home/PasteCheck.tsx", "utf8");
  assert.match(src, /setSubmittedUrl\(fetchQueryUrl\(v\)\)/);
  assert.doesNotMatch(src, /submittedUrl\.current/);
});

test("no last_delivered_at hides attempt dates and shows delivered copy", async () => {
  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit("https://api.example.com/no-delivery-evidence");
  const text = dom.window.document.body.textContent ?? "";
  assert.doesNotMatch(text, /2026-11-01 09:00 UTC/);
  assert.doesNotMatch(text, /2026-11-01 09:30 UTC/);
  assert.match(text, /No delivered paid test yet/);
  unmount();
});

test("rendered reason copy and REASON_TEXT have no semicolons", async () => {
  for (const text of Object.values(REASON_TEXT)) {
    assert.doesNotMatch(text, /;/, `REASON_TEXT: ${text.slice(0, 40)}`);
  }
  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit(CHECK_URL);
  const fixed = [
    "Paste a full https URL, for example https://api.example.com/v1/quote.",
    "That is not an https URL vet402 can look up.",
    "Too many checks from this network. Try again in a minute.",
    "vet402 could not read its records just now. Try again shortly.",
    "vet402 has not paid this URL yet. Run a live check:",
    "Alternatives could not be read just now.",
    "Checking",
  ];
  for (const line of fixed) assert.doesNotMatch(line, /;/);
  for (const li of dom.window.document.querySelectorAll(`.${cls.pasteReasons} li`)) {
    assert.doesNotMatch(li.textContent ?? "", /;/, "reason row");
  }
  unmount();
});

test("home hero has at most one pill CTA class and PasteCheck has one submit", () => {
  const page = readFileSync("src/app/page.tsx", "utf8");
  const hero = page.slice(page.indexOf('className={s.hero}'), page.indexOf("<PasteCheck"));
  const pillClasses = [...hero.matchAll(/className=\{s\.(btn|btnQuiet)\}/g)];
  assert.ok(pillClasses.length <= 1, `hero pill classes: ${pillClasses.length}`);
  const paste = readFileSync("src/components/site/home/PasteCheck.tsx", "utf8");
  const submits = [...paste.matchAll(/type="submit"/g)];
  assert.equal(submits.length, 1);
});

test("the live verdict line is screen-reader only, so the card's Verdict is the one visible verdict", async () => {
  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit(CHECK_URL);
  const doc = dom.window.document;
  const live = doc.querySelector('[aria-live="polite"]');
  assert.ok(live, "aria-live region");
  const liveVerdict = live!.querySelector('[data-testid="paste-live-verdict"]');
  assert.ok(liveVerdict, "live verdict line");
  assert.match(liveVerdict!.textContent ?? "", /Verdict ALLOW/);
  assert.equal(liveVerdict!.className, "sr-only");
  // 見える文字（sr-only の外）で Verdict の欄は1つだけ。
  const visible = [...doc.querySelectorAll("dt, p, span")].filter(
    (el) => !el.closest(".sr-only") && /^\s*Verdict\b/.test(el.textContent ?? ""),
  );
  assert.equal(visible.length, 1, visible.map((el) => el.outerHTML).join("\n"));
  assert.equal(visible[0]!.tagName, "DT");
  unmount();
});

test("same_host summary is visible once with singular listing copy", async () => {
  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit("https://api.example.com/not-in-catalog");
  const block = dom.window.document.querySelector('[data-testid="paste-same-host"]');
  assert.ok(block);
  assert.equal(block!.getAttribute("aria-live"), "polite");
  const summary = dom.window.document.querySelector('[data-testid="paste-same-host-summary"]');
  assert.ok(summary);
  assert.match(summary!.textContent ?? "", /This host has 1 recorded listing\b/);
  const duplicateLive = [...dom.window.document.querySelectorAll('[data-testid="paste-live-verdict"]')].some((el) =>
    /recorded listing/.test(el.textContent ?? ""),
  );
  assert.equal(duplicateLive, false, "live region must not repeat the visible same-host summary");
  unmount();
});
