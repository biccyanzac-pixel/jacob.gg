import { OpenJev, noul } from "open-jev";
import { RIDDLES } from "/scripts/riddle-bench/cases.mjs";

window.runSweep = async (dtype) => {
  const rows = [];
  let jev;
  try {
    jev = await OpenJev.load({ model: "kev-0.6b", dtype, device: "webgpu" });
  } catch (err) {
    return [{ dtype, riddle: null, tier: null, answer: null, ok: false, error: String(err?.message || err) }];
  }
  for (const riddle of RIDDLES) {
    const statement = `Is the answer a plausible interpretation of the riddle "${riddle.prompt}" that resolves its apparent contradiction?`;
    for (const c of riddle.cases) {
      const t0 = performance.now();
      try {
        const [verdict] = await jev.decide(c.answer, [noul(statement)]);
        const ms = performance.now() - t0;
        rows.push({
          dtype,
          device: jev.runtime.device,
          actualDtype: jev.runtime.dtype,
          riddle: riddle.id,
          tier: c.tier,
          answer: c.answer,
          noul: verdict.probability,
          score: verdict.probability * 100,
          ms,
          ok: true,
        });
      } catch (err) {
        rows.push({ dtype, riddle: riddle.id, tier: c.tier, answer: c.answer, ok: false, error: String(err?.message || err) });
      }
    }
  }
  await jev.dispose();
  return rows;
};
window.runQ4CrossEnvCheck = async () => {
  const prompt = "What can you enter without going in?";
  const statement = `Is the answer a plausible interpretation of the riddle "${prompt}" that resolves its apparent contradiction?`;
  const answer = "a competition";

  const jevAuto = await OpenJev.load({ model: "kev-0.6b", dtype: "auto", device: "webgpu" });
  const [vAuto] = await jevAuto.decide(answer, [noul(statement)]);
  const autoRuntime = jevAuto.runtime;
  await jevAuto.dispose();

  const jevQ4 = await OpenJev.load({ model: "kev-0.6b", dtype: "q4", device: "webgpu" });
  const q4Runs = [];
  for (let i = 0; i < 5; i += 1) {
    const [v] = await jevQ4.decide(answer, [noul(statement)]);
    q4Runs.push(v.probability);
  }
  const q4Runtime = jevQ4.runtime;
  await jevQ4.dispose();

  return { autoRuntime, autoNoul: vAuto.probability, q4Runtime, q4Runs };
};

window.sweepReady = true;
