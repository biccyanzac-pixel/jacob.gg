/**
 * Pick the judge configuration on evidence, not vibes.
 *
 * kev-0.6b with a long compound statement scored "asdfghjkl" at 95, which
 * would make the game trivially gameable. This sweeps candidate noul
 * statements across the two small open-jev models and prints what each
 * actually returns on the required answer set, plus a crude separation
 * metric: mean(score of answers that should be high) - mean(should be low).
 *
 * The labels below are only used to compare configurations here. Nothing in
 * the shipped game hard-codes an expected score.
 */
import { OpenJev, noul } from "open-jev";

const CASES = [
  ["happy", "I ate ice cream in the sunshine and laughed with my friend."],
  ["happy", "I finally finished my thesis and celebrated with pizza."],
  ["happy", "My dog farted and everyone started laughing."],
  ["low", "I hate everything and today was awful."],
  ["low", "asdfghjkl"],
  ["low", "I robbed a bank."],
  ["happy", "The sun was beautiful today."],
  ["happy", "fun happy thought"],
  ["low", "Yesterday I lost my wallet and cried."],
  ["happy", "I went swimming with my friend and then ate pizza."],
];

const STATEMENTS = {
  A_compound:
    "This text is a fun and happy thought: it genuinely expresses something that could " +
    "reasonably be described as fun and happy, rather than being negative, unhappy, " +
    "nonsense, or not an answer to the challenge.",
  B_plain: "This text is a fun and happy thought.",
  C_describes: "The writer is describing something fun and happy that made them feel good.",
  D_meaningful:
    "This is a real, meaningful sentence in English describing something fun and happy.",
  E_two_clause:
    "This text is a genuine sentence that describes something fun and happy, not gibberish " +
    "and not something sad or bad.",
};

const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ["kev-0.6b", "open-jev"];

for (const model of MODELS) {
  console.log(`\n${"=".repeat(78)}\nMODEL: ${model}`);
  let jev;
  try {
    const info = await OpenJev.info({ model, dtype: "auto" });
    console.log(
      `download ${(Number(info.downloadSize) / 1024 / 1024).toFixed(0)} MB, dtype ${info.dtype}, cached ${info.isCached}`,
    );
    jev = await OpenJev.load({ model, dtype: "auto" });
  } catch (err) {
    console.log(`  could not load: ${err.message}`);
    continue;
  }

  for (const [label, statement] of Object.entries(STATEMENTS)) {
    const rows = [];
    for (const [kind, answer] of CASES) {
      const [verdict] = await jev.decide(answer, [noul(statement)]);
      rows.push({ kind, answer, score: Math.round(verdict.probability * 100) });
    }
    const high = rows.filter((r) => r.kind === "happy").map((r) => r.score);
    const low = rows.filter((r) => r.kind === "low").map((r) => r.score);
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const separation = mean(high) - mean(low);
    const worstHigh = Math.min(...high);
    const worstLow = Math.max(...low);

    console.log(
      `\n  ${label.padEnd(14)} separation ${separation.toFixed(1).padStart(6)}  ` +
        `(lowest happy ${worstHigh}, highest low ${worstLow}, overlap ${worstLow >= worstHigh ? "YES" : "no"})`,
    );
    for (const r of rows) {
      console.log(
        `      ${r.kind === "happy" ? "+" : "-"} ${String(r.score).padStart(3)}  ${r.answer.slice(0, 56)}`,
      );
    }
  }

  await jev.dispose();
}
