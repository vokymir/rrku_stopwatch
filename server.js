// Spuštění: node server.js  ->  http://localhost:5555   (Node 18+, bez závislostí)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 5555, FILE = process.env.DATA || path.join(__dirname, 'data.json');
const MONTH = 30 * 864e5, PUBLIC = path.join(__dirname, 'public');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,x-token', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' };

class Repo {
  constructor(file) { this.file = file; try { this.db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.db = {}; } }
  save() { fs.writeFile(this.file, JSON.stringify(this.db), () => {}); }
  get(s) { const c = this.db[s]; if (c) c.seen = Date.now(); return c; }
  put(s, c) { this.db[s] = c; this.save(); }
  del(s) { delete this.db[s]; this.save(); }
  purge() { for (const s in this.db) if (Date.now() - this.db[s].seen > MONTH) delete this.db[s]; this.save(); }
}

class Perms {
  static admin(c, n) { return !!(c.users[n] && c.users[n].admin); }
  static role(c, d, n) { const D = c.config.discs.find(x => x.name === d); return D && D.roles ? D.roles[n] : undefined; }
  static discAdmin(c, d, n) { return Perms.admin(c, n) || Perms.role(c, d, n) === 'admin'; }
  static referee(c, d, n) { return Perms.discAdmin(c, d, n) || Perms.role(c, d, n) === 'referee'; }
  static frozen(c, d, cat) {
    let f = false;
    for (const e of c.events) if (e.d === d && e.c === cat) { if (e.k === 'freeze') f = true; if (e.k === 'unfreeze') f = false; }
    return f;
  }
  static canEvent(c, e, n) {
    if (e.k === 'freeze') return Perms.discAdmin(c, e.d, n) && !Perms.frozen(c, e.d, e.c);
    if (e.k === 'unfreeze') return Perms.discAdmin(c, e.d, n);
    return Perms.referee(c, e.d, n) && !Perms.frozen(c, e.d, e.c);
  }
}

class Hub {
  constructor() { this.subs = new Map(); }
  add(s, cl) { if (!this.subs.has(s)) this.subs.set(s, new Set()); this.subs.get(s).add(cl); return () => this.subs.get(s).delete(cl); }
  send(s, cid, o) { for (const c of this.subs.get(s) || []) if (c.cid !== cid) c.res.write('data: ' + JSON.stringify(o) + '\n\n'); }
  ping() { for (const set of this.subs.values()) for (const c of set) c.res.write(': ping\n\n'); }
}

