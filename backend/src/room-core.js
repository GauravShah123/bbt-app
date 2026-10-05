// Pure relay core (Contract D, v2). No Cloudflare or Node APIs: runs in the
// Durable Object, the Node dev server and node:test alike.
//
// Sockets are abstracted as { send(text), close(code, reason) }.

export const KEY_RE = /^[a-f0-9]{32}$/;
export const CID_RE = /^[A-Za-z0-9]{16}$/;
export const MAX_CLIENTS = 8;
export const MAX_MSG_BYTES = 512;
export const RATE_PER_SEC = 60;
export const GRACE_MS = 30000;
export const DEFAULT_MAX_MINUTES = 240;

const PARAM_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const STATE_RE = /^[A-Za-z_]{1,16}$/;
const MAX_CFG_PARAMS = 20;

export const AUTO_GRANT_WINDOW_MS = 5000;

export function validateJoin({ key, cid, claim, v }) {
  return KEY_RE.test(key || '') && CID_RE.test(cid || '') &&
    (claim === '0' || claim === '1') && v === '2';
}

/** In-memory usage store ({get,set}); the Durable Object adds persistence. */
export class MemoryStore {
  constructor() { this.map = new Map(); }
  get(k) { return this.map.get(k); }
  set(k, v) { this.map.set(k, v); }
}

/** Constant-time string compare (length difference folded into the result). */
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  const n = Math.max(a.length, b.length);
  let d = a.length ^ b.length;
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const isInt = (x) => Number.isInteger(x) && x >= 0 && x <= 0x7fffffff;
const isBit = (x) => x === 0 || x === 1;
const isNum = (x, lim = 1000) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= lim;
const isCid = (x) => typeof x === 'string' && CID_RE.test(x);
const round1 = (x) => Math.round(x * 10) / 10;

