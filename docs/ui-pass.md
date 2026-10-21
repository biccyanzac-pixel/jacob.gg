# UI and motion pass: before and after, per game

Started 2026-10-19. UI and motion only: no gameplay, scoring, seed, data or leaderboard changes. There is one branch,
`ui-pass`, in each repo (this one is the shared shell), and each lands as one PR. The shared values are in
[motion-system.md](motion-system.md).

Status (2026-10-20): all eight steps are done on every branch, and each repo passed the step 8 review gate with no
open notes. Draft PRs are open. Nothing is merged or deployed; the owner tests on a real phone first. Merge jacob.gg
first, because every game loads the kit from its `main`.

The owner's decisions on the plans: every step 3 row and every step 4 row (A–K) was approved, with conditions:
- Count-ups are tap-skippable and never delay the share button or the board.
- Phase changes and the hub's card cascade add under 250 ms, and the first card is never delayed.
- The kit has its own budget of 10 KB gzip growth; each game's own JS may grow at most 10%.

## Steps 3–8 per repo (what changed, and what was chosen not to change)

Every review blocked at least once. Each finding was fixed (optional notes too) and re-reviewed until approved.

| Repo | Motion (steps 3–5) | Break-ui (step 6) | Performance (step 7) | Review gate (step 8): what it caught |
| --- | --- | --- | --- | --- |
| Shell | `JGG.motion.swap` (old screen goes at once, new one enters in 220 ms), skippable `settle`, `scroll` (instant under reduce motion), stagger capped at the 7th item, asymmetric press, iOS `:active` fix. Hub: card cascade done within 250 ms, cards glide to their rank (FLIP), fade under reduce motion. | A 20-letter name in "Playing as" pushed 320 px pages sideways (fixed in the kit for every game). | The rating widget's date formatter is built once (it cost 40–90 ms on phones). | The first swap pinned the old screen and measured it after moving it, so it shrank or jumped in real layouts. It was replaced, along with retargeting, the stagger cap, press timing and the screen-reader copy. |
| ridd-le | Score settles from the old average to the new one; only the newest row reveals; the panel glides up into the form's place on the third attempt. The loader ring stops on error. The meter uses translateX (keeps its rounded end). Hint hides on `transitionend`. | "(you)" was cut off; rank 1000+; long "yesterday" names; the sandbox page was unstyled (now loads the kit); undefined tokens fixed. | No heavy animation screens (the model isn't an animation). | The looping loading sweep used an in-out curve, so it looked stalled (now linear). The glide start, and the hint fade-in that never played, also fixed. |
| Yogle | Result count-up and reveal; screen swaps; on hold complete the result appears at once while the play screen fades off it and the ring pulses. Live meter has no transition. | A board row with a missing field blanked the board; RTL names; archive rows were serif; the share grid has a safety scroll. | 3D figure loops stop off-screen and under reduce motion (0 frames/s idle vs 60); colours cached (0 vs 240 `getComputedStyle`/s). Play screen can't reach 60 fps: MediaPipe runs on the main thread. | The pulse first made the result wait 440 ms, then the fading camera screen blocked taps and a quick retry could stop the new game's camera. All fixed. |
| Predictle | Round result reveal and count-up; daily score count-up; phase enters; answer ring grows and fades, then the guess line fades in as it settles. Canvas decor holds still under reduce motion. | A missing field blanked the board; rank 1000+; RTL names; long "Playing as"; the share URL wraps. | One draw loop per round that sleeps after the round (0 redraws/s vs 34; main thread busy 26% vs 96%), predict ring at 30 fps, static scenery cached, observers released. Playback p95 50 ms vs 83 at 4× throttle. | Physics frames, slow motion, freeze, save and submit independently verified identical to origin/main (0 mismatches). Guess-line timing and a needless re-entrance on name edit fixed. |
| Pointle | Reveal score count-up (280 ms) and staggered facts; done total count-up; screens enter in 220 ms; the globe glides from your guess to the answer (450 ms) once it is on screen. Figure-8 hint is static with its path under reduce motion. | Rank 1000+; yesterday's winner pushed 320 px pages sideways; long group names; the map tip overlapped the attribution; the tilt control covered the readout at 320 px. | The sensor reveal redraws only when the reading moves (p95 16.7 ms vs 83 with the phone still); colours cached; globe materials no longer leak. Not fixed: the radar's coastline takes ~350 ms to draw on reveal. | (see the PR) |
| Factle | Done-screen count-up and row reveal; the reveal's tags appear in a 50 ms cascade; round → done swap. | A missing field blanked the board; the real fact ran sideways with long words; today's 43-letter word scrolled iPhones sideways (fixed in step 2). | Score boxes contain their relayout. | The facts were fading in while the round clock ran, which is a gameplay regression. Now the round appears at once; the per-round score shows plainly (the live timer just showed it). |
| Perceptle | Done-screen count-up; result bars grow with scaleX (no width animation, no replay on reload); countdown digits arrive; per-task points enter and count up quickly (280 ms). | A missing field blanked the board; rank 1000+; RTL names; raw server errors scrolled sideways; "100.00" and "0 (left)" now fit. Dead template CSS removed from the reference sheet. | Count reveal draws its dimmed dots once (script per frame p95 10 ms vs 36–54); colours cached. | Per-task points first used the once-a-day timings. Puzzle stimulus pixels and timing verified identical to origin/main. |
| Stratle | Reveal stagger; question score count-up (280 ms) and daily total (700 ms); phase swaps; crowd chart bars grow from the baseline, markers fade, depth bar wipes. Question names for lowball, crowdpoints and rare (owner-approved wording). | A missing field blanked the board; the chart's last axis label ran off at 320 px; long labels wrap. | Bars grow as one group: per-bar growth was far too slow at 4× throttle; grouped it costs nothing measurable (interleaved runs). | The per-question count-up was too long, and the rating widget pushed the board down a frame late. Both fixed. |
| Describle | Only the newest attempt row enters and its bars grow (the old width animation regrew every row on every guess); finishing reveal and count-up; loading → play swap. | A missing field blanked the board; rank 1000+; long chips and messages wrap. | Found that "Thinking…" and the spinner never painted during a guess (the AI ran in the same task as the tap). A one-frame wait fixes it. | The new wait would stall in a hidden tab; a 50 ms fallback fixes it. No double-submit verified. |

