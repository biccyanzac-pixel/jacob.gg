/**
 * Parts 6/7: does superficial formatting (case, whitespace, punctuation)
 * change the judge's score, versus genuine wording differences (articles)?
 * Loads the judge once (real production path: WebGPU, dtype auto) and
 * scores every variant in the same session so results are directly
 * comparable - no reload/re-init noise between them.
 *
 *   node scripts/kev-wasm-export/formatting-test.mjs [url]
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
    capitalization: ["a competition", "A competition", "A COMPETITION"],
    whitespace: ["a competition", "  a competition", "a   competition", "a\tcompetition"],
    punctuation: [
      "a competition",
      "a competition.",
      "a competition!",
      "a competition?",
      '"a competition"',
      "(a competition)",
    ],
    article_exit: ["exit", "an exit", "Exit", "exit.", "an exit."],
    article_competition: ["competition", "a competition", "Competition", "competition.", "a competition."],
  };

  const out = {};
  for (const [group, answers] of Object.entries(groups)) {
    out[group] = [];
    for (const answer of answers) {
      const verdict = await scoreAnswer({ answer, statement });
      out[group].push({ answer: JSON.stringify(answer), noul: verdict.noul, score: verdict.score });
    }
  }
  return { runtime: judgeRuntime(), groups: out };
});

console.log("runtime:", JSON.stringify(result.runtime));
for (const [group, rows] of Object.entries(result.groups)) {
  console.log(`\n--- ${group} ---`);
  for (const r of rows) {
    console.log(`  ${r.answer.padEnd(22)} noul=${r.noul.toPrecision(10)}  score=${r.score.toFixed(4)}`);
  }
  const scores = rows.map((r) => r.score);
  console.log(`  max-min = ${(Math.max(...scores) - Math.min(...scores)).toFixed(4)}`);
}

await browser.close();
