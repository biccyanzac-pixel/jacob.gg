// Worst-case data for the hub page and the kit (break-ui): huge and zero counts, missing ratings, long and
// non-Latin names in "Playing as", a 500-character rating message. Stubs the hub API; no worker needed.
//   node tools/break-check.mjs        -> screenshots in tools/results/break-*.png
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';

fs.mkdirSync('tools/results', { recursive: true });
const srv = await serve(8083);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
let failures = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const IDS = ['ridd-le', 'yogle', 'predictle', 'pointle', 'factle', 'perceptle', 'stratle', 'describle'];
const STATS = {
  huge: { plays: { today: 98765, week: 1234567, all: 987654321 }, games: IDS.map((id, i) => ({ id, plays: { all: [987654321, 1, 0, 10000, 999, 12345678, 2, 1001][i] }, rating: i % 3 ? { votes: [0, 1, 4821, 12][i % 4], avg: [0, 5, 0.5, 3.25][i % 4] } : { votes: 0 } })) },
  zero: { plays: { today: 0, week: 0, all: 0 }, games: IDS.map((id) => ({ id, plays: { all: 0 }, rating: { votes: 0 } })) },
};
const NAMES = ['WWWWWWWWWWWWWWWWWWWW', 'Aleksandra Wiśniewska', '🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄', 'محمد عبد الرحمن', '王小明', 'Jo'];

for (const [vp, viewport] of [['320', { width: 320, height: 700 }], ['desktop', { width: 1200, height: 900 }]]) {
  for (const scheme of ['dark', 'light']) {
    const tag = `${vp}/${scheme}`;
    const ctx = await browser.newContext({ viewport, colorScheme: scheme });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

    for (const [kind, stats] of Object.entries(STATS)) {
      await page.route('http://stub.hub/api/stats', (r) => r.fulfill({ json: stats }));
      await page.goto('http://localhost:8083/?hub=' + encodeURIComponent('http://stub.hub'));
      await page.waitForSelector('#plays:not([hidden])');
      const text = await page.textContent('#plays');
      check(`${tag} hub ${kind}: no sideways scroll`, !(await wide()));
      check(`${tag} hub ${kind}: counts are formatted, never NaN/undefined`, !/NaN|undefined/.test(await page.textContent('main')), text.replace(/\s+/g, ' ').trim());
      const metas = await page.locator('.meta').allTextContents();
      check(`${tag} hub ${kind}: "1 play" singular, no "1 plays"`, !metas.some((m) => /\b1 plays\b/.test(m)) && (kind !== 'huge' || metas.some((m) => /^1 play\b/.test(m))), metas.join(' | '));
      const clipped = await page.evaluate(() => [...document.querySelectorAll('.today, .card')].filter((e) => e.scrollWidth > e.clientWidth + 1).length);
      check(`${tag} hub ${kind}: no clipped boxes`, clipped === 0, `${clipped} clipped`);
      await page.screenshot({ path: `tools/results/break-hub-${kind}-${vp}-${scheme}.png`, fullPage: true });
      await page.unroute('http://stub.hub/api/stats');
    }
    // stats down: the page still works in its default order
    await page.route('http://stub.hub/api/stats', (r) => r.fulfill({ status: 500, body: 'down' }));
    await page.goto('http://localhost:8083/?hub=' + encodeURIComponent('http://stub.hub'));
    await page.waitForTimeout(300);
    check(`${tag} hub stats down: cards still listed, counts hidden`, (await page.locator('.grid .card').count()) === 8 && (await page.locator('#plays[hidden]').count()) === 1);

    // kit: "Playing as" with every awkward name, and a 500-character rating message
    await page.goto('http://localhost:8083/kit/demo.html?hub=off');
    for (const n of NAMES) {
      await page.evaluate((n) => {
        let m = document.getElementById('pa');
        if (!m) { m = document.createElement('p'); m.id = 'pa'; document.querySelector('.card').prepend(m); }
        JGG.playingAs({ mount: m, name: n });
      }, n);
      check(`${tag} kit playingAs "${n}": no sideways scroll`, !(await wide()));
      await page.click('#pa .jgg-change');
      check(`${tag} kit playingAs "${n}" editing: no sideways scroll`, !(await wide()));
      await page.keyboard.press('Escape');
    }
    await page.goto('http://localhost:8083/kit/demo.html?hub=' + encodeURIComponent('http://stub.hub'));
    await page.route('http://stub.hub/**', (r) => r.fulfill({ json: { mine: null, day: { votes: 1234567, avg: 4.25 } } }));
    await page.reload();
    await page.waitForSelector('.jgg-rate');
    await page.fill('.jgg-rate textarea', 'Lorem ipsum dolor sit amet, consectetuer adipiscing elit. '.repeat(9).slice(0, 500));
    check(`${tag} kit rating 500-char message: no sideways scroll`, !(await wide()));
    check(`${tag} no page errors`, errors.length === 0, errors.join('; '));
    await page.screenshot({ path: `tools/results/break-kit-${vp}-${scheme}.png`, fullPage: true });
    await ctx.close();
  }
}
await browser.close();
srv.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
