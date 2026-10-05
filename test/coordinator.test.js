'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Coordinator, MemberAgent, DEFAULTS } = require('../extension/page/coordinator.js');

const HUB = 'hub';
const SILENT = { levelDb: -80, noiseDb: -75, act: false };

// ---- simulator ----
class Sim {
  constructor(o = {}) {
    this.dt = o.dt || 10;
    this.now = 0;
    this.members = o.members || ['m1', 'm2'];
    this.ready = new Set(o.ready || this.members);
    this.c = new Coordinator({ selfId: HUB, params: o.params });
    this.ackDelay = Object.assign({}, o.ackDelay);  // per id; default 20 (member), selfAckDelay for hub
    this.defaultAck = o.ackDelay && typeof o.ackDelay === 'number' ? o.ackDelay : 20;
    if (typeof o.ackDelay === 'number') this.ackDelay = {};
    this.selfAck = o.selfAck === undefined ? 0 : o.selfAck;
    this.noAck = new Set();
    this.segs = [];          // {id, from, to, level, extra}
    this.remoteSegs = [];    // {id, from, to, level}
    this.staleAge = new Map();
    this.acks = [];          // queued {at, id, gen, gate, op}
    this.trace = [];         // {t, k:'cmd'|'ack', id, op, gen}
    this.outs = [];
    this.events = [];
    this.cmds = [];
    this.sendRoster();
  }
  sendRoster() {
    const list = [{ id: HUB, ready: true, n: 1 }];
    this.members.forEach((id, i) => list.push({ id, ready: this.ready.has(id), n: i + 2 }));
    this.c.onRoster(list);
  }
  speak(id, from, to, levelDb, extra) { this.segs.push({ id, from, to, levelDb, extra: extra || {} }); }
  remote(id, from, to, level = 0.05) { this.remoteSegs.push({ id, from, to, level }); }
  level(id) {
    let m = Object.assign({}, SILENT);
    for (const s of this.segs) {
      if (s.id === id && this.now >= s.from && this.now < s.to) m = Object.assign({ levelDb: s.levelDb, noiseDb: -75, act: true }, s.extra);
    }
    return m;
  }
  sources() {
    const sources = [];
    for (const s of this.remoteSegs) if (this.now >= s.from && this.now < s.to) sources.push({ id: s.id, level: s.level, ageMs: 20 });
    return { identified: true, sources };
  }
  step() {
    this.now += this.dt;
    const t = this.now;
    for (const id of [HUB, ...this.members]) {
      if (this.noLevel && this.noLevel.has(id)) continue;
      const m = this.level(id);
      const age = this.staleAge.get(id) || 0;
      this.c.onLevel(id, Object.assign({}, m, { at: t - age }));
    }
    const due = this.acks.filter((a) => a.at <= t);
    this.acks = this.acks.filter((a) => a.at > t);
    for (const a of due) { this.trace.push({ t, k: 'ack', id: a.id, op: a.op, gen: a.gen }); this.c.onApplied(a.id, a.gen, a.gate); }
    const out = this.c.tick(t, this.sources(), this.extra);
    this.outs.push({ t, out });
    for (const e of out.events) this.events.push(e);
    for (const cmd of out.commands) {
      this.cmds.push(Object.assign({ t }, cmd));
      this.trace.push({ t, k: 'cmd', id: cmd.to, op: cmd.op, gen: cmd.gen });
      if (this.noAck.has(cmd.to)) continue;
      const d = cmd.to === HUB ? this.selfAck : (this.ackDelay[cmd.to] !== undefined ? this.ackDelay[cmd.to] : this.defaultAck);
      const gate = cmd.op === 'open' ? 1 : 0;
      if (d === 0) { this.trace.push({ t, k: 'ack', id: cmd.to, op: cmd.op, gen: cmd.gen }); this.c.onApplied(cmd.to, cmd.gen, gate); }
      else this.acks.push({ at: t + d, id: cmd.to, gen: cmd.gen, gate, op: cmd.op });
    }
    return out;
  }
  run(ms) { const end = this.now + ms; let out; while (this.now < end) out = this.step(); return out; }
  last() { return this.outs[this.outs.length - 1].out; }
  states() { return this.events.filter((e) => e.type === 'state'); }
  stateAt(to) { return this.events.find((e) => e.type === 'state' && e.to === to); }
  switches() { return this.events.filter((e) => e.type === 'switch'); }
  cmdsOf(id, op) { return this.cmds.filter((c) => c.to === id && (!op || c.op === op)); }
}

function ownerNow(sim) { return sim.last().owner; }

// Put `id` in ownership via a loud speaker, then settle.
function makeOwner(sim, id, ms = 600) {
  const t0 = sim.now;
  sim.speak(id, t0, t0 + ms, -30);
  sim.run(ms);
  assert.strictEqual(ownerNow(sim), id);
  assert.strictEqual(sim.last().state, 'ROOM');
}

// ---- 1. start / solo ----
test('start: owner self in ROOM with a ready member; self opened', () => {
  const s = new Sim();
  s.run(100);
  assert.strictEqual(s.last().state, 'ROOM');
  assert.strictEqual(s.last().owner, HUB);
  assert.strictEqual(s.last().tabMuted, true);
  assert.deepStrictEqual(s.cmds.filter((c) => c.op === 'open').map((c) => c.to), [HUB]);
});

