# jacob.gg leaderboard worker

The shared, cross-device leaderboard backend for the daily game. Scoring
itself happens entirely in the player's browser (see `../web`) — this worker
never runs a model and never holds an AI API key. It exists only so that two
different people on two different devices can see one shared leaderboard
instead of each seeing their own localStorage.

**This is not deployed yet.** It needs a free Cloudflare account and one API
token — see "Deploying" below for the exact steps and the one thing that has
to happen in a browser (account creation can't be done non-interactively).

## Why this is a separate, optional piece

The game is fully playable without it: `web/public/config.json` has
`leaderboardUrl: null` by default, and the game falls back to a per-device
local leaderboard (clearly labelled as such in the UI) when no shared backend
is configured. Wiring this worker up only upgrades "leaderboard on this
device" to "leaderboard shared by everyone playing today" — nothing else in
the game changes.

## What it does

- `POST /api/session` — issues a player a random id + token pair. The id is
  never chosen by the client.
- `GET /api/leaderboard?challengeId=...` — today's board: everyone's name,
  answer and score, ordered by score then submission time.
- `POST /api/play` — records one submission. Independently recomputes the
  challenge id from the server's own clock, recomputes the answer hash,
  checks `score === Math.round(noul * 100)`, and enforces one row per
  `(player_id, challenge_id)` via a database constraint. See the comment block
  at the top of `src/index.js` for the full trust model, including what it
  deliberately cannot verify (see Limitations below).

## Deploying

You need a free Cloudflare account. Account creation itself requires a
browser and can't be scripted — that's the one manual step.

1. **Sign up** (if you don't have an account): https://dash.cloudflare.com/sign-up
2. **Create an API token**: https://dash.cloudflare.com/profile/api-tokens →
   "Create Token" → "Edit Cloudflare Workers" template → include D1 edit
   permission → create → copy the token.
3. Give that token to whoever is deploying (paste it, or set it as
   `CLOUDFLARE_API_TOKEN` yourself). Nothing else needs a click — from here
   it's all command line:

```bash
cd worker
npm install
export CLOUDFLARE_API_TOKEN=<the token from step 2>

# Create the D1 database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create jacob-gg-leaderboard

npm run db:init      # applies schema.sql to the remote database
npm run deploy       # publishes the worker; prints its https://*.workers.dev URL
```

4. Put that `workers.dev` URL into `web/public/config.json`:

```json
{ "leaderboardUrl": "https://jacob-gg-leaderboard.<your-subdomain>.workers.dev" }
```

5. Rebuild and redeploy the web app (push to `main`, or `npm run build` in
   `web/` and redeploy `web/dist`). The shared leaderboard is live from then on
   — no other code changes needed.

## Limitations (stated plainly, not hidden)

- **The noul itself cannot be re-verified server-side.** Doing so would mean
  running the model on the server, which needs paid inference and defeats the
  entire point of free, local, in-browser scoring. A sophisticated player who
  modifies their own browser's JavaScript could submit a fabricated noul that
  still satisfies `score === round(noul * 100)`. This worker closes every
  cheaper hole (forged player id, forged challenge, tampered answer text,
  score/noul mismatch, replay/double-submit) but not that one. This is a
  documented trade-off of the architecture, not an oversight.
- Free Cloudflare Workers/D1 tiers have daily request and row-read limits,
  which are generous for a small daily-game leaderboard but are limits.
- The in-memory rate limiter resets whenever the Worker's isolate recycles
  (Cloudflare's normal behaviour) — it blunts a burst, it does not guarantee a
  hard cap.
