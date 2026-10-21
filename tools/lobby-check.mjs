// End-to-end check of "Play together": a host and a player on phones make/join a room, play today's Factle inside the
// lobby, and both see one shared reveal and scoreboard.
//   cd rooms && npm run dev -- --var JOIN_LIMIT:500     node tools/preview.mjs      node tools/lobby-check.mjs
import { chromium, devices } from 'playwright-core';
const SITE = 'http://localhost:8099/jacob.gg/play/?rooms=' + encodeURIComponent('http://127.0.0.1:8861');
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
let fails = 0;
const check = (label, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${d ? '  ' + d : ''}`); if (!ok) fails++; };
const phone = async (name) => {
  const ctx = await b.newContext({ ...devices['Pixel 7'] });
  await ctx.addInitScript((n) => { try { localStorage.setItem('jgg:name', n); } catch {} }, name);
  await ctx.route(/workers\.dev/, (r) => r.abort()); // no real leaderboards from a test
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(SITE);
  return { page, errors };
};
async function playFactle(page) {
  const f = page.frameLocator('#frame');
  await f.locator('#start').click({ timeout: 20000 });
  for (let r = 0; r < 5; r++) {
    await f.locator('#facts li:nth-child(2) .fact').click({ timeout: 15000 });
    await f.locator('#confirm').click();
    await f.locator('#next').click({ timeout: 15000 });
  }
}

const host = await phone('Mum'), kid = await phone('Sam');
await host.page.fill('#nick', 'Mum');
await host.page.click('#create');
await host.page.waitForSelector('#s-lobby:not([hidden])');
const code = (await host.page.textContent('#code')).trim();
check('host makes a room and sees its code', /^[A-HJKMNP-Z2-9]{4}$/.test(code), code);
await kid.page.fill('#nick', 'Sam');
await kid.page.fill('#code-in', code.toLowerCase());
await kid.page.click('#join');
await kid.page.waitForSelector('#s-lobby:not([hidden])');
await host.page.waitForFunction(() => document.querySelectorAll('#players li').length === 2);
check('both players listed', true);
check('only the host sees the picker', await host.page.isVisible('#picker') && !(await kid.page.isVisible('#picker')));
check('no sideways scroll in the lobby', !(await host.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));

await host.page.click('.game[data-g="factle"]');
await host.page.selectOption('#mins', '3');
await host.page.click('#start');
await Promise.all([host, kid].map((p) => p.page.waitForSelector('#countdown:not([hidden])')));
check('everyone gets the countdown', true);
await Promise.all([host, kid].map((p) => p.page.waitForSelector('#s-play:not([hidden])', { timeout: 10000 })));
check('the game opens for everyone after the countdown', true);
await playFactle(host.page);
await host.page.waitForSelector('#play-wait:not([hidden])', { timeout: 15000 });
check('the host\'s finished score is picked up', true);
check('no reveal until everyone has finished', await host.page.isHidden('#s-reveal'));
await playFactle(kid.page);
await Promise.all([host, kid].map((p) => p.page.waitForSelector('#s-reveal:not([hidden])', { timeout: 20000 })));
const rows = await host.page.$$eval('#rv-results li', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
const kidRows = await kid.page.$$eval('#rv-results li', (ls) => ls.length);
check('one shared reveal with both results', rows.length === 2 && kidRows === 2, rows.join(' | '));
const board = await kid.page.$$eval('#rv-board li', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
check('scoreboard shows points', board.length === 2 && /\d/.test(board[0]), board.join(' | '));
check('host can go on to the next game', await host.page.isVisible('#next') && !(await kid.page.isVisible('#next')));

// a refresh mid-room keeps your place
await kid.page.reload();
await kid.page.waitForSelector('#s-lobby:not([hidden]), #s-reveal:not([hidden])', { timeout: 10000 });
const kidTotal = await host.page.evaluate(() => [...document.querySelectorAll('#rv-board li')].map((l) => l.textContent));
check('a refresh puts you back in the room', (await kid.page.textContent('#code')).trim() === code, kidTotal.join(' | '));
check('no page errors', !host.errors.length && !kid.errors.length, [...host.errors, ...kid.errors].join('; '));
await host.page.screenshot({ path: 'tools/results/lobby-reveal.png', fullPage: true });
await b.close();
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