test('solo with only self; leaves SOLO via SETTLING to ROOM when a member is ready', () => {
  const s = new Sim({ members: [] });
  s.run(100);
  let o = s.last();
  assert.strictEqual(o.state, 'SOLO');
  assert.strictEqual(o.owner, HUB);
  assert.strictEqual(o.tabMuted, false);
  assert.strictEqual(s.cmdsOf(HUB, 'open').length, 1);
  // a non-ready member does not leave SOLO
  s.members = ['m1']; s.ready = new Set(); s.sendRoster();
  s.run(200);
  assert.strictEqual(s.last().state, 'SOLO');
  s.ready = new Set(['m1']); s.sendRoster();
  s.run(20);
  assert.strictEqual(s.last().state, 'SETTLING');
  assert.strictEqual(s.last().tabMuted, true);
  s.run(200);
  o = s.last();
  assert.strictEqual(o.state, 'ROOM');
  assert.strictEqual(o.owner, HUB);
});

test('solo again after a clean leave, but not after a lost open member', () => {
  const s = new Sim({ members: ['m1'] });
  s.run(200);
  s.c.onLeft('m1'); s.members = []; s.sendRoster();
  s.run(50);
  assert.strictEqual(s.last().state, 'SOLO');
  const s2 = new Sim({ members: ['m1'] });
  makeOwner(s2, 'm1');
  s2.c.onLost('m1'); s2.members = []; s2.sendRoster();
  s2.run(50);
  assert.strictEqual(s2.last().state, 'PAUSED');
  s2.c.action('continueSolo');
  s2.run(20);
  assert.strictEqual(s2.last().state, 'SOLO');
});

// ---- 2. handoff ----
test('overlap handoff: open(new) acked before close(old) is sent; switch event has ms', () => {
  const s = new Sim({ ackDelay: { m1: 40 }, selfAck: 20 });
  s.speak(HUB, 0, 5000, -40);
  s.speak('m1', 500, 5000, -25);
  s.run(1500);
  const ks = s.trace.filter((x) => x.k === 'cmd' || x.k === 'ack').map((x) => `${x.k}:${x.id}:${x.op}`);
  const iOpen = ks.indexOf('cmd:m1:open'), iAck = ks.indexOf('ack:m1:open'), iClose = ks.indexOf('cmd:hub:close'), iAck2 = ks.indexOf('ack:hub:close');
  assert.ok(iOpen >= 0 && iOpen < iAck && iAck < iClose && iClose < iAck2, ks.join(','));
  assert.strictEqual(s.last().owner, 'm1');
  assert.strictEqual(s.last().state, 'ROOM');
  const sw = s.switches();
  assert.strictEqual(sw.length, 1);
  assert.strictEqual(sw[0].from, HUB);
  assert.strictEqual(sw[0].to, 'm1');
  assert.ok(sw[0].ms >= 60 && sw[0].ms <= 120, 'ms=' + sw[0].ms);
  assert.ok(s.stateAt('SWITCHING'));
});

test('gap handoff: close(old) acked before open(new)', () => {
  const s = new Sim({ ackDelay: { m1: 40 }, selfAck: 20, params: { handoffOverlap: 0 } });
  s.speak(HUB, 0, 5000, -40);
  s.speak('m1', 500, 5000, -25);
  s.run(1500);
  const ks = s.trace.filter((x) => x.k === 'cmd' || x.k === 'ack').map((x) => `${x.k}:${x.id}:${x.op}`);
  const iClose = ks.indexOf('cmd:hub:close'), iAck = ks.indexOf('ack:hub:close'), iOpen = ks.indexOf('cmd:m1:open'), iAck2 = ks.indexOf('ack:m1:open');
  assert.ok(iClose >= 0 && iClose < iAck && iAck < iOpen && iOpen < iAck2, ks.join(','));
  assert.strictEqual(s.last().owner, 'm1');
  assert.strictEqual(s.switches().length, 1);
  assert.ok(s.switches()[0].ms > 0);
});

// ---- 3. no flicker ----
test('no flicker: candidates within 3 dB for 10 s cause no switching', () => {
  const s = new Sim({ members: ['m1'] });
  for (let t = 0; t < 10000; t += 500) {
    const a = (t / 500) % 2 === 0;
    s.speak(HUB, t, t + 500, a ? -40 : -37.5);
    s.speak('m1', t, t + 500, a ? -37.5 : -40);
  }
  s.run(10000);
  assert.ok(s.switches().length <= 1, 'switches=' + s.switches().length);
});

test('minOwnMs respected when the owner is still speaking', () => {
  const s = new Sim({ members: ['m1'] });
  s.speak(HUB, 0, 3000, -40);
  s.speak('m1', 100, 3000, -28);   // 12 dB louder, from 100 ms
  s.run(1000);
  const open = s.cmdsOf('m1', 'open')[0];
  assert.ok(open.t >= 300 && open.t <= 420, 't=' + open.t);
  // the new owner is immediately out-shouted by the hub: no second switch before minOwnMs
  const s2 = new Sim({ members: ['m1'] });
  s2.speak(HUB, 0, 4000, -40);
  s2.speak('m1', 100, 1000, -28);
  s2.speak(HUB, 1000, 4000, -10);
  s2.run(3000);
  const opens = s2.cmds.filter((c) => c.op === 'open' && c.to !== undefined);
  const decisions = opens.filter((c) => c.t > 100).map((c) => c.t);
  for (let i = 1; i < decisions.length; i++) assert.ok(decisions[i] - decisions[i - 1] >= 300 || decisions[i] === decisions[i - 1]);
});

