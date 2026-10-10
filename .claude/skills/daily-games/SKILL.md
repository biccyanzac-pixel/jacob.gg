---
name: daily-games
description: Use when making a new jacob.gg daily game, or changing the look, leaderboard, results screen, ratings, hub page or deploy of an existing one (ridd-le, Yogle, Predictle, Pointle, Factle, Perceptle, Describle). Not for unrelated projects.
---

# jacob.gg daily games

The owner's daily puzzle games each live in their own GitHub repo under `github.com/biccyanzac-pixel`, served
from `https://biccyanzac-pixel.github.io/<game>/`. The hub repo **jacob.gg** ties them together, and every game
folder sits next to it: `<parent>/jacob.gg`, `<parent>/perceptle`, `<parent>/factle` and so on.

**If `../jacob.gg` (or `./jacob.gg`) isn't there, set up the workspace first:**
`git clone https://github.com/biccyanzac-pixel/jacob.gg && cd jacob.gg && npm run setup`. That clones every game
next to it and installs this skill on the computer.

**Then read `jacob.gg/PLAYBOOK.md`.** It has the house rules, the shared kit, the hub (plays, ratings, ranking),
the leaderboard-worker pattern, deploy commands, the ports in use and a checklist for a new game. Then read the
game's own `CLAUDE.md`.

The essentials, in case you only skim:
- New puzzle at 00:00 UTC, the same for everyone. Never change a past or current day.
- Weekday curve: Monday easiest through Saturday hardest; Sunday is a special (a twist, or hardest of all).
- One name for every game: `JGG.name()` / `JGG.setName()`, shown as "Playing as Jo · change"
  (`JGG.playingAs`). Ask only if no name is known, then auto-submit every finished game. No submit button.
- Every page loads `https://biccyanzac-pixel.github.io/jacob.gg/kit/jgg.css` and `jgg.js` first. Use the
  masthead with the jacob.gg link, `JGG.levelChip(day)` on the intro, and `JGG.rate({ game, day, mount })` on the
  results screen.
- A new game must also be added to the hub: `games.json`, a card in `index.html`, its D1 in
  `worker/wrangler.toml` and `worker/src/sources.js`, and `NAMES` in `kit/jgg.js`. Then redeploy the hub worker.
- Free project: ask the owner before anything paid or any third-party analytics.
- Other agents may be working in a game repo. Check `git status` and recent file times first, `git pull` before
  starting, and never commit someone else's uncommitted work.
- Commit as `biccyanzac-pixel <285977456+biccyanzac-pixel@users.noreply.github.com>` (setup sets this per repo).
