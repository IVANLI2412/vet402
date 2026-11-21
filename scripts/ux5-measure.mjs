/**
 * FIX_UX5 measurements: placeholder scrollWidth, HTML bytes, docs/api scroll height.
 * Usage: SKIP_CHAIN_READS=1 npm run build && npm run start (background), then
 *   SHOTS_BASE=http://127.0.0.1:3000 node scripts/ux5-measure.mjs
 */
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { join } from "path";

const base = process.env.SHOTS_BASE ?? "http://127.0.0.1:3000";
const widths = [360, 390, 768, 1024, 1440];

async function placeholderAt(page, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`${base}/`, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const input = document.querySelector("#lp-paste-url");
    if (!input) return null;
    const saved = input.value;
    input.value = input.placeholder;
    const filledScroll = input.scrollWidth;
    const filledClient = input.clientWidth;
    input.value = saved;
    return {
      filledScroll,
      filledClient,
      scrollCut: filledScroll > filledClient + 1,
      pageScrollW: document.documentElement.scrollWidth,
      pageClientW: document.documentElement.clientWidth,
      pageCut: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

async function htmlBytes(path) {
  const res = await fetch(`${base}${path}`, { redirect: "follow" });
  const text = await res.text();
  return Buffer.byteLength(text, "utf8");
}

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ deviceScaleFactor: 1, colorScheme: "light" });
const page = await context.newPage();

const placeholderRows = [];
for (const w of widths) {
  placeholderRows.push({ w, ...(await placeholderAt(page, w, 844)) });
}

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${base}/docs/api`, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(800);
const docsH = await page.evaluate(() => ({
  scrollHeight: document.documentElement.scrollHeight,
  h2: document.querySelectorAll("h2").length,
}));

const html = {
  methodology: await htmlBytes("/observatory/methodology"),
  fixFirst: await htmlBytes("/sellers/fix-first"),
  docsApi: await htmlBytes("/docs/api"),
};

const fixFirstHtml = await (await fetch(`${base}/sellers/fix-first`)).text();
const fixFirstBody = {
  bytes: Buffer.byteLength(fixFirstHtml, "utf8"),
  hasH1: /<h1[^>]*>What to fix first/i.test(fixFirstHtml),
  onlyLoading: /Loading the ledger/.test(fixFirstHtml) && !/<h1[^>]*>What to fix first/i.test(fixFirstHtml),
};

await browser.close();

const out = { placeholderRows, html, docsH, fixFirstBody };
console.log(JSON.stringify(out, null, 2));
writeFileSync(join(process.cwd(), "scripts/ux5-measure-last.json"), JSON.stringify(out, null, 2));