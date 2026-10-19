# jacob.gg motion system

Every game uses the same curves, durations and named transitions, so moving from the hub to a game and from game to game
feels like one site. They live in the shared kit: tokens and CSS classes in `kit/jgg.css`, script helpers in
`kit/jgg.js` (`JGG.motion`). No animation library is needed. Use CSS transitions for state changes and
the Web Animations API (through `JGG.motion`) for anything started from script.

## Rules

1. **Animate only when it helps.** Every animation has to do one job: give feedback, show where something came from,
   make a state change readable, or stop content from jumping. Decoration is allowed only on rare moments (a finished
   game, a first visit).
2. **The more often it's seen, the less it moves.** Taps and keyboard input, seen dozens of times a game, get
   `--jgg-t-press` or nothing at all. Phase changes, a few per game, get `enter`/`exit`. Results, once a day, can use
   `reveal` and `settle`.
3. **`transform` and `opacity` only.** Don't animate width, height, top, left or margins. Don't use `transition: all`.
4. **Never `scale(0)`.** Things grow from 0.96 to 0.98 with a fade.
5. **Never `ease-in` on UI.** It starts slowly, at the exact moment the player is watching.
6. **Interruptible.** Use transitions (not keyframes) for anything that can be toggled quickly. `JGG.motion` cancels
   the running animation on an element before starting a new one.
7. **Gameplay motion is not UI motion.** Puzzle stimuli, physics replays, timers and the camera feed keep their own
   timing. These rules are for the chrome around them.
8. **Reduce motion.** With `prefers-reduced-motion: reduce`, nothing moves. Entrances become a 160 ms fade, scores
   show their final value at once, and nothing is hidden or delayed. No information depends on motion.
9. **Hover only for a mouse.** Put `:hover` effects inside `@media (hover: hover) and (pointer: fine)`, and give every
   tappable thing an `:active` state.

## Tokens (`kit/jgg.css`)

| Token | Value | Use |
| --- | --- | --- |
| `--jgg-ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | Enter, exit, reveal, press. The default. |
| `--jgg-ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | Something already on screen moving or morphing. |
| `--jgg-ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | Sheets and drawers. |
| `ease` (built in) | | Colour, border and background changes. |
| `--jgg-t-press` | 120 ms | `:active` feedback. |
| `--jgg-t-hover` | 150 ms | Colour and border changes, hover lift. |
| `--jgg-t-exit` | 160 ms | Leaving. Shorter than arriving, because the next thing is what matters. |
| `--jgg-t-enter` | 220 ms | A panel, row or phase appearing. |
| `--jgg-t-reveal` | 320 ms | An answer or result being revealed. |
| `--jgg-t-settle` | 700 ms | A score counting up. |
| `--jgg-stagger` | 50 ms | Between items in a revealed group. |

## Named transitions

| Name | What moves | CSS | Script |
| --- | --- | --- | --- |
| press | `scale(0.97)` while held; in at 120 ms, release snaps back in 80 ms | `.jgg-press` | (none) |
| enter | fade in from `translateY(6px) scale(0.98)`, 220 ms | `.jgg-enter` | `JGG.motion.enter(el)` unhides and plays |
| exit | fade out to `translateY(-4px) scale(0.98)`, 160 ms | (none) | `JGG.motion.exit(el)` plays, then hides |
| swap | the old phase goes at once (the system's response snaps) and the new one enters, so a phase change takes 220 ms (owner's rule: under 250 ms) and never disturbs layout | (none) | `JGG.motion.swap(fromEl, toEl)` |
| reveal | fade in from `translateY(10px) scale(0.96)`, 320 ms, 50 ms stagger capped at the 7th item | `.jgg-reveal` + `style="--jgg-i: n"` | `JGG.motion.reveal(els)` |
| score-settle | the number counts up over 700 ms (ease-out cubic). Any tap or key jumps to the final value. Never `await` it before showing the share button or the board | (none) | `JGG.motion.settle(el, to, { from, format })` |
| scroll | `scrollIntoView`, smooth normally and instant under reduce motion | (none) | `JGG.motion.scroll(el, { block })` |

The CSS classes play once when the element is inserted or unhidden. Under reduce motion, each script helper becomes a
160 ms fade (or no animation for `settle`).

```js
// Games load the kit with defer and must work without it:
const m = window.JGG?.motion;
m ? m.swap(introEl, playEl) : ((introEl.hidden = true), (playEl.hidden = false));
m?.reveal(document.querySelectorAll('.round-row'));
m ? m.settle(scoreEl, total) : (scoreEl.textContent = total);
```

While `settle` counts, the ticking number is `aria-hidden` and a visually hidden copy holds the final value, so screen readers hear the real score. A transition that interrupts another starts from where that one had got to. iOS Safari needs a `touchstart` listener for `:active`; the kit adds one.

## Owner's timing rules

- A phase change adds under 250 ms as the player sees it. Exit and enter overlap, and the new screen is tappable
  from its first frame.
- Group entrances (the hub's cards) finish within 250 ms, and the first item has no delay.
- Count-ups can be skipped with a tap and never delay the share button or the leaderboard.

## What not to animate

- Keyboard input, typed letters, tile taps and guess submissions, which are seen dozens of times a game. Use press
  feedback at most.
- Leaderboard rows when the board refreshes. People are reading them.
- The countdown clock, scores during play, and any number the player is reading off.
- Anything that is the puzzle itself (Perceptle's stimuli, Predictle's physics, Pointle's pointing, Yogle's pose).

## Checking a change

- DevTools, Animations panel, playback at 10%. Look for a jump at the start or end, and for anything starting slowly.
- DevTools, Rendering, "Emulate CSS prefers-reduced-motion: reduce". Nothing should move, and nothing should be missing.
- Change phases quickly (double-tap the next button). Animations should retarget or cancel, not queue up.