test('fast takeover (idleTakeoverMs) when the owner is silent, bypassing minOwnMs', () => {
  const s = new Sim({ members: ['m1'] });
  s.speak('m1', 50, 3000, -35);
  s.run(400);
  const open = s.cmdsOf('m1', 'open')[0];
  assert.ok(open, 'no open sent');
  assert.ok(open.t >= 110 && open.t <= 140, 't=' + open.t);
  assert.ok(open.t < 300);
});

// ---- 4. candidates ----
test('user-muted, unhealthy and stale candidates are never selected', () => {
  for (const extra of [{ userMuted: true }, { healthy: false }]) {
    const s = new Sim({ members: ['m1'] });
    s.speak(HUB, 0, 3000, -45);
    s.speak('m1', 100, 3000, -20, extra);
    s.run(2000);
    assert.strictEqual(s.cmdsOf('m1').length, 0, JSON.stringify(extra));
    assert.strictEqual(s.last().owner, HUB);
  }
  const s = new Sim({ members: ['m1'] });
  s.staleAge.set('m1', 1000);
  s.speak('m1', 100, 3000, -20);
  s.run(2000);
  assert.strictEqual(s.cmdsOf('m1').length, 0);
});

test('an unhealthy owner is switched away from (to another candidate, else self)', () => {
  const s = new Sim({ members: ['m1', 'm2'] });
  makeOwner(s, 'm1');
  s.speak('m1', s.now, s.now + 2000, -30, { healthy: false });
  s.run(600);
  assert.ok(s.cmdsOf(HUB, 'open').length >= 2 || ownerNow(s) !== 'm1');
  assert.notStrictEqual(ownerNow(s), 'm1');
  assert.strictEqual(s.last().state, 'ROOM');
  // prefer the speaking candidate
  const s2 = new Sim({ members: ['m1', 'm2'] });
  makeOwner(s2, 'm1');
  s2.speak('m1', s2.now, s2.now + 2000, -30, { healthy: false });
  s2.speak('m2', s2.now, s2.now + 2000, -35);
  s2.run(600);
  assert.strictEqual(ownerNow(s2), 'm2');
});

test('unhealthy self owner with no other candidate pauses', () => {
  const s = new Sim({ members: ['m1'] });
  s.noLevel = new Set(['m1']);
  s.run(100);
  s.segs.push({ id: HUB, from: 100, to: 9999, levelDb: -40, extra: { healthy: false } });
  s.run(800);
  assert.strictEqual(s.last().state, 'PAUSED');
  assert.strictEqual(s.last().pause.reason, 'unhealthy');
});

// ---- 5. enrollment ----
test('remote enrolled while self owns the mic', () => {
  const s = new Sim();
  s.remote('R1', 300, 400);      // before learnSettleMs after the owner ack: ignored
  s.remote('R2', 1000, 1500);
  s.run(900);
  assert.strictEqual(s.last().remote.enrolled, 0);
  s.run(300);
  assert.strictEqual(s.last().remote.enrolled, 1);
  const e = s.events.find((x) => x.type === 'enroll');
  assert.deepStrictEqual({ id: e.id, kind: e.kind }, { id: 'R2', kind: 'remote' });
  assert.ok(s.c.remoteIds.has('R2'));
});

test('learn a member CSRC while it owns and speaks; then a new CSRC is remote', () => {
  const s = new Sim();
  makeOwner(s, 'm1', 800);
  s.speak('m1', s.now, s.now + 6000, -30);
  s.remote('C1', s.now, s.now + 6000, 0.02);
  s.run(1500);
  let o = s.last();
  assert.strictEqual(o.remote.learnedRoom, 1);
  assert.strictEqual(o.remote.enrolled, 0);
  const le = s.events.find((x) => x.type === 'enroll');
  assert.deepStrictEqual({ id: le.id, kind: le.kind, owner: le.owner }, { id: 'C1', kind: 'room', owner: 'm1' });
  assert.strictEqual(o.state, 'ROOM');
  s.remote('C2', s.now, s.now + 300, 0.05);
  s.run(200);
  o = s.last();
  assert.strictEqual(o.remote.enrolled, 1);
  assert.ok(s.c.remoteIds.has('C2'));
});

test('ambiguous cases enroll nothing', () => {
  const s = new Sim();
  makeOwner(s, 'm1', 800);
  s.speak('m1', s.now, s.now + 5000, -30);
  s.remote('C1', s.now, s.now + 3000, 0.03);
  s.remote('C2', s.now, s.now + 3000, 0.03);   // two unknown at once, owner has no CSRC
  s.run(3000);
  assert.strictEqual(s.last().remote.enrolled, 0);
  assert.strictEqual(s.last().remote.learnedRoom, 0);
  // owner silent + one unknown source: no learning
  const s2 = new Sim();
  makeOwner(s2, 'm1', 800);
  s2.remote('C1', s2.now, s2.now + 3000, 0.03);
  s2.run(3000);
  assert.strictEqual(s2.last().remote.enrolled + s2.last().remote.learnedRoom, 0);
});

// ---- 6. remote interrupt ----
function remoteSetup() {
  const s = new Sim({ members: ['m1', 'm2'], ackDelay: { m1: 100 } });
  s.c.remoteIds.add('R');
  makeOwner(s, 'm1');
  return s;
}

