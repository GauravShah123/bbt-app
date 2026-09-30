// Cloudflare Worker + Durable Object adapter around RoomCore.
// One Durable Object per room (room key = hashed Meet code). Uses the WebSocket
// Hibernation API so idle rooms cost nothing.

import { DurableObject } from 'cloudflare:workers';
import { RoomCore, KEY_RE, validateJoin, SEEN_TTL_MS } from './room-core.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');

    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!m) return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const key = m[1];
    const id = url.searchParams.get('id');
    const p = url.searchParams.get('p');
    if (!KEY_RE.test(key) || !validateJoin({ key, id, p })) {
      return new Response('bad request', { status: 400 });
    }
    const stub = env.ROOM.get(env.ROOM.idFromName(key));
    return stub.fetch(request);
  },
};

/** firstSeen store: sync in-memory cache, persisted to DO storage in the background. */
class PersistedStore {
  constructor(storage) {
    this.storage = storage;
    this.map = new Map();
  }
  async load() {
    const all = await this.storage.list({ prefix: 'seen:' });
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [k, v] of all) {
      if (v && v.lastSeen >= cutoff) this.map.set(k.slice(5), v);
      else this.storage.delete(k);
    }
  }
  get(id) { return this.map.get(id); }
  set(id, rec) {
    this.map.set(id, rec);
    this.storage.put('seen:' + id, rec);
  }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new PersistedStore(ctx.storage);
    this.core = new RoomCore({ store: this.store });
    ctx.blockConcurrencyWhile(async () => {
      await this.store.load();
      // Rebuild membership after hibernation.
      for (const ws of ctx.getWebSockets()) {
        const meta = ws.deserializeAttachment();
        if (meta) this.core.restore(this.wrap(ws, meta));
      }
    });
  }

  wrap(ws, meta) {
    // Stable wrapper per WebSocket so RoomCore's Set/WeakMap identity holds.
    if (ws.__sock) return ws.__sock;
    const sock = {
      ws,
      meta,
      send: (text) => ws.send(text),
      close: (code, reason) => ws.close(code, reason),
    };
    ws.__sock = sock;
    return sock;
  }

  sockFor(ws) {
    return ws.__sock || this.wrap(ws, ws.deserializeAttachment() || {});
  }

  async fetch(request) {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const p = url.searchParams.get('p');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const sock = this.wrap(server, { id, p });
    if (this.core.join(sock, { id, p })) server.serializeAttachment(sock.meta);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const sock = this.sockFor(ws);
    const before = sock.meta && sock.meta.p;
    this.core.message(sock, typeof message === 'string' ? message : '');
    if (sock.meta && sock.meta.p !== before) ws.serializeAttachment(sock.meta);
  }

  async webSocketClose(ws, code) {
    this.core.leave(this.sockFor(ws));
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ }
  }

  async webSocketError(ws) {
    this.core.leave(this.sockFor(ws));
  }
}
