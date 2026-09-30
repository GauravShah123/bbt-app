/*
 * policy.js - pure decision logic for Hybrid Audio (Contract 1 in docs/ARCHITECTURE.md).
 * VAD, distributed gain sharing, floor state machine, CSRC classifier.
 * No DOM / WebAudio. Runs in MAIN world (sets globalThis.__hybridAudio.policy) and Node (module.exports).
 */
(function () {
  'use strict';

  var DEFAULTS = Object.freeze({
    vadOnsetDb: 9, vadReleaseDb: 5, vadHoldMs: 300,
    floorInitDb: -60, floorMinDb: -90, floorRiseDbPerSec: 1.0,
    shareExponent: 2, idleDuckDb: -12,
    remoteOnDb: -50,
    remoteOnIdleMs: 60, remoteOnMs: 300, remoteHoldMs: 500, roomHoldMs: 500,
    remoteFreshMs: 300, peerStaleMs: 1500,
    leakMarginDb: 10, leakTauMs: 2000,
    csrcEvidence: 10, csrcLookbackMs: 800,
  });

  var FLOOR_FALL_TAU_MS = 200;
  var FLOOR_WARMUP_MS = 1000;     // initial calibration: floor tracks the mic both ways, no onset
  var FLOOR_SPEAKING_RISE = 0.25; // fraction of floorRiseDbPerSec while speaking (escape hatch for steady noise)
  var SOURCE_FORGET_MS = 60000;
  var SWEEP_MS = 1000;
  var DB_MIN = -180;
  var EMPTY = Object.freeze([]);

  function num(v, d) { return (typeof v === 'number' && v - v === 0) ? v : d; }
  function toDb(a) { return 20 * Math.log10(a > 1e-9 ? a : 1e-9); }

  function mergeParams(target, src) {
    if (!src) return target;
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k) && typeof src[k] === 'number' && src[k] - src[k] === 0) {
        target[k] = src[k];
      }
    }
    return target;
  }

  function Controller(overrides) {
    this.p = mergeParams(mergeParams({}, DEFAULTS), overrides);
    this.lastNow = null;
    this.warmStart = -1;
    // VAD
    this.floorDb = this.p.floorInitDb;
    this.speaking = false;
    this.belowSince = -1;
    this.leakDb = -Infinity;
    // room / remote tracking
    this.lastRoomSpeechAt = -Infinity;
    this.sources = new Map();
    this.cur = [];
    this.lastSweep = 0;
    this.dbgSources = {};
    // FSM
    this.state = 'idle';
    this.rvSince = -1; this.rvOffSince = -1; this.rsOffSince = -1;
    this.trigger = null;
  }

  Controller.prototype.setParams = function (partial) {
    mergeParams(this.p, partial);
  };

  Controller.prototype.step = function (input) {
    var P = this.p;
    var inp = input || {};

    // ---- time ----
    var now = num(inp.now, NaN);
    if (now !== now) now = this.lastNow === null ? 0 : this.lastNow + 21;
    var dt = this.lastNow === null ? 21 : now - this.lastNow;
    if (dt < 0) dt = 0; else if (dt > 1000) dt = 1000;
    this.lastNow = now;

    var mode = inp.mode;
    var participating = inp.participating === undefined ? true : !!inp.participating;
    var selfAmp = participating ? Math.max(0, num(inp.selfAmp, 0)) : 0;
    var selfDb = toDb(selfAmp);
    var beta = P.shareExponent;

    // ---- peers ----
    var peers = Array.isArray(inp.peers) ? inp.peers : EMPTY;
    var peerSpeaking = false, firstSpeakerId = null, wPeers = 0, nPeers = 0;
    for (var i = 0; i < peers.length; i++) {
      var pe = peers[i];
      if (!pe) continue;
      if (num(pe.ageMs, Infinity) > P.peerStaleMs) continue;
      var pa = Math.max(0, num(pe.amp, 0));
      nPeers++;
      wPeers += Math.pow(pa, beta);
      if (pe.speaking === true && !peerSpeaking) { peerSpeaking = true; firstSpeakerId = pe.id; }
    }

    // ---- remote sources: per-tick activity ----
    var rem = inp.remote || {};
    var identified = rem.identified === true;
    var srcs = Array.isArray(rem.sources) ? rem.sources : EMPTY;
    var cur = this.cur; cur.length = 0;
    var remoteDb = DB_MIN, anyActive = false, leakActive = false;
    var roomSilentLong = now - this.lastRoomSpeechAt >= P.csrcLookbackMs; // previous-tick view
    for (var j = 0; j < srcs.length; j++) {
      var s = srcs[j];
      if (!s) continue;
      var st = this.sources.get(s.id);
      if (!st) { st = { re: 0, ro: 0, seen: now, cls: 'unknown', active: false, id: s.id }; this.sources.set(s.id, st); }
      st.seen = now;
      var fresh = num(s.ageMs, Infinity) <= P.remoteFreshMs;
      var ldb = toDb(Math.max(0, num(s.level, 0)));
      if (fresh && ldb > remoteDb) remoteDb = ldb;
      st.active = fresh && ldb > P.remoteOnDb;
      if (st.active && !(identified && st.cls === 'room')) {
        // Sources already learned as in-room never count as remote voice or leak.
        anyActive = true;
        leakActive = true;
      }
      cur.push(st);
    }

    // ---- VAD ----
    var floor = this.floorDb;
    var wasSpeaking = this.speaking;
    if (participating) {
      if (this.warmStart < 0) this.warmStart = now;
      var warm = now - this.warmStart < FLOOR_WARMUP_MS;
      if (warm || selfDb < floor) {
        floor += (selfDb - floor) * (1 - Math.exp(-dt / FLOOR_FALL_TAU_MS));
      } else {
        var rise = P.floorRiseDbPerSec * dt / 1000 * (wasSpeaking ? FLOOR_SPEAKING_RISE : 1);
        floor += rise;
        if (floor > selfDb) floor = selfDb;
      }
      if (floor < P.floorMinDb) floor = P.floorMinDb; else if (floor > 0) floor = 0;
      this.floorDb = floor;

      // leak EMA: learn Hub-speaker pickup only while remote audio plays into a silent room
      if (leakActive && !wasSpeaking && roomSilentLong) {
        if (this.leakDb === -Infinity) this.leakDb = selfDb;
        else this.leakDb += (selfDb - this.leakDb) * (1 - Math.exp(-dt / P.leakTauMs));
      }

      if (wasSpeaking) {
        if (selfDb < floor + P.vadReleaseDb) {
          if (this.belowSince < 0) this.belowSince = now;
          if (now - this.belowSince >= P.vadHoldMs) { this.speaking = false; this.belowSince = -1; }
        } else {
          this.belowSince = -1;
        }
      } else if (!warm && selfDb > floor + P.vadOnsetDb &&
                 (!leakActive || selfDb > (this.leakDb === -Infinity ? floor : this.leakDb) + P.leakMarginDb)) {
        this.speaking = true; this.belowSince = -1;
      }
    } else {
      this.speaking = false; this.belowSince = -1;
    }
    var selfSpeaking = this.speaking;

    // ---- in-room speech ----
    var rs = selfSpeaking || peerSpeaking;
    if (rs) this.lastRoomSpeechAt = now;
    var roomRecent = now - this.lastRoomSpeechAt < P.csrcLookbackMs;

    // ---- CSRC classifier ----
    var rv = false;
    var dbg = this.dbgSources;
    for (var k in dbg) delete dbg[k];
    for (var m = 0; m < cur.length; m++) {
      var c = cur[m];
      if (c.active) {
        if (roomRecent) c.ro++; else c.re++;
      }
      var cls = 'unknown';
      // 'room' is sticky: leaving it needs a majority of remote evidence, so in-room audio
      // that lingers in Meet after the talker stops can never gate the room.
      if (c.cls === 'room' && c.re <= c.ro) cls = 'room';
      else if (c.re >= P.csrcEvidence) cls = (c.ro > 5 * c.re) ? 'unknown' : 'remote';
      else if (c.ro >= 3 * P.csrcEvidence && c.re === 0) cls = 'room';
      c.cls = cls;
      dbg[c.id] = identified ? cls : 'unknown';
      if (c.active && identified && cls === 'remote') rv = true;
    }
    if (anyActive && !roomRecent) rv = true; // anyActive already excludes learned in-room sources

    if (now - this.lastSweep >= SWEEP_MS) {
      this.lastSweep = now;
      var self = this;
      this.sources.forEach(function (v, key) { if (now - v.seen > SOURCE_FORGET_MS) self.sources.delete(key); });
    }

    // ---- timers (always warm) ----
    if (rv) { if (this.rvSince < 0) this.rvSince = now; this.rvOffSince = -1; }
    else { this.rvSince = -1; if (this.rvOffSince < 0) this.rvOffSince = now; }
    if (rs) this.rsOffSince = -1; else if (this.rsOffSince < 0) this.rsOffSince = now;

    // ---- mode resolution ----
    var events = EMPTY;
    var out_state, gain, tabMuted;
    var isHub = inp.isHub === true;
    var fsm = false;

    if (mode === 'off') { out_state = 'off'; gain = 1; tabMuted = false; }
    else if (mode === 'hub') { out_state = 'manual'; gain = 1; tabMuted = false; }
    else if (mode === 'member') { out_state = 'manual'; gain = 0; tabMuted = true; }
    else if (!inp.connected) {
      out_state = 'fallback';
      if (inp.everConnected && isHub) { gain = 1; tabMuted = false; } else { gain = 0; tabMuted = true; }
    } else if (num(inp.roomSize, 0) <= 1) { out_state = 'solo'; gain = 1; tabMuted = false; }
    else fsm = true;

    if (!fsm) {
      this.state = 'idle'; this.trigger = null;
    } else {
      var from = this.state, to = from;
      if (from === 'idle') {
        if (rv && now - this.rvSince >= P.remoteOnIdleMs) to = 'remote';
        else if (rs) to = 'room';
      } else if (from === 'room') {
        if (rv && now - this.rvSince >= P.remoteOnMs) to = 'remote';
        else if (!rs && this.rsOffSince >= 0 && now - this.rsOffSince >= P.roomHoldMs) to = 'idle';
      } else { // remote
        if (!rv && this.rvOffSince >= 0 && now - this.rvOffSince >= P.remoteHoldMs) to = rs ? 'room' : 'idle';
      }
      if (to !== from) {
        this.state = to;
        events = [{ type: 'state', from: from, to: to, at: now }];
        if (to === 'remote') events.push({ type: 'remote-detect', ms: now - this.rvSince, at: now });
        if (to === 'room') this.trigger = peerSpeaking ? firstSpeakerId : (selfSpeaking ? 'self' : null);
        else this.trigger = null;
      }
      out_state = this.state;
      if (out_state === 'remote' || !participating) gain = 0;
      else {
        var wSelf = Math.pow(selfAmp, beta);
        var tot = wSelf + wPeers;
        gain = tot > 1e-14 ? wSelf / tot : 1 / (1 + nPeers);
        if (out_state === 'idle') gain *= Math.pow(10, P.idleDuckDb / 20);
      }
      tabMuted = isHub ? out_state === 'room' : true;
    }
    if (!(gain >= 0)) gain = 0; else if (gain > 1) gain = 1;

    return {
      state: out_state,
      gain: gain,
      tabMuted: tabMuted,
      // A manual Member transmits nothing, so it must not claim a share or trigger room state.
      speaking: mode === 'member' ? false : selfSpeaking,
      amp: (participating && mode !== 'member') ? selfAmp : 0,
      remoteActive: rv,
      trigger: (fsm && isHub && out_state === 'room') ? this.trigger : null,
      events: events,
      debug: {
        floorDb: this.floorDb,
        leakDb: this.leakDb,
        selfDb: selfDb,
        remoteDb: remoteDb,
        sources: dbg, // reused object; copy if you need to retain it
      },
    };
  };

  var api = { DEFAULTS: DEFAULTS, Controller: Controller };

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    var g = globalThis;
    if (!g.__hybridAudio) {
      Object.defineProperty(g, '__hybridAudio', { value: {}, enumerable: false, configurable: true, writable: true });
    }
    g.__hybridAudio.policy = api;
  }
})();
