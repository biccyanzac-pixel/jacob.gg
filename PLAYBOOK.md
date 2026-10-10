# jacob.gg playbook

How every jacob.gg daily game is built, styled, deployed and connected to the hub. Read this before starting a new
game or changing a shared part of an existing one. Each game's own `CLAUDE.md` holds its game-specific rules.

## 0. Any computer: set up the workspace

Every game is its own GitHub repo, and they all sit side by side in one folder, next to this one:

```
git clone https://github.com/biccyanzac-pixel/jacob.gg
cd jacob.gg
npm run setup              # add -- --install to also npm install everything
```

`npm run setup` clones every game in `games.json` next to `jacob.gg`, so `../perceptle` and `../factle` are there,
just like on the owner's PC (where they live on the Desktop). Games that are already there get pulled, unless
they have uncommitted work. It also sets the commit identity in each repo and installs the `daily-games` skill
into `~/.claude/skills`, so a Claude session started in any game folder finds this playbook. Then open
`jacob.gg.code-workspace` in VS Code to see the hub and every game in one window.

Once per computer, for deploying: push access to `github.com/biccyanzac-pixel` (sign in to git or GitHub), and
`npx wrangler login` for the Cloudflare workers and databases. No secrets live in the repos (the hub's admin
password is a Cloudflare secret).

Run `npm run setup` again any time to pick up new games and other people's commits.

## 1. Where things are

| What | Where |
| --- | --- |
| Games (one folder and one GitHub repo each) | `../<game>` next to this folder → `github.com/biccyanzac-pixel/<game>` |
| Live games | `https://biccyanzac-pixel.github.io/<game>/` (GitHub Pages, `gh-pages` branch) |
| Hub page | this repo, `index.html`, served from `main` at `https://biccyanzac-pixel.github.io/jacob.gg/` |
| Shared kit (look + rating box) | this repo, `kit/jgg.css` and `kit/jgg.js` |
| Hub worker (plays, ratings, admin) | this repo, `worker/` → `https://jgg-hub.jacob-gg-leaderboard-worker.workers.dev` |
| Game list | this repo, `games.json` |
| Leaderboard workers | each game's `worker/` → `https://<game>-leaderboard.jacob-gg-leaderboard-worker.workers.dev` |

Live games: ridd-le, Yogle, Predictle, Pointle, Factle, Perceptle, Stratle. In development: Describle. All are listed in
`games.json` (`games` = live, `inDevelopment` = not on the hub yet).

Identity for every repo: `biccyanzac-pixel <285977456+biccyanzac-pixel@users.noreply.github.com>` (set it repo-locally).

## 2. House rules for play

Every game follows these unless the owner agrees an exception.

1. **One puzzle a day, the same for everyone.** It changes at 00:00 UTC. Show a "Next in HH:MM:SS" countdown, and
   switch to the new day by itself if the player is idle.
2. **Never change a past or current day.** Generate puzzles from the date (seeded, deterministic), or pre-generate
   day files, and only ever regenerate future days. Pin it with a test (golden fixtures or a schedule test).
3. **Weekday difficulty curve.** Monday is the easiest, getting harder through to Saturday, the hardest. Sunday is
   a **special**: a twist, or the hardest day of all. Show it on the intro with `JGG.levelChip(day)`. The hub shows
   the same curve.
