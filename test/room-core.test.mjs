import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomCore, MemoryStore, safeEqual, validateJoin } from '../backend/src/room-core.js';

const cidOf = (c) => c.padEnd(16, '0');
const A = cidOf('A'), B = cidOf('B'), C = cidOf('C'), D = cidOf('D');

function fakeSock() {
  const s = { sent: [], closed: null };
  s.send = (t) => s.sent.push(JSON.parse(t));
  s.close = (code, reason) => { s.closed = { code, reason }; };
  s.all = (t) => s.sent.filter((m) => m.t === t);
  s.last = (t) => s.all(t).at(-1);
  s.count = (t) => s.all(t).length;
  s.clear = () => { s.sent.length = 0; };
  return s;
}

function setup(opts = {}) {
  let t = Date.UTC(2026, 0, 1, 12, 0, 0);
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const timers = [];
  const setTimer = (fn, ms) => { const h = { fn, at: t + ms, off: false }; timers.push(h); return h; };
  const clearTimer = (h) => { if (h) h.off = true; };
  clock.fire = (ms) => {
    t += ms;
    for (const h of timers) if (!h.off && h.at <= t) { h.off = true; h.fn(); }
  };
  const core = new RoomCore({ now: clock.now, setTimer, clearTimer, store: new MemoryStore(), ...opts });
  const clients = {};
  const join = (cid, claim = 0, tok = '') => {
    const s = fakeSock();
    clients[cid] = s;
    s.ok = core.join(s, { cid, tok, claim });
    return s;
  };
  const send = (s, m) => core.message(s, JSON.stringify(m));
  return { core, clock, join, send, clients };
}

/** hub A (first), members B, C ready. */
function room3() {
  const r = setup();
  const a = r.join(A), b = r.join(B), c = r.join(C);
  r.send(b, { t: 'ready', r: 1 });
  r.send(c, { t: 'ready', r: 1 });
  [a, b, c].forEach((s) => s.clear());
  return { ...r, a, b, c };
}

test('first client becomes hub; welcome has sid/you/hub/epoch/roster', () => {
  const { join, core } = setup();
  const a = join(A);
  assert.equal(a.ok, true);
  const w = a.last('welcome');
  assert.equal(w.you, A);
  assert.equal(w.hub, A);
  assert.equal(w.epoch, 1);
  assert.match(w.sid, /^[0-9a-f]+$/);
  assert.deepEqual(w.roster, [{ cid: A, n: 1, ready: 0 }]);
  assert.equal(core.hub, A);
});

test('second client without claim is a member; claim=1 does not steal a live hub', () => {
  const { join, core } = setup();
  join(A);
  const b = join(B, 0);
  assert.equal(b.last('welcome').hub, A);
  const c = join(C, 1);
  assert.equal(c.last('welcome').hub, A);
  assert.equal(core.epoch, 1);
});

test('claim=1 becomes hub when hub is null after grace', () => {
  const { join, core, clock, clients } = setup();
  join(A); join(B);
  core.close(clients[A]);
  clock.fire(30001);
  const c = join(C, 1);
  assert.equal(c.last('welcome').hub, C);
  assert.equal(core.epoch, 2);
});

test('hub grace: same cid reclaims, others blocked, take blocked during grace', () => {
  const { join, core, send, clock, clients } = setup();
  join(A); const b = join(B);
  core.close(clients[A]);
  assert.equal(core.hub, null);
  assert.equal(core.hubLost.cid, A);
  const r = b.last('roster');
  assert.equal(r.hub, null);
  assert.equal(r.hubLost, A);
  const c = join(C, 1);
  assert.equal(c.last('welcome').hub, null);
  send(b, { t: 'take' });
  assert.equal(core.hub, null);
  clock.fire(10000);
  const a2 = join(A, 0);
  assert.equal(a2.last('welcome').hub, A);
  assert.equal(a2.last('welcome').epoch, 2);
  assert.equal(core.hubLost, null);
  assert.equal(b.last('roster').hub, A);
  assert.equal(b.last('roster').hubLost, null);
  clock.fire(40000); // old timer must not fire anything
  assert.equal(core.hub, A);
});

