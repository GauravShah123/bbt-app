// Pure relay + Hub election logic. No Cloudflare or Node APIs, so it runs in the
// Durable Object, the Node dev server and node:test alike.

export const KEY_RE = /^[a-f0-9]{32}$/;
export const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
export const PREFS = ['auto', 'hub', 'member'];
export const MAX_PEERS = 16;
export const MAX_MSG_BYTES = 512;
export const RATE_PER_SEC = 40;
export const SEEN_TTL_MS = 6 * 60 * 60 * 1000;

const PARAM_KEY_RE = /^[a-zA-Z]{1,32}$/;

export function validateJoin({ key, id, p }) {
  return KEY_RE.test(key || '') && ID_RE.test(id || '') && PREFS.includes(p);
}

/** In-memory firstSeen store; the Durable Object wraps this with persistence. */
export class MemoryStore {
  constructor() { this.map = new Map(); }
  get(id) { return this.map.get(id); }
  set(id, rec) { this.map.set(id, rec); }
  delete(id) { this.map.delete(id); }
  entries() { return this.map.entries(); }
}

export class RoomCore {
  /**
   * @param {{store?: {get,set}, now?: () => number, ttlMs?: number}} opts
   */
  constructor({ store = new MemoryStore(), now = () => Date.now(), ttlMs = SEEN_TTL_MS } = {}) {
    this.store = store;
    this.now = now;
    this.ttlMs = ttlMs;
    this.sockets = new Set();
    this.buckets = new WeakMap();
    this.lastRosterSig = '';
  }

  /** Adds a socket. Returns false (and closes it) if rejected. */
  join(sock, { id, p }) {
    if (!ID_RE.test(id || '') || !PREFS.includes(p)) {
      safeClose(sock, 4002, 'bad params');
      return false;
    }
    for (const other of this.sockets) {
      if (other.meta.id === id) {
        this.sockets.delete(other);
        safeClose(other, 4000, 'replaced');
      }
    }
    if (this.sockets.size >= MAX_PEERS) {
      safeClose(sock, 4001, 'full');
      return false;
    }
    sock.meta = { id, p, firstSeen: this.touchSeen(id) };
    this.sockets.add(sock);
    this.broadcastRoster();
    return true;
  }

  /** Re-adds a socket after Durable Object hibernation, without broadcasting. */
  restore(sock) {
    if (!sock.meta || !ID_RE.test(sock.meta.id || '')) return;
    this.sockets.add(sock);
    this.lastRosterSig = this.rosterSig();
  }

  leave(sock) {
    if (!this.sockets.delete(sock)) return;
    this.touchSeen(sock.meta.id);
    this.broadcastRoster();
  }

  message(sock, text) {
    if (!this.sockets.has(sock)) return;
    if (typeof text !== 'string' || text.length > MAX_MSG_BYTES) return;
    if (!this.takeToken(sock)) return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;

    switch (m.t) {
      case 'st': {
        if (!isNum(m.a, 0, 1) || !isFlag(m.s) || !isFlag(m.r) || !isNum(m.rt, 0, 10000)) return;
        this.relay(sock, { t: 'st', id: sock.meta.id, a: m.a, s: m.s, r: m.r, rt: m.rt });
        return;
      }
      case 'p': {
        if (!PREFS.includes(m.p) || m.p === sock.meta.p) return;
        sock.meta.p = m.p;
        this.broadcastRoster();
        return;
      }
      case 'ping': {
        if (!isNum(m.ts, 0, Number.MAX_SAFE_INTEGER)) return;
        safeSend(sock, JSON.stringify({ t: 'pong', ts: m.ts }));
        return;
      }
      case 'cfg': {
        const params = validParams(m.params);
        if (!params) return;
        this.relay(sock, { t: 'cfg', params, from: sock.meta.id });
        return;
      }
      default:
        return;
    }
  }

  electHub() {
    let best = null;
    for (const pref of ['hub', 'auto']) {
      for (const s of this.sockets) {
        if (s.meta.p !== pref) continue;
        if (!best || s.meta.firstSeen < best.meta.firstSeen ||
            (s.meta.firstSeen === best.meta.firstSeen && s.meta.id < best.meta.id)) best = s;
      }
      if (best) return best.meta.id;
    }
    return null;
  }

  // --- internals ---

  touchSeen(id) {
    const now = this.now();
    const rec = this.store.get(id);
    const firstSeen = rec && now - rec.lastSeen <= this.ttlMs ? rec.firstSeen : now;
    this.store.set(id, { firstSeen, lastSeen: now });
    return firstSeen;
  }

  rosterSig() {
    const peers = [...this.sockets].map((s) => `${s.meta.id}:${s.meta.p}`).sort().join(',');
    return `${this.electHub()}|${peers}`;
  }

  broadcastRoster() {
    const sig = this.rosterSig();
    if (sig === this.lastRosterSig) return;
    this.lastRosterSig = sig;
    const hub = this.electHub();
    const peers = [...this.sockets].map((s) => ({ id: s.meta.id, p: s.meta.p }));
    for (const s of this.sockets) {
      safeSend(s, JSON.stringify({ t: 'roster', you: s.meta.id, hub, peers }));
    }
  }

  relay(from, msg) {
    const text = JSON.stringify(msg);
    for (const s of this.sockets) if (s !== from) safeSend(s, text);
  }

  takeToken(sock) {
    const now = this.now();
    let b = this.buckets.get(sock);
    if (!b) { b = { tokens: RATE_PER_SEC, at: now }; this.buckets.set(sock, b); }
    b.tokens = Math.min(RATE_PER_SEC, b.tokens + ((now - b.at) / 1000) * RATE_PER_SEC);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

function isNum(v, lo, hi) { return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi; }
function isFlag(v) { return v === 0 || v === 1; }

function validParams(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const keys = Object.keys(p);
  if (keys.length === 0 || keys.length > 20) return null;
  const out = {};
  for (const k of keys) {
    if (!PARAM_KEY_RE.test(k) || typeof p[k] !== 'number' || !Number.isFinite(p[k])) return null;
    out[k] = p[k];
  }
  return out;
}

function safeSend(sock, text) { try { sock.send(text); } catch { /* socket gone */ } }
function safeClose(sock, code, reason) { try { sock.close(code, reason); } catch { /* already closed */ } }