test('remote interrupt: REMOTE_PENDING keeps the tab muted until the close is acked; then REMOTE; settle and reopen', () => {
  const s = remoteSetup();
  const T = s.now + 100;
  s.remote('R', T, T + 1000, 0.05);
  s.run(200);
  const pend = s.outs.filter((x) => x.out.state === 'REMOTE_PENDING');
  assert.ok(pend.length >= 5, 'pending ticks ' + pend.length);
  assert.ok(pend.every((x) => x.out.tabMuted === true));
  assert.ok(pend.every((x) => x.out.freezeNoise === true));
  const close = s.cmdsOf('m1', 'close').pop();
  assert.ok(close.t - T >= 40 && close.t - T <= 60);
  assert.strictEqual(s.last().state, 'REMOTE_PENDING');   // ack not yet delivered (100 ms)
  s.run(100);
  assert.strictEqual(s.last().state, 'REMOTE');
  assert.strictEqual(s.last().tabMuted, false);
  const rev = s.events.find((x) => x.type === 'remote');
  assert.ok(rev && rev.ms >= 140 && rev.ms <= 180, 'ms=' + (rev && rev.ms));
  // stays REMOTE while remote is active
  s.run(600);
  assert.strictEqual(s.last().state, 'REMOTE');
  // remote ends at T+1000
  s.run(800);
  const settling = s.stateAt('SETTLING');
  assert.ok(settling.at - (T + 1000) >= 280 && settling.at - (T + 1000) <= 340, 'settle at ' + (settling.at - T - 1000));
  const room = s.events.filter((x) => x.type === 'state' && x.to === 'ROOM').pop();
  assert.ok(room.at - settling.at >= 150 && room.at - settling.at <= 170);
  const opens = s.cmdsOf('m1', 'open');
  assert.ok(opens[opens.length - 1].t >= room.at - 10, 'previous owner reopened');
  assert.strictEqual(s.last().state, 'ROOM');
  assert.strictEqual(ownerNow(s), 'm1');
  assert.strictEqual(s.outs.find((x) => x.out.state === 'SETTLING').out.tabMuted, true);
});

// ---- 7. learned room CSRC ----
test('a learned room CSRC never triggers REMOTE', () => {
  const s = new Sim();
  makeOwner(s, 'm1', 800);
  s.speak('m1', s.now, s.now + 8000, -30);
  s.remote('C1', s.now, s.now + 8000, 0.05);
  s.run(3000);
  assert.strictEqual(s.last().remote.learnedRoom, 1);
  s.run(4000);
  assert.ok(!s.states().some((e) => e.to === 'REMOTE_PENDING' || e.to === 'REMOTE'));
  assert.strictEqual(s.last().state, 'ROOM');
});

// ---- 8. failures ----
test('ack timeout in REMOTE_PENDING: PAUSED{ackTimeout}, tab stays muted, closes retried', () => {
  const s = remoteSetup();
  s.noAck.add('m1');
  const T = s.now + 100;
  s.remote('R', T, T + 5000, 0.05);
  s.run(1300);
  const o = s.last();
  assert.strictEqual(o.state, 'PAUSED');
  assert.deepStrictEqual(o.pause, { reason: 'ackTimeout', id: 'm1' });
  assert.strictEqual(o.tabMuted, true);
  assert.ok(s.outs.every((x) => x.out.tabMuted === true || x.out.state === 'REMOTE' || x.out.state === 'SOLO'));
  assert.ok(!s.states().some((e) => e.to === 'REMOTE'));
  assert.ok(s.events.some((e) => e.type === 'timeout' && e.id === 'm1' && e.op === 'close'));
  assert.ok(o.actions.includes('resume') && o.actions.includes('hubOnly'));
});

test('owner lost: PAUSED{ownerLost}, hubOnly/dropLost offered, dropLost resumes', () => {
  const s = new Sim();
  makeOwner(s, 'm1');
  s.c.onLost('m1');
  s.members = ['m2']; s.sendRoster();
  s.run(30);
  let o = s.last();
  assert.strictEqual(o.state, 'PAUSED');
  assert.deepStrictEqual(o.pause, { reason: 'ownerLost', id: 'm1' });
  assert.strictEqual(o.tabMuted, true);
  assert.ok(o.actions.includes('hubOnly') && o.actions.includes('dropLost'));
  s.c.action('dropLost', 'm1');
  s.run(300);
  o = s.last();
  assert.strictEqual(o.state, 'ROOM');
  assert.ok(o.owner === HUB || o.owner === 'm2');
  assert.strictEqual(o.pause, null);
});

test('lost closed member is just dropped; lost member inferred from the roster', () => {
  const s = new Sim();
  s.run(200);
  s.c.onLost('m2'); s.members = ['m1']; s.sendRoster();
  s.run(100);
  assert.strictEqual(s.last().state, 'ROOM');
  const s2 = new Sim();
  makeOwner(s2, 'm1');
  s2.members = ['m2']; s2.sendRoster();   // m1 vanished without leave
  s2.run(30);
  assert.strictEqual(s2.last().state, 'PAUSED');
  assert.strictEqual(s2.last().pause.reason, 'ownerLost');
});

test('clean leave of the owner hands the mic to another candidate', () => {
  const s = new Sim();
  makeOwner(s, 'm1');
  s.c.onLeft('m1'); s.members = ['m2']; s.sendRoster();
  s.speak('m2', s.now, s.now + 1000, -30);
  s.run(400);
  assert.strictEqual(s.last().state, 'ROOM');
  assert.strictEqual(ownerNow(s), 'm2');
});

