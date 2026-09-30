/**
 * Phase 3: sweep candidate single-Noul riddle-judge statements against the
 * benchmark in cases.mjs, on the actual shipped model (kev-0.6b).
 *
 * Measures ORDERING quality, not just mean separation: Spearman rank
 * correlation between the hand-assigned tier (1=best..10=worst) and the
 * model's score, per riddle and aggregated. Also flags the specific failure
 * modes called out in the task: nonsense/parroting/literal-failure scoring
 * high, tier-1-4 answers scoring low, everything clustering together, and
 * how often 95+ is reached (it should be rare and should come from tier 1).
 *
 * One noul() call per case - this sweep is deliberately testing whether ONE
 * Noul question is enough, per the task's explicit instruction not to add a
 * second model call without evidence.
 *
 *   node scripts/riddle-bench/sweep.mjs [statementKey ...]
 */
import { OpenJev, noul } from "open-jev";
import { RIDDLES } from "./cases.mjs";

// Candidate statements. All target the same single proposition: "the answer
// makes the riddle true under a plausible interpretation of its wording."
// Deliberately no "creative"/"funny"/"clever"/"interesting" language - per
// the task, only add that if benchmark results demand it.
const STATEMENTS = {
  A_q_makes_true: (r) =>
    `Does the answer make the riddle "${r}" true under a plausible interpretation of its wording?`,
  B_decl_makes_true: (r) =>
    `The answer makes the riddle "${r}" true under a plausible interpretation of its wording.`,
  C_q_provides: (r) =>
    `Does the answer provide a plausible interpretation that makes the riddle "${r}" true?`,
  D_q_resolves: (r) =>
    `Is the answer a plausible interpretation of the riddle "${r}" that resolves its apparent contradiction?`,
  E_decl_solves: (r) =>
    `This answer genuinely solves the riddle "${r}" by interpreting its wording in a plausible way.`,
  F_decl_because: (r) =>
    `Under a plausible interpretation of its wording, the riddle "${r}" is true because of this answer.`,

  // Round 2: every round-1 statement's dominant failure was the SAME across
  // all 5 riddles - an answer that merely restates/repeats the riddle's own
  // wording back scored 85-99, higher than almost every genuine answer. These
  // explicitly name and exclude that before concluding a second Noul call is
  // needed.
  G_no_restate: (r) =>
    `Is the answer a genuinely different, plausible interpretation of the riddle "${r}" that resolves its apparent contradiction, rather than a restatement of the riddle's own wording?`,
  H_short_solution: (r) => `The answer is a different, plausible solution to the riddle "${r}".`,
  I_short_new_meaning: (r) =>
    `The answer gives a new, plausible meaning that solves the riddle "${r}", not just repeating the riddle's own words.`,
  J_structured: (r) =>
    `Riddle: "${r}"
The answer above gives a plausible interpretation, different from the riddle's own wording, that makes the riddle true.`,
};

const requested = process.argv.slice(2);
const keys = requested.length ? requested : Object.keys(STATEMENTS);

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
  // tier is "lower = better", score is "higher = better" - correlate tier
  // against -score so a perfect judge gives +1.
  const rTier = rank(tiers);
  const rScore = rank(scores.map((s) => -s));
  const n = tiers.length;
  const meanR = (n + 1) / 2;
  let num = 0;
  let denT = 0;
  let denS = 0;
  for (let i = 0; i < n; i += 1) {
    const dt = rTier[i] - meanR;
    const ds = rScore[i] - meanR;
    num += dt * ds;
    denT += dt * dt;
    denS += ds * ds;
  }
  return denT === 0 || denS === 0 ? null : num / Math.sqrt(denT * denS);
}

const MODEL = "kev-0.6b";
console.log(`model: ${MODEL}`);
const info = await OpenJev.info({ model: MODEL, dtype: "auto" });
console.log(`download ${(Number(info.downloadSize) / 1024 / 1024).toFixed(0)} MB, cached ${info.isCached}`);
const jev = await OpenJev.load({ model: MODEL, dtype: "auto" });
console.log(`loaded on ${jev.runtime.device}, dtype ${jev.runtime.dtype}\n`);

