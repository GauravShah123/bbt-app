'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Controller, DEFAULTS } = require('../extension/page/policy.js');

const TICK = 21;
const amp = (db) => Math.pow(10, db / 20);
const SIL = -70;

// Scripted simulator. Scene fields are mutable between run() calls.
function makeSim(overrides, base) {
  const c = new Controller(overrides);
  const sim = {
    c, t: 1000, out: null, outs: [], states: new Set(), events: [],
    mode: 'auto', connected: true, everConnected: true, isHub: true, roomSize: 3, participating: true,
    selfDb: SIL,
    peers: {},          // id -> { db, speaking, ageMs }
    identified: true,
    sources: {},        // id -> db (omitted => absent)
    record: false,
    ...base,
  };
  sim.tick = function () {
    sim.t += TICK;
    const peers = Object.keys(sim.peers).map((id) => {
      const p = sim.peers[id];
      return { id, amp: amp(p.db), speaking: p.speaking !== undefined ? p.speaking : p.db > -45, ageMs: p.ageMs !== undefined ? p.ageMs : 30 };
    });
    const sources = Object.keys(sim.sources).map((id) => ({ id, level: amp(sim.sources[id]), ageMs: 0 }));
    const out = c.step({
      now: sim.t, selfAmp: amp(sim.selfDb), participating: sim.participating, mode: sim.mode,
      connected: sim.connected, everConnected: sim.everConnected, isHub: sim.isHub, roomSize: sim.roomSize,
      peers, remote: { identified: sim.identified, sources },
    });
    sim.out = out;
    sim.states.add(out.state);
    for (const e of out.events) sim.events.push(e);
    if (sim.record) sim.outs.push(out);
    return out;
  };
  sim.run = function (ms, each) {
    const n = Math.round(ms / TICK);
    for (let i = 0; i < n; i++) { const o = sim.tick(); if (each) each(o, i); }
    return sim.out;
  };
  sim.warm = function () { sim.run(1500); };
  // run until predicate true, returns elapsed ms (or -1)
  sim.until = function (pred, maxMs) {
    const t0 = sim.t;
    while (sim.t - t0 < maxMs) { const o = sim.tick(); if (pred(o)) return sim.t - t0; }
    return -1;
  };
  return sim;
}

test('DEFAULTS match the contract', () => {
  assert.strictEqual(DEFAULTS.vadOnsetDb, 9);
  assert.strictEqual(DEFAULTS.remoteHoldMs, 500);
  assert.strictEqual(DEFAULTS.csrcLookbackMs, 800);
  const c = new Controller({ remoteHoldMs: 123 });
  assert.strictEqual(c.p.remoteHoldMs, 123);
  c.setParams({ remoteHoldMs: 77, bogus: 'x' });
  assert.strictEqual(c.p.remoteHoldMs, 77);
});

test('1. manual / off / solo / fallback outputs', () => {
  const s = makeSim();
  s.warm();
  const chk = (o, state, gain, muted) => {
    assert.strictEqual(o.state, state);
    assert.strictEqual(o.gain, gain);
    assert.strictEqual(o.tabMuted, muted);
  };
  s.mode = 'off'; chk(s.run(100), 'off', 1, false);
  s.mode = 'hub'; chk(s.run(100), 'manual', 1, false);
  s.mode = 'member'; chk(s.run(100), 'manual', 0, true);
  s.mode = 'auto'; s.roomSize = 1; chk(s.run(100), 'solo', 1, false);
  s.roomSize = 3; s.connected = false; s.everConnected = true; s.isHub = true; chk(s.run(100), 'fallback', 1, false);
  s.isHub = false; chk(s.run(100), 'fallback', 0, true);
  s.everConnected = false; s.isHub = true; chk(s.run(100), 'fallback', 0, true);
  s.connected = true; s.everConnected = true; s.isHub = false;
  assert.strictEqual(s.run(100).state, 'idle');
});

test('2. near talker wins the share; silence shares equally with idle duck', () => {
  const s = makeSim(null, { peers: { a: { db: SIL, speaking: false }, b: { db: SIL, speaking: false } } });
  s.warm();
  let o = s.run(200);
  assert.strictEqual(o.state, 'idle');
  assert.ok(Math.abs(o.gain - (1 / 3) * Math.pow(10, -12 / 20)) < 1e-6, `idle gain ${o.gain}`);
  s.selfDb = -20; s.peers.a.db = -28; s.peers.b.db = -28;
  o = s.run(300);
  assert.strictEqual(o.state, 'room');
  assert.ok(o.gain > 0.7, `gain ${o.gain}`);
  assert.ok(o.gain <= 1);
  assert.strictEqual(o.amp, amp(-20));
});

