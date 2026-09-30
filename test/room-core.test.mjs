import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomCore, MemoryStore, SEEN_TTL_MS } from '../backend/src/room-core.js';

function fakeSock() {
  const s = { sent: [], closed: null };
  s.send = (t) => s.sent.push(JSON.parse(t));
  s.close = (code, reason) => { s.closed = { code, reason }; };
  s.last = (t) => [...s.sent].reverse().find((m) => m.t === t);
  s.count = (t) => s.sent.filter((m) => m.t === t).length;
  return s;
}

function room(opts = {}) {
  let t = 1000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const core = new RoomCore({ now: clock.now, store: opts.store || new MemoryStore() });
  return { core, clock };
}

function joinAt(core, clock, id, p = 'auto') {
  clock.advance(10);
  const s = fakeSock();
  core.join(s, { id, p });
  return s;
}

test('join sends personalized roster; first auto joiner is hub', () => {
  const { core, clock } = room();
  const a = joinAt(core, clock, 'aaaaaaaa');
  const b = joinAt(core, clock, 'bbbbbbbb');
  const r = b.last('roster');
  assert.equal(r.you, 'bbbbbbbb');
  assert.equal(r.hub, 'aaaaaaaa');
  assert.equal(r.peers.length, 2);
  assert.equal(a.last('roster').you, 'aaaaaaaa');
});

test('hub pref beats earlier auto; member never hub; re-election on leave', () => {
  const { core, clock } = room();
  const a = joinAt(core, clock, 'aaaaaaaa', 'member');
  assert.equal(a.last('roster').hub, null);
  const b = joinAt(core, clock, 'bbbbbbbb', 'auto');
  assert.equal(a.last('roster').hub, 'bbbbbbbb');
  const c = joinAt(core, clock, 'cccccccc', 'hub');
  assert.equal(a.last('roster').hub, 'cccccccc');
  core.leave(c);
  assert.equal(a.last('roster').hub, 'bbbbbbbb');
  core.message(b, JSON.stringify({ t: 'p', p: 'member' }));
  assert.equal(a.last('roster').hub, null);
});

test('reconnecting id keeps seniority and replaces old socket', () => {
  const { core, clock } = room();
  const a1 = joinAt(core, clock, 'aaaaaaaa');
  const b = joinAt(core, clock, 'bbbbbbbb');
  const a2 = joinAt(core, clock, 'aaaaaaaa');
  assert.deepEqual(a1.closed, { code: 4000, reason: 'replaced' });
  assert.equal(core.sockets.size, 2);
  assert.equal(b.last('roster').hub, 'aaaaaaaa');
  // Drop and come back later: still hub.
  core.leave(a2);
  assert.equal(b.last('roster').hub, 'bbbbbbbb');
  clock.advance(60_000);
  const a3 = joinAt(core, clock, 'aaaaaaaa');
  assert.equal(a3.last('roster').hub, 'aaaaaaaa');
});

test('seniority expires after TTL', () => {
  const { core, clock } = room();
  const a = joinAt(core, clock, 'aaaaaaaa');
  const b = joinAt(core, clock, 'bbbbbbbb');
  core.leave(a);
  clock.advance(SEEN_TTL_MS + 1);
  const a2 = joinAt(core, clock, 'aaaaaaaa');
  assert.equal(a2.last('roster').hub, 'bbbbbbbb');
  assert.ok(b);
});

test('st and cfg relay to others only; ping pongs sender only', () => {
  const { core, clock } = room();
  const a = joinAt(core, clock, 'aaaaaaaa');
  const b = joinAt(core, clock, 'bbbbbbbb');
  core.message(a, JSON.stringify({ t: 'st', a: 0.1234, s: 1, r: 0, rt: 40 }));
  assert.deepEqual(b.last('st'), { t: 'st', id: 'aaaaaaaa', a: 0.1234, s: 1, r: 0, rt: 40 });
  assert.equal(a.count('st'), 0);
  core.message(a, JSON.stringify({ t: 'cfg', params: { shareExponent: 3 } }));
  assert.deepEqual(b.last('cfg'), { t: 'cfg', params: { shareExponent: 3 }, from: 'aaaaaaaa' });
  assert.equal(a.count('cfg'), 0);
  core.message(a, JSON.stringify({ t: 'ping', ts: 5 }));
  assert.deepEqual(a.last('pong'), { t: 'pong', ts: 5 });
  assert.equal(b.count('pong'), 0);
});

test('validation rejects bad input', () => {
  const { core, clock } = room();
  const a = joinAt(core, clock, 'aaaaaaaa');
  const b = joinAt(core, clock, 'bbbbbbbb');
  const bad = [
    'not json',
    JSON.stringify({ t: 'nope' }),
    JSON.stringify({ t: 'st', a: 2, s: 1, r: 0, rt: 1 }),
    JSON.stringify({ t: 'st', a: 0.1, s: 2, r: 0, rt: 1 }),
    JSON.stringify({ t: 'st', a: 0.1, s: 1, r: 0 }),
    JSON.stringify({ t: 'cfg', params: { 'bad key': 1 } }),
    JSON.stringify({ t: 'cfg', params: { x: 'str' } }),
    JSON.stringify({ t: 'cfg', params: [] }),
    JSON.stringify({ t: 'p', p: 'boss' }),
    JSON.stringify({ t: 'st', a: 0.1, s: 1, r: 0, rt: 1, pad: 'x'.repeat(600) }),
  ];
  const before = b.sent.length;
  for (const m of bad) { clock.advance(100); core.message(a, m); }
  assert.equal(b.sent.length, before);
  const s = fakeSock();
  assert.equal(core.join(s, { id: 'short', p: 'auto' }), false);
  assert.equal(s.closed.code, 4002);
});

test('rate limit drops excess', () => {
  const { core, clock } = room();
  const a = joinAt(core, clock, 'aaaaaaaa');
  const b = joinAt(core, clock, 'bbbbbbbb');
  const msg = JSON.stringify({ t: 'st', a: 0.1, s: 1, r: 0, rt: 1 });
  for (let i = 0; i < 100; i++) core.message(a, msg);
  assert.equal(b.count('st'), 40);
  clock.advance(1000);
  for (let i = 0; i < 100; i++) core.message(a, msg);
  assert.equal(b.count('st'), 80);
});

test('peer cap', () => {
  const { core, clock } = room();
  for (let i = 0; i < 16; i++) joinAt(core, clock, `peer${String(i).padStart(4, '0')}`);
  const s = fakeSock();
  assert.equal(core.join(s, { id: 'toomany00', p: 'auto' }), false);
  assert.equal(s.closed.code, 4001);
  assert.equal(core.sockets.size, 16);
});

test('roster only broadcast on change', () => {
  const { core, clock } = room();
  const a = joinAt(core, clock, 'aaaaaaaa');
  const n = a.count('roster');
  core.message(a, JSON.stringify({ t: 'p', p: 'auto' }));
  assert.equal(a.count('roster'), n);
  core.leave(fakeSock()); // unknown socket: no-op
  assert.equal(a.count('roster'), n);
});

test('restore re-adds without broadcasting', () => {
  const { core } = room();
  const s = fakeSock();
  s.meta = { id: 'aaaaaaaa', p: 'auto', firstSeen: 1 };
  core.restore(s);
  assert.equal(core.sockets.size, 1);
  assert.equal(s.sent.length, 0);
  assert.equal(core.electHub(), 'aaaaaaaa');
});
