// ============================================================
// TableScroll（2026-09-02 デザイン監査 P1: 表が紙幅 665px を超え、主要列が初期非表示）。
// 先頭列を紙面に貼り付け、右に続きがあるときだけ「→ N more columns」を出す。
// ============================================================
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { TableScroll } from "@/components/site/TableScroll";

let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;

before(async () => {
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
});

function render() {
  return renderToStaticMarkup(
    createElement(
      TableScroll,
      { label: "t" } as Parameters<typeof TableScroll>[0],
      createElement("table", { className: "fact-table" }, createElement("tbody", null, createElement("tr", null, createElement("td", null, "a"), createElement("td", null, "b")))),
    ),
  );
}

test("first column of a fact table is sticky on the paper", () => {
  // renderToStaticMarkup は属性の & を &amp; にする
  const html = render().replace(/&amp;/g, "&");
  assert.match(html, /\[&_\.fact-table_td:first-child\]:sticky/);
  assert.match(html, /\[&_\.fact-table_td:first-child\]:left-0/);
  assert.match(html, /\[&_\.fact-table_td:first-child\]:bg-paper/);
  assert.match(html, /\[&_\.fact-table_th:first-child\]:sticky/);
});

test("the overflow hint is omitted until the client measures hidden columns", () => {
  const html = render();
  assert.doesNotMatch(html, /data-table-scroll-hint/);
  const src = readFileSync("src/components/site/TableScroll.tsx", "utf8");
  assert.match(src, /hiddenColumns > 0/);
  assert.match(src, /aria-hidden="true"/);
  assert.match(src, /data-table-scroll-hint=""/);
  assert.match(src, /more \{hiddenColumns === 1 \? "column" : "columns"\}/);
  assert.doesNotMatch(src, /hidden=\{hiddenColumns === 0\}/);
});

test("when hidden columns are measured, the hint shows count, plural copy, and aria-hidden", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://vet402.com/",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.self = dom.window;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  class ResizeObserverStub {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe() {
      this.cb([], this as unknown as ResizeObserver);
    }
    disconnect() {}
  }
  g.ResizeObserver = ResizeObserverStub;

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const table = createElement(
    "table",
    { className: "fact-table" },
    createElement(
      "thead",
      null,
      createElement("tr", null, createElement("th", null, "a"), createElement("th", null, "b"), createElement("th", null, "c")),
    ),
    createElement("tbody", null, createElement("tr", null, createElement("td", null, "1"), createElement("td", null, "2"), createElement("td", null, "3"))),
  );

  await act(async () => {
    root.render(
      createElement(TableScroll, { label: "Columns" } as Parameters<typeof TableScroll>[0], table),
    );
  });

  const region = dom.window.document.querySelector(".table-scroll") as HTMLElement;
  assert.ok(region);
  Object.defineProperty(region, "scrollWidth", { configurable: true, value: 600 });
  Object.defineProperty(region, "clientWidth", { configurable: true, value: 200 });
  Object.defineProperty(region, "scrollLeft", { configurable: true, value: 0 });
  const regionRight = 200;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const tag = this.tagName.toLowerCase();
    if (tag === "th") {
      const idx = Array.from(this.parentElement?.children ?? []).indexOf(this);
      return { left: idx === 0 ? 0 : regionRight + 10, right: idx === 0 ? 80 : regionRight + 50, top: 0, bottom: 20, width: 80, height: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    if (this === region) {
      return { left: 0, right: regionRight, top: 0, bottom: 100, width: regionRight, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };

  await act(async () => {
    region.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });

  const html = container.innerHTML;
  assert.match(html, /data-table-scroll-hint=""/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /2 more columns/);
  act(() => root.unmount());
  container.remove();
});