test('3. VAD onset, hold, release timing', () => {
  const s = makeSim();
  s.warm();
  s.selfDb = -30;
  assert.strictEqual(s.tick().speaking, true, 'onset on first loud tick');
  s.run(1000);
  s.selfDb = SIL;
  const ms = s.until((o) => !o.speaking, 1000);
  assert.ok(ms >= 300 && ms <= 300 + 2 * TICK, `release after ${ms}ms`);
  // short dip inside hold does not release
  s.selfDb = -30; s.run(200);
  s.selfDb = SIL; s.run(200);
  s.selfDb = -30;
  assert.strictEqual(s.run(200).speaking, true);
});

test('3b. floor adapts to steady noise', () => {
  const s = makeSim(null, { selfDb: -45 });
  s.run(4000);
  assert.strictEqual(s.out.speaking, false);
  assert.ok(Math.abs(s.out.debug.floorDb - -45) < 2, `floor ${s.out.debug.floorDb}`);
  s.selfDb = -30;
  assert.strictEqual(s.run(200).speaking, true);
});

test('4. remote alone: state remote, gains 0, hub unmuted, returns to idle after hold', () => {
  const s = makeSim(null, { peers: { a: { db: SIL, speaking: false } } });
  s.warm();
  s.sources.R = -30;
  const ms = s.until((o) => o.state === 'remote', 1000);
  assert.ok(ms > 0 && ms <= DEFAULTS.remoteOnIdleMs + 3 * TICK, `remote after ${ms}ms`);
  s.run(300, (o) => {
    assert.strictEqual(o.state, 'remote');
    assert.strictEqual(o.gain, 0);
    assert.strictEqual(o.tabMuted, false);
    assert.strictEqual(o.remoteActive, true);
  });
  delete s.sources.R;
  const back = s.until((o) => o.state === 'idle', 2000);
  assert.ok(back >= DEFAULTS.remoteHoldMs && back <= DEFAULTS.remoteHoldMs + 3 * TICK, `idle after ${back}ms`);
  assert.ok(s.out.gain > 0);
});

test('5. in-room CSRC never becomes remote nor gates the room (60 s alternating talk)', () => {
  const s = makeSim(null, { peers: { p1: { db: SIL, speaking: false }, p2: { db: SIL, speaking: false } } });
  s.warm();
  let csrcOffAt = -1, sawRemote = false, roomTicks = 0, gatedInRoom = 0, everRemoteCls = false;
  // each peer talks 3 s, 1 s gap; the CSRC (their voice heard back through Meet) lags 150 ms
  // and only exists while a peer is speaking.
  const t0 = s.t;
  let lastSpeakT = -1e9;
  for (let i = 0; s.t - t0 < 60000; i++) {
    const phase = Math.floor((s.t - t0) / 4000);
    const within = (s.t - t0) % 4000;
    const talker = phase % 2 === 0 ? 'p1' : 'p2';
    const talking = within < 3000;
    s.peers.p1.db = SIL; s.peers.p2.db = SIL; s.peers.p1.speaking = false; s.peers.p2.speaking = false;
    if (talking) { s.peers[talker].db = -25; s.peers[talker].speaking = true; lastSpeakT = s.t; }
    if (s.t - lastSpeakT <= 150) s.sources.C = -30; else delete s.sources.C;
    const o = s.tick();
    if (o.state === 'remote') sawRemote = true;
    if (o.remoteActive) sawRemote = true;
    if (o.debug.sources.C === 'remote') everRemoteCls = true;
    if (talking && within > 600) { roomTicks++; if (o.gain === 0 || o.state !== 'room') gatedInRoom++; }
  }
  assert.strictEqual(sawRemote, false);
  assert.strictEqual(everRemoteCls, false);
  assert.ok(roomTicks > 1000);
  assert.strictEqual(gatedInRoom, 0);
  assert.strictEqual(s.c.sources.get('C').cls, 'room');
});

