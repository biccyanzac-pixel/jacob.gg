# Play together: room server (phase 1)

`rooms/` is a separate Cloudflare Worker (`jgg-rooms`) with one Durable Object per room. It is not deployed yet.
Local: `cd rooms && npm run dev` (port 8861); tests: `npm test` (unit) and `npm run test:live` (simulated clients,
against `npm run dev -- --var JOIN_LIMIT:200`).

## Free-tier limits (Workers Free, checked 2026-10-21 on developers.cloudflare.com)

| Limit | Free plan | What a room uses |
| --- | --- | --- |
| Durable Object requests | 100,000 / day (shared across all DOs) | joining = 1; incoming WebSocket messages count 20:1 (100 messages = 5 requests); outgoing messages are free |
| Duration | 13,000 GB-s / day | ~0 while idle: the WebSocket Hibernation API is used, so idle rooms aren't billed |
| SQLite rows written | 100,000 / day | only on real changes (join, pick, start, lock-in, reveal); progress updates never write |
| SQLite rows read | 5,000,000 / day | one read when a room wakes |
| Storage | 5 GB per account | a room is a few KB; deleted after 6 h idle |
| Backend | SQLite-backed DOs only (no key-value DOs on Free) | uses `new_sqlite_classes` |
| Per object | ~1,000 requests/s soft limit; CPU 30 s per request | far above a 16-player room |
| DO classes | 100 per account | 2 (Room, Gate) |

Worked example: a 16-player room playing a 2-minute round with progress at 2 Hz sends about 3,840 incoming messages,
which counts as about 192 requests. So 100,000 a day is roughly 500 such rounds, plus joins. Limits reset at 00:00 UTC.

## HTTP

- `POST /api/rooms` `{capacity?}` → `201 {code, hostToken}`. 10 per IP per hour.
- `GET /api/rooms/:code` → `{exists}` (case and spaces ignored). Counts as a join attempt: 30 per IP per 10 minutes.
- `GET /api/rooms/:code/ws` → WebSocket (also a join attempt). Origins: `ALLOWED_ORIGINS` in `wrangler.toml`.

Codes are 4 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O, 1/I/L). A room expires after 6 hours with no
state change, or an hour after the host ends it.

## WebSocket messages (JSON, `t` = type)

Client → server:
- `hello {nickname, token?, role: 'player'|'spectator'}`, which must be first. Send back the saved `token` to reclaim
  the same slot and scores after a refresh or a dropped connection. The host connects with the `hostToken`.
- `progress {p: 0..1, seq}`: live presence. It is never stored, and is ignored after locking in.
- `lockin {score, payload}`: once per round. The server timestamps it and flags implausible values (over the max,
  faster than `minSec`, before the start) without rejecting them.
- `played {game, date, yes}`: the answer to a `check`.
- `ping {id}` → `pong {serverNow, id}` (for clock offset).
- Host only:
  - `pick {game, mode: 'daily'|'archive'|'random', date?, durationSec, maxScore?, minSec?}`. The server sets the date
    (today for daily) and the seed (random).
  - `check {game, date}`: the spoiler query. Players answer with `played`; the host receives `spoiler` messages.
  - `start`: a 3-second countdown, then the round.
  - `reveal`: force the reveal.
  - `settings {capacity?, scoring?: 'rank'|'raw', handicaps?: {slot: pct}}`.
  - `kick {slot}` and `end`.

Server → client: `welcome {you, room, lockedIn, serverNow}`, `room {room, serverNow}` (the full snapshot on every
change), `presence {slot, state, p, seq}`, `countdown {round, startsAt, endsAt, serverNow}`,
`reveal {why: 'all-locked'|'time'|'host', round, results, serverNow}`, `check`, `spoiler`, `closed`, `error {code}`.

The reveal fires exactly once per round, whichever of these comes first: every online player locked in, the round
timer (a Durable Object alarm), or the host. Points: 1st 5, 2nd 3, 3rd 2, every other finisher 1. Ties share the
better place, and the next player skips (5, 5, 2). Handicaps add a percentage (0–100) to the score before ranking.
`raw` mode adds the handicapped score instead.

## Not in phase 1 (later phases)

The lobby UI, the game contract, shared reveals, reactions, teams, persistent rooms, async mode and the recap card.
Posting room scores to each game's leaderboard with a "room play" tag needs a column in each game's leaderboard table,
and the hub's `worker/src/sources.js` must skip those rows so room play doesn't count as daily plays. That's planned
for phase 3.