test('after grace: roster broadcast with hubLost null, then take succeeds (epoch+1)', () => {
  const { join, core, send, clock, clients } = setup();
  join(A); const b = join(B); const c = join(C);
  core.close(clients[A]);
  clock.fire(30001);
  assert.equal(b.last('roster').hubLost, null);
  assert.equal(b.last('roster').hub, null);
  send(c, { t: 'take' });
  assert.equal(core.hub, C);
  assert.equal(core.epoch, 2);
  assert.equal(b.last('roster').hub, C);
  assert.equal(b.last('roster').epoch, 2);
  send(b, { t: 'take' }); // hub exists: ignored
  assert.equal(core.hub, C);
  assert.equal(core.epoch, 2);
});

test('grace with only hub in room: reclaim keeps sid; empty room after grace gets new sid', () => {
  const { join, core, clock, clients } = setup();
  const a = join(A);
  const sid = a.last('welcome').sid;
  core.close(clients[A]);
  clock.fire(5000);
  const a2 = join(A);
  assert.equal(a2.last('welcome').sid, sid);
  assert.equal(a2.last('welcome').hub, A);
  core.close(a2);
  clock.fire(31000);
  const b = join(B);
  assert.notEqual(b.last('welcome').sid, sid);
  assert.equal(b.last('welcome').hub, B);
});

test('leave by hub promotes earliest-joined READY member; epoch+1; socket closed 1000', () => {
  const { join, core, send, clients } = setup();
  const a = join(A), b = join(B), c = join(C);
  send(c, { t: 'ready', r: 1 }); // B not ready, C ready -> C wins
  send(a, { t: 'leave' });
  assert.deepEqual(a.closed, { code: 1000, reason: 'bye' });
  assert.equal(core.hub, C);
  assert.equal(core.epoch, 2);
  const r = b.last('roster');
  assert.equal(r.hub, C);
  assert.equal(r.epoch, 2);
  assert.equal(r.roster.length, 2);
  assert.equal(b.count('left'), 0);
  assert.equal(clients[A], a);
});

test('leave by hub with nobody ready promotes earliest member; with nobody, hub null', () => {
  const { join, core, send } = setup();
  const a = join(A), b = join(B), c = join(C);
  send(a, { t: 'leave' });
  assert.equal(core.hub, B);
  send(b, { t: 'leave' });
  assert.equal(core.hub, C);
  send(c, { t: 'leave' });
  assert.equal(core.hub, null);
  assert.equal(core.hubLost, null);
  assert.equal(core.idle, true);
  assert.ok(b.closed && c.closed);
});

test('yield promotes target; epoch+1; invalid targets and non-hub ignored', () => {
  const { send, core, a, b, c } = room3();
  send(b, { t: 'yield', to: C }); // not hub
  assert.equal(core.hub, A);
  send(a, { t: 'yield', to: D }); // not a member
  send(a, { t: 'yield', to: A }); // self
  assert.equal(core.hub, A);
  assert.equal(core.epoch, 1);
  send(a, { t: 'yield', to: C });
  assert.equal(core.hub, C);
  assert.equal(core.epoch, 2);
  for (const s of [a, b, c]) assert.equal(s.last('roster').hub, C);
});

test('epoch increments on every hub grant', () => {
  const { join, send, core, clock, clients } = setup();
  const a = join(A); const b = join(B);
  assert.equal(core.epoch, 1);
  send(a, { t: 'yield', to: B });
  assert.equal(core.epoch, 2);
  send(b, { t: 'yield', to: A });
  assert.equal(core.epoch, 3);
  core.close(clients[A]);
  clock.fire(31000);
  send(b, { t: 'take' });
  assert.equal(core.epoch, 4);
  send(b, { t: 'leave' });
  assert.equal(core.epoch, 4); // nobody to promote
});

test('ready: sets flag, broadcasts roster; same value no broadcast; bad values dropped', () => {
  const { send, a, b } = room3();
  send(b, { t: 'ready', r: 0 });
  assert.equal(a.last('roster').roster.find((x) => x.cid === B).ready, 0);
  a.clear(); b.clear();
  send(b, { t: 'ready', r: 0 });
  assert.equal(a.count('roster'), 0);
  send(b, { t: 'ready', r: 2 });
  send(b, { t: 'ready', r: true });
  send(b, { t: 'ready' });
  assert.equal(a.count('roster'), 0);
});