test('6. interrupt: learned remote CSRC during room talk -> remote after ~remoteOnMs, remote-detect emitted', () => {
  const s = makeSim(null, { peers: { p1: { db: SIL, speaking: false } } });
  s.warm();
  // teach: remote alone for 1.5 s
  s.sources.R = -30; s.run(1500);
  delete s.sources.R; s.run(2000);
  assert.strictEqual(s.out.state, 'idle');
  s.events.length = 0;
  // room talking
  s.peers.p1.db = -25; s.peers.p1.speaking = true;
  s.run(1500);
  assert.strictEqual(s.out.state, 'room');
  assert.strictEqual(s.out.tabMuted, true);
  s.sources.R = -30;
  const ms = s.until((o) => o.state === 'remote', 1000);
  assert.ok(ms >= DEFAULTS.remoteOnMs - TICK && ms <= DEFAULTS.remoteOnMs + 3 * TICK, `interrupt after ${ms}ms`);
  assert.strictEqual(s.out.gain, 0);
  assert.strictEqual(s.out.tabMuted, false);
  const rd = s.events.find((e) => e.type === 'remote-detect');
  assert.ok(rd, 'remote-detect event');
  assert.ok(rd.ms >= DEFAULTS.remoteOnMs && rd.ms <= DEFAULTS.remoteOnMs + 2 * TICK, `ms ${rd.ms}`);
  assert.ok(s.events.some((e) => e.type === 'state' && e.from === 'room' && e.to === 'remote'));
});

test('7. leak guard: hub-speaker leak does not set speaking; real talker does', () => {
  const s = makeSim();
  s.warm();
  // control: without a remote source, -35 dBFS is speech
  s.selfDb = -35;
  assert.strictEqual(s.tick().speaking, true);
  s.selfDb = SIL; s.run(1500);
  assert.strictEqual(s.out.speaking, false);

  s.sources.R = -30;
  s.selfDb = -35;
  let spoke = false;
  s.run(6000, (o) => { if (o.speaking) spoke = true; });
  assert.strictEqual(spoke, false, 'leak must not be speaking');
  assert.ok(Math.abs(s.out.debug.leakDb - -35) < 1.5, `leakDb ${s.out.debug.leakDb}`);
  s.selfDb = -15;
  assert.strictEqual(s.tick().speaking, true);
  // real talker stays "speaking" for a few seconds (leak estimate must not chase speech)
  let dropped = 0;
  s.run(4000, (o) => { if (!o.speaking) dropped++; });
  assert.strictEqual(dropped, 0);
});

test('8. unidentified mode: no interrupts while the room is talking; remote when room silent', () => {
  const s = makeSim(null, { identified: false, peers: { p1: { db: SIL, speaking: false } } });
  s.warm();
  s.peers.p1.db = -25; s.peers.p1.speaking = true;
  s.sources.S = -30;
  s.run(5000, (o) => { assert.notStrictEqual(o.state, 'remote'); assert.strictEqual(o.remoteActive, false); });
  s.peers.p1.db = SIL; s.peers.p1.speaking = false;
  const ms = s.until((o) => o.state === 'remote', 3000);
  assert.ok(ms >= DEFAULTS.csrcLookbackMs, `remote after ${ms}ms`);
  assert.ok(ms <= DEFAULTS.csrcLookbackMs + DEFAULTS.remoteOnIdleMs + 500 + 4 * TICK, `remote after ${ms}ms`);
});

test('9. tabMuted: hub muted only in room; non-hub always muted in auto', () => {
  for (const isHub of [true, false]) {
    const s = makeSim(null, { isHub, peers: { p1: { db: SIL, speaking: false } } });
    s.warm();
    assert.strictEqual(s.out.state, 'idle');
    assert.strictEqual(s.out.tabMuted, isHub ? false : true);
    s.peers.p1.db = -25; s.peers.p1.speaking = true;
    s.run(200);
    assert.strictEqual(s.out.state, 'room');
    assert.strictEqual(s.out.tabMuted, true);
    assert.strictEqual(s.out.trigger, isHub ? 'p1' : null);
    s.peers.p1.db = SIL; s.peers.p1.speaking = false;
    s.run(1000);
    assert.strictEqual(s.out.state, 'idle');
    assert.strictEqual(s.out.tabMuted, isHub ? false : true);
    assert.strictEqual(s.out.trigger, null);
    s.sources.R = -30; s.run(400);
    assert.strictEqual(s.out.state, 'remote');
    assert.strictEqual(s.out.tabMuted, isHub ? false : true);
  }
  // self trigger
  const s = makeSim();
  s.warm(); s.selfDb = -25; s.run(100);
  assert.strictEqual(s.out.trigger, 'self');
});

