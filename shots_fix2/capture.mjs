import { chromium } from "playwright";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.SHOTS_BASE ?? "http://localhost:3099";
const widths = [390, 1280];
const themes = [
  { suffix: "light", colorScheme: "light" },
  { suffix: "dark", colorScheme: "dark" },
];
const pages = [
  { name: "home", url: `${base}/` },
  { name: "connect", url: `${base}/connect` },
  { name: "docs-mcp", url: `${base}/docs/mcp` },
  { name: "check-a-seller", url: `${base}/x402/check-a-seller` },
  { name: "observatory-state", url: `${base}/observatory/state` },
];

mkdirSync(__dirname, { recursive: true });
const browser = await chromium.launch();
for (const w of widths) {
  for (const theme of themes) {
    const context = await browser.newContext({
      viewport: { width: w, height: w === 390 ? 844 : 800 },
      colorScheme: theme.colorScheme,
    });
    const page = await context.newPage();
    for (const p of pages) {
      if (p.name !== "home" && theme.suffix === "dark") continue;
      await page.goto(p.url, { waitUntil: "networkidle", timeout: 120000 });
      await page.waitForTimeout(400);
      const file = path.join(__dirname, `${p.name}_${w}_${theme.suffix}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log("wrote", file);
    }
    await context.close();
  }
}
await browser.close();