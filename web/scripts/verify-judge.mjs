/**
 * Verify the real shipped configuration: the gibberish gate plus the real
 * open-jev/kev-0.6b judge, against the required answer set. Same library the
 * browser uses; Node runs it on CPU instead of WebGPU/WASM.
 *
 * No expected scores are hard-coded. This asserts the contract (a real
 * probability in [0,1], integer score, actual separation between answers)
 * and prints everything so a human can sanity-check the judgement itself.
 *
 *   node scripts/verify-judge.mjs
 */
import { OpenJev, noul } from "open-jev";
import { CHALLENGES, scoreFromNoul } from "../../shared/challenges.js";
import { looksLikeRealText } from "../../shared/gibberish.js";

const challenge = CHALLENGES[0];

const ANSWERS = [
  "I ate ice cream in the sunshine and laughed with my friend.",
  "I finally finished my thesis and celebrated with pizza.",
  "My dog farted and everyone started laughing.",
  "I hate everything and today was awful.",
  "asdfghjkl",
  "I robbed a bank.",
  "The sun was beautiful today.",
  "fun happy thought",
  "Yesterday I lost my wallet and cried.",
  "I went swimming with my friend and then ate pizza.",
];

console.log(`statement  : ${challenge.noulStatement}\n`);

const jev = await OpenJev.load({ model: "kev-0.6b", dtype: "auto" });
console.log(`loaded on ${jev.runtime.device}, dtype ${jev.runtime.dtype}\n`);

let failures = 0;
const scores = [];

for (const answer of ANSWERS) {
  const gate = looksLikeRealText(answer);
  if (!gate) {
    console.log(`  GATE  blocked (not real text)         ${answer}`);
    continue;
  }

  const started = Date.now();
  const [verdict] = await jev.decide(answer, [noul(challenge.noulStatement)]);
  const ms = Date.now() - started;

  const p = verdict?.probability;
  const ok = verdict?.type === "noul" && typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;
  if (!ok) {
    failures += 1;
    console.log(`  FAIL  ${JSON.stringify(verdict)}  <- ${answer}`);
    continue;
  }

  const score = scoreFromNoul(p);
  if (score !== Math.round(p * 100)) {
    failures += 1;
    console.log(`  FAIL  score/noul mismatch`);
    continue;
  }

  scores.push(score);
  console.log(`  noul=${p.toFixed(4)}  score=${String(score).padStart(3)}  ${ms}ms   ${answer}`);
}

console.log();
console.log(`scored         : ${scores.length}/${ANSWERS.length} (rest blocked by the gibberish gate)`);
console.log(`score range    : ${Math.min(...scores)} .. ${Math.max(...scores)}`);
console.log(`distinct scores: ${new Set(scores).size}`);

// The one hard requirement the gate exists for: pure keymash must not reach
// the judge and must not produce a score at all.
const gibberishGated = !looksLikeRealText("asdfghjkl");
if (!gibberishGated) {
  console.log("FAIL: gibberish gate did not block asdfghjkl");
  failures += 1;
}
if (new Set(scores).size < 3) {
  console.log("FAIL: the judge is not discriminating between answers");
  failures += 1;
}

await jev.dispose();
console.log(failures === 0 ? "\nALL CONTRACT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
