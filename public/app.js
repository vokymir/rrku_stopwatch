'use strict';
/* Ranger stopky: klient. Třídy: Store, Perms, Clock, DoubleTap, Sync, Views, Actions, App. */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const range = n => Array.from({ length: n }, (_, i) => String(i + 1));
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const fmt = ms => {
  const s = Math.max(0, ms) / 1000, h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(1).padStart(4, '0');
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + x;
};
const DEFAULTS = {
  cats: [{ name: 'DR', teams: range(8) }, { name: 'AR', teams: range(23) }, { name: 'ER', teams: range(10) }, { name: 'RR', teams: range(10) }],
  discs: ['Fyzická zdatnost (běh)', 'Rozdělání ohně', 'Biblické znalosti', 'Uzlování', 'Morseovka']
};
const LABEL = { start: 'Start', tstop: 'Čas zastaven', tresume: 'Čas pokračuje', stop: 'Tým {t} zastaven', resume: 'Tým {t} pokračuje', freeze: '❄ Zmrazeno', unfreeze: 'Rozmrazeno' };

class Store {
  static KEY = 'rr2';
  static load() {
    const d = { theme: 'light', server: 'http://localhost:5555', secret: '', nick: '', on: false, tokens: {}, cid: uid(), off: 0, cat: 0, config: { name: 'Ranger roku', cats: [], discs: [] }, users: {}, events: [] };
    try { return { ...d, ...JSON.parse(localStorage.getItem(Store.KEY) || '{}') }; } catch { return d; }
  }
  static save() { try { localStorage.setItem(Store.KEY, JSON.stringify(S)); } catch { alert('Paměť prohlížeče je plná, data nelze uložit.'); } }
}
let S = Store.load();

/* V lokálním režimu je uživatel správce; na serveru rozhodují role. */
class Perms {
  static admin() { return !S.on || !!(S.users[S.nick] && S.users[S.nick].admin); }
  static role(d) { return S.on ? (d.roles || {})[S.nick] : 'admin'; }
  static discAdmin(d) { return Perms.admin() || Perms.role(d) === 'admin'; }
  static referee(d) { return Perms.discAdmin(d) || Perms.role(d) === 'referee'; }
}

/* Hodiny jedné kategorie v jedné disciplíně: start, pauzy celého času, časy týmů. */
class Clock {
  static live(events) {
    const v = new Set(events.filter(e => e.k === 'void').map(e => e.ref));
    return events.filter(e => e.k !== 'void' && !v.has(e.id)).sort((a, b) => a.ts - b.ts);
  }
  static frozen(events, d, c) {
    let f = false;
    for (const e of Clock.live(events)) if (e.d === d && e.c === c) { if (e.k === 'freeze') f = true; if (e.k === 'unfreeze') f = false; }
    return f;
  }
  constructor(events, d, c) {
    const L = Clock.live(events).filter(e => e.d === d && e.c === c);
    this.start = L.filter(e => e.k === 'start').pop();
    this.after = this.start ? L.filter(e => e.ts >= this.start.ts && e !== this.start) : [];
    this.pauses = []; let from = null;
    for (const e of this.after) {
      if (e.k === 'tstop' && from == null) from = e.ts;
      if (e.k === 'tresume' && from != null) { this.pauses.push([from, e.ts]); from = null; }
    }
    this.paused = from != null;
    if (this.paused) this.pauses.push([from, Infinity]);
  }
  state() { return !this.start ? 'idle' : this.paused ? 'paused' : 'run'; }
  at(ts) {
    if (!this.start) return 0;
    let t = ts - this.start.ts;
    for (const [a, b] of this.pauses) t -= Math.max(0, Math.min(ts, b) - a);
    return Math.max(0, t);
  }
  /* Zastavení + pokračování + zastavení = celkový čas (pokračování bylo omyl). */
  team(t, now) {
    if (!this.start) return { s: 'off', ms: 0 };
    const es = this.after.filter(e => e.t === t && (e.k === 'stop' || e.k === 'resume')), last = es[es.length - 1];
    return !last || last.k === 'resume' ? { s: 'run', ms: this.at(now) } : { s: 'stop', ms: this.at(last.ts) };
  }
}

