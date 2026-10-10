// Minimal static server for the hub: node tools/serve.mjs [port]  ->  http://localhost:8083/
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
export function serve(port = 8083) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
      if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(port, () => resolve(srv));
  });
}
if (process.argv[1]?.endsWith('serve.mjs')) serve(Number(process.argv[2]) || 8083).then(() => console.log('jacob.gg hub on http://localhost:' + (Number(process.argv[2]) || 8083) + '/'));