const repo = new Repo(FILE), hub = new Hub();
const json = (res, code, o) => { res.writeHead(code, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const publicUsers = c => Object.fromEntries(Object.entries(c.users).map(([n, u]) => [n, { admin: !!u.admin }]));
const who = (c, tok) => Object.keys(c.users).find(n => c.users[n].token === tok);
const validSecret = s => /^[\w-]{6,12}$/.test(s);

class Handlers {
  static head(c) { return [200, { exists: !!c }]; }
  static state(c) { return [200, { config: c.config, users: publicUsers(c), events: c.events, now: Date.now() }]; }

  static join(s, c, b) {
    const nick = String(b.nick || '').trim();
    if (!nick || nick.length > 24) return [400, { error: 'Přezdívka musí mít 1 až 24 znaků.' }];
    if (!c) {
      if (!validSecret(s)) return [400, { error: 'Heslo musí mít 6 až 12 znaků (písmena, číslice, _ nebo -).' }];
      const token = crypto.randomUUID();
      repo.put(s, { seen: Date.now(), config: b.config || { name: '', cats: [], discs: [] }, events: Array.isArray(b.events) ? b.events.map(e => ({ ...e, u: e.u || nick })) : [], users: { [nick]: { token, admin: true } } });
      return [200, { token, created: true }];
    }
    const u = c.users[nick];
    if (u) return b.token && b.token === u.token ? [200, { token: u.token, created: false }] : [409, { error: 'Přezdívka je na tomto serveru obsazená.' }];
    const token = crypto.randomUUID();
    c.users[nick] = { token, admin: false }; repo.save();
    hub.send(s, null, { type: 'users', users: publicUsers(c) });
    return [200, { token, created: false }];
  }

  static config(s, c, me, b) {
    if (!Perms.admin(c, me)) return [403, { error: 'Jen správce může měnit konfiguraci.' }];
    c.config = b.config; repo.save(); hub.send(s, b.cid, { type: 'config', config: c.config });
    return [200, { ok: 1 }];
  }

  static role(s, c, me, b) {
    if (!b.d) {
      if (!Perms.admin(c, me) || !c.users[b.nick]) return [403, { error: 'Nedostatečná práva.' }];
      c.users[b.nick].admin = !!b.admin; repo.save(); hub.send(s, null, { type: 'users', users: publicUsers(c) });
      return [200, { ok: 1 }];
    }
    const D = c.config.discs.find(x => x.name === b.d), r = b.role || '';
    if (!D || !c.users[b.nick] || !['', 'referee', 'admin'].includes(r)) return [400, { error: 'Neplatný požadavek.' }];
    if (!Perms.discAdmin(c, b.d, me) || (r === 'admin' && !Perms.admin(c, me))) return [403, { error: 'Nedostatečná práva.' }];
    D.roles = D.roles || {}; r ? (D.roles[b.nick] = r) : delete D.roles[b.nick];
    repo.save(); hub.send(s, null, { type: 'config', config: c.config });
    return [200, { ok: 1 }];
  }

  static events(s, c, me, b) {
    const have = new Set(c.events.map(e => e.id)), added = [], rejected = [];
    for (const e of b.events || []) {
      if (!e || !e.id || have.has(e.id)) continue;
      if (!Perms.canEvent(c, e, me)) { rejected.push(e.id); continue; }
      const ev = { ...e, u: me }; c.events.push(ev); added.push(ev); have.add(e.id);
    }
    if (added.length) { repo.save(); hub.send(s, b.cid, { type: 'events', events: added }); }
    return [200, { added: added.length, rejected }];
  }

  static remove(s, c, me) {
    if (!Perms.admin(c, me)) return [403, { error: 'Jen správce může smazat soutěž.' }];
    repo.del(s); hub.send(s, null, { type: 'deleted' });
    return [200, { ok: 1 }];
  }
}

class Router {
  static serveStatic(u, res) {
    const f = path.join(PUBLIC, u === '/' ? 'index.html' : path.normalize(u).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (e, b) => {
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }[path.extname(f)] || 'application/octet-stream';
      res.writeHead(e ? 404 : 200, { 'content-type': type }); res.end(b);
    });
  }

  static stream(s, me, u, req, res) {
    if (!me) return json(res, 403, { error: 'Neplatný přístup.' });
    res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': ok\n\n');
    req.on('close', hub.add(s, { res, cid: u.searchParams.get('cid') }));
  }

  static handle(req, res) {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const m = u.pathname.match(/^\/api\/c\/([^/]+)(?:\/(\w+))?$/);
    if (!m) return Router.serveStatic(u.pathname, res);
    const s = decodeURIComponent(m[1]), sub = m[2] || '', c = repo.get(s);
    const me = c && who(c, req.headers['x-token'] || u.searchParams.get('token'));
    if (sub === 'stream') return Router.stream(s, me, u, req, res);
    let body = '';
    req.on('data', d => { body += d; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      let b = {}; try { b = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'Chybný JSON.' }); }
      const r = Router.dispatch(req.method, sub, s, c, me, b);
      json(res, r[0], r[1]);
    });
  }

  static dispatch(method, sub, s, c, me, b) {
    if (sub === 'head' && method === 'GET') return Handlers.head(c);
    if (sub === 'join' && method === 'POST') return Handlers.join(s, c, b);
    if (!c) return [404, { error: 'Soutěž neexistuje.' }];
    if (!me) return [403, { error: 'Nejste připojeni.' }];
    if (!sub && method === 'GET') return Handlers.state(c);
    if (!sub && method === 'DELETE') return Handlers.remove(s, c, me);
    if (sub === 'config' && method === 'POST') return Handlers.config(s, c, me, b);
    if (sub === 'role' && method === 'POST') return Handlers.role(s, c, me, b);
    if (sub === 'events' && method === 'POST') return Handlers.events(s, c, me, b);
    return [404, { error: 'Neznámá cesta.' }];
  }
}

repo.purge(); setInterval(() => repo.purge(), 864e5); setInterval(() => hub.ping(), 25000);
http.createServer(Router.handle).listen(PORT, () => console.log('Ranger stopky: http://localhost:' + PORT));
