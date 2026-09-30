// Local / self-hosted relay using the same RoomCore as the Cloudflare Worker.
//   TEAM_TOKEN=secret PORT=8787 node backend/dev-server.js
// Point the extension's backend URL at ws://localhost:8787.

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RoomCore, MemoryStore, validateJoin } from './src/room-core.js';

const PORT = Number(process.env.PORT) || 8787;
const TOKEN = process.env.TEAM_TOKEN || '';
const MAX_MINUTES = Number(process.env.MAX_MINUTES_PER_DAY) > 0 ? Number(process.env.MAX_MINUTES_PER_DAY) : 240;
if (!TOKEN) console.warn('WARNING: TEAM_TOKEN is not set; any token is accepted.');

const store = new MemoryStore(); // team usage counter, shared by all local rooms
const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  res.statusCode = 404;
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/room\/([^/]+)$/);
  const key = m && m[1];
  const q = url.searchParams;
  if (!key || !validateJoin({ key, cid: q.get('cid'), claim: q.get('claim'), v: q.get('v') })) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    let core = rooms.get(key);
    if (!core) { core = new RoomCore({ token: TOKEN, maxMinutes: MAX_MINUTES, store }); rooms.set(key, core); }
    const sock = {
      send: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); },
      close: (code, reason) => ws.close(code, reason),
    };
    const gone = () => { core.close(sock); if (core.idle) setTimeout(sweep, 31000).unref(); };
    ws.on('message', (data, isBinary) => { if (!isBinary) core.message(sock, data.toString()); });
    ws.on('close', gone);
    ws.on('error', gone);
    core.join(sock, { cid: q.get('cid'), tok: q.get('tok') || '', claim: Number(q.get('claim')) });
  });
});

function sweep() { for (const [k, c] of rooms) if (c.idle) rooms.delete(k); }

// Usage ticks every 60 s while a room is occupied.
setInterval(() => { for (const c of rooms.values()) if (c.occupied) c.tick(Date.now()); }, 60000).unref();

server.listen(PORT, () => console.log(`hybrid-audio relay v2 on ws://localhost:${PORT}`));
