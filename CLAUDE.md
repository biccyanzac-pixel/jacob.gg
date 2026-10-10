# jacob.gg hub: notes for coding agents

This repo is the hub for all the daily games: the hub page (`index.html`), the shared kit every game loads
(`kit/`), the hub worker for plays, ratings and admin (`worker/`), the game list (`games.json`), and
**PLAYBOOK.md**, the house rules and how-to for every game. Read PLAYBOOK.md first.

Critical rules:
- `kit/jgg.css` and `kit/jgg.js` are live in every game as soon as `main` is pushed. Keep changes backwards
  compatible, or put breaking ones in `kit/v2/`. Run `node tools/ui-check.mjs` and look at two or three games after a kit change.
- The hub worker binds the games' leaderboard D1s and only ever SELECTs from them (`worker/src/sources.js`).
  Never write to another game's database.
- Before working in a game's repo, check `git status` and recent file times. Other agents may be working there;
  don't commit or overwrite their uncommitted work.
- Free project: ask the owner before adding any paid service or third-party analytics.
- Commit as `biccyanzac-pixel <285977456+biccyanzac-pixel@users.noreply.github.com>`. The page is served from `main`
  by GitHub Pages; the worker deploys with `cd worker && npx wrangler deploy`.
- Local ports: site 8083, hub worker 8831.
- Tests: `cd worker && rm -rf .wrangler && npm run db:seed:local && npm run dev:local`, then `npm test` in
  `worker/` and `node tools/ui-check.mjs` here.
