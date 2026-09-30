/**
 * Start the local jev-local judge if it is not already running, wait for it to
 * be healthy, then warm it up so the first real submission is not stuck behind
 * a model load.
 *
 * jev-local (github.com/us/jev-local) is an interface-compatible open-source
 * System One server. It is NOT hosted Jev's model - see lib/judge.js.
 *
 * Two things about it drive this script:
 *
 *  - Its default scorer is a deterministic hash stub with, in its own words,
 *    "no intelligence claimed". JEVLOCAL_SCORER=hf is what selects the real
 *    open-weights model, so this script always sets it.
 *  - It builds that scorer lazily, on the first scoring request. So /health
 *    answers instantly while the model is not loaded at all, and the warm-up
 *    request below is what actually pays the load cost.
 *
 * Usage: node scripts/start-local-judge.mjs [--stop] [--quiet]
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const QUIET = args.has("--quiet");
const STOP = args.has("--stop");

const HOME = process.env.JEVLOCAL_HOME || path.join(os.homedir(), "Programs", "jev-local");
const PYTHON =
  process.env.JEVLOCAL_PYTHON ||
  path.join(HOME, ".venv", "Scripts", process.platform === "win32" ? "python.exe" : "python");
const BASE_URL = (process.env.JEVLOCAL_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const PORT = Number(new URL(BASE_URL).port || 8000);

// Chosen for this machine: the repo's own leaderboard puts Qwen2.5-1.5B-Instruct
// at noul 1.00 on its set1 eval-half, level with the 3B, and this game uses
// only the noul head - so the larger weights buy nothing here. Override with
// JEVLOCAL_MODEL (e.g. Qwen/Qwen2.5-3B-Instruct) if you want the bigger one.
const MODEL_ID = "Qwen/Qwen2.5-1.5B-Instruct";
// Weights already on disk win over the hub id, so a normal start needs no
// network at all and cannot be throttled part-way through a download.
const VENDORED = path.join(HOME, "models", "Qwen2.5-1.5B-Instruct");
const MODEL =
  process.env.JEVLOCAL_MODEL ||
  (fs.existsSync(path.join(VENDORED, "config.json")) ? VENDORED : MODEL_ID);

const LOG = process.env.JEVLOCAL_LOG || path.join(os.homedir(), "jev-local.log");
const PIDFILE = path.join(os.tmpdir(), "jev-local.pid");

const HEALTH_TIMEOUT_MS = 60_000;
// The warm-up may download several GB the very first time, then load the
// weights on a CPU. Both are slow and neither is a failure.
const WARMUP_TIMEOUT_MS = Number(process.env.JEVLOCAL_WARMUP_TIMEOUT_MS) || 45 * 60_000;

const say = (message) => {
  if (!QUIET) console.log(message);
};

async function health(timeoutMs = 2000) {
  try {
    const response = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PIDFILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function stop() {
  const pid = readPid();
  if (pid === null) {
    say("no recorded local judge pid; nothing to stop");
    return 0;
  }
  try {
    process.kill(pid);
    say(`stopped local judge (pid ${pid})`);
  } catch (err) {
    say(`could not stop pid ${pid}: ${err.code ?? err.message}`);
  }
  try {
    fs.rmSync(PIDFILE);
  } catch {
    // Leaving a stale pid file behind is harmless.
  }
  return 0;
}

function preflight() {
  const problems = [];
  if (!fs.existsSync(HOME)) problems.push(`jev-local not found at ${HOME}`);
  if (!fs.existsSync(PYTHON)) problems.push(`its python venv not found at ${PYTHON}`);
  return problems;
}

function launch() {
  const out = fs.openSync(LOG, "a");
  fs.writeSync(
    out,
    `\n=== starting jev-local ${new Date().toISOString()} model=${MODEL} port=${PORT} ===\n`,
  );

  const child = spawn(PYTHON, ["-m", "jevlocal", "--port", String(PORT)], {
    cwd: HOME,
    env: {
      ...process.env,
      // Without this the server serves the deterministic stub, which would
      // hand the game fake scores. Non-negotiable.
      JEVLOCAL_SCORER: "hf",
      JEVLOCAL_MODEL: MODEL,
      // Chat-template wrapping. The repo's leaderboard measures noul with it
      // on, which is the only head this game uses.
      JEVLOCAL_CHAT: process.env.JEVLOCAL_CHAT ?? "1",
      // Hugging Face's Xet transfer path stalled at 0 bytes on this machine
      // while the plain CDN sustained ~9 MB/s. Disabling it makes the
      // first-run weight download finish instead of hanging.
      HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET ?? "1",
      PYTHONUNBUFFERED: "1",
    },
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });

  child.unref();
  if (child.pid) fs.writeFileSync(PIDFILE, String(child.pid), "utf8");
  return child.pid;
}

async function waitForHealth(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (await health()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * One real scoring request, which is what forces the model to load. Returns
 * the noul so the caller can prove the model is genuinely answering.
 */
async function warmUp() {
  const response = await fetch(`${BASE_URL}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "jev-local",
      state: "warm-up: a sunny afternoon",
      questions: {
        verdict: {
          type: "noul",
          instructions: "Is this text actually a fun and happy thought?",
          criteria: { true: "It is fun and happy.", false: "It is not." },
        },
      },
    }),
    signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`warm-up got HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const body = await response.json();
  const answer = body?.answers?.verdict ?? body?.data?.result?.answers?.verdict;
  if (typeof answer?.noul !== "number") {
    throw new Error(`warm-up response had no noul: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { noul: answer.noul, model: body?.model ?? "unknown" };
}

// --- main ------------------------------------------------------------------

if (STOP) process.exit(await stop());

if (await health()) {
  say(`local judge already running at ${BASE_URL}`);
} else {
  const problems = preflight();
  if (problems.length) {
    console.error("Cannot start the local judge:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nSee the local-judge section of README.md for the one-time setup.");
    process.exit(1);
  }

  say(`starting local judge (${MODEL}) on port ${PORT} ...`);
  const pid = launch();
  say(`  pid ${pid}, log ${LOG}`);

  if (!(await waitForHealth(HEALTH_TIMEOUT_MS))) {
    console.error(`local judge did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s.`);
    console.error(`check ${LOG}`);
    process.exit(1);
  }
  say("  healthy");
}

// Always warm up: the process may be healthy but not yet holding the weights.
say("warming up the model (first run downloads weights; this can take a while) ...");
const started = Date.now();
try {
  const { noul, model } = await warmUp();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  say(`  ready in ${seconds}s - ${model} returned noul ${noul}`);
} catch (err) {
  console.error(`local judge warm-up failed: ${err.message}`);
  console.error(`check ${LOG}`);
  process.exit(1);
}