/* Potvrzení dvojklikem: první klepnutí tlačítko "nabije", druhé provede akci. */
class DoubleTap {
  static key = null; static timer = 0;
  static hit(key) {
    if (DoubleTap.key === key) { DoubleTap.disarm(); return true; }
    DoubleTap.key = key; clearTimeout(DoubleTap.timer); DoubleTap.timer = setTimeout(DoubleTap.disarm, 3000);
    App.render(); return false;
  }
  static disarm() { DoubleTap.key = null; clearTimeout(DoubleTap.timer); App.render(); }
}

class Sync {
  static es = null;
  static url(p = '') { return S.server.replace(/\/$/, '') + '/api/c/' + encodeURIComponent(S.secret) + p; }
  static tok() { return S.tokens[Sync.url()] || ''; }
  static async call(p, method = 'GET', body) {
    let r;
    try { r = await fetch(Sync.url(p), { method, headers: { 'content-type': 'application/json', 'x-token': Sync.tok() }, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw new Error('Server není dostupný.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Chyba ' + r.status);
    return j;
  }
  static async connect() {
    const h = await Sync.call('/head'), hadTok = !!Sync.tok();
    if (h.exists && !hadTok && (S.events.length || S.config.discs.length) && S.pending !== Sync.url()) {
      S.pending = Sync.url();
      return 'Soutěž s tímto heslem už existuje. Připojíte se jako divák a data v tomto zařízení budou nahrazena. Pro potvrzení klikněte znovu na Připojit.';
    }
    const j = await Sync.call('/join', 'POST', { nick: S.nick, token: Sync.tok(), config: S.config, events: S.events });
    S.tokens[Sync.url()] = j.token; S.on = true;
    if (!j.created && !hadTok) S.events = [];
    await Sync.pull(); Sync.stream();
    return j.created ? 'Soutěž vytvořena, jste správce.' : 'Připojeno k existující soutěži.';
  }
  static async pull() {
    const j = await Sync.call('');
    S.off = j.now - Date.now(); S.config = j.config; S.users = j.users; Sync.merge(j.events); Store.save();
  }
  static merge(evs) {
    const ids = new Set(S.events.map(e => e.id)); let n = 0;
    for (const e of evs) if (!ids.has(e.id)) { S.events.push(e); n++; }
    if (n) Store.save();
    return n;
  }
  static drop(ids) { if (ids && ids.length) S.events = S.events.filter(e => !ids.includes(e.id)); }
  static async flush() { try { Sync.drop((await Sync.call('/events', 'POST', { events: S.events, cid: S.cid })).rejected); } catch { /* zkusí se znovu po připojení */ } }
  static async push(e) {
    if (!S.on) return;
    try {
      const r = await Sync.call('/events', 'POST', { events: [e], cid: S.cid });
      if (r.rejected.length) { Sync.drop(r.rejected); Store.save(); alert('Server akci odmítl (chybí oprávnění nebo jsou výsledky zmrazené).'); App.render(); }
    } catch { App.ui.ok = false; App.status(); }
  }
  static async pushConfig() { if (S.on) try { await Sync.call('/config', 'POST', { config: S.config, cid: S.cid }); } catch (e) { alert(e.message); } }
  static stream() {
    if (Sync.es) Sync.es.close();
    Sync.es = new EventSource(Sync.url('/stream?cid=' + S.cid + '&token=' + Sync.tok()));
    Sync.es.onmessage = m => Sync.onMessage(JSON.parse(m.data));
    Sync.es.onopen = async () => { App.ui.ok = true; try { await Sync.pull(); await Sync.flush(); } catch { /* offline */ } App.status(); App.draw(); };
    Sync.es.onerror = () => { App.ui.ok = false; App.status(); };
  }
  static onMessage(d) {
    if (d.type === 'events' && Sync.merge(d.events)) App.draw();
    if (d.type === 'config') { S.config = d.config; Store.save(); App.draw(); }
    if (d.type === 'users') { S.users = d.users; Store.save(); App.draw(); }
    if (d.type === 'deleted') { Sync.disconnect(); alert('Soutěž byla na serveru smazána. Data zůstala jen v tomto zařízení.'); }
  }
  static disconnect() { if (Sync.es) Sync.es.close(); S.on = false; App.ui.ok = false; Store.save(); App.render(); }
}

class Views {
  static dbtn(key, label, cls = '') {
    const on = DoubleTap.key === key;
    return `<button class="${on ? 'armed' : cls}" data-a="dt" data-k="${esc(key)}">${on ? 'Opravdu? Klepněte znovu' : label}</button>`;
  }
  static disciplines() {
    const list = S.config.discs.map((d, i) => `<a href="#d/${i}">${esc(d.name)}</a>`).join('') || '<p>Zatím tu nejsou žádné disciplíny.</p>';
    const adm = Perms.admin() ? `<h2>Nová disciplína</h2><div class="row"><input id="f_nd" placeholder="Název disciplíny"><button class="p" data-a="addd">Přidat</button></div>
      <button data-a="defd">Přidat výchozí disciplíny Rangera roku</button><p>Hromadný import najdete v <a href="#io">Export / import</a>.</p>` : '';
    return `<div class="list">${list}</div>${adm}`;
  }
  static discipline() {
    const x = App.ctx(); if (!x) return S.config.cats.length ? Views.disciplines() : '<p>Správce nejdřív musí vytvořit kategorie.</p>';
    const { d, c } = x, clk = new Clock(S.events, d.name, c.name), frozen = Clock.frozen(S.events, d.name, c.name);
    const ref = Perms.referee(d) && !frozen, n = Date.now() + S.off, st = clk.state(), ctl = st === 'idle' || App.ui.show;
    const tabs = S.config.cats.map((k, j) => `<button class="${j === S.cat ? 'on' : ''}" data-a="cat" data-i="${j}">${esc(k.name)}</button>`).join('');
    const ice = frozen ? '<div class="ice">❄ Výsledky této kategorie jsou zmrazené. Ledová hlídka drží pozice.</div>' : '';
    const controls = !ref ? '' : `<div class="row">${st === 'idle' ? '<button class="p" data-a="start">Start</button>' :
      `<button data-a="toggle">${ctl ? 'Skrýt ovládání' : 'Zobrazit ovládání'}</button>` +
      (ctl ? (st === 'run' ? Views.dbtn('tstop', 'Stop') : Views.dbtn('tresume', 'Pokračovat')) + Views.dbtn('restart', 'Restart') : '')}</div>`;
    const teams = c.teams.map((t, j) => {
      const r = clk.team(t, n), k = 'team:' + t, on = DoubleTap.key === k;
      if (r.s === 'stop' && ref) return `<button class="team stop ${on ? 'armed' : ''}" data-a="dt" data-k="${esc(k)}" data-i="${j}"><b>${esc(t)}</b><span class="t">${on ? 'Opravdu pokračovat?' : fmt(r.ms)}</span></button>`;
      return `<button class="team ${r.s}" data-i="${j}" ${ref && r.s === 'run' ? 'data-a="tap"' : ''}><b>${esc(t)}</b><span class="t">${r.s === 'off' ? '' : fmt(r.ms)}</span></button>`;
    }).join('');
    const frz = Perms.discAdmin(d) ? `<div class="row">${frozen ? Views.dbtn('unfreeze', '❄ Rozmrazit výsledky') : '<button data-a="freeze">❄ Zmrazit výsledky</button>'}</div>` : '';
    return `<h2 style="margin-top:0">${esc(d.name)}</h2><div class="tabs">${tabs}</div>${ice}
      <div class="${frozen ? 'frozen' : ''}"><div id="clk" class="clk ${st}">${fmt(clk.at(n))}${st === 'paused' ? ' ⏸' : ''}</div>${controls}<div class="g">${teams}</div></div>
      ${frz}${Views.log(d, c, clk, ref)}${Views.roles(d)}`;
  }
  static log(d, c, clk, ref) {
    const gone = new Set(S.events.filter(e => e.k === 'void').map(e => e.ref));
    const rows = S.events.filter(e => e.d === d.name && e.c === c.name && e.k !== 'void').sort((a, b) => b.ts - a.ts).slice(0, 80).map(e => {
      const off = gone.has(e.id), txt = (LABEL[e.k] || e.k).replace('{t}', esc(e.t));
      return `<div class="ev ${off ? 'gone' : ''}"><span>${new Date(e.ts).toLocaleTimeString('cs-CZ')} · ⏱ ${fmt(clk.at(e.ts))} · ${txt} · <b>${esc(e.u)}</b></span>${ref && !off ? `<button data-a="rm" data-id="${e.id}">Odebrat</button>` : ''}</div>`;
    }).join('');
    return `<h2>Záznam (${esc(d.name)}, ${esc(c.name)})</h2>${rows || '<p>Zatím nic.</p>'}`;
  }
  static roles(d) {
    if (!S.on || !Perms.discAdmin(d)) return '';
    const opts = n => { const r = (d.roles || {})[n] || ''; return `<option value="">Divák</option><option value="referee" ${r === 'referee' ? 'selected' : ''}>Rozhodčí</option><option value="admin" ${r === 'admin' ? 'selected' : ''} ${Perms.admin() ? '' : 'disabled'}>Správce disciplíny</option>`; };
    return '<h2>Role v této disciplíně</h2>' + Object.keys(S.users).filter(n => !S.users[n].admin).map(n => `<label>${esc(n)}<select data-a="role" data-n="${esc(n)}">${opts(n)}</select></label>`).join('');
  }
  static cats() {
    if (!Perms.admin()) return '<p>Kategorie může upravovat jen správce.</p>';
    const txt = S.config.cats.map(c => c.name + ': ' + (c.teams.every((t, i) => t === String(i + 1)) ? c.teams.length : c.teams.join(', '))).join('\n');
    return `<label>Název soutěže<input id="f_n" value="${esc(S.config.name)}"></label>
      <label>Kategorie<small>Jedna na řádek: „AR: 23“ (týmy 1 až 23) nebo „AR: Vlci, Lišky“. Názvy musí být jedinečné.</small><textarea id="f_c" rows="6">${esc(txt)}</textarea></label>
      <div class="row"><button class="p" data-a="savec">Uložit</button><button data-a="defc">Vyplnit výchozí (Ranger roku)</button></div>
      <p>Import celé konfigurace: <a href="#io">Export / import</a>.</p><p class="msg">${esc(App.ui.msg || '')}</p>`;
  }
  static server() {
    const on = S.on, dis = on ? 'disabled' : '';
    const users = on && Perms.admin() ? '<h2>Uživatelé</h2>' + Object.keys(S.users).map(n => `<label><input type="checkbox" style="width:auto" data-a="uadm" data-n="${esc(n)}" ${S.users[n].admin ? 'checked' : ''} ${n === S.nick ? 'disabled' : ''}> ${esc(n)} (správce)</label>`).join('') : '';
    return `<label>Adresa serveru<input id="f_s" value="${esc(S.server)}" ${dis}></label>${on ? '' : '<button data-a="here">Vyplnit adresu této stránky</button>'}
      <label>Heslo soutěže<small>Libovolný řetězec o 6 až 12 znacích. Kdo ho zná, může se připojit.</small><input id="f_k" maxlength="12" value="${esc(S.secret)}" ${dis}></label>
      ${on ? '' : '<button data-a="gen">Vygenerovat náhodné heslo (můžete ho přepsat čímkoli)</button>'}
      <label>Přezdívka na serveru<small>Na serveru musí být jedinečná.</small><input id="f_nick" maxlength="24" value="${esc(S.nick)}" placeholder="např. Vlčí stopa" ${dis}></label>
      <p class="msg">${esc(App.ui.msg || '')}</p>
      <div class="row">${on ? '<button data-a="disc">Odpojit</button>' + (Perms.admin() ? Views.dbtn('delete', 'Smazat soutěž na serveru') : '') : '<button class="p" data-a="conn">Připojit</button>'}</div>
      <p>Soutěže, ke kterým se nikdo měsíc nepřipojil, server automaticky smaže.</p>${users}`;
  }
  static io() {
    const ex = [['all', 'Vše'], ['discs', 'Disciplíny'], ['cats', 'Kategorie'], ['events', 'Výsledky']].map(([p, l]) => `<button data-a="exp" data-p="${p}">${l}</button>`).join('');
    const imp = !Perms.admin() ? '<p>Import může provést jen správce.</p>' : `<h2>Import</h2><label>Vložte obsah exportovaného souboru<textarea id="f_i" rows="5"></textarea></label>
      <p>Co naimportovat:</p>${[['discs', 'Disciplíny'], ['cats', 'Kategorie'], ['events', 'Výsledky']].map(([p, l]) => `<label><input type="checkbox" class="ip" value="${p}" checked style="width:auto"> ${l}</label>`).join('')}
      <button class="p" data-a="imp">Importovat</button><p class="msg">${esc(App.ui.msg || '')}</p>`;
    return `<h2>Export</h2><div class="row">${ex}</div>${imp}`;
  }
}

class Actions {
  static dt(b) { if (DoubleTap.hit(b.dataset.k)) Actions.confirmed(b.dataset.k); }
  static confirmed(k) {
    const i = k.indexOf(':'), a = i < 0 ? k : k.slice(0, i), t = i < 0 ? '' : k.slice(i + 1);
    if (a === 'tstop' || a === 'tresume') App.emit({ k: a });
    else if (a === 'restart') App.emit({ k: 'start' });
    else if (a === 'team') App.emit({ k: 'resume', t });
    else if (a === 'unfreeze') App.emit({ k: 'unfreeze' });
    else if (a === 'delete') Sync.call('', 'DELETE').then(() => Sync.disconnect()).catch(e => { App.ui.msg = e.message; App.render(); });
  }
  static start() { App.emit({ k: 'start' }); }
  static toggle() { App.ui.show = !App.ui.show; App.render(); }
  static tap(b) { const x = App.ctx(); navigator.vibrate && navigator.vibrate(30); App.emit({ k: 'stop', t: x.c.teams[+b.dataset.i] }); }
  static freeze() { App.emit({ k: 'freeze' }); }
  static rm(b) { App.emit({ k: 'void', ref: b.dataset.id }); }
  static cat(b) { S.cat = +b.dataset.i; Store.save(); App.render(); }
  static theme() { S.theme = S.theme === 'dark' ? 'light' : 'dark'; Store.save(); App.render(); }
  static here() { $('#f_s').value = location.origin; }
  static gen() { const A = 'abcdefghjkmnpqrstuvwxyz23456789'; $('#f_k').value = Array.from(crypto.getRandomValues(new Uint8Array(10)), v => A[v % A.length]).join(''); }
  static async conn() {
    S.server = $('#f_s').value.trim(); S.secret = $('#f_k').value.trim(); S.nick = $('#f_nick').value.trim();
    if (!S.server || !/^[\w-]{6,12}$/.test(S.secret) || !S.nick) { App.ui.msg = 'Vyplňte adresu, heslo (6 až 12 znaků: písmena, číslice, _ -) a přezdívku.'; return App.render(); }
    try { App.ui.msg = await Sync.connect(); } catch (e) { App.ui.msg = e.message; }
    Store.save(); App.render();
  }
  static disc() { Sync.disconnect(); }
  static addd() {
    const name = $('#f_nd').value.trim();
    if (!name || S.config.discs.some(d => d.name === name)) return alert('Zadejte jedinečný název disciplíny.');
    S.config.discs.push({ name, roles: {} }); Actions.saveConfig();
  }
  static defd() { for (const n of DEFAULTS.discs) if (!S.config.discs.some(d => d.name === n)) S.config.discs.push({ name: n, roles: {} }); Actions.saveConfig(); }
  static defc() { $('#f_c').value = DEFAULTS.cats.map(c => c.name + ': ' + c.teams.length).join('\n'); }
  static savec() {
    S.config.name = $('#f_n').value.trim();
    S.config.cats = $('#f_c').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const i = l.indexOf(':'), r = i < 0 ? '' : l.slice(i + 1).trim();
      return { name: (i < 0 ? l : l.slice(0, i)).trim(), teams: /^\d+$/.test(r) ? range(+r) : r.split(',').map(v => v.trim()).filter(Boolean) };
    });
    App.ui.msg = 'Uloženo.'; Actions.saveConfig();
  }
  static saveConfig() { Store.save(); Sync.pushConfig(); App.render(); }
  static exp(b) {
    const p = b.dataset.p, all = { v: 2, name: S.config.name, cats: S.config.cats, discs: S.config.discs, events: S.events }, o = { v: 2 };
    for (const k of p === 'all' ? ['name', 'cats', 'discs', 'events'] : [p]) o[k] = all[k];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(o)], { type: 'application/json' })); a.download = 'ranger-' + p + '.json'; a.click();
  }
  static imp() {
    let o; try { o = JSON.parse($('#f_i').value); } catch { App.ui.msg = 'Obsah není platný JSON.'; return App.render(); }
    const parts = [...document.querySelectorAll('.ip:checked')].map(e => e.value).filter(p => o[p]), done = [];
    for (const p of parts) { if (p === 'events') Sync.merge(o.events); else S.config[p] = o[p]; done.push(p); }
    if (o.name && done.includes('cats')) S.config.name = o.name;
    App.ui.msg = done.length ? 'Importováno: ' + done.join(', ') + '.' : 'V souboru není nic z vybraného.';
    Store.save(); Sync.pushConfig(); if (done.includes('events')) Sync.flush(); App.render();
  }
  static async role(b) {
    const x = App.ctx();
    try { await Sync.call('/role', 'POST', { d: x.d.name, nick: b.dataset.n, role: b.value }); } catch (e) { alert(e.message); }
  }
  static async uadm(b) { try { await Sync.call('/role', 'POST', { nick: b.dataset.n, admin: b.checked }); } catch (e) { alert(e.message); } }
}

