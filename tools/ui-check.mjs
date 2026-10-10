// Browser checks for the hub page and the kit's rating widget, in headless Chrome, against a local hub worker:
//   cd worker && rm -rf .wrangler && npm run db:seed:local && npm run dev:local     (in another terminal)
//   node tools/ui-check.mjs        -> screenshots in tools/results/
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';

const HUB = process.env.HUB || 'http://127.0.0.1:8831';
fs.mkdirSync('tools/results', { recursive: true });
const srv = await serve(8083);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
let failures = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const WEEKDAY = new Date().getUTCDay();

for (const [name, viewport, scheme] of [['phone-dark', { width: 360, height: 800 }, 'dark'], ['desktop-light', { width: 1200, height: 900 }, 'light']]) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // hub page
  await page.goto(`http://localhost:8083/?hub=${encodeURIComponent(HUB)}`);
  await page.waitForSelector('#plays:not([hidden])', { timeout: 10000 });
  check(`${name}: level line`, /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/.test(await page.textContent('#level')));
  check(`${name}: week strip marks today`, (await page.locator('#week li.now').count()) === 1 && (await page.locator('#week li').count()) === 7);
  const order = await page.locator('.grid .card').evaluateAll((cs) => cs.map((c) => c.dataset.game));
  const ranked = (await (await fetch(`${HUB}/api/stats`)).json()).games.map((g) => g.id);
  check(`${name}: cards in the hub's rank order`, order.join(',') === ranked.join(','), order.join(','));
  check(`${name}: card meta`, /plays?/.test(await page.locator('[data-game="perceptle"] .meta').textContent()));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  check(`${name}: no horizontal scroll`, !overflow);
  await page.screenshot({ path: `tools/results/hub-${name}.png`, fullPage: true });

  // rating widget on the kit demo
  await page.goto(`http://localhost:8083/kit/demo.html?game=${name.startsWith('phone') ? 'factle' : 'pointle'}&hub=${encodeURIComponent(HUB)}`);
  await page.waitForSelector('.jgg-rate');
  check(`${name}: send disabled before choosing`, await page.locator('.jgg-rate-send').isDisabled());
  const box = await page.locator('.jgg-stars-bg').boundingBox();
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
  check(`${name}: tap at 70% = 3.5 stars`, (await page.textContent('.jgg-stars-value')) === '3.5 ★', await page.textContent('.jgg-stars-value'));
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.99, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  check(`${name}: slide to the end = 5`, (await page.textContent('.jgg-stars-value')) === '5 ★');
  await page.focus('.jgg-stars');
  await page.keyboard.press('ArrowLeft');
  check(`${name}: keyboard steps by 0.5`, (await page.textContent('.jgg-stars-value')) === '4.5 ★');
  await page.fill('.jgg-rate textarea', 'Nice one');
  await page.click('.jgg-rate-send');
  await page.waitForFunction(() => document.querySelector('.jgg-rate-note').textContent.startsWith('Thanks'));
  check(`${name}: sent`, (await page.textContent('.jgg-rate-note')).includes('Thanks!'), await page.textContent('.jgg-rate-note'));
  await page.screenshot({ path: `tools/results/kit-${name}.png`, fullPage: true });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.jgg-rate-note').textContent.startsWith('You rated'));
  check(`${name}: remembers my rating`, (await page.inputValue('.jgg-rate textarea')) === 'Nice one' && (await page.textContent('.jgg-stars-value')) === '4.5 ★');
  const chips = await page.locator('#levels .jgg-level').allTextContents();
  check(`${name}: level chips Monday..Sunday`, chips[0] === 'Monday · easiest' && chips[5] === 'Saturday · hardest' && chips[6] === 'Sunday special', chips.join(' | '));
  check(`${name}: no page errors`, errors.length === 0, errors.join('; '));
  await ctx.close();
}

// Chrome can hang on close on Windows; never let that hold the result.
await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
srv.closeAllConnections();
srv.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