function safeClose(sock, code, reason) { try { sock.close(code, reason); } catch { /* already closed */ } }
function safeSend(sock, obj) { try { sock.send(JSON.stringify(obj)); } catch { /* peer gone */ } }
function utf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
function randomSid() {
  const b = new Uint8Array(8);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 8; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
export function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

export class RoomCore {
  /**
   * @param {{token?:string, maxMinutes?:number, now?:()=>number,
   *          store?:{get,set}, setTimer?:Function, clearTimer?:Function,
   *          graceMs?:number}} opts
   */
  constructor({
    token = '', maxMinutes = DEFAULT_MAX_MINUTES, now = () => Date.now(),
    store = new MemoryStore(), setTimer, clearTimer, graceMs = GRACE_MS,
  } = {}) {
    this.token = token || '';
    this.maxMinutes = maxMinutes;
    this.now = now;
    this.store = store;
    this.setTimer = setTimer || ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = clearTimer || ((h) => globalThis.clearTimeout(h));
    this.graceMs = graceMs;

    this.sid = null;
    this.epoch = 0;
    this.hub = null;
    this.hubLost = null;       // { cid, until }
    this.graceTimer = null;
    this.clients = new Map();  // cid -> { sock, n, ready }
    this.bySock = new Map();   // sock -> cid
    this.nextN = 1;
    this.rate = new Map();     // sock -> { sec, count }
    this.lastSig = '';
    this.lastAccrue = null;
    this.autoGrant = null;     // { cid, at } hub granted without a claim (first to reconnect)
  }

  get occupied() { return this.clients.size > 0; }
  /** True when nothing (clients or pending grace) needs the core kept alive. */
  get idle() { return this.clients.size === 0 && !this.hubLost; }

  // ---- usage cap -----------------------------------------------------------
  usedMinutes(at = this.now()) { return this.store.get(utcDay(at)) || 0; }

  accrue(at = this.now()) {
    if (this.lastAccrue !== null) {
      const delta = Math.max(0, at - this.lastAccrue) / 60000;
      if (delta > 0) this.store.set(utcDay(at), this.usedMinutes(at) + delta);
    }
    this.lastAccrue = this.clients.size > 0 ? at : null;
  }

  /** Called every 60 s by the adapter while occupied. */
  tick(at = this.now()) { this.accrue(at); }

  // ---- join / close --------------------------------------------------------
  join(sock, { cid, tok, claim } = {}) {
    if (!isCid(cid)) { safeClose(sock, 4002, 'bad params'); return false; }
    if (this.token && !safeEqual(typeof tok === 'string' ? tok : '', this.token)) {
      safeClose(sock, 4003, 'auth'); return false;
    }
    if (this.usedMinutes() >= this.maxMinutes) { safeClose(sock, 4004, 'daily cap'); return false; }

    const old = this.clients.get(cid);
    if (!old && this.clients.size >= MAX_CLIENTS) { safeClose(sock, 4001, 'full'); return false; }

    const t = this.now();
    let n;
    const replacedHub = !!old && this.hub === cid;
    if (old) {
      // Duplicate cid: the old socket is closed 4000 (not treated as leave). A member replace
      // tells the Hub it was lost so it can pause or recover; a Hub replace bumps the epoch below.
      if (!replacedHub && this.hub) this.sendTo(this.hub, { t: 'lost', cid });
      n = old.n;
      this.bySock.delete(old.sock);
      this.rate.delete(old.sock);
      safeClose(old.sock, 4000, 'replaced');
    } else {
      if (this.clients.size === 0 && !this.hubLost) { this.sid = randomSid(); this.nextN = 1; }
      n = this.nextN++;
    }
    if (this.clients.size === 0) this.lastAccrue = t;
    if (!this.sid) this.sid = randomSid();
    this.clients.set(cid, { sock, n, ready: 0 });
    this.bySock.set(sock, cid);

    // Hub grant.
    if (replacedHub) {
      // Duplicate-cid replace of the current Hub: members may still hold a gate opened by the
      // old coordinator. Re-grant (epoch+1) so they close on the epoch change.
      this.grantHub(cid);
    } else if (this.hub === cid) {
      // unreachable guard: hub cid always has a client entry
    } else if (this.hub === null) {
      const claimed = claim === 1 || claim === '1';
      if (this.hubLost && this.hubLost.cid === cid) {
        this.grantHub(cid);
        this.autoGrant = null;
      } else if (!this.hubLost && (claimed || this.clients.size === 1)) {
        this.grantHub(cid);
        // Granted only because it reconnected first (e.g. after a relay restart): the real Hub
        // may still be on its way back. Remember it so a claimer can take the role back.
        this.autoGrant = claimed ? null : { cid, at: t };
      }
    } else if ((claim === 1 || claim === '1') && this.autoGrant && this.autoGrant.cid === this.hub &&
               t - this.autoGrant.at < AUTO_GRANT_WINDOW_MS) {
      // The previous Hub reconnected shortly after someone else was auto-granted: hand it back.
      this.autoGrant = null;
      this.grantHub(cid);
    }

    safeSend(sock, {
      t: 'welcome', sid: this.sid, you: cid, hub: this.hub, epoch: this.epoch, roster: this.rosterList(),
    });
    this.broadcastRoster(sock);
    return true;
  }

  /** Unexpected disconnect (not a clean leave). */
  close(sock) {
    const cid = this.bySock.get(sock);
    this.rate.delete(sock);
    if (cid === undefined) return;
    this.bySock.delete(sock);
    this.clients.delete(cid);
    if (cid === this.hub) {
      this.hub = null;
      this.hubLost = { cid, until: this.now() + this.graceMs };
      this.clearGrace();
      this.graceTimer = this.setTimer(() => this.graceExpired(cid), this.graceMs);
    } else if (this.hub) {
      this.sendTo(this.hub, { t: 'lost', cid });
    }
    this.afterRemoval();
  }

  graceExpired(cid) {
    this.graceTimer = null;
    if (this.hubLost && this.hubLost.cid === cid) {
      this.hubLost = null;
      const next = this.pickSuccessor();
      if (next) { this.grantHub(next); this.autoGrant = null; }
    }
    this.broadcastRoster();
  }
  clearGrace() {
    if (this.graceTimer !== null) { this.clearTimer(this.graceTimer); this.graceTimer = null; }
  }

  grantHub(cid) {
    this.hub = cid;
    this.epoch += 1;
    this.autoGrant = null;   // callers that auto-grant set it again right after
    if (this.hubLost) { this.hubLost = null; this.clearGrace(); }
  }

  afterRemoval() {
    if (this.clients.size === 0) this.accrue();
    this.broadcastRoster();
  }

  // ---- messages ------------------------------------------------------------
  message(sock, text) {
    const cid = this.bySock.get(sock);
    if (cid === undefined || typeof text !== 'string') return;
    if (utf8Len(text) > MAX_MSG_BYTES) return;
    const sec = Math.floor(this.now() / 1000);
    let b = this.rate.get(sock);
    if (!b || b.sec !== sec) { b = { sec, count: 0 }; this.rate.set(sock, b); }
    if (++b.count > RATE_PER_SEC) return;

    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return;
    const isHub = cid === this.hub;

    switch (m.t) {
      case 'ready': {
        if (!isBit(m.r)) return;
        const c = this.clients.get(cid);
        if (c.ready === m.r) return;
        c.ready = m.r;
        this.broadcastRoster();
        return;
      }
      case 'lvl': {
        if (isHub || !this.hub) return;
        if (!isInt(m.q) || !isNum(m.l) || !isNum(m.z) || !isBit(m.a) || !isBit(m.h) || !isBit(m.m)) return;
        this.sendTo(this.hub, { t: 'lvl', from: cid, q: m.q, l: round1(m.l), z: round1(m.z), a: m.a, h: m.h, m: m.m });
        return;
      }
      case 'cmd': {
        if (!isHub) return;
        if (!isCid(m.to) || m.to === cid || (m.op !== 'open' && m.op !== 'close') || !isInt(m.e) || !isInt(m.g)) return;
        if (m.e !== this.epoch) return;
        this.sendTo(m.to, { t: 'cmd', op: m.op, e: m.e, g: m.g });
        return;
      }
      case 'applied': {
        if (isHub || !this.hub) return;
        if (!isInt(m.e) || !isInt(m.g) || !isBit(m.gate)) return;
        this.sendTo(this.hub, { t: 'applied', from: cid, e: m.e, g: m.g, gate: m.gate });
        return;
      }
      case 'hb': {
        if (!isHub) return;
        if (!isInt(m.e) || typeof m.s !== 'string' || !STATE_RE.test(m.s)) return;
        if (m.o !== null && !isCid(m.o)) return;
        const out = { t: 'hb', e: m.e, s: m.s, o: m.o };
        for (const [id] of this.clients) if (id !== cid) this.sendTo(id, out);
        return;
      }
      case 'leave': {
        this.handleLeave(sock, cid, isHub);
        return;
      }
      case 'yield': {
        if (!isHub || !isCid(m.to) || m.to === cid || !this.clients.has(m.to)) return;
        this.grantHub(m.to);
        this.broadcastRoster();
        return;
      }
      case 'want': {
        if (isHub || !this.hub) return;
        this.sendTo(this.hub, { t: 'want', from: cid });
        return;
      }
      case 'take': {
        if (this.hub !== null || this.hubLost) return;
        this.grantHub(cid);
        this.broadcastRoster();
        return;
      }
      case 'ping': {
        if (!isNum(m.ts, Number.MAX_SAFE_INTEGER)) return;
        this.sendTo(cid, { t: 'pong', ts: m.ts });
        return;
      }
      case 'cfg': {
        const p = m.params;
        if (!p || typeof p !== 'object' || Array.isArray(p)) return;
        const keys = Object.keys(p);
        if (keys.length === 0 || keys.length > MAX_CFG_PARAMS) return;
        const clean = {};
        for (const k of keys) {
          if (!PARAM_KEY_RE.test(k) || !isNum(p[k], 1e9)) return;
          clean[k] = p[k];
        }
        for (const [id] of this.clients) if (id !== cid) this.sendTo(id, { t: 'cfg', params: clean, from: cid });
        return;
      }
      default:
        return;
    }
  }

  handleLeave(sock, cid, wasHub) {
    this.bySock.delete(sock);
    this.rate.delete(sock);
    this.clients.delete(cid);
    if (wasHub) {
      this.hub = null;
      const next = this.pickSuccessor();
      if (next) this.grantHub(next);
    } else if (this.hub) {
      this.sendTo(this.hub, { t: 'left', cid });
    }
    this.afterRemoval();
    safeClose(sock, 1000, 'bye');
  }

  pickSuccessor() {
    let best = null;
    let bestReady = null;
    for (const [id, c] of this.clients) {
      if (!best || c.n < this.clients.get(best).n) best = id;
      if (c.ready && (!bestReady || c.n < this.clients.get(bestReady).n)) bestReady = id;
    }
    return bestReady || best;
  }

  // ---- roster --------------------------------------------------------------
  rosterList() {
    return [...this.clients].map(([cid, c]) => ({ cid, n: c.n, ready: c.ready }))
      .sort((a, b) => a.n - b.n);
  }

  sendTo(cid, obj) {
    const c = this.clients.get(cid);
    if (c) safeSend(c.sock, obj);
  }

  /** Broadcast a roster only if something changed; skip `except` (its welcome has the state). */
  broadcastRoster(except) {
    const roster = this.rosterList();
    const hubLost = this.hubLost ? this.hubLost.cid : null;
    const sig = JSON.stringify([this.sid, this.hub, this.epoch, roster, hubLost]);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    const msg = { t: 'roster', sid: this.sid, hub: this.hub, epoch: this.epoch, roster, hubLost };
    for (const [, c] of this.clients) if (c.sock !== except) safeSend(c.sock, msg);
  }
}
