/**
 * Part 2: controlled formatting-canonicalization experiment. Loads the real
 * judge once (current production path: WebGPU, explicit dtype:"q4") and
 * scores every variant in the same session.
 *
 *   node scripts/kev-wasm-export/formatting-test-v2.mjs [url]
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));

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
    // CASE 1 - capitalization
    case1_capitalization: ["A room", "a room", "A ROOM", "a RoOm"],
    // CASE 2 - leading/trailing whitespace
    case2_leading_trailing_ws: ["A room", " A room", "A room ", "  A room  "],
    // CASE 3 - internal whitespace
    case3_internal_ws: ["A room", "A  room", "A   room"],
    // CASE 4 - punctuation
    case4_punctuation: ["A room", "A room.", "A room!", "A room?", "A room,"],
    // CASE 5 - combinations
    case5_combinations: ["A room", "  a room.", "A  ROOM!", " a room,  "],
    // CASE 6 - semantic/article (kept separate, NOT assumed equivalent)
    case6_articles: ["competition", "a competition", "exit", "an exit"],
    // PART 2C adversarial: punctuation that is part of the word/meaning,
    // not merely decorative - does stripping it change what was said?
    case7_adversarial_punctuation: [
      "a dead-end",      // hyphenated compound - stripping hyphen: "a dead end" (arguably same meaning)
      "a dead end",      // the un-hyphenated form, for direct comparison
      "don't look back", // contraction apostrophe - stripping: "dont look back"
      "dont look back",  // the apostrophe-stripped form, for direct comparison
      "4pm",             // no punctuation, baseline
      "4 p.m.",          // abbreviation periods that are NOT sentence-final
    ],
    // PART 2C adversarial: short vs multi-word, to see if whitespace/punct
    // effects scale differently.
    case8_adversarial_length: ["exit", "exit.", "the exit to the building", "the exit to the building."],
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
    console.log(`  ${JSON.stringify(r.answer).padEnd(28)} noul=${r.noul.toPrecision(10)}  score=${r.score.toFixed(4)}`);
  }
  const scores = rows.map((r) => r.score);
  console.log(`  max-min = ${(Math.max(...scores) - Math.min(...scores)).toFixed(4)}`);
}

fs.writeFileSync(path.join(here, "formatting_results_v2.json"), JSON.stringify(result, null, 2));
await browser.close();