// ---- 9. relay / hub only ----
test('relay down: PAUSED{relay}, self closed; hubOnly: HUB_ONLY, self open, tab unmuted', () => {
  const s = new Sim();
  s.run(200);
  assert.strictEqual(s.last().owner, HUB);
  s.c.onRelay(false);
  s.run(50);
  let o = s.last();
  assert.strictEqual(o.state, 'PAUSED');
  assert.deepStrictEqual(o.pause, { reason: 'relay' });
  assert.strictEqual(o.tabMuted, true);
  assert.strictEqual(s.cmdsOf(HUB, 'close').length, 1);
  assert.ok(o.actions.includes('hubOnly'));
  assert.ok(!s.cmds.some((c) => c.to !== HUB && c.t > 200));
  s.c.action('hubOnly');
  s.run(50);
  o = s.last();
  assert.strictEqual(o.state, 'HUB_ONLY');
  assert.strictEqual(o.tabMuted, false);
  assert.strictEqual(o.owner, HUB);
  assert.strictEqual(s.cmdsOf(HUB, 'open').pop().t > 200, true);
});

test('hubOnly with an open member waits for its close ack before unmuting', () => {
  const s = new Sim({ ackDelay: { m1: 100 } });
  makeOwner(s, 'm1');
  s.c.action('hubOnly');
  s.run(50);
  assert.strictEqual(s.last().state, 'HUB_ONLY');
  assert.strictEqual(s.last().tabMuted, true);
  s.run(100);
  assert.strictEqual(s.last().tabMuted, false);
  assert.deepStrictEqual(s.last().actions, ['resume']);
  s.c.action('resume');
  s.run(400);
  assert.strictEqual(s.last().state, 'ROOM');
});

test('relay back up after a relay pause resumes through SETTLING', () => {
  const s = new Sim();
  s.run(200);
  s.c.onRelay(false); s.run(100);
  s.c.onRelay(true); s.run(20);
  assert.strictEqual(s.last().state, 'SETTLING');
  s.run(300);
  assert.strictEqual(s.last().state, 'ROOM');
  assert.strictEqual(ownerNow(s), HUB);
});

// ---- 10. sound check ----
test('sound check enrolls a remote', () => {
  const s = new Sim();
  s.run(200);
  assert.deepStrictEqual(s.last().actions, ['soundCheck']);
  s.c.action('soundCheck');
  s.run(30);
  assert.strictEqual(s.last().state, 'SOUNDCHECK');
  assert.strictEqual(s.last().tabMuted, false);
  assert.strictEqual(s.last().freezeNoise, true);
  s.remote('U', s.now + 100, s.now + 400, 0.05);
  s.run(200);
  assert.strictEqual(s.last().remote.enrolled, 1);
  assert.ok(s.c.remoteIds.has('U'));
  assert.strictEqual(s.last().state, 'SETTLING');
  s.run(800);
  assert.strictEqual(s.last().state, 'ROOM');
  assert.ok(!s.last().actions.includes('soundCheck'));
});

test('sound check times out after 8 s', () => {
  const s = new Sim();
  s.run(100);
  s.c.action('soundCheck');
  s.run(8100);
  assert.strictEqual(s.last().state, 'SETTLING');
  s.run(300);
  assert.strictEqual(s.last().state, 'ROOM');
});

// ---- 11. retries ----
test('un-acked command is re-sent every ~250 ms, then times out', () => {
  const s = new Sim({ members: ['m1'] });
  s.noAck.add('m1');
  s.speak('m1', 0, 9999, -30);
  s.run(1600);
  const opens = s.cmdsOf('m1', 'open');
  assert.ok(opens.length >= 4 && opens.length <= 5, 'sends=' + opens.length);
  assert.ok(new Set(opens.map((c) => c.gen)).size === 1);
  for (let i = 1; i < opens.length; i++) assert.ok(opens[i].t - opens[i - 1].t >= 250 && opens[i].t - opens[i - 1].t <= 270);
  assert.ok(s.events.some((e) => e.type === 'timeout' && e.id === 'm1' && e.op === 'open'));
  assert.strictEqual(s.last().state, 'PAUSED');
  assert.strictEqual(s.last().pause.reason, 'ownerLost');
});

test('a stale ack (old gen) is ignored', () => {
  const c = new Coordinator({ selfId: 'h' });
  c.onRoster([{ id: 'h', ready: true, n: 1 }, { id: 'a', ready: true, n: 2 }]);
  let o = c.tick(0, null);
  const g1 = o.commands.find((x) => x.op === 'open').gen;
  c.onRelay(false);                       // supersedes the open with close (new gen)
  o = c.tick(10, null);
  const g2 = o.commands.find((x) => x.op === 'close').gen;
  assert.ok(g2 > g1);
  c.onApplied('h', g1, 1);                // stale
  o = c.tick(260, null);
  assert.ok(o.commands.some((x) => x.op === 'close' && x.gen === g2), 'close still pending and re-sent');
  c.onApplied('h', g2, 0);
  o = c.tick(520, null);
  assert.strictEqual(o.commands.length, 0);
});

