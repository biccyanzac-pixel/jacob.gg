/**
 * Phase 4b (only reached because Phase 3 demonstrated a reproducible failure
 * no single-statement rewording fixed across 10 variants: an answer that
 * merely restates the riddle's own wording scored at or near the top of
 * every riddle, every time - see sweep.mjs's round 1+2 output).
 *
 * Tests ONE combination: primary interpretive-fit noul x secondary
 * not-a-restatement noul, asked in a SINGLE decide() call (one forward pass,
 * two question branches - open-jev's own architecture note: "read the state
 * once and score every option of every question in a single pass"). This is
 * not "multiple model calls"; it is one call with two questions, which is
 * what the task's "avoid unnecessary model calls" constraint is actually
 * about (wall-clock inference time), not the number of noul() entries.
 *
 *   node scripts/riddle-bench/sweep-dual.mjs
 */
import { OpenJev, noul } from "open-jev";
import { RIDDLES } from "./cases.mjs";

const PRIMARY = (r) => `The answer provides a plausible interpretation that makes the riddle "${r}" true.`;
const SECONDARY = (r) =>
  `The answer is different from, and not just a restatement or repetition of, the riddle "${r}".`;

function spearman(tiers, scores) {
  const rank = (values) => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(values.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[order[k][1]] = avgRank;
      i = j + 1;
    }
    return ranks;
  };
  const rTier = rank(tiers);
  const rScore = rank(scores.map((s) => -s));
  const n = tiers.length;
  const meanR = (n + 1) / 2;
  let num = 0, denT = 0, denS = 0;
  for (let i = 0; i < n; i += 1) {
    const dt = rTier[i] - meanR, ds = rScore[i] - meanR;
    num += dt * ds; denT += dt * dt; denS += ds * ds;
  }
  return denT === 0 || denS === 0 ? null : num / Math.sqrt(denT * denS);
}

const MODEL = "kev-0.6b";
const jev = await OpenJev.load({ model: MODEL, dtype: "auto" });
console.log(`model: ${MODEL} on ${jev.runtime.device}, dtype ${jev.runtime.dtype}`);
console.log(`primary:   ${PRIMARY("<riddle>")}`);
console.log(`secondary: ${SECONDARY("<riddle>")}\n`);

const perRiddle = [];
const timings = [];

for (const riddle of RIDDLES) {
  const primaryStmt = PRIMARY(riddle.prompt);
  const secondaryStmt = SECONDARY(riddle.prompt);
  const rows = [];
  for (const c of riddle.cases) {
    const started = performance.now();
    const [p, s] = await jev.decide(c.answer, [noul(primaryStmt), noul(secondaryStmt)]);
    timings.push(performance.now() - started);
    const combined = Math.round(p.probability * s.probability * 10000) / 100;
    rows.push({ ...c, primary: Math.round(p.probability * 10000) / 100, secondary: Math.round(s.probability * 10000) / 100, score: combined });
  }
  rows.sort((a, b) => b.score - a.score);

  const tiers = rows.map((r) => r.tier);
  const scores = rows.map((r) => r.score);
  const good = rows.filter((r) => r.tier <= 4);
  const bad = rows.filter((r) => r.tier >= 7);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanGood = mean(good.map((r) => r.score));
  const meanBad = mean(bad.map((r) => r.score));
  const minGood = Math.min(...good.map((r) => r.score));
  const maxBad = Math.max(...bad.map((r) => r.score));
  const corr = spearman(tiers, scores);
  const over95 = rows.filter((r) => r.score >= 95);
  const badOver95 = over95.filter((r) => r.tier >= 7);
  const topIsGood = rows[0].tier <= 4;

  perRiddle.push({ corr, separation: meanGood - meanBad, overlap: maxBad >= minGood, badOver95: badOver95.length, topIsGood });

  console.log(`--- ${riddle.id} ---  "${riddle.prompt}"`);
  console.log(
    `  corr=${corr?.toFixed(2)}  sep=${(meanGood - meanBad).toFixed(1)}  minGood=${minGood.toFixed(1)}  ` +
      `maxBad=${maxBad.toFixed(1)}  overlap=${maxBad >= minGood ? "YES" : "no"}  95+bad=${badOver95.length}  top-is-good=${topIsGood}`,
  );
  for (const r of rows) {
    const flag = r.tier <= 4 && r.score < 50 ? " <-- weak for tier " + r.tier
      : r.tier >= 7 && r.score >= 50 ? " <-- HIGH for tier " + r.tier : "";
    console.log(`    t${r.tier}  combined=${String(r.score).padStart(6)}  (p=${r.primary} s=${r.secondary})  ${r.answer.slice(0, 40)}${flag}`);
  }
  console.log();
}

const meanOf = (field) => perRiddle.reduce((a, r) => a + (r[field] ?? 0), 0) / perRiddle.length;
console.log(
  `SUMMARY dual-noul: meanCorr=${meanOf("corr").toFixed(2)} meanSep=${meanOf("separation").toFixed(1)} ` +
    `overlaps=${perRiddle.filter((r) => r.overlap).length}/${RIDDLES.length} ` +
    `badOver95=${perRiddle.reduce((a, r) => a + r.badOver95, 0)} allTopGood=${perRiddle.every((r) => r.topIsGood)}`,
);
console.log(`mean per-answer latency (2-question single call): ${(timings.reduce((a,b)=>a+b,0)/timings.length).toFixed(0)}ms`);

await jev.dispose();