4. **One name, then auto-submit.** The name is shared by every game: read `JGG.name()` when the game has none
   of its own, call `JGG.setName(n)` whenever the player sets or changes it, and show "Playing as Jo · change"
   (`JGG.playingAs(...)`, or the game's own equivalent). Only ask for a name if none is known yet, either
   before playing or at the end. After that, every finished game goes on the leaderboard with no button. A failed send shows the
   error and a retry. Games with retries (Yogle, ridd-le) submit every finished try. The board ranks the player's
   best (or, in ridd-le, the average of their 3) and shows "best of N".
5. **Leaderboard**: today's board is always visible. Ties go to whoever finished first. Archive replays go on a
   separate "played later" board (`is_late = 1`) and never touch a day's real board.
6. **Results screen**: score, a per-round breakdown, a **Share result** button (emoji grid plus a link), then the
   **rating box** (`JGG.rate`), then "come back tomorrow".
7. **Archive** of past days, playable late. **Practice** is optional and never on a leaderboard.
8. **Free, no ads, no accounts, no third-party analytics.** Ask the owner before adding anything paid, with a cost
   estimate. Camera, location and similar data stay on the device unless the owner agrees otherwise.

## 3. House look: the kit

Every game page starts like this, with the kit loaded **before** the game's own CSS and scripts:

```html
<meta name="color-scheme" content="dark light">
<link rel="stylesheet" href="https://biccyanzac-pixel.github.io/jacob.gg/kit/jgg.css">
<link rel="stylesheet" href="css/style.css">
<script src="https://biccyanzac-pixel.github.io/jacob.gg/kit/jgg.js" defer></script>
<script type="module" src="js/app.js"></script>
...
<main class="shell">
  <header class="masthead"><a class="wordmark" href="https://biccyanzac-pixel.github.io/jacob.gg/">jacob<span>.gg</span></a></header>
  <section class="card">...</section>
</main>
```

- `kit/jgg.css` holds the colour tokens (`--bg --surface --surface-2 --border --text --muted --accent --good --bad
  --warn --radius --shadow`), dark by default with a light theme, the font (`--jgg-font`), `body`, `.shell`,
  `.masthead`/`.wordmark`, the level chip and the rating box. **A game must not redefine these.** It may add its
  own tokens (Pointle's map colours, Yogle's left/right limb colours).
- Components (cards, eyebrows, buttons, fields, leaderboard rows, archive list) still live in each game's CSS.
  Copy them from `perceptle/site/css/style.css` (or `factle`) for a new game, so it looks like the rest.
- To change fonts or colours on every game at once, edit `kit/jgg.css`, push this repo, then look at two or three
  games. Breaking changes (renamed classes, a new structure) go in a new `kit/v2/` so older games keep working.
- `kit/demo.html` shows the kit on its own.
- Pages must work at 360 px wide with no horizontal scroll, and in both light and dark.

`kit/jgg.js` gives you `window.JGG`:

```js
JGG.levelChip(day)                      // <span class="jgg-level"> "Saturday · hardest"; use it on the intro
JGG.level(day)                          // { weekday, level (0 = Sunday), label, text }
JGG.rate({ game: 'factle', day, mount }) // the rating box, into an element on the results screen; call it on every render
JGG.name() / JGG.setName(n)             // the player's name, shared by every game (falls back to ridd-le's old key)
JGG.playingAs({ mount, name, onChange }) // "Playing as Jo · change" with an inline editor
```

Use `window.JGG?.rate(...)` so a game still works if the kit fails to load. For local tests, `?hub=<url>` points
the rating box at a local hub worker (`?hub=off` disables it).

## 4. The hub: plays, ratings, ranking

- **Plays** are not sent by games. Every 10 minutes the hub worker reads new rows from each game's leaderboard D1
  (bound in `worker/wrangler.toml`, queried in `worker/src/sources.js`, `rowid > cursor`). One play = one
  player × one puzzle day × one game, however many tries. History came along on the first sync.
  - So a game's leaderboard table needs: `player_id`, `day_key` (YYYY-MM-DD), `is_late`, an ISO timestamp, and
    a normal rowid table that is insert-only or upsert-only. **If you rename or replace that table, update
    `worker/src/sources.js` and redeploy the hub** (`cd worker && npx wrangler deploy`). Otherwise that game's
    plays stop counting; the others are unaffected.
- **Ratings**: 0–5 stars in half steps plus an optional message (up to 500 characters), one per browser per game
  per puzzle day. Re-rating replaces it.
- **Hub page**: today's weekday level, plays today and over the last 7 days, and each game's plays and average
  stars. Cards are ordered by `0.5 × plays/most plays + 0.5 × rating/5`, where rating is a Bayesian average
  (5 imaginary votes at 3.5 stars, so a single 5-star vote can't top the list).
- **Reading feedback**: open `https://jgg-hub.jacob-gg-leaderboard-worker.workers.dev/admin` (any username, the admin
  password) for per-game and per-day averages, plays and every message, with filters by game and day and a CSV
  download. Change the password with `cd worker && npx wrangler secret put ADMIN_PASSWORD`.
- Tests: `cd worker && rm -rf .wrangler && npm run db:seed:local && npm run dev:local`, then `npm test` (API) and,
  from the repo root, `npm install && node tools/ui-check.mjs` (hub page + rating box in Chrome).

## 5. Leaderboard worker pattern (per game)

Cloudflare Worker + D1, free plan, the same shape in every game (copy `perceptle/worker` or `factle/worker`):
- `POST /api/session` issues a server-generated player id and token (the token is stored hashed).
- Submissions are validated server-side. Recompute the score from the raw answer where possible (Perceptle,
  Factle, Predictle). Otherwise check consistency (Yogle, Pointle, ridd-le). Rows are insert-only, and "late" is
  decided by the server's clock.
- `ALLOWED_ORIGINS = "https://biccyanzac-pixel.github.io"`; local dev adds `http://localhost:<site port>`.
- If the worker bundles site files (generators, schedules), redeploy the worker whenever they change.
- Free-plan limits to respect: D1 allows 10 databases per account (8 are in use: seven games and the hub), 5M rows
  read per day, and 50 queries per Worker invocation. Keep running totals rather than scanning every row.

## 6. Deploying

- Game site: `git subtree split --prefix site -b gh-pages && git push -f origin gh-pages` (Predictle and ridd-le
  differ, see their READMEs).
- Game worker: `cd worker && npx wrangler deploy` (remote schema: `npm run db:init`, migrations as the game
  documents).
- Hub page and kit: commit and push `main` in this repo (GitHub Pages serves `main`; about a minute).
- Hub worker: `cd worker && npx wrangler deploy`.
- In PowerShell, pass commit messages with `git commit -F <file>`. Inline messages containing quotes get mangled.

## 7. Local ports (don't reuse)

| Game | Site | Worker |
| --- | --- | --- |
| Yogle | 8080 | 8797 |
| Pointle | 8080 | 8799 |
| Factle | 8081 | 8811 |
| Perceptle | 8082 | 8821 |
| Stratle | 8084 | 8841 |
| Describle | 8082 | 8812 |
| Predictle | 8090 | 8798 |
| ridd-le | 5173 (Vite dev), 4173 (preview) | 8787 |
| jacob.gg hub | 8083 | 8831 |

Pick the next free pair for a new game and add it here.

## 8. Adding a new game: checklist

1. New folder `../<game>` next to `jacob.gg`, new GitHub repo `biccyanzac-pixel/<game>`, repo-local commit
   identity, a short `CLAUDE.md` (game rules, tests, ports, "see ../jacob.gg/PLAYBOOK.md"). Add it to `games.json`
   under `inDevelopment` (and to `jacob.gg.code-workspace`) so `npm run setup` clones it on other computers;
   move it to `games` at launch.
2. `site/` with the page skeleton from section 3 and components copied from Perceptle. Day number from an `EPOCH`,
   countdown, the weekday curve (section 2.3), share text, archive, the rating box.
3. `worker/` from the pattern in section 5. Create the D1 (`npx wrangler d1 create <game>-leaderboard`), apply the
   schema, deploy, and put the URL in the site's config.
4. Tests: determinism/golden days, worker API e2e, a headless-Chrome e2e at 360 px and desktop (Playwright with
   the system Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`).
5. Hub: add the game to `games.json`, add a card (with `data-game="<id>"` and its own art and colour) to
   `index.html`, add its D1 binding to `worker/wrangler.toml` and its query to `worker/src/sources.js`, and add its
   display name to `NAMES` in `kit/jgg.js`. Redeploy the hub worker and push this repo. Update the README table.
6. Deploy the game (section 6) and open it from the hub on a phone.

## 9. Kit status per game

| Game | Kit look | Level chip | Rating box | Shared name + change | Auto-submit | Weekday curve |
| --- | --- | --- | --- | --- | --- | --- |
| Factle | yes | yes | yes | yes | yes (name before play) | yes; Sunday hardest for days after 2026-10-23 |
| Pointle | yes | yes | yes | yes | yes (once named) | yes; Sunday mix |
| Yogle | yes | yes | yes | yes | yes (once named, every try) | yes; Sunday hardest |
| Perceptle | yes | yes | yes (on-time days) | yes | yes (name before play) | yes; Sunday illusion special |
| Predictle | yes | yes | yes | yes | yes | yes; Sunday toughest |
| ridd-le | yes | no (no curve) | yes | yes (until the first attempt) | yes (every attempt) | no curve yet |
| Stratle | yes | yes | yes | yes | yes (name before play) | yes; crowd deepens Mon to Sun, Sunday deepest |
| Describle | not yet (in development) | – | – | – | – | – |

When a game is brought up to date, update this table.

## 10. Starting a new game in a new chat

On any computer, open a folder (the one that holds `jacob.gg` and the games, or an empty one) and start with:

```
New jacob.gg daily game. If ./jacob.gg or ../jacob.gg isn't here, first run:
git clone https://github.com/biccyanzac-pixel/jacob.gg && cd jacob.gg && npm run setup
Then use the daily-games skill and follow jacob.gg/PLAYBOOK.md exactly
(house rules, kit, leaderboard worker, tests, deploy, hub registration, ports).
Copy the page structure and components from ../perceptle or ../factle so it
looks like the others. Register it on the hub (games.json, card, hub worker
sources, kit NAMES) as the very last step, after checking git status in
../jacob.gg, because other agents may be editing it.

Game name: <name>
Idea: <how a round works, how scoring works>
Weekday curve: <what makes Monday easy and Saturday hard, what Sunday's special is>
```

To change an existing game, the same opening works with `Task: <what to change in which game>` instead of the
game idea.
