# UI and motion pass: before and after, per game

Started 2026-10-19. UI and motion only: no gameplay, scoring, seed, data or leaderboard changes. There is one branch,
`ui-pass`, in each repo (this one is the shared shell), and each lands as one PR. The shared values are in
[motion-system.md](motion-system.md).

Status: steps 1 (motion system) and 2 (mobile-native) are done on every branch. Steps 3 and 4 are waiting for the
owner's approval of the plans.

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

| Game | Before | After steps 1–2 | Change |
| --- | --- | --- | --- |
| ridd-le (built dist) | 688,728 | 688,728 | 0 |
| Yogle | 53,374 | 53,374 | 0 |
| Predictle | 77,400 | 77,756 | +356 (+0.5%) |
| Pointle | 142,759 | 142,885 | +126 (+0.1%) |
| Factle | 20,684 | 20,684 | 0 |
| Perceptle | 117,921 | 117,921 | 0 |
| Stratle | 108,455 | 108,455 | 0 |
| Describle | 65,404 | 65,404 | 0 |
| Shared kit `jgg.js` (every game) | 11,329 (3,990 gzip) | 14,747 (5,205 gzip) | +3,418 (+1,215 gzip) |

The kit is shared and cached across games. Counted as part of Factle, the smallest game, it puts Factle at +10.7% raw
(+11% gzip). The owner decides whether the shared kit counts against each game's budget.

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
