# jacob.gg

**Working on the games (any computer):**

```
git clone https://github.com/biccyanzac-pixel/jacob.gg
cd jacob.gg
npm run setup        # clones every game next to this folder, installs the daily-games skill
```

Then open `jacob.gg.code-workspace` in VS Code, and read [PLAYBOOK.md](PLAYBOOK.md).

The hub page for the daily games: **https://biccyanzac-pixel.github.io/jacob.gg/**

| Game | Repo | Play |
| --- | --- | --- |
| ridd-le | [biccyanzac-pixel/ridd-le](https://github.com/biccyanzac-pixel/ridd-le) | https://biccyanzac-pixel.github.io/ridd-le/ |
| Yogle | [biccyanzac-pixel/yogle](https://github.com/biccyanzac-pixel/yogle) | https://biccyanzac-pixel.github.io/yogle/ |
| Predictle | [biccyanzac-pixel/predictle](https://github.com/biccyanzac-pixel/predictle) | https://biccyanzac-pixel.github.io/predictle/ |
| Pointle | [biccyanzac-pixel/pointle](https://github.com/biccyanzac-pixel/pointle) | https://biccyanzac-pixel.github.io/pointle/ |
| Factle | [biccyanzac-pixel/factle](https://github.com/biccyanzac-pixel/factle) | https://biccyanzac-pixel.github.io/factle/ |
| Perceptle | [biccyanzac-pixel/perceptle](https://github.com/biccyanzac-pixel/perceptle) | https://biccyanzac-pixel.github.io/perceptle/ |
| Stratle | [biccyanzac-pixel/stratle](https://github.com/biccyanzac-pixel/stratle) | https://biccyanzac-pixel.github.io/stratle/ |

The hub page is a static `index.html`, served by GitHub Pages straight from `main`. It shows today's weekday
difficulty, plays today and this week, and each game's plays and stars. Cards are ordered by plays and rating.

| Part | What it is |
| --- | --- |
| [PLAYBOOK.md](PLAYBOOK.md) | House rules, look and workflow for every game. **Start here for a new game.** |
| [kit/](kit/) | `jgg.css` + `jgg.js`, loaded by every game: colours, font, masthead, weekday level, rating box ([demo](kit/demo.html)) |
| [worker/](worker/) | `jgg-hub` Cloudflare Worker + D1: syncs plays from every game's leaderboard, stores ratings, `/api/stats`, `/admin` |
| [games.json](games.json) | The list of live games |

**Reading ratings and messages:** https://jgg-hub.jacob-gg-leaderboard-worker.workers.dev/admin (password-protected;
filter by game and day, or download a CSV).

This repo used to hold ridd-le (renamed 2026-10-09). Old links to `/jacob.gg/` now land here, one click from the riddle.