// ---- 12. MemberAgent ----
test('MemberAgent: epoch / gen filtering', () => {
  const m = new MemberAgent({});
  m.onEpoch(5);
  assert.strictEqual(m.onCommand({ e: 5, g: 3, op: 'open' }), 1);
  assert.strictEqual(m.onCommand({ e: 4, g: 9, op: 'open' }), null);
  assert.strictEqual(m.onCommand({ e: 5, g: 3, op: 'open' }), null);
  assert.strictEqual(m.onCommand({ e: 5, g: 2, op: 'open' }), null);
  assert.strictEqual(m.tick(0, { relayUp: true }).gate, 1);
  assert.strictEqual(m.onCommand({ e: 3, g: 1, op: 'close' }), 0);
  assert.strictEqual(m.tick(10, { relayUp: true }).gate, 0);
  assert.strictEqual(m.onCommand({ e: 5, g: 4, op: 'open' }), 1);
  assert.strictEqual(m.onCommand({ e: 99, g: 1, op: 'close' }), 0);
  assert.strictEqual(m.tick(20, { relayUp: true }).gate, 0);
});

test('MemberAgent: watchdog on missing heartbeat or relay down; onEpoch closes', () => {
  const m = new MemberAgent({});
  m.onEpoch(1);
  m.onHeartbeat(1000, { e: 1, s: 'ROOM', o: 'x' });
  m.onCommand({ e: 1, g: 1, op: 'open' });
  let r = m.tick(2499, { relayUp: true });
  assert.deepStrictEqual([r.gate, r.watchdog], [1, false]);
  r = m.tick(2500, { relayUp: true });
  assert.deepStrictEqual([r.gate, r.watchdog], [0, true]);
  // stays closed until a fresh open
  m.onHeartbeat(2600, { e: 1, s: 'ROOM', o: 'x' });
  assert.strictEqual(m.tick(2610, { relayUp: true }).gate, 0);
  m.onCommand({ e: 1, g: 2, op: 'open' });
  assert.strictEqual(m.tick(2620, { relayUp: true }).gate, 1);
  r = m.tick(2630, { relayUp: false });
  assert.deepStrictEqual([r.gate, r.watchdog], [0, true]);
  m.onCommand({ e: 1, g: 3, op: 'open' });
  m.onHeartbeat(2700, { e: 1, s: 'ROOM' });
  assert.strictEqual(m.tick(2710, { relayUp: true }).gate, 1);
  m.onEpoch(2);
  assert.strictEqual(m.tick(2720, { relayUp: true }).gate, 0);
  assert.strictEqual(m.onCommand({ e: 1, g: 10, op: 'open' }), null);
});

test('MemberAgent: freezeNoise follows the heartbeat state', () => {
  const m = new MemberAgent({});
  m.onEpoch(1);
  const t = (now, s) => { m.onHeartbeat(now, { e: 1, s, o: null }); return m.tick(now, { relayUp: true }).freezeNoise; };
  assert.strictEqual(t(0, 'ROOM'), false);
  assert.strictEqual(t(10, 'REMOTE'), true);
  assert.strictEqual(t(20, 'REMOTE_PENDING'), true);
  assert.strictEqual(t(30, 'SETTLING'), true);
  assert.strictEqual(t(40, 'ROOM'), false);
  m.onHeartbeat(50, { e: 1, s: 'REMOTE' });
  assert.strictEqual(m.tick(2000, { relayUp: true }).freezeNoise, false);   // heartbeat stale
  assert.strictEqual(m.onCommand(null), null);
});

// ---- 13. NaN safety ----
function assertFinite(v, path = 'out') {
  if (typeof v === 'number') assert.ok(Number.isFinite(v), `${path} = ${v}`);
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) assertFinite(v[k], path + '.' + k);
}

test('garbage inputs never throw and never yield NaN', () => {
  const c = new Coordinator({ selfId: HUB, params: { switchSustainMs: NaN, minOwnMs: 'x', bogus: 1 } });
  assert.deepStrictEqual(Object.assign({}, c.p), Object.assign({}, DEFAULTS));
  const junk = [undefined, null, NaN, Infinity, 'x', {}, [], { id: NaN }];
  const outs = [];
  assert.doesNotThrow(() => {
    for (const j of junk) {
      c.onRoster(j); c.onLevel(j, j); c.onLevel('m1', { levelDb: NaN, noiseDb: undefined, at: NaN, act: NaN });
      c.onApplied(j, j, j); c.onLeft(j); c.onLost(j); c.onRelay(j); c.action(j, j);
      outs.push(c.tick(j, j));
      outs.push(c.tick(NaN, { identified: 1, sources: [null, {}, { id: 'a', level: NaN, ageMs: undefined }, { id: 'b', level: Infinity, ageMs: NaN }] }));
    }
    c.onRoster([null, { id: 'm1' }, {}, { id: 'm2', ready: true, n: NaN }]);
    c.onLevel('m2', { levelDb: -30, noiseDb: NaN, act: true, at: NaN });
    for (let t = 0; t < 2000; t += 10) outs.push(c.tick(t, { sources: [{ id: 'q', level: NaN, ageMs: 0 }] }));
    c.action('soundCheck'); c.action('hubOnly'); c.action('resume'); c.action('dropLost'); c.action('continueSolo'); c.action('resetIds');
    for (let t = 2000; t < 2500; t += 10) outs.push(c.tick(t, { sources: [{ id: 'q', level: 0.3, ageMs: NaN }] }));
  });
  for (const o of outs) assertFinite(o);
  const m = new MemberAgent({ params: { watchdogMs: NaN } });
  assert.doesNotThrow(() => {
    m.onEpoch(NaN); m.onCommand({ e: NaN, g: NaN, op: 'open' }); m.onHeartbeat(NaN, {}); m.onHeartbeat(undefined, undefined);
    assertFinite(m.tick(NaN, undefined)); assertFinite(m.tick(undefined, { relayUp: NaN }));
  });
});