const allResults = {};

for (const key of keys) {
  const build = STATEMENTS[key];
  console.log(`${"=".repeat(88)}\nSTATEMENT ${key}\n  ${build("<riddle>")}\n`);

  const perRiddle = [];

  for (const riddle of RIDDLES) {
    const statement = build(riddle.prompt);
    const rows = [];
    for (const c of riddle.cases) {
      const [verdict] = await jev.decide(c.answer, [noul(statement)]);
      const score = Math.round(verdict.probability * 10000) / 100; // 2dp
      rows.push({ ...c, score });
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

    perRiddle.push({
      riddle: riddle.id,
      corr,
      separation: meanGood - meanBad,
      minGood,
      maxBad,
      overlap: maxBad >= minGood,
      over95: over95.length,
      badOver95: badOver95.length,
      topIsGood,
      stdev: Math.sqrt(mean(scores.map((s) => (s - mean(scores)) ** 2))),
    });

    console.log(`  --- ${riddle.id} ---  "${riddle.prompt}"`);
    console.log(
      `    corr(tier,score)=${corr?.toFixed(2)}  separation=${(meanGood - meanBad).toFixed(1)}  ` +
        `minGood=${minGood.toFixed(1)}  maxBad=${maxBad.toFixed(1)}  overlap=${maxBad >= minGood ? "YES" : "no"}  ` +
        `95+=${over95.length}(bad:${badOver95.length})  top-is-good=${topIsGood}`,
    );
    for (const r of rows) {
      const flag = r.tier <= 4 && r.score < 50 ? " <-- weak despite being tier " + r.tier
        : r.tier >= 7 && r.score >= 50 ? " <-- HIGH despite being tier " + r.tier
        : "";
      console.log(`      t${r.tier}  ${String(r.score).padStart(6)}  ${r.answer.slice(0, 48)}${flag}`);
    }
    console.log();
  }

  const meanOf = (field) => perRiddle.reduce((a, r) => a + (r[field] ?? 0), 0) / perRiddle.length;
  const summary = {
    meanCorr: meanOf("corr"),
    meanSeparation: meanOf("separation"),
    totalOverlaps: perRiddle.filter((r) => r.overlap).length,
    totalBadOver95: perRiddle.reduce((a, r) => a + r.badOver95, 0),
    totalOver95: perRiddle.reduce((a, r) => a + r.over95, 0),
    allTopGood: perRiddle.every((r) => r.topIsGood),
    meanStdev: meanOf("stdev"),
  };
  allResults[key] = summary;
  console.log(
    `  SUMMARY ${key}: meanCorr=${summary.meanCorr.toFixed(2)} meanSeparation=${summary.meanSeparation.toFixed(1)} ` +
      `overlaps=${summary.totalOverlaps}/${RIDDLES.length} badOver95=${summary.totalBadOver95} ` +
      `totalOver95=${summary.totalOver95} allTopGood=${summary.allTopGood} meanStdev=${summary.meanStdev.toFixed(1)}\n`,
  );
}

console.log(`${"=".repeat(88)}\nOVERALL RANKING (by mean rank correlation, then separation)\n`);
const ranked = Object.entries(allResults).sort(
  (a, b) => b[1].meanCorr - a[1].meanCorr || b[1].meanSeparation - a[1].meanSeparation,
);
for (const [key, s] of ranked) {
  console.log(
    `  ${key.padEnd(20)} corr=${s.meanCorr.toFixed(2)}  sep=${s.meanSeparation.toFixed(1)}  ` +
      `overlaps=${s.totalOverlaps}  badOver95=${s.totalBadOver95}  allTopGood=${s.allTopGood}`,
  );
}

await jev.dispose();
