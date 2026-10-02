/**
 * Part 3: re-run the formatting benchmark AFTER canonicalization, through
 * the real scoreAnswer() path (not the pure-JS canonicalizeForJudge()
 * function directly) - this proves the actual judge call now receives
 * identical input for cosmetic variants, not just that the string
 * transform looks right in isolation.
 *
 *   node scripts/kev-wasm-export/formatting-test-post-canon.mjs [url]
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const url = process.argv[2] || "http://localhost:5173/";

const browser = await chromium.launch({ executablePath: EDGE_PATHS.find((p) => fs.existsSync(p)), headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[console error]", m.text()); });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

const result = await page.evaluate(async () => {
  const { loadJudge, scoreAnswer, judgeRuntime } = await import("/src/judge.js");
  await loadJudge();

  const prompt = "What can you enter without going in?";
  const statement = `Is the answer a plausible interpretation of the riddle "${prompt}" that resolves its apparent contradiction?`;

  const groups = {
    cosmetic_should_match: ["A room", " a room ", "A  ROOM", "a room.", "A room!", "A room?", "A room,", '"A room"', "(A room)"],
    semantic_must_differ: ["competition", "a competition", "exit", "an exit", "dead-end", "dead end", "don't look back", "dont look back"],
  };

  const out = {};
  for (const [group, answers] of Object.entries(groups)) {
    out[group] = [];
    for (const answer of answers) {
      const verdict = await scoreAnswer({ answer, statement });
      out[group].push({ answer, noul: verdict.noul, score: verdict.score });
    }
  }
  return { runtime: judgeRuntime(), groups: out };
});

console.log("runtime:", JSON.stringify(result.runtime));
for (const [group, rows] of Object.entries(result.groups)) {
  console.log(`\n--- ${group} ---`);
  for (const r of rows) {
    console.log(`  ${JSON.stringify(r.answer).padEnd(24)} noul=${r.noul.toPrecision(12)}  score=${r.score.toFixed(6)}`);
  }
  const scores = rows.map((r) => r.score);
  console.log(`  max-min = ${(Math.max(...scores) - Math.min(...scores)).toFixed(6)}`);
}
await browser.close();
