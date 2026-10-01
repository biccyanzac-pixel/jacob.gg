/**
 * Benchmarks the candidate WASM-compatible mobile fallback (Xenova/nli-
 * deberta-v3-xsmall, 3-way NLI: contradiction/entailment/neutral) against the
 * same riddle cases used to pick the shipped kev-0.6b statement, using the
 * exact same metric (Spearman rank correlation between hand-assigned tier and
 * score) so the two are directly comparable.
 *
 * Model inference here runs in Node via onnxruntime-node's CPU EP, not the
 * browser's onnxruntime-web WASM EP - a separate Playwright probe already
 * confirmed this exact model/dtype genuinely loads and infers under real
 * browser WASM with navigator.gpu absent (scripts/riddle-bench/run-wasm-
 * probe.mjs). Node CPU EP here is only standing in for faster iteration on
 * benchmark *quality*, which is backend-independent (same weights, same
 * arithmetic contract) - it does not retest WASM compatibility.
 *
 *   node scripts/riddle-bench/sweep-nli-fallback.mjs
 */
import { AutoTokenizer, AutoModelForSequenceClassification } from "@huggingface/transformers";
import { RIDDLES } from "./cases.mjs";
import { riddleStatementAsDeclarative } from "./nli-statement.mjs";

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
    const dt = rTier[i] - meanR;
    const ds = rScore[i] - meanR;
    num += dt * ds;
    denT += dt * dt;
    denS += ds * ds;
  }
  return denT === 0 || denS === 0 ? null : num / Math.sqrt(denT * denS);
}

const MODEL = "Xenova/nli-deberta-v3-xsmall";
console.log(`model: ${MODEL} (device: cpu, dtype: int8)`);
const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
const model = await AutoModelForSequenceClassification.from_pretrained(MODEL, { device: "cpu", dtype: "int8" });
console.log("loaded\n");

const ENTAILMENT_IDX = 1; // {0: contradiction, 1: entailment, 2: neutral}

async function score(premise, hypothesis) {
  const inputs = tokenizer(premise, { text_pair: hypothesis, padding: true, truncation: true });
  const { logits } = await model(inputs);
  const data = Array.from(logits.data);
  const max = Math.max(...data);
  const exps = data.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map((v) => v / sum);
  return probs[ENTAILMENT_IDX];
}

const perRiddle = [];
for (const riddle of RIDDLES) {
  const hypothesis = riddleStatementAsDeclarative(riddle.prompt);
  const rows = [];
  for (const c of riddle.cases) {
    const premise = `Riddle: "${riddle.prompt}" Answer: "${c.answer}"`;
    const p = await score(premise, hypothesis);
    rows.push({ ...c, score: Math.round(p * 10000) / 100 });
  }
  rows.sort((a, b) => b.score - a.score);
  const tiers = rows.map((r) => r.tier);
  const scores = rows.map((r) => r.score);
  const good = rows.filter((r) => r.tier <= 4);
  const bad = rows.filter((r) => r.tier >= 7);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const corr = spearman(tiers, scores);
  const meanGood = mean(good.map((r) => r.score));
  const meanBad = mean(bad.map((r) => r.score));
  const minGood = Math.min(...good.map((r) => r.score));
  const maxBad = Math.max(...bad.map((r) => r.score));
  const over95 = rows.filter((r) => r.score >= 95);
  const badOver95 = over95.filter((r) => r.tier >= 7);
  const topIsGood = rows[0].tier <= 4;

  perRiddle.push({ riddle: riddle.id, corr, separation: meanGood - meanBad, overlap: maxBad >= minGood, over95: over95.length, badOver95: badOver95.length, topIsGood });

  console.log(`--- ${riddle.id} --- "${riddle.prompt}"`);
  console.log(`  corr=${corr?.toFixed(2)} separation=${(meanGood - meanBad).toFixed(1)} overlap=${maxBad >= minGood ? "YES" : "no"} 95+=${over95.length}(bad:${badOver95.length}) topIsGood=${topIsGood}`);
  for (const r of rows) {
    const flag = r.tier <= 4 && r.score < 50 ? " <-- weak despite tier " + r.tier
      : r.tier >= 7 && r.score >= 50 ? " <-- HIGH despite tier " + r.tier
      : "";
    console.log(`    t${r.tier}  ${String(r.score).padStart(6)}  ${r.answer.slice(0, 48)}${flag}`);
  }
  console.log();
}

const meanOf = (f) => perRiddle.reduce((a, r) => a + (r[f] ?? 0), 0) / perRiddle.length;
console.log("=".repeat(80));
console.log(`SUMMARY: meanCorr=${meanOf("corr").toFixed(2)} meanSeparation=${meanOf("separation").toFixed(1)} overlaps=${perRiddle.filter((r) => r.overlap).length}/${perRiddle.length} totalBadOver95=${perRiddle.reduce((a, r) => a + r.badOver95, 0)} allTopGood=${perRiddle.every((r) => r.topIsGood)}`);