test('lvl goes to the hub only, rounded, tagged with from; hub lvl dropped; bad schema dropped', () => {
  const { send, a, b, c } = room3();
  send(b, { t: 'lvl', q: 7, l: -42.26, z: -60.04, a: 1, h: 1, m: 0 });
  assert.deepEqual(a.last('lvl'), { t: 'lvl', from: B, q: 7, l: -42.3, z: -60, a: 1, h: 1, m: 0 });
  assert.equal(c.count('lvl'), 0);
  assert.equal(b.count('lvl'), 0);
  send(a, { t: 'lvl', q: 1, l: 0, z: 0, a: 0, h: 1, m: 0 });
  assert.equal(b.count('lvl') + c.count('lvl'), 0);
  a.clear();
  send(b, { t: 'lvl', q: 1, l: 'x', z: 0, a: 0, h: 1, m: 0 });
  send(b, { t: 'lvl', q: 1, l: 0, z: 0, a: 2, h: 1, m: 0 });
  send(b, { t: 'lvl', q: -1, l: 0, z: 0, a: 0, h: 1, m: 0 });
  send(b, { t: 'lvl', q: 1.5, l: 0, z: 0, a: 0, h: 1, m: 0 });
  send(b, { t: 'lvl', q: 1, l: 0, z: 0, a: 0, h: 1 });
  send(b, { t: 'lvl', q: 1, l: null, z: 0, a: 0, h: 1, m: 0 });
  assert.equal(a.count('lvl'), 0);
});

test('cmd: hub with current epoch reaches only its target', () => {
  const { send, core, a, b, c } = room3();
  send(a, { t: 'cmd', to: B, op: 'open', e: core.epoch, g: 5 });
  assert.deepEqual(b.last('cmd'), { t: 'cmd', op: 'open', e: 1, g: 5 });
  assert.equal(c.count('cmd'), 0);
  assert.equal(a.count('cmd'), 0);
});

test('cmd: stale epoch dropped; non-hub cmd dropped; bad schema dropped; unknown target dropped', () => {
  const { send, core, a, b, c } = room3();
  send(a, { t: 'cmd', to: B, op: 'open', e: core.epoch - 1, g: 1 });
  send(a, { t: 'cmd', to: B, op: 'open', e: core.epoch + 1, g: 1 });
  send(b, { t: 'cmd', to: C, op: 'close', e: core.epoch, g: 1 });
  send(a, { t: 'cmd', to: B, op: 'explode', e: core.epoch, g: 1 });
  send(a, { t: 'cmd', to: 'short', op: 'open', e: core.epoch, g: 1 });
  send(a, { t: 'cmd', to: B, op: 'open', e: core.epoch, g: -1 });
  send(a, { t: 'cmd', to: D, op: 'open', e: core.epoch, g: 1 });
  send(a, { t: 'cmd', to: A, op: 'open', e: core.epoch, g: 1 });
  assert.equal(b.count('cmd') + c.count('cmd') + a.count('cmd'), 0);
});

test('cmd after a promotion: old epoch dropped, new hub works', () => {
  const { send, core, a, b, c } = room3();
  send(a, { t: 'yield', to: B });
  send(b, { t: 'cmd', to: C, op: 'close', e: 1, g: 1 }); // stale
  assert.equal(c.count('cmd'), 0);
  send(b, { t: 'cmd', to: C, op: 'close', e: core.epoch, g: 1 });
  assert.equal(c.count('cmd'), 1);
  send(a, { t: 'cmd', to: C, op: 'close', e: core.epoch, g: 2 }); // former hub
  assert.equal(c.count('cmd'), 1);
});

test('applied goes to the hub only, with from; hub applied dropped; bad gate dropped', () => {
  const { send, a, b, c } = room3();
  send(b, { t: 'applied', e: 1, g: 3, gate: 1 });
  assert.deepEqual(a.last('applied'), { t: 'applied', from: B, e: 1, g: 3, gate: 1 });
  assert.equal(c.count('applied'), 0);
  a.clear();
  send(a, { t: 'applied', e: 1, g: 3, gate: 1 });
  send(b, { t: 'applied', e: 1, g: 3, gate: 5 });
  send(b, { t: 'applied', e: 1, gate: 1 });
  assert.equal(a.count('applied') + b.count('applied') + c.count('applied'), 0);
});

