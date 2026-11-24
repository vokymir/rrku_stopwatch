// Run: node server.js   (Node 18+, no dependencies). Env: PORT (default 3000), DATA (default ./data.json)
const http = require('http'), fs = require('fs'), path = require('path'), { randomInt } = require('crypto');
const FILE = process.env.DATA || path.join(__dirname, 'data.json'), PORT = process.env.PORT || 3000;
let db = {}; try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const save = () => fs.writeFile(FILE, JSON.stringify(db), () => {});
const subs = {};
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,x-pin', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS' };
const json = (res, code, o) => { res.writeHead(code, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const bcast = (s, cid, o) => { for (const c of subs[s] || []) if (c.cid !== cid) c.res.write('data: ' + JSON.stringify(o) + '\n\n'); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const m = u.pathname.match(/^\/api\/c\/([\w-]{6,64})(?:\/(\w+))?$/);
  if (!m) {
    if (u.pathname === '/' || u.pathname === '/index.html')
      return fs.readFile(path.join(__dirname, 'index.html'), (e, b) => { res.writeHead(e ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' }); res.end(b); });
    res.writeHead(404); return res.end();
  }
  const [, s, sub] = m, c = db[s];
  if (sub === 'stream') {
    if (!c) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': ok\n\n');
    const cl = { res, cid: u.searchParams.get('cid') };
    (subs[s] = subs[s] || new Set()).add(cl);
    return req.on('close', () => subs[s].delete(cl));
  }
  if (req.method === 'GET' && !sub) {
    if (!c) return json(res, 404, { error: 'not found' });
    return json(res, 200, { config: c.config, events: c.events, now: Date.now() });
  }
  let body = ''; req.on('data', d => { body += d; if (body.length > 5e6) req.destroy(); });
  req.on('end', () => {
    let b = {}; try { b = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    if (req.method === 'POST' && !sub) {                       // create contest, return PIN once
      if (c) return json(res, 409, { error: 'exists' });
      const pin = String(randomInt(100000, 1000000));
      db[s] = { pin, config: b.config || {}, events: [] }; save();
      return json(res, 200, { pin });
    }
    if (!c) return json(res, 404, { error: 'not found' });
    if (req.method === 'PUT' && sub === 'config') {            // only with PIN
      if (req.headers['x-pin'] !== c.pin) return json(res, 403, { error: 'wrong PIN' });
      c.config = b.config; save(); bcast(s, b.cid, { type: 'config', config: c.config });
      return json(res, 200, { ok: 1 });
    }
    if (req.method === 'POST' && sub === 'events') {           // anyone with the secret; deduplicated by id
      const have = new Set(c.events.map(e => e.id)), add = (b.events || []).filter(e => e && e.id && !have.has(e.id));
      if (add.length) { c.events.push(...add); save(); bcast(s, b.cid, { type: 'events', events: add }); }
      return json(res, 200, { added: add.length });
    }
    json(res, 404, { error: 'no route' });
  });
}).listen(PORT, () => console.log('Listening on http://localhost:' + PORT));
setInterval(() => { for (const k in subs) for (const c of subs[k]) c.res.write(': ping\n\n'); }, 25000);