test('10. stale peers are ignored; NaN inputs never yield NaN', () => {
  const s = makeSim(null, { peers: { loud: { db: -10, speaking: true, ageMs: 2000 } } });
  s.warm();
  assert.strictEqual(s.out.state, 'idle', 'stale speaking peer ignored');
  s.selfDb = -30; s.run(200);
  assert.strictEqual(s.out.gain, 1, 'stale peer has no weight');
  s.peers.loud.ageMs = 100;
  assert.ok(s.tick().gain < 0.1, 'fresh loud peer takes the share');

  const c = new Controller();
  const bad = NaN;
  for (let i = 0; i < 100; i++) {
    const o = c.step({
      now: i % 2 ? bad : 1000 + i * 21, selfAmp: bad, participating: true, mode: 'auto', connected: true,
      everConnected: true, isHub: true, roomSize: bad,
      peers: [{ id: 'x', amp: bad, speaking: true, ageMs: bad }, { id: 'y', amp: undefined, ageMs: 10 }, null],
      remote: { identified: true, sources: [{ id: 'r', level: bad, ageMs: bad }, { id: 'q', level: undefined, ageMs: 0 }] },
    });
    for (const v of [o.gain, o.amp, o.debug.floorDb, o.debug.selfDb, o.debug.remoteDb]) assert.ok(Number.isFinite(v), `non-finite ${v}`);
    assert.ok(!Number.isNaN(o.debug.leakDb));
    assert.ok(o.gain >= 0 && o.gain <= 1);
  }
  const o2 = c.step({});
  assert.ok(Number.isFinite(o2.gain));
  assert.strictEqual(o2.state, 'fallback');
  // all peers silent (sum of weights ~ 0) -> 1/n
  const s2 = makeSim(null, { selfDb: -120, peers: { a: { db: -120, speaking: false }, b: { db: -120, speaking: false } } });
  s2.mode = 'auto';
  const o3 = s2.run(100);
  assert.ok(Math.abs(o3.gain - Math.pow(10, -12 / 20) / 3) < 1e-6);
  // not participating
  s2.participating = false; s2.selfDb = -20;
  const o4 = s2.run(100);
  assert.strictEqual(o4.gain, 0);
  assert.strictEqual(o4.amp, 0);
  assert.strictEqual(o4.speaking, false);
});

test('11. onset: self gets the floor on the first speaking tick even if peers just reported low amps', () => {
  const s = makeSim(null, { peers: { a: { db: -50, speaking: false, ageMs: 40 }, b: { db: -48, speaking: false, ageMs: 40 } } });
  s.warm();
  s.selfDb = -25;
  const o = s.tick();
  assert.strictEqual(o.speaking, true);
  assert.ok(o.gain > 0.8, `gain ${o.gain}`);
  assert.strictEqual(o.state, 'room');
});

test('forgets sources unseen for 60 s', () => {
  const s = makeSim();
  s.warm();
  s.sources.R = -30; s.run(1000);
  delete s.sources.R; s.run(62000);
  assert.strictEqual(s.c.sources.size, 0);
});

// ---- Integration-review fixes ----
{
  const { test: t2 } = require('node:test');
  const assert2 = require('node:assert');
  const { Controller } = require('../extension/page/policy.js');
  const base = (now, extra) => Object.assign({
    now, selfAmp: 0.001, participating: true, mode: 'auto', connected: true, everConnected: true,
    isHub: true, roomSize: 3, peers: [], remote: { identified: true, sources: [] },
  }, extra);

  t2('manual member broadcasts no level and no speech', () => {
    const c = new Controller();
    let out;
    for (let now = 0; now < 3000; now += 21) {
      out = c.step(base(now, { mode: 'member', selfAmp: now > 1500 ? 0.3 : 0.001 }));
    }
    assert2.strictEqual(out.amp, 0);
    assert2.strictEqual(out.speaking, false);
    assert2.strictEqual(out.gain, 0);
  });

  t2('learned in-room CSRC does not gate a silent room after the talker stops', () => {
    const c = new Controller();
    let now = 0, out;
    // Peer talks for 3 s; its CSRC is active (learned as room).
    for (; now < 3000; now += 21) {
      out = c.step(base(now, {
        peers: [{ id: 'p1', amp: 0.2, speaking: now > 1100, ageMs: 10 }],
        remote: { identified: true, sources: now > 1100 ? [{ id: 'cX', level: 0.3, ageMs: 5 }] : [] },
      }));
    }
    assert2.strictEqual(out.debug.sources.cX, 'room');
    // Peer stops; its CSRC echo lingers 1.5 s (longer than the lookback).
    const states = new Set();
    for (; now < 6000; now += 21) {
      out = c.step(base(now, {
        peers: [{ id: 'p1', amp: 0.001, speaking: false, ageMs: 10 }],
        remote: { identified: true, sources: now < 4500 ? [{ id: 'cX', level: 0.3, ageMs: 5 }] : [] },
      }));
      states.add(out.state);
    }
    assert2.ok(!states.has('remote'), 'room echo must never trigger remote: ' + [...states]);
  });
}