test('hb: hub broadcast to members only (not back); non-hub hb dropped; bad schema dropped', () => {
  const { send, a, b, c } = room3();
  send(a, { t: 'hb', e: 1, s: 'ROOM', o: B });
  assert.deepEqual(b.last('hb'), { t: 'hb', e: 1, s: 'ROOM', o: B });
  assert.deepEqual(c.last('hb'), { t: 'hb', e: 1, s: 'ROOM', o: B });
  assert.equal(a.count('hb'), 0);
  send(a, { t: 'hb', e: 1, s: 'REMOTE', o: null });
  assert.equal(b.last('hb').o, null);
  b.clear(); c.clear();
  send(b, { t: 'hb', e: 1, s: 'ROOM', o: B });
  send(a, { t: 'hb', e: 1, s: 'bad state!', o: B });
  send(a, { t: 'hb', e: 'x', s: 'ROOM', o: B });
  send(a, { t: 'hb', e: 1, s: 'ROOM', o: 'nope' });
  assert.equal(a.count('hb') + b.count('hb') + c.count('hb'), 0);
});

test('want: member -> hub only with from; hub want dropped', () => {
  const { send, a, b, c } = room3();
  send(b, { t: 'want' });
  assert.deepEqual(a.last('want'), { t: 'want', from: B });
  assert.equal(c.count('want'), 0);
  send(a, { t: 'want' });
  assert.equal(b.count('want') + c.count('want'), 0);
});

test('take by a member while a hub exists is ignored', () => {
  const { send, core, b } = room3();
  send(b, { t: 'take' });
  assert.equal(core.hub, A);
  assert.equal(core.epoch, 1);
});

test('ping -> pong to sender only; bad ts dropped', () => {
  const { send, a, b } = room3();
  send(b, { t: 'ping', ts: 12345 });
  assert.deepEqual(b.last('pong'), { t: 'pong', ts: 12345 });
  assert.equal(a.count('pong'), 0);
  send(b, { t: 'ping', ts: 'now' });
  send(b, { t: 'ping' });
  assert.equal(b.count('pong'), 1);
});

test('cfg: broadcast to others with from; limits and key/number validation', () => {
  const { send, a, b, c } = room3();
  send(b, { t: 'cfg', params: { switchAdvantageDb: 8, minOwnMs: 250 } });
  assert.deepEqual(a.last('cfg'), { t: 'cfg', params: { switchAdvantageDb: 8, minOwnMs: 250 }, from: B });
  assert.deepEqual(c.last('cfg').from, B);
  assert.equal(b.count('cfg'), 0);
  a.clear(); c.clear();
  const many = {};
  for (let i = 0; i < 21; i++) many['p' + i] = i;
  send(b, { t: 'cfg', params: many });
  send(b, { t: 'cfg', params: { x: 'str' } });
  send(b, { t: 'cfg', params: { 'bad key': 1 } });
  send(b, { t: 'cfg', params: { x: null } });
  send(b, { t: 'cfg', params: [1] });
  send(b, { t: 'cfg', params: {} });
  send(b, { t: 'cfg' });
  assert.equal(a.count('cfg') + c.count('cfg'), 0);
  const twenty = {};
  for (let i = 0; i < 20; i++) twenty['p' + i] = i;
  send(b, { t: 'cfg', params: twenty });
  assert.equal(a.count('cfg'), 1);
});

test('member clean leave: hub gets left before roster; roster shrinks; socket closed 1000', () => {
  const { send, a, b } = room3();
  send(b, { t: 'leave' });
  assert.deepEqual(b.closed, { code: 1000, reason: 'bye' });
  assert.deepEqual(a.last('left'), { t: 'left', cid: B });
  const order = a.sent.map((m) => m.t);
  assert.ok(order.indexOf('left') < order.indexOf('roster'));
  assert.equal(a.last('roster').roster.length, 2);
  assert.equal(a.count('lost'), 0);
});

test('member unexpected close: hub gets lost + roster without the member', () => {
  const { core, a, b, c } = room3();
  core.close(b);
  assert.deepEqual(a.last('lost'), { t: 'lost', cid: B });
  assert.equal(a.count('left'), 0);
  assert.equal(a.last('roster').roster.some((x) => x.cid === B), false);
  assert.equal(c.count('lost'), 0);
  assert.equal(c.last('roster').roster.length, 2);
  core.close(b); // idempotent
  assert.equal(a.count('lost'), 1);
});

