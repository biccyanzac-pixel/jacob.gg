/**
 * Verify the judge against the required answer set, using the same library and
 * the same model the browser uses (open-jev + kev-0.6b). Node runs it on the
 * CPU backend; the browser runs the identical graph on WebGPU/WASM.
 *
 * No expected scores are hard-coded: this prints what the model actually
 * returns and only asserts the contract (a real probability in [0,1] that
 * converts to an integer score, and that it is not generated prose).
 *
 *   node scripts/verify-judge.mjs
 */
import { OpenJev, noul } from "open-jev";
import { CHALLENGES, scoreFromNoul } from "../../shared/challenges.js";

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

const info = await OpenJev.info({ model: "kev-0.6b", dtype: "auto" });
console.log(`model      : kev-0.6b`);
console.log(`dtype      : ${info.dtype}`);
console.log(`device     : ${info.device}`);
console.log(`cached     : ${info.isCached}`);
console.log(`download   : ${(Number(info.downloadSize) / 1024 / 1024).toFixed(0)} MB`);
console.log(`statement  : ${challenge.noulStatement}`);
console.log();

const loadStart = Date.now();
const jev = await OpenJev.load({
  model: "kev-0.6b",
  dtype: "auto",
  onProgress: ({ progress }) => {
    if (Math.round(progress * 100) % 25 === 0) {
      process.stdout.write(`\rdownloading ${Math.round(progress * 100)}%   `);
    }
  },
});
console.log(`\nloaded in ${((Date.now() - loadStart) / 1000).toFixed(1)}s on ${jev.runtime.device}\n`);

let failures = 0;
const results = [];

for (const answer of ANSWERS) {
  const started = Date.now();
  const [verdict] = await jev.decide(answer, [noul(challenge.noulStatement)]);
  const ms = Date.now() - started;

  const p = verdict?.probability;
  const ok =
    verdict?.type === "noul" &&
    typeof p === "number" &&
    Number.isFinite(p) &&
    p >= 0 &&
    p <= 1 &&
    typeof verdict.answer === "boolean";

  if (!ok) {
    failures += 1;
    console.log(`FAIL  ${JSON.stringify(verdict)}  <- ${answer}`);
    continue;
  }

  const score = scoreFromNoul(p);
  if (score !== Math.round(p * 100) || !Number.isInteger(score)) {
    failures += 1;
    console.log(`FAIL  score ${score} != round(${p} * 100)`);
    continue;
  }

  results.push({ answer, p, score, ms });
  console.log(
    `  noul=${p.toFixed(4)}  score=${String(score).padStart(3)}  ${String(ms).padStart(5)}ms   ${answer}`,
  );
}

console.log();
const scores = results.map((r) => r.score);
console.log(`answers scored : ${results.length}/${ANSWERS.length}`);
console.log(`score range    : ${Math.min(...scores)} .. ${Math.max(...scores)}`);
console.log(`distinct scores: ${new Set(scores).size}`);
console.log(
  `median latency : ${
    [...results.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(results.length / 2)]
  }ms`,
);

// Contract checks, not opinions about particular answers.
if (new Set(scores).size < 3) {
  console.log("FAIL: the judge is not discriminating between answers");
  failures += 1;
}

await jev.dispose();
console.log(failures === 0 ? "\nALL CONTRACT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
