# Room contract: how a game talks to the Play together lobby

The lobby (`play/index.html`) runs each round's game in an iframe on the same origin. A game knows it's in a room
when `window.parent !== window`. It can then post its progress and its finish to the lobby. The lobby forwards them
to the room server (`rooms/`, see [rooms.md](rooms.md)), which shows them to the other players.

Posting is optional. A game that posts nothing still works: the lobby reads its finished score off the page with the
`done` and `score` selectors in `GAMES` (`play/index.html`). A game that posts gets live progress for the other
players, and its finish locks in at once instead of after the score has been steady for 1.2 s.

## Messages, game → lobby

```js
if (window.parent !== window) window.parent.postMessage(message, location.origin);
```

Always pass `location.origin` as the target, never `'*'`. The lobby ignores any message that isn't from its own iframe,
on its own origin, with `jgg: 'room'`, and for the game the round is playing.

Every message has:

| Field | Type | Meaning |
| --- | --- | --- |
| `jgg` | `'room'` | Marks the message as ours. |
| `type` | `'progress'` or `'finish'` | |
| `game` | string | The game's id in `games.json`, for example `'lettrle'`. |
| `day` | `YYYY-MM-DD` | The puzzle day being played (an archive day in archive rounds). |

### `progress`

Send it when the player makes a move that counts (Lettrle: the start, then after each guess). The lobby sends at most two
a second to the room server and drops the rest, keeping the newest.

| Field | Type | Meaning |
| --- | --- | --- |
| `p` | number, 0–1 | How far through the game the player is. Lettrle: guesses made ÷ 6. |
| `rows` | string[], optional | Colour rows for word games: each row is `g`, `y` or `x` per tile (right place, in the word, not in it). At most 8 rows of at most 8 tiles. |

Game-specific fields may ride along (Lettrle adds `length`, `max` and `guesses`); the lobby ignores them.

**Never send anything that gives the puzzle away.** Rows are colours only, never letters or words. The room server
enforces this: it relays `rows` only if every row matches `^[gyx]{1,8}$` (`cleanRows` in `rooms/src/logic.js`), and
otherwise drops them. Progress is never stored.

### `finish`

Send it once, when the game is over, and again when a finished game is loaded (with `already: true`).

| Field | Type | Meaning |
| --- | --- | --- |
| `score` | number | The room score: **more is better**, because the room ranks by highest score. Turn "fewer is better" around (Lettrle: 6 for a first-guess solve, down to 1 for six guesses, 0 for a miss). |
| `already` | boolean | `true` if the game was already finished when the page loaded, so the player had played it before. The reveal flags it. |
| `rows` | string[], optional | The final colour rows, shown next to the player on the reveal. Same rules as above. |
| `solved`, `ms` | optional | Game-specific, for the record (Lettrle: solved or not, and the time). |

The lobby locks in `score` straight away (`lockin {score, payload: {already, rows}}`). A room round's score never goes on
the game's own leaderboard; the game still saves to its leaderboard as it normally would.

## The fallback selectors

The page must also show the same score in an element the lobby can find, in case the kit or the message is missed:

- `done`: an element that is visible only when the game is over.
- `score`: an element whose text is the room score (digits only). It may be hidden.

Lettrle uses `#done` and a hidden `<span id="room-score">` that holds the room score.

## Example: Lettrle

```js
// after the third guess
{ jgg: 'room', type: 'progress', game: 'lettrle', day: '2026-10-21', p: 0.5, rows: ['xxyxx', 'yxgxx', 'gygxg'],
  length: 5, max: 6, guesses: 3 }
// solved on the fourth
{ jgg: 'room', type: 'finish', game: 'lettrle', day: '2026-10-21', score: 3, already: false, solved: true, ms: 74210,
  rows: ['xxyxx', 'yxgxx', 'gygxg', 'ggggg'], length: 5, max: 6, guesses: 4 }
```

The lobby shows each player's newest row next to their dot in the play bar, and their whole grid on the reveal.

## Example: Groupyle

Groupyle sends how many groups the player has found and how many mistakes they've made. It **never** sends a word, a
group's name or which words were picked: the other players are solving the same board.

| Field | Type | Meaning |
| --- | --- | --- |
| `p` | number, 0–1 | Groups found ÷ groups on the board. |
| `found` | integer | Groups found so far (0–4, or 0–5 on Sundays). |
| `groups` | integer | Groups on the board: 4, or 5 on Sundays. |
| `mistakes` | integer | Wrong guesses so far (0–4). A repeated guess doesn't count. |
| `maxMistakes` | integer | 4: the game ends at the fourth mistake. |
| `rows` | string[] | One row, one tile per group: `g` for found, `x` for not yet. Never words. |

It posts `progress` when the board appears and after every guess, and `finish` when the last group is found or the
fourth mistake is made (and `finish` with `already: true` when a finished game is loaded).

The room `score` is **groups found, plus the mistakes left if the board was solved** (`roomScore` in
`groupyle/site/js/daily.js`). So a solve always beats a fail, fewer mistakes beat more, and failing with more groups
found beats failing with fewer. A solved board scores 5–8 (Sunday 6–9); an unsolved one scores 0–3 (0–4 on Sundays). The time isn't in the score: in a room everyone
plays the same round, and ties share a place. The daily leaderboard still breaks ties by the server-timed time.

```js
// after a mistake and one found group
{ jgg: 'room', type: 'progress', game: 'groupyle', day: '2026-10-24', p: 0.25, found: 1, groups: 4, mistakes: 1,
  maxMistakes: 4, rows: ['gxxx'] }
// solved with one mistake
{ jgg: 'room', type: 'finish', game: 'groupyle', day: '2026-10-24', p: 1, found: 4, groups: 4, mistakes: 1,
  maxMistakes: 4, rows: ['gggg'], score: 7, solved: true, ms: 95310, already: false }
```

Fallback selectors: `#done` and a hidden `<span id="room-score">` with the same score.

## Adding a game to Play together

1. Add it to `GAMES` in `play/index.html`: `id`, `name`, `em` (an emoji), `min` (default round length in minutes),
   `archive` (the query parameter for an archive day, `'day'` or `'date'`, or leave it out for today only), and the
   `done` and `score` selectors.
2. Optionally post `progress` and `finish` as above. Test it inside an iframe on the same origin (Lettrle's
   `tools/e2e-ui.mjs` does this with a stub lobby page).
