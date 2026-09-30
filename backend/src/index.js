// Cloudflare Worker + Durable Object adapter around RoomCore (Contract D, v2).
// One Durable Object for the whole team (so the daily usage cap is team-wide);
// it hosts one RoomCore per room key. Ordinary server.accept() WebSockets (no
// hibernation): the object stays resident while sockets are open.
//   env.TEAM_TOKEN           secret  (wrangler secret put TEAM_TOKEN)
//   env.MAX_MINUTES_PER_DAY  var     (default 240)

import { DurableObject } from 'cloudflare:workers';
import { RoomCore, validateJoin, utcDay } from './room-core.js';

const USAGE_PREFIX = 'usage:';
const TICK_MS = 60000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');

    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!m) return new Response('not found', { status: 404 });
    const q = url.searchParams;
    const key = m[1];
    if (!validateJoin({ key, cid: q.get('cid'), claim: q.get('claim'), v: q.get('v') })) {
      return new Response('bad request', { status: 400 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    return env.ROOM.get(env.ROOM.idFromName('team')).fetch(request);
  },
};

/** Sync usage store: in-memory cache, persisted to DO storage in the background. */
class UsageStore {
  constructor(storage) { this.storage = storage; this.map = new Map(); }
  async load() {
    const today = utcDay(Date.now());
    const all = await this.storage.list({ prefix: USAGE_PREFIX });
    for (const [k, v] of all) {
      const day = k.slice(USAGE_PREFIX.length);
      if (day === today) this.map.set(day, v);
      else this.storage.delete(k);
    }
  }
  get(day) { return this.map.get(day); }
  set(day, v) {
    this.map.set(day, v);
    this.storage.put(USAGE_PREFIX + day, v).catch(() => {});
  }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new UsageStore(ctx.storage);
    const max = Number(env.MAX_MINUTES_PER_DAY);
    this.coreOpts = {
      token: env.TEAM_TOKEN || '',
      maxMinutes: Number.isFinite(max) && max > 0 ? max : 240,
      store: this.store,
    };
    this.rooms = new Map(); // room key -> RoomCore
    this.timer = null;
    ctx.blockConcurrencyWhile(() => this.store.load());
  }

  startTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const core of this.rooms.values()) if (core.occupied) core.tick(now);
      this.sweep();
    }, TICK_MS);
  }
  stopTicking() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  sweep() {
    for (const [k, core] of this.rooms) if (core.idle) this.rooms.delete(k);
    if (![...this.rooms.values()].some((c) => c.occupied)) this.stopTicking();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams;
    const key = url.pathname.split('/')[2];
    let core = this.rooms.get(key);
    if (!core) { core = new RoomCore(this.coreOpts); this.rooms.set(key, core); }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const sock = { send: (t) => server.send(t), close: (c, r) => server.close(c, r) };
    server.addEventListener('message', (ev) => {
      core.message(sock, typeof ev.data === 'string' ? ev.data : '');
    });
    const gone = () => { core.close(sock); if (core.idle) setTimeout(() => this.sweep(), 31000); };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    const ok = core.join(sock, { cid: q.get('cid'), tok: q.get('tok') || '', claim: Number(q.get('claim')) });
    if (ok) this.startTicking();
    return new Response(null, { status: 101, webSocket: client });
  }
}