test('tick is cheap', () => {
  const s = new Sim({ members: ['m1', 'm2', 'm3', 'm4', 'm5'] });
  s.run(200);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) {
    s.now += 10;
    s.c.onLevel('m1', { levelDb: -30, noiseDb: -70, act: true, at: s.now });
    s.c.tick(s.now, { sources: [{ id: 'a', level: 0.001, ageMs: 10 }] });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `20000 ticks took ${ms} ms`);
});

// ---- Integration-review regressions: CSRC self-correction ----
test('mis-enrolled member CSRC (joined late) is reclassified as room after one glitch', () => {
  const s = new Sim({ members: ['m1'] });
  s.run(1000);                                   // hub owns mic
  s.remote('cB', 1000, 1400, 0.3);               // m1 was in the Meet, not joined, mic live: enrolled as remote
  s.run(1500);
  assert.ok(s.c.remoteIds.has('cB'), 'precondition: mis-enrolled');
  // m1 now talks; takes the mic; its own audio (cB) comes back through Meet ~300 ms after its gate opens.
  s.speak('m1', 2600, 9000, -20);
  const openAck = () => s.trace.find((x) => x.k === 'ack' && x.id === 'm1' && x.op === 'open');
  s.run(400);
  const oa = openAck();
  assert.ok(oa, 'm1 opened');
  // cB active only while m1's gate is open (+300 ms Meet latency)
  const gateOpenAt = (t) => { let g = 0; for (const x of s.trace) if (x.k === 'ack' && x.id === 'm1' && x.t <= t - 300) g = x.op === 'open' ? 1 : 0; return g; };
  for (let i = 0; i < 400; i++) {
    s.remoteSegs = gateOpenAt(s.now) ? [{ id: 'cB', from: 0, to: 1e9, level: 0.3 }] : [];
    s.step();
  }
  assert.ok(s.events.some((e) => e.type === 'reclassify' && e.id === 'cB' && e.to === 'room'), 'reclassified to room');
  assert.strictEqual(s.c.roomOf.get('cB'), 'm1');
  const remoteEntries = s.events.filter((e) => e.type === 'state' && e.to === 'REMOTE_PENDING' && e.at > 2600).length;
  assert.ok(remoteEntries <= 1, 'at most one glitch, got ' + remoteEntries + ' ' + JSON.stringify(s.events.filter((e) => e.type !== 'enroll').map((e) => [e.type, e.to || e.ms, e.at || ''])));
  assert.strictEqual(s.last().owner, 'm1');
});

test('learned room CSRC active long after its gate closed is reclassified as remote', () => {
  const s = new Sim({ members: ['m1'] });
  s.run(500);
  s.c.roomOf.set('cX', 'm1');                    // wrongly learned as m1's
  s.run(1500);                                   // m1 gate closed since start
  s.remote('cX', s.now, s.now + 1000, 0.3);      // cX talks while m1 is closed
  s.run(1000);
  assert.ok(s.events.some((e) => e.type === 'reclassify' && e.id === 'cX' && e.to === 'remote'));
  assert.ok(s.c.remoteIds.has('cX'));
});

test('remote enrolls while hub is solo', () => {
  const s = new Sim({ members: [] });
  s.run(1000);
  assert.strictEqual(s.last().state, 'SOLO');
  s.remote('cR', 1000, 1500, 0.3);
  s.run(1000);
  assert.ok(s.c.remoteIds.has('cR'));
});

test('lost owner that comes back ready (reload / wifi blip) auto-resumes', () => {
  const s = new Sim({ members: ['m1'] });
  s.speak('m1', 0, 1e9, -20);
  s.run(1500);
  assert.strictEqual(s.last().owner, 'm1');
  s.c.onLost('m1');
  s.members = []; s.sendRoster();
  s.run(200);
  assert.strictEqual(s.last().state, 'PAUSED');
  // m1 rejoins: first not ready, then ready (gate closed)
  s.members = ['m1']; s.ready = new Set(); s.sendRoster(); s.run(200);
  assert.strictEqual(s.last().state, 'PAUSED');
  s.ready = new Set(['m1']); s.sendRoster(); s.run(1000);
  assert.ok(['ROOM', 'SWITCHING'].includes(s.last().state), s.last().state);
  assert.ok(s.events.some((e) => e.type === 'recovered' && e.id === 'm1'));
});

// ---- recovery / mute confirmation / owner refresh ----
test('self userMuted with no other candidate stays in ROOM owned by self', () => {
  const s = new Sim({ members: ['m1'] });
  s.noLevel = new Set(['m1']);
  s.segs.push({ id: HUB, from: 0, to: 1e9, levelDb: -40, extra: { userMuted: true } });
  s.run(3000);
  assert.strictEqual(s.last().state, 'ROOM');
  assert.strictEqual(s.last().owner, HUB);
  assert.ok(!s.states().some((e) => e.to === 'PAUSED'));
});