class App {
  static ui = { show: false, ok: false, msg: '' };
  static ctx() {
    const i = +location.hash.slice(3), d = S.config.discs[i], c = S.config.cats[S.cat] || S.config.cats[0];
    return location.hash.startsWith('#d/') && d && c ? { d, c } : null;
  }
  static emit(o) {
    const x = App.ctx(); if (!x) return;
    const frozen = Clock.frozen(S.events, x.d.name, x.c.name), adm = o.k === 'freeze' || o.k === 'unfreeze';
    if (adm ? !Perms.discAdmin(x.d) : !Perms.referee(x.d)) return;
    if (frozen && o.k !== 'unfreeze') return;
    const e = { id: uid(), ts: Date.now() + S.off, u: S.nick || 'já', d: x.d.name, c: x.c.name, ...o };
    S.events.push(e); Store.save(); Sync.push(e); App.render();
  }
  static status() { const e = $('#st'); if (e) e.textContent = S.on ? (App.ui.ok ? '● online' : '○ offline') : 'jen v zařízení'; }
  static nav() {
    const h = location.hash, link = (hr, t, on) => `<a href="${hr}" class="${on ? 'on' : ''}">${t}</a>`;
    return link('#', 'Disciplíny', !/^#(kat|server|io)/.test(h)) + (Perms.admin() ? link('#kat', 'Kategorie', h === '#kat') : '') +
      link('#server', 'Server', h === '#server') + link('#io', 'Export / import', h === '#io') +
      `<span id="st"></span><button data-a="theme">${S.theme === 'dark' ? '☀' : '☾'}</button>`;
  }
  static render() {
    document.documentElement.dataset.theme = S.theme;
    $('#ttl').textContent = S.config.name || 'Ranger stopky';
    $('#nav').innerHTML = App.nav();
    const h = location.hash;
    $('#app').innerHTML = h === '#server' ? Views.server() : h === '#kat' ? Views.cats() : h === '#io' ? Views.io() : h.startsWith('#d/') ? Views.discipline() : Views.disciplines();
    App.status();
  }
  static draw() { if (!['#server', '#kat', '#io'].includes(location.hash)) App.render(); }
  static tick() {
    const x = App.ctx(); if (!x) return;
    const clk = new Clock(S.events, x.d.name, x.c.name), n = Date.now() + S.off, e = $('#clk');
    if (e) e.textContent = fmt(clk.at(n)) + (clk.paused ? ' ⏸' : '');
    document.querySelectorAll('.team.run .t').forEach(el => { el.textContent = fmt(clk.team(x.c.teams[+el.parentNode.dataset.i], n).ms); });
  }
  static init() {
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (DoubleTap.key && (!b || b.dataset.k !== DoubleTap.key)) DoubleTap.disarm();
      if (b && b.type !== 'checkbox' && b.tagName !== 'SELECT' && Actions[b.dataset.a]) Actions[b.dataset.a](b);
    });
    document.addEventListener('change', e => { const b = e.target.closest('[data-a]'); if (b && (b.type === 'checkbox' || b.tagName === 'SELECT')) Actions[b.dataset.a](b); });
    addEventListener('hashchange', () => { App.ui.show = false; App.render(); });
    setInterval(App.tick, 200);
    App.render();
    if (S.on) { Sync.pull().then(() => App.draw()).catch(() => {}); Sync.stream(); }
  }
}
App.init();
