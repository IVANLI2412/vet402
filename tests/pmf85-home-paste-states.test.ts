import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

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

const BIORXIV_HOME = "https://x402-v2-mint-biorxiv-details.vercel.app/";
const BIORXIV_LISTING = "https://x402-v2-mint-biorxiv-details.vercel.app/v1/biorxiv-details";

before(async () => {
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ PasteCheck } = await import("@/components/site/home/PasteCheck"));
});

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo) => {
    const u = String(input);
    if (u.includes("/api/v1/check")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            not_in_catalog: true,
            record_url: null,
            same_host_listings: [
              {
                url: BIORXIV_LISTING,
                method: "POST",
                catalog_status: "listed",
                record_url: "https://vet402.com/observatory/e/8f5ae9d7-1111-1111-1111-111111111111",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    if (u.includes("/api/v1/find")) {
      return Promise.resolve(new Response(JSON.stringify({ alternatives: [] }), { status: 200 }));
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

test("B-1: biorxiv host top shows /v1/biorxiv-details row without No record yet", async () => {
  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit(BIORXIV_HOME);
  const text = dom.window.document.body.textContent ?? "";
  assert.match(text, /This host has 1 recorded listing\b/);
  assert.doesNotMatch(text, /This host has 1 recorded listings/);
  assert.match(text, /\/v1\/biorxiv-details/);
  assert.match(text, /POST/);
  assert.doesNotMatch(text, /No record yet/);
  const recordLink = dom.window.document.querySelector('[data-testid="paste-same-host"] a[href*="observatory"]');
  assert.ok(recordLink, "same-host row links to record_url");
  assert.ok(dom.window.document.querySelectorAll('[data-testid="paste-same-host"] li').length <= 3);
  unmount();
});

test("B-1: same-host listings cap at three rows when the check returns four", async () => {
  globalThis.fetch = ((input: RequestInfo) => {
    const u = String(input);
    if (u.includes("/api/v1/check")) {
      const listings = [1, 2, 3, 4].map((n) => ({
        url: `https://many.example/v1/route-${n}`,
        method: "GET",
        record_url: `https://vet402.com/observatory/e/${n}`,
      }));
      return Promise.resolve(
        new Response(JSON.stringify({ not_in_catalog: true, record_url: null, same_host_listings: listings }), {
          status: 200,
        }),
      );
    }
    if (u.includes("/api/v1/find")) {
      return Promise.resolve(new Response(JSON.stringify({ alternatives: [] }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit("https://many.example/");
  assert.equal(dom.window.document.querySelectorAll('[data-testid="paste-same-host"] li').length, 3);
  assert.match(dom.window.document.body.textContent ?? "", /This host has 4 recorded listings/);
  unmount();
});

test("B-1: same-host alternatives use path segments, not substring matches", async () => {
  globalThis.fetch = ((input: RequestInfo) => {
    const u = String(input);
    if (u.includes("/api/v1/check")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            not_in_catalog: true,
            record_url: null,
            same_host_listings: [
              {
                url: "https://rapid.example/v1/api-quote",
                method: "GET",
                record_url: "https://vet402.com/observatory/e/a",
              },
            ],
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
                url: "https://alt.example/v1/rapid-pay",
                delivered_30d: 1,
                paid_attempts_30d: 1,
                record_url: "https://vet402.com/observatory/e/r",
              },
              {
                url: "https://alt.example/v1/api-quote",
                delivered_30d: 2,
                paid_attempts_30d: 2,
                record_url: "https://vet402.com/observatory/e/q",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit("https://rapid.example/v1/api-quote");
  const text = dom.window.document.body.textContent ?? "";
  assert.match(text, /alt\.example\/v1\/api-quote/);
  assert.doesNotMatch(text, /rapid-pay/);
  assert.match(text, /Alternatives that delivered more often/);
  unmount();
});

test("B-1: same-host with failed find and no path match omits the Alternatives heading", async () => {
  globalThis.fetch = ((input: RequestInfo) => {
    const u = String(input);
    if (u.includes("/api/v1/check")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            not_in_catalog: true,
            record_url: null,
            same_host_listings: [
              {
                url: "https://host.example/",
                method: "GET",
                record_url: "https://vet402.com/observatory/e/h",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    if (u.includes("/api/v1/find")) {
      return Promise.reject(new Error("find failed"));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit("https://host.example/");
  const text = dom.window.document.body.textContent ?? "";
  assert.match(text, /This host has 1 recorded listing\b/);
  assert.doesNotMatch(text, /Alternatives that delivered more often/);
  unmount();
});

test("B-1: none state shows diagnose curl", async () => {
  globalThis.fetch = ((input: RequestInfo) => {
    const u = String(input);
    if (u.includes("/api/v1/check")) {
      return Promise.resolve(
        new Response(JSON.stringify({ not_in_catalog: true, same_host_listings: [], record_url: null }), {
          status: 200,
        }),
      );
    }
    if (u.includes("/api/v1/find")) {
      return Promise.resolve(new Response(JSON.stringify({ alternatives: [] }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  await act(async () => {
    root.render(React.createElement(PasteCheck, { cls }));
  });
  await submit("https://unknown.example/v1/none");
  const text = dom.window.document.body.textContent ?? "";
  assert.match(text, /vet402 has not paid this URL yet/);
  assert.match(text, /api\/v1\/diagnose\?url=/);
  unmount();
});