test('self unhealthy pause auto-resumes after 1000 ms of continuous health', () => {
  const s = new Sim({ members: ['m1'] });
  s.noLevel = new Set(['m1']);
  s.run(100);
  s.segs.push({ id: HUB, from: 100, to: 1500, levelDb: -40, extra: { healthy: false } });
  s.run(1000);
  assert.strictEqual(s.last().state, 'PAUSED');
  assert.strictEqual(s.last().pause.reason, 'unhealthy');
  s.run(700);   // healthy since ~1500; not yet 1000 ms
  assert.strictEqual(s.last().state, 'PAUSED');
  s.run(1200);
  assert.ok(['SETTLING', 'ROOM'].includes(s.last().state), s.last().state);
  assert.ok(s.events.some((e) => e.type === 'autoResume' && e.reason === 'unhealthy'));
  s.run(500);
  assert.strictEqual(s.last().state, 'ROOM');
  assert.strictEqual(s.last().owner, HUB);
});

test('ackTimeout pause keeps re-sending close and auto-resumes once it acks', () => {
  const s = remoteSetup();
  s.noAck.add('m1');
  const T = s.now + 100;
  s.remote('R', T, T + 60000, 0.05);
  s.run(1500);
  assert.strictEqual(s.last().state, 'PAUSED');
  const n1 = s.cmdsOf('m1', 'close').length;
  s.run(1500);
  assert.ok(s.cmdsOf('m1', 'close').length > n1);
  assert.strictEqual(s.last().state, 'PAUSED');
  s.noAck.delete('m1');
  s.run(1500);
  assert.ok(s.events.some((e) => e.type === 'autoResume' && e.reason === 'ackTimeout'));
  assert.notStrictEqual(s.last().state, 'PAUSED');
});

test('ownerLost pause auto-drops the lost id after lostDropMs and resumes', () => {
  const s = new Sim();
  makeOwner(s, 'm1');
  s.c.onLost('m1');
  s.members = ['m2']; s.sendRoster();
  s.run(2000);
  assert.strictEqual(s.last().state, 'PAUSED');
  assert.ok(s.last().actions.includes('dropLost') && s.last().actions.includes('hubOnly'));
  assert.strictEqual(DEFAULTS.lostDropMs, 2500);
  s.run(800);
  assert.ok(s.events.some((e) => e.type === 'autoDrop' && e.id === 'm1'));
  assert.ok(s.events.some((e) => e.type === 'autoResume' && e.reason === 'ownerLost'));
  s.run(500);
  assert.strictEqual(s.last().state, 'ROOM');
  assert.strictEqual(s.last().pause, null);
});

test('SETTLING waits for confirmed tab mute before reopening any mic', () => {
  const s = remoteSetup();
  s.extra = { tabMuted: null };
  const T = s.now + 100;
  s.remote('R', T, T + 500, 0.05);
  s.run(1500);
  assert.strictEqual(s.last().state, 'SETTLING');
  assert.strictEqual(s.last().debug.waitingMute, true);
  const n = s.cmds.length;
  s.run(2000);
  assert.strictEqual(s.last().state, 'SETTLING');
  assert.strictEqual(s.cmds.length, n);
  s.extra = { tabMuted: false };
  s.run(500);
  assert.strictEqual(s.last().state, 'SETTLING');
  s.extra = { tabMuted: true };
  s.run(300);
  assert.strictEqual(s.last().state, 'ROOM');
  assert.strictEqual(s.last().debug.waitingMute, false);
});

test('leaving HUB_ONLY via resume waits for confirmed mute; undefined extra behaves as before', () => {
  const s = new Sim({ members: ['m1'] });
  s.extra = { tabMuted: false };
  s.run(200);
  s.c.action('hubOnly');
  s.run(300);
  assert.strictEqual(s.last().state, 'HUB_ONLY');
  s.c.action('resume');
  s.run(1000);
  assert.strictEqual(s.last().state, 'SETTLING');
  s.extra = { tabMuted: true };
  s.run(300);
  assert.strictEqual(s.last().state, 'ROOM');
  const s2 = new Sim({ members: ['m1'] });
  s2.run(200); s2.c.action('hubOnly'); s2.run(300); s2.c.action('resume'); s2.run(400);
  assert.strictEqual(s2.last().state, 'ROOM');
});

test('leaving SOUNDCHECK waits for confirmed mute', () => {
  const s = new Sim({ members: ['m1'] });
  s.extra = { tabMuted: true };
  s.run(200);
  s.c.action('soundCheck');
  s.extra = { tabMuted: null };
  s.run(9000);
  assert.strictEqual(s.last().state, 'SETTLING');
  assert.strictEqual(s.last().debug.waitingMute, true);
  s.extra = { tabMuted: true };
  s.run(300);
  assert.strictEqual(s.last().state, 'ROOM');
});

test('member owner gets a fresh open every ownerRefreshMs; not a switch', () => {
  const s = new Sim({ members: ['m1', 'm2'] });
  s.speak('m1', 0, 1e9, -30);
  s.run(1000);
  assert.strictEqual(s.last().owner, 'm1');
  const base = s.cmdsOf('m1', 'open').length;
  const sw = s.switches().length;
  s.run(3500);
  const opens = s.cmdsOf('m1', 'open');
  assert.ok(opens.length - base >= 3 && opens.length - base <= 4, String(opens.length - base));
  assert.strictEqual(new Set(opens.map((c) => c.gen)).size, opens.length);
  assert.strictEqual(s.switches().length, sw);
  assert.strictEqual(s.last().state, 'ROOM');
  assert.strictEqual(s.last().owner, 'm1');
});