## Frame times on a quiet machine (step 7, re-measured after all agents finished)

Pixel 7 profile with 4× CPU throttle as the mid-range-phone proxy; 3 runs before (origin/main, old kit) and 3 after,
alternated; medians. Software WebGL (SwiftShader). The display ran at 57–72 Hz, so "60 fps met" means p95 at the
frame period.

| Game / screen | Before → after | Verdict |
| --- | --- | --- |
| Factle reveal; done | p95 16.8 → 16.8; done p95 33.3 → 16.8 (first-frame stall 360 → 190 ms) | Same; done faster. 60 fps met |
| Stratle reveal, 70-bar chart | p95 16.8 → 16.8, worst 16.8 → 16.8 | Same (bar growth costs nothing). 60 fps met |
| Perceptle count / midpoint / proportion reveals | p95 ≈16.7 both; script per frame 7.6 → 3.4 ms (count); proportion worst 150 → 83 ms | Same or faster. 60 fps met |
| Predictle playback, predict, after round, bonus | p95 at the frame period both; main thread 49 → 8% after the round, 50 → 20% while predicting; redraws 57 → 0/s after the round | Same frames, far less CPU. 60 fps met |
| Pointle sensor reveal (still / moving) | p95 55 → 14 / 41 → 28 ms | Faster; still meets 60 fps |
| Pointle map play / reveal drag | p95 55 → 55 / 28 → 28 ms | Same; drags miss 60 fps before and after (software WebGL) |
| Pointle reveal entrance | median 13.8 → 27.6 ms while the globe glides | Slower **only during the new 450 ms globe glide** (each glide frame is a software-WebGL render); with the glide disabled it matches before. Kept (owner-approved row E): a phone GPU draws this globe cheaply. Check on a real phone |
| Yogle home figure | scrolled away 214 → 6 ms/s of main thread, 57 → 0 frames/s; `getComputedStyle` 228/s → 0 | Faster |
| Yogle play screen | 52.9 → 52.8 ms median (lite model) | Same; MediaPipe on the main thread caps it at 16–20 fps, so 60 fps is not met |
| Describle guesses 2–3 | p95 ≈18 both | Same; 60 fps met. A CPU profile of the finishing guess shows less script after the change (1,318 vs 1,576 ms; rating widget 29 → 3 ms) |

Chosen not to change, everywhere: leaderboard rows, countdown clocks, timers, live meters and sensors, sliders, board
tabs and typing get no motion, and puzzle stimuli, physics and slow motion keep their timing.

## How it was checked

- Each game's own unit tests and (where it runs locally) its headless e2e.
- A device check per game in headless browsers: Playwright WebKit with the iPhone 13 profile (the closest we can get
  to iPhone Safari on Windows), Chrome with the Pixel 7 profile (Android Chrome), and Chrome at 1280×900, each in dark
  and light. The live kit was routed to this branch's kit. It asserts no sideways scroll on every screen reached, no
  page errors, both theme-color metas, viewport-fit=cover, no ungated `:hover`, inputs at least 16px, and no hover left
  after a tap. Screenshots were looked at by eye.
- Not reproducible headless, so it needs a real phone: how sticky hover feels, notch padding (emulators report zero
  insets), the keyboard, rubber-banding, and iOS overscroll (Playwright's Windows WebKit doesn't support
  `overscroll-behavior`).

## JS budget (own shipped JS, bytes)

Owner's rule: each game's own JS grows at most 10%; the shared kit has its own budget of 10 KB gzip growth.

