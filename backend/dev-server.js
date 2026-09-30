// Local / self-hosted relay using the same RoomCore as the Cloudflare Worker.
//   node backend/dev-server.js           (PORT env, default 8787)
// Point the extension at ws://localhost:8787 (Test panel → Backend URL).

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RoomCore, KEY_RE, validateJoin } from './src/room-core.js';

const PORT = Number(process.env.PORT) || 8787;
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
  const id = url.searchParams.get('id');
  const p = url.searchParams.get('p');
  if (!key || !KEY_RE.test(key) || !validateJoin({ key, id, p })) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    let core = rooms.get(key);
    if (!core) { core = new RoomCore(); rooms.set(key, core); }
    const sock = {
      send: (text) => ws.readyState === ws.OPEN && ws.send(text),
      close: (code, reason) => ws.close(code, reason),
    };
    ws.on('message', (data, isBinary) => { if (!isBinary) core.message(sock, data.toString()); });
    ws.on('close', () => {
      core.leave(sock);
      if (core.sockets.size === 0) rooms.delete(key);
    });
    ws.on('error', () => core.leave(sock));
    core.join(sock, { id, p });
  });
});

server.listen(PORT, () => console.log(`hybrid-audio relay on ws://localhost:${PORT}`));
