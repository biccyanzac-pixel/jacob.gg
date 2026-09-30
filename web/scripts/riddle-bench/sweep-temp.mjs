/**
 * Phase 3 (temperature variable): sweep open-jev's decide() `temperature`
 * option on the best-performing single statement found so far (D_q_resolves,
 * meanCorr=0.07), since it's a free lever - same one model call, no extra
 * inference cost, just reshapes the softmax over each question's logits.
 *
 *   node scripts/riddle-bench/sweep-temp.mjs
 */
import { OpenJev, noul } from "open-jev";
import { RIDDLES } from "./cases.mjs";

const STATEMENT = (r) =>
  `Is the answer a plausible interpretation of the riddle "${r}" that resolves its apparent contradiction?`;

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

const jev = await OpenJev.load({ model: "kev-0.6b", dtype: "auto" });
console.log(`statement: ${STATEMENT("<riddle>")}\n`);

for (const temperature of [0.3, 0.5, 1, 2, 4]) {
  const perRiddle = [];
  for (const riddle of RIDDLES) {
    const statement = STATEMENT(riddle.prompt);
    const rows = [];
    for (const c of riddle.cases) {
      const [v] = await jev.decide(c.answer, [noul(statement)], { temperature });
      rows.push({ ...c, score: Math.round(v.probability * 10000) / 100 });
    }
    const good = rows.filter((r) => r.tier <= 4).map((r) => r.score);
    const bad = rows.filter((r) => r.tier >= 7).map((r) => r.score);
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    perRiddle.push({
      corr: spearman(rows.map((r) => r.tier), rows.map((r) => r.score)),
      separation: mean(good) - mean(bad),
    });
  }
  const meanCorr = perRiddle.reduce((a, r) => a + r.corr, 0) / perRiddle.length;
  const meanSep = perRiddle.reduce((a, r) => a + r.separation, 0) / perRiddle.length;
  console.log(`temperature=${temperature}  meanCorr=${meanCorr.toFixed(2)}  meanSep=${meanSep.toFixed(1)}`);
}

await jev.dispose();
