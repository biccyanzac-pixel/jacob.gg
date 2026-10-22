// Preview the hub and every game together, before anything is deployed, on this PC and on a phone on the same Wi-Fi.
//   node tools/preview.mjs [gamesFolder]   -> http://localhost:8099/  (and http://<this PC's IP>:8099/ for a phone)
// gamesFolder defaults to ../ (the normal checkouts); pass ../ui-pass to preview branch worktrees. This repo's own
// working tree is served as /jacob.gg/, so its kit is the one being tested: every page's link to the live kit
// (https://biccyanzac-pixel.github.io/...) is rewritten to this server. ridd-le is served from web/dist, so build it
// first with BASE_PATH=/ridd-le/ (cd ../ridd-le/web && BASE_PATH=/ridd-le/ npx vite build; in Git Bash prefix MSYS_NO_PATHCONV=1,
// or it turns /ridd-le/ into a Windows path).
// Leaderboards and ratings don't load here: the real workers only accept the real site, so test plays can't touch
// the real boards. Camera, motion sensors and WebGPU need https or localhost, so on a phone over Wi-Fi Yogle's camera,
// Pointle's phone mode and ridd-le's judge won't start; everything else works.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAMES = path.resolve(HUB, process.argv[2] || '..');
const PORT = Number(process.env.PORT) || 8099;
const ROOTS = {
  'jacob.gg': HUB,
  'ridd-le': path.join(GAMES, 'ridd-le', 'web', 'dist'),
  yogle: path.join(GAMES, 'yogle', 'site'),
  predictle: path.join(GAMES, 'predictle', 'public'),
  pointle: path.join(GAMES, 'pointle', 'site'),
  factle: path.join(GAMES, 'factle', 'site'),
  perceptle: path.join(GAMES, 'perceptle', 'site'),
  stratle: path.join(GAMES, 'stratle', 'site'),
  describle: path.join(GAMES, 'describle', 'site'),
  lettrle: path.join(GAMES, 'lettrle', 'site'),
  groupyle: path.join(GAMES, 'groupyle', 'site'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const REWRITE = new Set(['.html', '.js', '.mjs', '.css']);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') { res.writeHead(302, { Location: '/jacob.gg/' }); return res.end(); }
  const [, game, ...rest] = decodeURIComponent(url.pathname).split('/');
  const root = ROOTS[game];
  if (!root) { res.writeHead(404); return res.end('not found'); }
  if (url.pathname === `/${game}`) { res.writeHead(302, { Location: `/${game}/` }); return res.end(); }
  let p = path.join(root, ...rest);
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(p).toLowerCase();
  const head = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (!REWRITE.has(ext)) { res.writeHead(200, head); return fs.createReadStream(p).pipe(res); }
  const body = fs.readFileSync(p, 'utf8').replaceAll('https://biccyanzac-pixel.github.io/', '/');
  res.writeHead(200, head);
  res.end(body);
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`Preview: http://localhost:${PORT}/  (games from ${GAMES})`);
  for (const ip of ips) console.log(`  phone on the same Wi-Fi: http://${ip}:${PORT}/`);
});
