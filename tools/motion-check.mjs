// Browser checks for the kit's motion system (docs/motion-system.md) on kit/demo.html, in headless Chrome.
// No worker needed:   node tools/motion-check.mjs
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';

const srv = await serve(8083);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
let failures = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };

for (const reducedMotion of ['no-preference', 'reduce']) {
  for (const [vp, viewport] of [['iphone', { width: 390, height: 844 }], ['desktop', { width: 1200, height: 900 }]]) {
    const name = `${vp}/${reducedMotion}`;
    const ctx = await browser.newContext({ viewport, reducedMotion, hasTouch: vp === 'iphone', isMobile: vp === 'iphone' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:8083/kit/demo.html?hub=off');
    await page.waitForFunction(() => window.JGG?.motion);

    check(`${name}: tokens defined`, (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--jgg-t-enter').trim())) === '220ms');
    check(`${name}: kit inputs >= 16px`, await page.evaluate(() => {
      const i = document.createElement('input'); i.className = 'jgg-name-input'; document.body.append(i);
      const ok = parseFloat(getComputedStyle(i).fontSize) >= 16; i.remove(); return ok;
    }));

    // swap: A leaves (exit), B arrives (enter). The animations used must be transform + opacity only.
    const frames = await page.evaluate(async () => {
      const a = document.getElementById('m-a'), b = document.getElementById('m-b');
      const p = JGG.motion.swap(a, b);
      const props = [...a.getAnimations(), ...b.getAnimations()].flatMap((x) => x.effect.getKeyframes().flatMap((k) => Object.keys(k)));
      await p;
      return { props: [...new Set(props)], aHidden: a.hidden, bHidden: b.hidden, bOpacity: getComputedStyle(b).opacity, running: b.getAnimations().length };
    });
    check(`${name}: swap hides A, shows B fully`, frames.aHidden && !frames.bHidden && frames.bOpacity === '1' && frames.running === 0, JSON.stringify(frames));
    const animated = frames.props.filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p));
    check(`${name}: animates only ${reducedMotion === 'reduce' ? 'opacity' : 'transform + opacity'}`,
      reducedMotion === 'reduce' ? animated.join() === 'opacity' : animated.sort().join() === 'opacity,transform', animated.join());

    // swap back straight away, twice: interrupted transitions must not leave anything hidden or transparent
    const rapid = await page.evaluate(async () => {
      const a = document.getElementById('m-a'), b = document.getElementById('m-b');
      JGG.motion.swap(b, a);
      await new Promise((r) => setTimeout(r, 40));
      await JGG.motion.swap(a, b);
      await new Promise((r) => setTimeout(r, 50));
      return { a: a.hidden, b: b.hidden, op: getComputedStyle(b).opacity };
    });
    check(`${name}: rapid swaps settle cleanly`, rapid.a === true && rapid.b === false && rapid.op === '1', JSON.stringify(rapid));

    // owner's rule: a phase change adds under 250 ms as seen by the player (exit and enter overlap)
    const swapMs = await page.evaluate(async () => {
      const a = document.getElementById('m-a'), b = document.getElementById('m-b');
      const [from, to] = a.hidden ? [b, a] : [a, b];
      const t = performance.now(); await JGG.motion.swap(from, to); return performance.now() - t;
    });
    check(`${name}: a swap takes under 250 ms`, swapMs < 250, `${Math.round(swapMs)} ms`);
    const layoutOk = await page.evaluate(() => [...document.querySelectorAll('#m-a, #m-b')].every((e) => !e.getAttribute('style')));
    check(`${name}: swap leaves no inline styles behind`, layoutOk);

    // owner's rule: the count-up is skippable with a tap and never holds anything up
    if (reducedMotion !== 'reduce') {
      await page.evaluate(() => { document.getElementById('m-score').textContent = '0'; JGG.motion.settle(document.getElementById('m-score'), 8420, { format: (v) => Math.round(v).toLocaleString('en') }); });
      await page.waitForTimeout(80);
      if (vp === 'iphone') await page.tap('h1'); else await page.mouse.click(5, 5);
      check(`${name}: a tap skips the count-up to the final score`, (await page.textContent('#m-score')) === '8,420', await page.textContent('#m-score'));
    }

    // scroll helper: instant under reduce motion
    const behavior = await page.evaluate(() => { let b; const o = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (x) { b = x.behavior; }; JGG.motion.scroll(document.body); Element.prototype.scrollIntoView = o; return b; });
    check(`${name}: scroll is ${reducedMotion === 'reduce' ? 'instant' : 'smooth'}`, behavior === (reducedMotion === 'reduce' ? 'auto' : 'smooth'), behavior);

    // reveal + settle
    await page.evaluate(() => { document.getElementById('m-score').textContent = '0'; });
    const t0 = Date.now();
    await page.click('#m-reveal');
    const first = await page.textContent('#m-score');
    const label = await page.getAttribute('#m-score', 'aria-label');
    if (reducedMotion === 'reduce') check(`${name}: settle shows the final score at once`, first === '8,420', first);
    else check(`${name}: settle exposes the final score to screen readers while counting`, label === '8,420' || first === '8,420', `${first} / ${label}`);
    await page.waitForFunction(() => document.getElementById('m-score').textContent === '8,420', null, { timeout: 3000 });
    check(`${name}: settle ends on the final value`, true, `${Date.now() - t0} ms`);
    // hub: cascade within 250 ms, first card tappable at once, reorder glides (not under reduce motion)
    await page.route('http://stub.hub/api/stats', (r) => setTimeout(() => r.fulfill({ json: {
      plays: { today: 1, week: 2, all: 3 },
      games: ['describle', 'stratle', 'perceptle', 'factle', 'pointle', 'predictle', 'yogle', 'ridd-le'].map((id) => ({ id, plays: { all: 5 }, rating: { votes: 0 } })) } }), 600));
    await page.goto('http://localhost:8083/?hub=' + encodeURIComponent('http://stub.hub'));
    const hub = await page.evaluate(() => {
      const first = document.querySelector('.grid .card'), r = first.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 2));
      const ends = document.getAnimations().map((a) => a.effect.getComputedTiming().endTime);
      return { tappable: first.contains(hit), longest: Math.max(...ends), firstDelay: first.getAnimations()[0]?.effect.getTiming().delay ?? 0 };
    });
    check(`${name}: hub cascade done within 250 ms, first card tappable at once`, hub.tappable && hub.longest <= 250 && hub.firstDelay === 0, JSON.stringify(hub));
    await page.waitForFunction(() => document.querySelector('.grid .card').dataset.game === 'describle');
    const glides = await page.evaluate(() => document.getAnimations().filter((a) => JSON.stringify(a.effect.getKeyframes()).includes('translate(')).length);
    check(`${name}: hub reorder ${reducedMotion === 'reduce' ? 'jumps without motion' : 'glides'}`, reducedMotion === 'reduce' ? glides === 0 : glides > 0, `${glides} gliding`);
    check(`${name}: no page errors`, errors.length === 0, errors.join('; '));
    check(`${name}: no horizontal scroll`, !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
    await ctx.close();
  }
}

await browser.close();
srv.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