test('hub unexpected close: hub null, hubLost in roster, no lost/left notices', () => {
  const { core, a, b, c } = room3();
  core.close(a);
  for (const s of [b, c]) {
    assert.equal(s.count('lost') + s.count('left'), 0);
    assert.equal(s.last('roster').hubLost, A);
    assert.equal(s.last('roster').hub, null);
  }
});

test('duplicate cid: older socket closed 4000, no leave/lost, keeps n and hub', () => {
  const { join, core, send, a, b } = room3();
  const b2 = join(B);
  assert.deepEqual(b.closed, { code: 4000, reason: 'replaced' });
  assert.equal(a.count('lost') + a.count('left'), 0);
  assert.equal(core.clients.size, 3);
  assert.equal(b2.last('welcome').roster.find((x) => x.cid === B).n, 2);
  core.close(b); // late close event of the replaced socket: ignored
  assert.equal(a.count('lost'), 0);
  assert.equal(core.clients.size, 3);
  send(b2, { t: 'want' });
  assert.equal(a.count('want'), 1);
  // hub reconnecting over its own old socket stays hub without epoch change
  const a2 = join(A);
  assert.equal(a2.last('welcome').hub, A);
  assert.equal(core.epoch, 1);
});

test('auth: wrong/missing token closes 4003; right token ok; empty config accepts anything', () => {
  const r = setup({ token: 'sekret' });
  const bad = r.join(A, 0, 'wrong');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.closed, { code: 4003, reason: 'auth' });
  assert.equal(r.join(B, 0, '').ok, false);
  assert.equal(r.join(B, 0, 'sekretX').ok, false);
  assert.equal(r.join(B, 0, 'sekre').ok, false);
  assert.equal(r.core.occupied, false);
  assert.equal(r.join(C, 0, 'sekret').ok, true);
  const open = setup({ token: '' });
  assert.equal(open.join(A, 0, 'anything').ok, true);
  assert.equal(open.join(B, 0, '').ok, true);
});

test('safeEqual / validateJoin helpers', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  const key = 'a'.repeat(32);
  assert.equal(validateJoin({ key, cid: A, claim: '1', v: '2' }), true);
  assert.equal(validateJoin({ key, cid: A, claim: '2', v: '2' }), false);
  assert.equal(validateJoin({ key, cid: A, claim: '0', v: '1' }), false);
  assert.equal(validateJoin({ key: 'A'.repeat(32), cid: A, claim: '0', v: '2' }), false);
  assert.equal(validateJoin({ key, cid: 'short', claim: '0', v: '2' }), false);
  assert.equal(validateJoin({ key, cid: 'a-'.repeat(8), claim: '0', v: '2' }), false);
});

test('bad cid closes 4002', () => {
  const { core } = setup();
  const s = fakeSock();
  assert.equal(core.join(s, { cid: 'bad', tok: '', claim: 0 }), false);
  assert.equal(s.closed.code, 4002);
});

test('limits: 9th client rejected 4001; a duplicate cid is not counted as new', () => {
  const { join, core } = setup();
  for (let i = 0; i < 8; i++) join(cidOf('X' + i));
  assert.equal(core.clients.size, 8);
  const ninth = join(cidOf('Y'));
  assert.equal(ninth.ok, false);
  assert.deepEqual(ninth.closed, { code: 4001, reason: 'full' });
  const dup = join(cidOf('X3'));
  assert.equal(dup.ok, true);
  assert.equal(core.clients.size, 8);
});

test('limits: message > 512 bytes dropped (bytes, not chars)', () => {
  const { send, core, a, b } = room3();
  const pad = 'x'.repeat(480);
  send(a, { t: 'cfg', params: { ok: 1 }, pad }); // ~520 bytes
  assert.equal(b.count('cfg'), 0);
  core.message(a, JSON.stringify({ t: 'cfg', params: { ok: 1 }, pad: 'é'.repeat(250) })); // 500 chars, > 512 bytes
  assert.equal(b.count('cfg'), 0);
  send(a, { t: 'cfg', params: { ok: 1 } });
  assert.equal(b.count('cfg'), 1);
});

test('limits: 60 msgs/s per socket, excess dropped, window resets', () => {
  const { send, clock, a, b } = room3();
  clock.advance(1000);
  for (let i = 0; i < 100; i++) send(b, { t: 'lvl', q: i, l: -40, z: -60, a: 1, h: 1, m: 0 });
  assert.equal(a.count('lvl'), 60);
  clock.advance(1000);
  send(b, { t: 'lvl', q: 1, l: -40, z: -60, a: 1, h: 1, m: 0 });
  assert.equal(a.count('lvl'), 61);
});

