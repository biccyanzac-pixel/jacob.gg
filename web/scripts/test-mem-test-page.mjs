import { chromium } from "playwright-core";
import fs from "node:fs";
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const url = process.argv[2] || "http://localhost:4173/mem-test.html";

const browser = await chromium.launch({ executablePath: EDGE_PATHS.find((p) => fs.existsSync(p)), headless: true });
const page = await browser.newPage();
page.on("console", (m) => console.log(`[${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.click("#run");
await page.waitForFunction(
  () => (document.getElementById("log")?.textContent ?? "").includes("RESULT:"),
  undefined,
  { timeout: 5 * 60 * 1000, polling: 500 },
);
const text = await page.locator("#log").textContent();
console.log("=== PAGE LOG ===");
console.log(text);
await browser.close();