| Game | origin/main | Final | Change |
| --- | --- | --- | --- |
| ridd-le (built `main-*.js`; whole dist +0.3%) | 26,746 | 28,600 | +6.9% |
| Yogle | 53,374 | 57,735 | +8.2% |
| Predictle | 77,400 | 82,609 | +6.7% |
| Pointle | 142,759 | 147,071 | +3.0% |
| Factle | 20,684 | 21,747 | +5.1% |
| Perceptle | 117,921 | 123,578 | +4.8% |
| Stratle | 108,455 | 111,550 | +2.9% |
| Describle | 65,404 | 67,626 | +3.4% |
| Shared kit, gzip (`jgg.js` + `jgg.css`) | 3,990 + 2,106 | 6,026 + 3,416 | +3,346 B (of the 10 KB budget) |

No new libraries anywhere: CSS transitions and the Web Animations API only.

## Shell (this repo)

- **Before:** colour tokens only, no motion tokens. Body `min-height: 100vh` (on phones a short page still scrolled).
  The rating textarea was 15.2px, so iOS zoomed on focus. Hub: no viewport-fit or theme-color; the card hover lift
  was not gated, so it stuck after a tap on phones; no press state.
- **After:** motion tokens, `.jgg-press`, `.jgg-enter` and `.jgg-reveal`, and `JGG.motion` (enter, exit, swap,
  reveal, settle) with reduce-motion fades. `.shell` pads the safe areas. 100svh body, 16px kit inputs,
  `touch-action: manipulation` on controls, press feedback on the rating button. Hub: viewport-fit, safe areas,
  theme-color per scheme, no tap flash, card lift only for a mouse, press scale for touch.
  `tools/motion-check.mjs` tests the motion helpers (iPhone and desktop sizes, motion on and reduced, interrupted swaps).
- **Bug found and fixed while testing:** an interrupted `swap` could leave two phases visible. A swap is now
  cancelled when a newer one brings its old phase back.

## Every game (step 2, mobile-native)

The same baseline everywhere: theme-color per scheme, viewport-fit=cover (which turns on the kit's safe-area
padding), no grey tap flash, an `:active` state on every control (scale 0.97 on buttons, a background change on
full-width rows, colour only on keypads, opacity under reduce motion), every `:hover` limited to a mouse, no text
selection on controls, inputs at least 16px, `overscroll-behavior: contain` on inner scroll lists, and keyboard
hints on name fields.

| Game | Game-specific fixes | Chosen not to change (and why) |
| --- | --- | --- |
| ridd-le | Same baseline on `sandbox.html`. The music toggle's press keeps its centring transform. | No fixed elements and no vh units, so nothing to do there. |
| Yogle | The play screen blocks pull-to-refresh while it's shown. HUD, target pose and fps readout clear the landscape notch. `.input` really is 1.05rem now (a `font:` shorthand had been overriding it). | Live meter and HUD values: they update every frame, so they get no extra motion. |
| Predictle | The canvas no longer blocks page scrolling while you watch or after a round. It takes touch only in the predict, aim and explore phases (a class toggle at the existing phase switches). `.stage` uses svh. | Slow-motion replay: it's gameplay. |
| Pointle | The radar and bar canvases block scrolling only while they can be dragged (map mode). Before, in phone mode they blocked scrolling of the reveal. Map height uses svh. The groups select is now 16px (it was 13.6px, so iOS zoomed). The AR hint wraps instead of running off narrow phones, and the AR bar clears the notch. | Map and globe drag surfaces keep `touch-action: none`. The compass rose's 80ms linear smoothing stays: it's live sensor data. |
| Factle | `credits.html` now loads the kit (it was unstyled). Long unbroken words in facts wrap: today's round 5 has a 43-letter name that made the page scroll sideways on iPhones. | (none) |
| Perceptle | Arena clears the landscape notch and blocks overscroll. Keypad keys stay colour-only on press (tapped dozens of times a day). `calibrate.html` and the dev viewer get the same metas. | The arena and stage canvas keep `touch-action: none`: they are full-screen input surfaces. |
| Stratle | Range sliders keep horizontal drags inside a scrolling page (`touch-action: pan-y`). Review rows tint on press. | (none) |
| Describle | `enterkeyhint="send"` on the description box (Enter already submits). | Board tabs: two short labels fit at 360px, so no wrapping change. |

## Found along the way, for later steps or for the owner

- Stratle: `NAMES` in app.js has no `lowball`, `crowdpoints` or `rare`, so the question label shows the raw key and the
  results row reads "Q4 · undefined" (visible today). It's a copy fix, and it needs the owner's OK.
- Predictle: `test/gen.test.mjs:64` fails on the committed data (2027-03-06 "easy stops too high"). That's a future
  day, not touched by this pass.
- ridd-le `sandbox.html`, Perceptle `calibrate.html`/`dev/show.html` and Pointle `sensors.html` don't load the kit, so
  they render unstyled. ridd-le and Factle use `--accent-contrast`, `--panel` and `--warning`, which the kit doesn't
  define, so the archive button gets dark text on the accent colour in light mode.
- ridd-le: the loader ring keeps spinning on the load-error screen.
- Factle: source links sit inside disabled `<button>`s after the reveal (invalid nesting; may not be tappable).
- Yogle: archive rows render in a serif font in WebKit (font family not inherited).
- Pointle: the map tip text is clipped by the attribution bar on iPhone 13.
