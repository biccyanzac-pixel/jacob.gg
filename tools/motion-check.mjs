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
      const props = a.getAnimations().flatMap((x) => x.effect.getKeyframes().flatMap((k) => Object.keys(k)));
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

    // reveal + settle
    const t0 = Date.now();
    await page.click('#m-reveal');
    const first = await page.textContent('#m-score');
    const label = await page.getAttribute('#m-score', 'aria-label');
    if (reducedMotion === 'reduce') check(`${name}: settle shows the final score at once`, first === '8,420', first);
    else check(`${name}: settle exposes the final score to screen readers while counting`, label === '8,420' || first === '8,420', `${first} / ${label}`);
    await page.waitForFunction(() => document.getElementById('m-score').textContent === '8,420', null, { timeout: 3000 });
    check(`${name}: settle ends on the final value`, true, `${Date.now() - t0} ms`);
    check(`${name}: no page errors`, errors.length === 0, errors.join('; '));
    check(`${name}: no horizontal scroll`, !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
    await ctx.close();
  }
}

await browser.close();
srv.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
