/**
 * Isolate the gibberish problem: can kev-0.6b detect "this is not real text" at
 * all, independent of the happy/sad question? If a plain coherence noul also
 * fails on asdfghjkl, combining two nouls will not help. If it succeeds, a
 * two-question AND (happy AND coherent) is worth trying.
 */
import { OpenJev, noul } from "open-jev";

const PROBES = [
  "This is a real sentence in English, not random keyboard mashing or gibberish.",
  "This text is coherent and meaningful.",
  "A human reader could understand what this text means.",
];

const TEXTS = [
  "asdfghjkl",
  "qwe zxcv blah",
  "kjshdf ksjdhf ksjdhfk",
  "I ate ice cream in the sunshine.",
  "fun happy thought",
  "The sun was beautiful today.",
];

for (const model of ["kev-0.6b", "open-jev"]) {
  console.log(`\n=== ${model} ===`);
  let jev;
  try {
    jev = await OpenJev.load({ model, dtype: "auto" });
  } catch (err) {
    console.log(`  load failed: ${err.message}`);
    continue;
  }
  for (const statement of PROBES) {
    console.log(`\n  probe: "${statement}"`);
    for (const text of TEXTS) {
      const [v] = await jev.decide(text, [noul(statement)]);
      console.log(`    ${String(Math.round(v.probability * 100)).padStart(3)}  ${text}`);
    }
  }
  await jev.dispose();
}
