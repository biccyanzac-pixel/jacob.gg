// jacob.gg "Play together": the room server. Routes:
//   POST /api/rooms                 -> { code, hostToken }   create a room (rate-limited per IP)
//   GET  /api/rooms/:code           -> { exists }            check a code before joining (rate-limited per IP)
//   GET  /api/rooms/:code/ws        -> WebSocket             join (rate-limited per IP); protocol in docs/rooms.md
import { makeCode, normalizeCode } from './logic.js';
export { Room } from './room.js';

// [attempts, per window ms] per IP. JOIN_LIMIT / CREATE_LIMIT vars override the counts (e.g. for local tests).
const limits = (env) => ({ create: [+env.CREATE_LIMIT || 10, 60 * 60e3], join: [+env.JOIN_LIMIT || 30, 10 * 60e3] });

// Join and create attempts per IP, in memory, sharded over 8 objects. Best-effort: an evicted shard forgets its
// counts, which only ever errs towards letting someone in. No storage writes, so it costs only the request.
export class Gate {
  constructor(ctx) { this.hits = new Map(); }
  async fetch(request) {
    const { ip, kind, max, win } = await request.json(), now = Date.now();
    const key = kind + ':' + ip, list = (this.hits.get(key) ?? []).filter((t) => now - t < win);
    if (this.hits.size > 50_000) this.hits.clear();
    if (list.length >= max) return Response.json({ ok: false, retryAfter: Math.ceil((list[0] + win - now) / 1000) });
    list.push(now);
    this.hits.set(key, list);
    return Response.json({ ok: true });
  }
}

async function allowed(env, request, kind) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  let h = 0; for (const c of ip) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const gate = env.GATE.get(env.GATE.idFromName('gate-' + (h % 8)));
  const [max, win] = limits(env)[kind];
  return (await gate.fetch('https://gate/', { method: 'POST', body: JSON.stringify({ ip, kind, max, win }) })).json();
}

function cors(env, request) {
  const origin = request.headers.get('Origin') ?? '';
  const ok = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).includes(origin);
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {};
}
const json = (data, status, headers) => Response.json(data, { status, headers });

export default {
  async fetch(request, env) {
    const url = new URL(request.url), h = cors(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const m = url.pathname.match(/^\/api\/rooms(?:\/([^/]+))?(\/ws)?$/);
    if (!m) return json({ error: 'not found' }, 404, h);

    if (!m[1] && request.method === 'POST') {
      const gate = await allowed(env, request, 'create');
      if (!gate.ok) return json({ error: 'slow down', retryAfter: gate.retryAfter }, 429, h);
      const body = await request.json().catch(() => ({}));
      for (let tries = 0; tries < 8; tries++) {
        const code = makeCode(), hostToken = crypto.randomUUID();
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const r = await stub.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, hostToken, capacity: body.capacity }) });
        if (r.ok) return json({ code, hostToken }, 201, h);
      }
      return json({ error: 'no free code, try again' }, 503, h);
    }

    const code = normalizeCode(m[1]);
    const gate = await allowed(env, request, 'join');
    if (!gate.ok) return json({ error: 'slow down', retryAfter: gate.retryAfter }, 429, h);
    if (!code) return json({ error: 'no such room' }, 404, h);
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    if (m[2]) {
      const origin = request.headers.get('Origin');
      if (origin && !Object.keys(h).length) return new Response('origin not allowed', { status: 403 });
      return stub.fetch(request);
    }
    const r = await (await stub.fetch('https://room/exists')).json();
    return json(r, r.exists ? 200 : 404, h);
  },
};