test('garbage input is ignored: bad JSON, non-object, unknown t, non-string, unknown socket', () => {
  const { core, a, b } = room3();
  core.message(b, '{nope');
  core.message(b, '[]');
  core.message(b, '5');
  core.message(b, 'null');
  core.message(b, JSON.stringify({ t: 'zzz' }));
  core.message(b, JSON.stringify({ t: 7 }));
  core.message(b, 42);
  core.message(fakeSock(), JSON.stringify({ t: 'ready', r: 1 }));
  assert.equal(a.sent.length, 0);
});

test('roster only on change: joins, ready changes, leaves; not on forwarded traffic', () => {
  const { join, send, core, clients } = setup();
  const a = join(A);
  assert.equal(a.count('roster'), 0); // only its welcome
  const b = join(B);
  assert.equal(a.count('roster'), 1);
  assert.equal(b.count('roster'), 0);
  assert.equal(b.count('welcome'), 1);
  send(b, { t: 'ready', r: 1 });
  assert.equal(a.count('roster'), 2);
  send(b, { t: 'ready', r: 1 });
  send(b, { t: 'lvl', q: 1, l: 0, z: 0, a: 0, h: 1, m: 0 });
  send(b, { t: 'ping', ts: 1 });
  send(a, { t: 'hb', e: 1, s: 'ROOM', o: A });
  assert.equal(a.count('roster'), 2);
  assert.equal(b.count('roster'), 1);
  core.close(clients[B]);
  assert.equal(a.count('roster'), 3);
});

test('usage cap: tick accrues minutes per UTC day; over cap refuses joins 4004; existing continue', () => {
  const store = new MemoryStore();
  const r = setup({ maxMinutes: 3, store });
  const a = r.join(A);
  r.clock.advance(60000); r.core.tick(r.clock.now());
  r.clock.advance(60000); r.core.tick(r.clock.now());
  assert.ok(Math.abs(r.core.usedMinutes() - 2) < 1e-9);
  assert.ok(Math.abs(store.get('2026-01-01') - 2) < 1e-9);
  assert.equal(r.join(B).ok, true);
  r.clock.advance(60000); r.core.tick(r.clock.now());
  const c = r.join(C);
  assert.equal(c.ok, false);
  assert.deepEqual(c.closed, { code: 4004, reason: 'daily cap' });
  assert.equal(a.closed, null); // existing sessions continue
  r.send(a, { t: 'ping', ts: 1 });
  assert.equal(a.count('pong'), 1);
});

test('usage cap: empty room does not accrue; usage flushed when last client leaves; new day resets', () => {
  const r = setup({ maxMinutes: 10 });
  const a = r.join(A);
  r.clock.advance(90000);
  r.send(a, { t: 'leave' });
  assert.ok(Math.abs(r.core.usedMinutes() - 1.5) < 1e-9);
  r.clock.advance(3600000);
  r.core.tick(r.clock.now());
  assert.ok(Math.abs(r.core.usedMinutes() - 1.5) < 1e-9);
  const r2 = setup({ maxMinutes: 1 });
  r2.join(A);
  r2.clock.advance(60000); r2.core.tick(r2.clock.now());
  assert.equal(r2.join(B).ok, false);
  r2.clock.advance(24 * 3600000);
  assert.equal(r2.join(C).ok, true);
});

test('usage cap: shared store is honored across cores (team counter)', () => {
  const store = new MemoryStore();
  const r1 = setup({ maxMinutes: 1, store });
  r1.join(A);
  r1.clock.advance(60000); r1.core.tick(r1.clock.now());
  const r2 = setup({ maxMinutes: 1, store });
  assert.equal(r2.join(A).ok, false);
});

test('welcome roster for a late joiner lists everyone ordered by n', () => {
  const { join, send } = setup();
  const a = join(A); const b = join(B);
  send(b, { t: 'ready', r: 1 });
  const c = join(C);
  assert.deepEqual(c.last('welcome').roster, [
    { cid: A, n: 1, ready: 0 }, { cid: B, n: 2, ready: 1 }, { cid: C, n: 3, ready: 0 },
  ]);
  assert.equal(a.last('roster').roster.length, 3);
});
