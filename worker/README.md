# jacob.gg leaderboard worker

The shared, cross-device leaderboard backend for the daily game. Scoring
itself happens entirely in the player's browser (see `../web`) — this worker
never runs a model and never holds an AI API key. It exists so that different
people on different devices see one shared leaderboard, with up to 3 attempts
per player per challenge genuinely enforced by the database, not just asked
of the client nicely.

**Status: coded and verified against a local Miniflare instance (real D1
emulation, no Cloudflare account needed for that). Not yet deployed publicly**
— that needs a free Cloudflare account and an interactive login, which no
script can complete for you. See "Deploying" below for the exact commands.

## Why this is a separate, optional piece

The game is fully playable without it: `web/public/config.json` has
`leaderboardUrl: null` by default, and the game falls back to a per-device
local record of your 3 attempts and a local-only leaderboard (clearly
labelled as such in the UI). Wiring this worker up only upgrades "attempts and
leaderboard on this device" to "attempts enforced by, and leaderboard shared
by, a real server" — nothing else in the game changes.

## What it does

- `POST /api/session` — issues a player a random id + token pair. The id is
  never chosen by the client.
- `GET /api/leaderboard?challengeId=...` — today's board: one row per player,
  their **best** of up to 3 attempts, ranked by score.
- `GET /api/attempts?challengeId=...&playerId=...` — this player's own
  attempts so far (up to 3), so a page reload or a cleared localStorage (as
  long as the session token survives) restores state from the server instead
  of the browser's memory.
- `POST /api/play` — records one attempt. Independently recomputes the
  challenge id from the server's own clock, recomputes the answer hash,
  checks `score === noul * 100` (within float tolerance), assigns the attempt
  number itself as `(existing rows for this player+challenge) + 1` — never
  trusting a client-sent number — and rejects a 4th attempt outright. See the
  comment block at the top of `src/index.js` for the full trust model,
  including what it deliberately cannot verify (see Limitations below).

**Leaderboard tie-break rule** (documented here and in `src/index.js` because
it has to be consistent everywhere it matters): when two players have the
same best score, the one whose best-scoring attempt was submitted **earlier**
ranks first; if that's somehow also equal, the submission's row id (insertion
order) is the final, fully deterministic tiebreak.

## Verifying it locally (no Cloudflare account needed)

`wrangler dev --local` runs a real Miniflare emulation of the Worker and D1,
entirely on your machine:

```bash
cd worker
npm install
npx wrangler d1 execute jacob-gg-leaderboard --local --file=schema.sql
npx wrangler dev --local --port 8787
```

Then `curl`/fetch `http://127.0.0.1:8787/api/...` exactly as the frontend
would. This is how the backend logic was verified before deployment — every
route, the 3-attempt cap, the best-score leaderboard query, the tie-break, and
the forged-token/forged-score rejections were all exercised against this local
server with real requests, not mocked.

## Deploying (the one interactive step)

You need a free Cloudflare account. Account creation and the OAuth login
itself require a browser and can't be scripted — that's the one manual step,
and it's the normal `wrangler login` flow, not an API token pasted anywhere.

```bash
cd worker
npm install

# Opens a browser to dash.cloudflare.com and waits for you to log in / sign up
# and click Allow. No token to copy - wrangler stores the session itself.
npx wrangler login

# Creates the database and prints its database_id.
npx wrangler d1 create jacob-gg-leaderboard
```

Paste the printed `database_id` into `wrangler.toml`'s `database_id` field
(replacing `REPLACE_WITH_D1_DATABASE_ID`), then:

```bash
npm run db:init      # applies schema.sql to the real, remote database
npm run deploy       # publishes the worker; prints its https://*.workers.dev URL
```

Put that URL into `web/public/config.json`:

```json
{ "leaderboardUrl": "https://jacob-gg-leaderboard.<your-subdomain>.workers.dev" }
```

Rebuild and redeploy the web app (push to `main`, or `npm run build` in
`web/` and redeploy `web/dist`). The shared leaderboard and server-enforced
3-attempt limit are live from then on — no other code changes needed.

## Limitations (stated plainly, not hidden)

- **The noul itself cannot be re-verified server-side.** Doing so would mean
  running the model on the server, which needs paid inference and defeats the
  entire point of free, local, in-browser scoring. A sophisticated player who
  modifies their own browser's JavaScript could submit a fabricated noul that
  still satisfies `score === noul * 100`. This worker closes every cheaper
  hole (forged player id, forged challenge, tampered answer text, score/noul
  mismatch, a 4th attempt, replaying an old attempt) but not that one. This is
  a documented trade-off of the architecture, not an oversight.
- Free Cloudflare Workers/D1 tiers have daily request and row-read limits,
  generous for a small daily-game leaderboard but limits nonetheless.
- The in-memory rate limiter resets whenever the Worker's isolate recycles
  (normal Cloudflare behaviour) — it blunts a burst, it does not guarantee a
  hard cap.
- A player who loses their session token (different browser, cleared site
  data entirely) gets a fresh identity and therefore a fresh 3 attempts. There
  is no login system in this version, so identity is "this browser session",
  documented, not solved with real accounts here.
