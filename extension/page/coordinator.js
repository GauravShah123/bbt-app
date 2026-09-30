/* Hybrid Audio coordinator: pure Hub FSM (Coordinator) + MemberAgent. See docs/ARCHITECTURE.md section 6.
 * No DOM, WebAudio, timers or Date. Time comes only from the `now` arguments (ms, one clock).
 * Level timestamps (`at`) must be on the same clock as tick(now). */
(function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    switchAdvantageDb: 6, switchSustainMs: 100, minOwnMs: 300, idleTakeoverMs: 60,
    levelFreshMs: 400, minSpeechDb: -55,
    remoteOnDb: -50, remoteOnMs: 40, remoteHoldMs: 300, remoteFreshMs: 150,
    settleMs: 150, ackTimeoutMs: 1000, handoffOverlap: 1,
    learnTicks: 15, enrollTicks: 3, learnSettleMs: 600,
    hbIntervalMs: 500, watchdogMs: 1500,
    verifyLatencyMs: 1000, newOwnerWindowMs: 3000, verifyWindowMs: 2000,
  });
  const RESEND_MS = 250;
  const SOUNDCHECK_MS = 8000;
  const PAUSE_KEY = {};
  const NONE = Object.freeze({ fresh: false, bad: false, usable: false, score: -Infinity });
  const FREEZE_STATES = { REMOTE_PENDING: 1, REMOTE: 1, SETTLING: 1, SOUNDCHECK: 1 };
  const HB_FREEZE = { REMOTE_PENDING: 1, REMOTE: 1, SETTLING: 1 };

  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const hasId = (id) => id !== undefined && id !== null;
  function cleanParams(target, partial) {
    if (!partial || typeof partial !== 'object') return;
    for (const k in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(partial, k)) continue;
      let v = partial[k];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (typeof v === 'number' && isFinite(v)) target[k] = v;
    }
  }

  class Coordinator {
    constructor(opts) {
      opts = opts || {};
      this.selfId = hasId(opts.selfId) ? opts.selfId : 'self';
      this.p = Object.assign({}, DEFAULTS);
      cleanParams(this.p, opts.params);
      this.state = 'ROOM';
      this.owner = this.selfId;
      this.ownerSince = null;
      this.stSince = null;
      this.relayUp = true;
      this.roster = new Map();            // other members: id -> {ready, n}
      this.lv = new Map();                // id -> level record
      this.gate = new Map([[this.selfId, 0]]); // 0 closed | 1 open or possibly open
      this.pend = new Map();              // id -> {gen, op, at, last}
      this.gen = 0;
      this.ackedAt = new Map();
      this.closedAt = new Map();          // id -> time its gate close was confirmed
      this.remTrig = null;                // remote turn triggered while a new member owner was talking
      this.lost = new Set();
      this.roomOf = new Map();            // csrc -> member id
      this.remoteIds = new Set();
      this.cnt = new Map();               // csrc -> {kind, n}
      this.ev = [];
      this.cmds = [];
      this.sw = null;
      this.pause = null;
      this.chal = null;
      this.remSince = null;
      this.lastRemAct = -Infinity;
      this.remOnset = 0;
      this.sc = null;
      this.hoWait = false;
      this.identified = false;
      this.inited = false;
      this._now = 0;
      this._lastList = [];
    }

    setParams(partial) { cleanParams(this.p, partial); }

    // ---- inputs ----
    onRoster(list) {
      if (!Array.isArray(list)) return;
      this._lastList = list;
      const seen = new Set();
      let resume = false;
      for (const e of list) {
        if (!e || !hasId(e.id)) continue;
        seen.add(e.id);
        if (e.id === this.selfId) continue;
        if (this.lost.has(e.id)) {
          // A lost laptop came back. `ready` means its gate is confirmed closed (fresh page or
          // watchdog-closed), so the uncertainty that caused the pause is resolved.
          if (!e.ready) continue;
          this.lost.delete(e.id);
          this.ev.push({ type: 'recovered', id: e.id });
          if (this.state === 'PAUSED' && this.pause && this.pause.reason === 'ownerLost' &&
              this.lost.size === 0 && this.relayUp) resume = true;
        }
        const r = this.roster.get(e.id);
        if (r) { r.ready = !!e.ready; r.n = num(e.n, r.n); }
        else { this.roster.set(e.id, { ready: !!e.ready, n: num(e.n, 0) }); this.gate.set(e.id, 0); this.closedAt.set(e.id, this._now); }
      }
      for (const id of Array.from(this.roster.keys())) if (!seen.has(id)) this.onLost(id);
      if (resume) this._toSettling(null);
    }

    onLevel(id, m) {
      if (!hasId(id) || !m || typeof m !== 'object') return;
      let l = this.lv.get(id);
      if (!l) { if (this.lv.size >= 32) return; l = {}; this.lv.set(id, l); }
      l.levelDb = num(m.levelDb, -120);
      l.noiseDb = num(m.noiseDb, l.levelDb);
      l.act = !!m.act;
      l.healthy = m.healthy !== false && m.healthy !== 0;
      l.userMuted = !!m.userMuted;
      l.at = num(m.at, this._now);
    }

    onApplied(id, gen, gate) {
      const pd = this.pend.get(id);
      if (!pd || pd.gen !== gen) return;           // stale or unknown ack
      const want = pd.op === 'open' ? 1 : 0;
      let g = gate === 1 || gate === true ? 1 : gate === 0 || gate === false ? 0 : want;
      if (g !== want) return;                      // member did not reach the wanted state: keep retrying
      this.pend.delete(id);
      this.gate.set(id, g);
      this.ackedAt.set(id, this._now);
      if (g === 0) this.closedAt.set(id, this._now);
    }

    onLeft(id) {
      if (!hasId(id) || id === this.selfId) return;
      const sw = this.sw;
      this._drop(id);
      this.lost.delete(id);
      if (this.owner === id) this.owner = null;
      if (this.state === 'SWITCHING' && sw) {
        if (sw.to === id) {
          const f = sw.from;
          this.sw = null;
          this.owner = (f !== null && this._known(f) && this.gate.get(f) === 1 && !this.pend.has(f)) ? f : null;
          this._setState('ROOM', null);
        } else if (sw.from === id) sw.from = null;
      }
    }

    onLost(id) {
      if (!hasId(id) || id === this.selfId || !this.roster.has(id)) return;
      const open = this.gate.get(id) !== 0 || this.pend.has(id);
      const st = this.state;
      this._drop(id);
      if (!open || st === 'HUB_ONLY') return;
      this.lost.add(id);
      if (this.owner === id) this.owner = null;
      if (st === 'PAUSED') {
        if (this.pause && this.pause.reason !== 'relay') this.pause = { reason: 'ownerLost', id };
        return;
      }
      this._pause('ownerLost', id, null);
    }

    onRelay(up) {
      up = !!up;
      if (up === this.relayUp) return;
      this.relayUp = up;
      if (!up) {
        // members' watchdogs close their gates; nothing reachable but self
        for (const id of this.roster.keys()) { this.gate.set(id, 0); this.pend.delete(id); }
        const st = this.state;
        if (st !== 'SOLO' && st !== 'HUB_ONLY' && st !== 'PAUSED') this._pause('relay', undefined, null);
      } else if (this.state === 'PAUSED' && this.pause && this.pause.reason === 'relay') {
        this._toSettling(null);
      }
    }

    action(name, arg) {
      const st = this.state;
      switch (name) {
        case 'hubOnly': this._enterHubOnly(null); break;
        case 'resume':
          if ((st === 'PAUSED' && this.relayUp) || st === 'HUB_ONLY') this._toSettling(null);
          break;
        case 'dropLost': {
          const id = arg !== undefined ? arg : (this.pause ? this.pause.id : undefined);
          if (hasId(id)) { this.lost.delete(id); this._drop(id); if (this.owner === id) this.owner = null; }
          else this.lost.clear();
          this.onRoster(this._lastList);
          if (st === 'PAUSED' && this.relayUp) this._toSettling(null);
          break;
        }
        case 'soundCheck':
          if (st === 'ROOM' || st === 'SOLO' || st === 'HUB_ONLY') {
            this.sw = null; this.chal = null; this.hoWait = false; this.cnt.clear();
            this.sc = { phase: 'closing', since: null };
            this._setState('SOUNDCHECK', null);
            this._closeAll(null);
          }
          break;
        case 'continueSolo':
          if (this.roster.size === 0) this._enterSolo(null);
          else if (st === 'PAUSED' && this.relayUp) { this.lost.clear(); this._toSettling(null); }
          break;
        case 'resetIds': this.roomOf.clear(); this.remoteIds.clear(); this.cnt.clear(); break;
        default: break;
      }
    }

    // ---- tick ----
    tick(now, remote) {
      now = num(now, this._now);
      this._now = now;
      if (this.stSince === null) this.stSince = now;
      if (this.ownerSince === null) this.ownerSince = now;
      if (this.sc && this.sc.since === null && this.sc.phase === 'listening') this.sc.since = now;
      if (!this.inited) { this.inited = true; this._ensureOpen(this.selfId); }
      this._service(now);

      const p = this.p;
      let ra = false, unk = null, raIds = null;
      const srcs = remote && remote.sources;
      this.identified = !!(remote && remote.identified);
      if (Array.isArray(srcs)) {
        for (let i = 0; i < srcs.length; i++) {
          const s = srcs[i];
          if (!s || !hasId(s.id)) continue;
          if (!(num(s.ageMs, Infinity) <= p.remoteFreshMs)) continue;
          const lvl = num(s.level, 0);
          const db = lvl > 0 ? 20 * Math.log10(lvl) : -Infinity;
          if (!(db > p.remoteOnDb)) continue;
          if (this.remoteIds.has(s.id)) { ra = true; (raIds || (raIds = [])).push(s.id); }
          else if (this.roomOf.has(s.id)) this._verifyRoom(s.id, now);
          else (unk || (unk = [])).push(s.id);
        }
      }
      if (ra) { if (this.remSince === null) this.remSince = now; this.lastRemAct = now; } else this.remSince = null;
      const sustained = this.remSince !== null && now - this.remSince >= p.remoteOnMs;

      let enrollable = false;
      switch (this.state) {
        case 'ROOM':
          if (this._soloCheck(now)) break;
          if (sustained) { this._toRemotePending(now, raIds); break; }
          if (this.owner === null) { this._beginSwitch(this._pickTarget(now), now); break; }
          this._select(now);
          enrollable = this.state === 'ROOM';
          break;
        case 'SWITCHING':
          if (sustained) { this._toRemotePending(now, raIds); break; }
          this._stepSwitch(now);
          break;
        case 'REMOTE_PENDING':
          if (this._allClosed()) {
            this.ev.push({ type: 'remote', ms: Math.max(0, now - this.remOnset) });
            this._setState('REMOTE', now);
          }
          break;
        case 'REMOTE':
          if (this._soloCheck(now)) break;
          if (!ra && now - this.lastRemAct >= p.remoteHoldMs) { this._verifyRemoteTurn(now); this._setState('SETTLING', now); }
          break;
        case 'SETTLING':
          if (this._soloCheck(now)) break;
          if (now - this.stSince >= p.settleMs) {
            const t = this._pickTarget(now);
            this._closeAll(t);
            this.owner = t;
            this.ownerSince = now;
            this.chal = null;
            this._ensureOpen(t);
            this._setState('ROOM', now);
          }
          break;
        case 'SOUNDCHECK': {
          const sc = this.sc;
          if (sc.phase === 'closing') {
            if (this._allClosed()) { sc.phase = 'listening'; sc.since = now; }
          } else {
            enrollable = true;
            if (now - sc.since >= SOUNDCHECK_MS) this._toSettling(now);
          }
          break;
        }
        case 'SOLO':
          for (const r of this.roster.values()) if (r.ready) { this._toSettling(now); break; }
          if (this.state === 'SOLO') enrollable = true;
          break;
        case 'HUB_ONLY':
          if (this.hoWait && this._membersClosed()) this.hoWait = false;
          break;
        default: break;
      }
      if (enrollable) this._enroll(now, unk);
      else if (this.cnt.size) this.cnt.clear();

      this._service(now);
      return this._out(now);
    }

    // ---- internals ----
    _known(id) { return id === this.selfId || this.roster.has(id); }
    _ids() { const a = [this.selfId]; for (const k of this.roster.keys()) a.push(k); return a; }
    _drop(id) {
      this.roster.delete(id); this.lv.delete(id); this.gate.delete(id);
      this.pend.delete(id); this.ackedAt.delete(id);
    }
    _setState(s, now) {
      if (s === this.state) return;
      this.ev.push({ type: 'state', from: this.state, to: s, at: now });
      this.state = s;
      this.stSince = now;
    }
    _send(id, op) {
      if (id !== this.selfId && !this.relayUp) return;
      this.pend.set(id, { gen: ++this.gen, op, at: null, last: null });
    }
    _ensureOpen(id) {
      const pd = this.pend.get(id);
      if (pd ? pd.op === 'open' : this.gate.get(id) === 1) return;
      this._send(id, 'open');
    }
    _closeAll(except) {
      for (const id of this._ids()) {
        if (id === except) continue;
        if (id !== this.selfId && !this.relayUp) continue;
        const pd = this.pend.get(id);
        if (pd && pd.op === 'close') continue;
        if (pd || this.gate.get(id) !== 0) this._send(id, 'close');
      }
    }
    _allClosed() {
      for (const id of this._ids()) if (this.gate.get(id) !== 0 || this.pend.has(id)) return false;
      return true;
    }
    _membersClosed() {
      for (const id of this.roster.keys()) if (this.gate.get(id) !== 0 || this.pend.has(id)) return false;
      return true;
    }
    _closedOrGone(id) { return !this._known(id) || (this.gate.get(id) === 0 && !this.pend.has(id)); }

    _service(now) {
      let to = null;
      for (const [id, pd] of this.pend) {
        if (pd.at === null) { pd.at = pd.last = now; this.cmds.push({ to: id, op: pd.op, gen: pd.gen }); continue; }
        if (now - pd.at >= this.p.ackTimeoutMs) { (to || (to = [])).push(id); continue; }
        if (now - pd.last >= RESEND_MS) { pd.last = now; this.cmds.push({ to: id, op: pd.op, gen: pd.gen }); }
      }
      if (to) {
        for (const id of to) {
          const pd = this.pend.get(id);
          if (!pd) continue;
          this.pend.delete(id);
          this._onTimeout(id, pd.op, now);
        }
      }
    }

    _onTimeout(id, op, now) {
      this.ev.push({ type: 'timeout', id, op, at: now });
      this.gate.set(id, 1);                        // unknown: assume it may be open
      const st = this.state;
      if (st === 'REMOTE_PENDING' || (st === 'SOUNDCHECK' && this.sc.phase === 'closing') ||
          (st === 'HUB_ONLY' && this.hoWait)) { this._pause('ackTimeout', id, now); return; }
      if (st === 'PAUSED' || st === 'REMOTE' || st === 'SOLO' || st === 'HUB_ONLY' || st === 'SOUNDCHECK') return;
      if (id === this.selfId) { this._pause('unhealthy', id, now); return; }
      this._drop(id);
      this.lost.add(id);
      if (this.owner === id) this.owner = null;
      this._pause('ownerLost', id, now);
    }

    _pause(reason, id, now) {
      this.sw = null; this.chal = null; this.sc = null; this.hoWait = false;
      this.pause = id === undefined ? { reason } : { reason, id };
      this._setState('PAUSED', now);
      this._closeAll(null);
    }

    _toSettling(now) {
      this.sw = null; this.pause = null; this.chal = null; this.sc = null; this.hoWait = false;
      this._setState('SETTLING', now);
    }

    _enterSolo(now) {
      this.owner = this.selfId; this.ownerSince = now;
      this.sw = null; this.chal = null; this.pause = null; this.sc = null; this.hoWait = false;
      this._ensureOpen(this.selfId);
      this._setState('SOLO', now);
    }

    _enterHubOnly(now) {
      this.owner = this.selfId; this.ownerSince = now;
      this.sw = null; this.chal = null; this.pause = null; this.sc = null;
      this.hoWait = true;
      this._closeAll(this.selfId);
      this._ensureOpen(this.selfId);
      this._setState('HUB_ONLY', now);
    }

    _soloCheck(now) {
      if (this.roster.size === 0 && this.lost.size === 0) { this._enterSolo(now); return true; }
      return false;
    }

    _toRemotePending(now, raIds) {
      this.remOnset = this.remSince !== null ? this.remSince : now;
      // If a member only just took the mic and is talking, this "remote" may really be that
      // member's own audio (its CSRC was mis-enrolled while it was in the Meet but not joined).
      // Remember it and verify when the remote turn ends (_verifyRemoteTurn).
      const o = this.owner, at = this.ackedAt.get(o);
      this.remTrig = null;
      if (o !== null && o !== this.selfId && raIds && at !== undefined && now - at <= this.p.newOwnerWindowMs &&
          this._info(o, now).usable) {
        this.remTrig = { owner: o, ids: raIds.slice(), at: now };
      }
      this.sw = null; this.chal = null;
      this._setState('REMOTE_PENDING', now);
      this._closeAll(null);
    }

    _info(id, now) {
      const l = this.lv.get(id);
      if (!l) return NONE;
      const fresh = now - l.at <= this.p.levelFreshMs;
      const bad = fresh && (!l.healthy || l.userMuted);
      return {
        fresh, bad,
        usable: fresh && !bad && l.act && l.levelDb > this.p.minSpeechDb,
        score: l.levelDb - l.noiseDb,
      };
    }

    _isCandidate(id, now) {
      if (id !== this.selfId) { const r = this.roster.get(id); if (!r || !r.ready) return false; }
      const inf = this._info(id, now);
      return inf.fresh && !inf.bad;
    }

    _pickTarget(now) {
      const prev = this.owner;
      if (prev !== null && this._isCandidate(prev, now)) return prev;
      let best = null, bs = -Infinity;
      for (const id of this._ids()) {
        if (!this._isCandidate(id, now)) continue;
        const s = this._info(id, now).score;
        if (best === null || s > bs) { best = id; bs = s; }
      }
      return best !== null ? best : this.selfId;
    }

    _select(now) {
      const p = this.p, owner = this.owner, self = this.selfId;
      const oi = this._info(owner, now);
      let bestU = null, bestUs = -Infinity, bestA = null, bestAs = -Infinity;
      for (const id of this._ids()) {
        if (id === owner) continue;
        if (id !== self && !this.roster.get(id).ready) continue;
        const inf = this._info(id, now);
        if (!inf.fresh || inf.bad) continue;
        if (inf.usable && inf.score > bestUs) { bestUs = inf.score; bestU = id; }
        if (inf.score > bestAs) { bestAs = inf.score; bestA = id; }
      }
      let target = null, need = p.switchSustainMs, idle = false, pauseIntent = false;
      if (oi.bad) {
        idle = true; need = p.idleTakeoverMs;
        target = bestU !== null ? bestU : bestA;
        if (target === null) {
          if (owner !== self && !this._info(self, now).bad) target = self;
          else pauseIntent = true;
        }
      } else if (!oi.usable) {
        idle = true; need = p.idleTakeoverMs; target = bestU;
      } else if (bestU !== null && bestUs - oi.score > p.switchAdvantageDb) target = bestU;

      if (target === null && !pauseIntent) { this.chal = null; return; }
      const key = pauseIntent ? PAUSE_KEY : target;
      if (!this.chal || this.chal.key !== key) this.chal = { key, since: now };
      if (now - this.chal.since < need) return;
      if (!idle && now - this.ownerSince < p.minOwnMs) return;
      if (pauseIntent) this._pause('unhealthy', self, now);
      else this._beginSwitch(target, now);
    }

    _beginSwitch(to, now) {
      const from = this.owner;
      const needClose = from !== null && from !== to && this._known(from) &&
        (this.gate.get(from) !== 0 || this.pend.has(from));
      this.sw = { from: needClose ? from : null, to, t0: now, phase: 'opening', fromId: from };
      this.owner = to; this.ownerSince = now; this.chal = null;
      this._setState('SWITCHING', now);
      if (!this.p.handoffOverlap && needClose) { this.sw.phase = 'closing'; this._send(from, 'close'); }
      else this._ensureOpen(to);
    }

    _stepSwitch(now) {
      const sw = this.sw, overlap = !!this.p.handoffOverlap;
      if (!sw) { this._setState('ROOM', now); return; }
      for (let i = 0; i < 2; i++) {
        let done = false;
        if (sw.phase === 'opening') {
          if (this.gate.get(sw.to) === 1 && !this.pend.has(sw.to)) {
            if (overlap && sw.from !== null && !this._closedOrGone(sw.from)) {
              const pd = this.pend.get(sw.from);
              if (!(pd && pd.op === 'close')) this._send(sw.from, 'close');
              sw.phase = 'closing';
            } else done = true;
          }
        } else if (this._closedOrGone(sw.from)) {
          if (overlap) done = true;
          else { this._ensureOpen(sw.to); sw.phase = 'opening'; }
        }
        if (done) {
          this.ev.push({ type: 'switch', from: sw.fromId, to: sw.to, ms: Math.max(0, now - sw.t0) });
          this.sw = null;
          this._setState('ROOM', now);
          return;
        }
      }
    }

    // Invariant: a room laptop's CSRC can only carry audio while that laptop's gate is open.
    // A learned room CSRC active long after its laptop's gate closed is someone else: remote.
    _verifyRoom(id, now) {
      const m = this.roomOf.get(id);
      if (m === undefined || m === this.selfId) return;
      const closed = this.gate.get(m) === 0 && !this.pend.has(m);
      const since = this.closedAt.get(m);
      if (closed && since !== undefined && now - since > this.p.verifyLatencyMs) {
        this.roomOf.delete(id);
        this.remoteIds.add(id);
        this.ev.push({ type: 'reclassify', id, to: 'remote', was: m });
      }
    }

    // Remote turn ended quickly after interrupting a brand-new owner who is still talking, and the
    // source went quiet once that owner's gate closed: it was the owner's own audio. Fix the map.
    _verifyRemoteTurn(now) {
      const t = this.remTrig;
      this.remTrig = null;
      if (!t || now - t.at > this.p.verifyWindowMs) return;
      const l = this.lv.get(t.owner);
      if (!l || !l.act || now - l.at > this.p.levelFreshMs) return;
      for (const id of t.ids) {
        this.remoteIds.delete(id);
        this.roomOf.set(id, t.owner);
        this.ev.push({ type: 'reclassify', id, to: 'room', owner: t.owner });
      }
      this.owner = t.owner; // SETTLING reopens it
    }

    _hasCsrc(owner) {
      for (const v of this.roomOf.values()) if (v === owner) return true;
      return false;
    }

    _enroll(now, unk) {
      if (!unk) { if (this.cnt.size) this.cnt.clear(); return; }
      if (this.cnt.size) for (const id of Array.from(this.cnt.keys())) if (unk.indexOf(id) < 0) this.cnt.delete(id);
      const p = this.p, o = this.owner;
      let kind = null;
      if (this.state === 'SOUNDCHECK') kind = 'remote';
      else {
        const at = this.ackedAt.get(o);
        if (o === null || this.gate.get(o) !== 1 || this.pend.has(o) || at === undefined || now - at < p.learnSettleMs) {
          this.cnt.clear(); return;
        }
        if (o === this.selfId || this._hasCsrc(o)) kind = 'remote';
        else if (unk.length === 1 && this._info(o, now).fresh && this.lv.get(o).act) kind = 'room';
      }
      if (kind === null) { this.cnt.clear(); return; }
      let enrolled = 0;
      for (const id of unk) {
        let c = this.cnt.get(id);
        if (!c || c.kind !== kind) { c = { kind, n: 0 }; this.cnt.set(id, c); }
        c.n++;
        if (c.n < (kind === 'remote' ? p.enrollTicks : p.learnTicks)) continue;
        this.cnt.delete(id);
        if (kind === 'remote') {
          this.remoteIds.add(id); enrolled++;
          this.ev.push({ type: 'enroll', id, kind: 'remote' });
        } else {
          this.roomOf.set(id, o);
          this.ev.push({ type: 'enroll', id, kind: 'room', owner: o });
        }
      }
      if (enrolled && this.state === 'SOUNDCHECK') this._toSettling(now);
    }

    _actions() {
      switch (this.state) {
        case 'ROOM': return this.remoteIds.size === 0 ? ['soundCheck'] : [];
        case 'HUB_ONLY': return ['resume'];
        case 'PAUSED': {
          const r = this.pause && this.pause.reason;
          if (r === 'ownerLost') return this.roster.size === 0 ? ['hubOnly', 'dropLost', 'continueSolo'] : ['hubOnly', 'dropLost'];
          if (r === 'relay') return ['hubOnly'];
          if (r === 'ackTimeout') return this.pause.id !== undefined ? ['resume', 'hubOnly', 'dropLost'] : ['resume', 'hubOnly'];
          return ['resume', 'hubOnly'];
        }
        default: return [];
      }
    }

    _out(now) {
      const st = this.state;
      const events = this.ev, commands = this.cmds;
      for (let i = 0; i < events.length; i++) if (events[i].at === null) events[i].at = now;
      this.ev = []; this.cmds = [];
      let tabMuted = true;
      if (st === 'REMOTE' || st === 'SOLO') tabMuted = false;
      else if (st === 'HUB_ONLY') tabMuted = this.hoWait;
      else if (st === 'SOUNDCHECK') tabMuted = this.sc.phase !== 'listening';
      const showOwner = st === 'ROOM' || st === 'SWITCHING' || st === 'SOLO' || st === 'HUB_ONLY';
      return {
        state: st,
        owner: showOwner ? this.owner : null,
        commands,
        tabMuted,
        freezeNoise: !!FREEZE_STATES[st],
        pause: this.pause && st === 'PAUSED' ? Object.assign({}, this.pause) : null,
        actions: this._actions(),
        remote: { enrolled: this.remoteIds.size, identified: this.identified, learnedRoom: this.roomOf.size },
        events,
        debug: { gen: this.gen, pending: this.pend.size, lost: this.lost.size, relayUp: this.relayUp, members: this.roster.size, now },
      };
    }
  }

  class MemberAgent {
    constructor(opts) {
      opts = opts || {};
      this.p = Object.assign({}, DEFAULTS);
      cleanParams(this.p, opts.params);
      this.epoch = null;
      this.lastG = -1;
      this.desired = 0;
      this.hbAt = null;          // null: grace period starts at the next tick
      this.hbState = null;
      this._last = 0;
    }
    setParams(partial) { cleanParams(this.p, partial); }

    onEpoch(e) {
      if (e === undefined || e === null || (typeof e === 'number' && !isFinite(e))) return;
      if (e === this.epoch) return;
      this.epoch = e;
      this.lastG = -1;
      this.desired = 0;
      this.hbAt = null;
      this.hbState = null;
    }

    onCommand(cmd) {
      if (!cmd || typeof cmd !== 'object') return null;
      const g = num(cmd.g, NaN);
      if (cmd.op === 'close') {
        this.desired = 0;
        if (cmd.e === this.epoch && g > this.lastG) this.lastG = g;
        return 0;
      }
      if (cmd.op === 'open') {
        if (this.epoch === null || cmd.e !== this.epoch || !(g > this.lastG)) return null;
        this.lastG = g;
        this.desired = 1;
        return 1;
      }
      return null;
    }

    onHeartbeat(now, hb) {
      if (!hb || typeof hb !== 'object') return;
      if (this.epoch === null && hb.e !== undefined && hb.e !== null) this.epoch = hb.e;
      if (hb.e !== this.epoch) return;
      this.hbAt = num(now, this._last);
      this.hbState = typeof hb.s === 'string' ? hb.s : null;
    }

    tick(now, ctx) {
      now = num(now, this._last);
      this._last = now;
      if (this.hbAt === null) this.hbAt = now;
      const watchdog = !(ctx && ctx.relayUp) || now - this.hbAt >= this.p.watchdogMs;
      if (watchdog) this.desired = 0;
      const freezeNoise = !watchdog && this.hbState !== null && !!HB_FREEZE[this.hbState];
      return { gate: this.desired ? 1 : 0, freezeNoise, watchdog };
    }
  }

  const api = { Coordinator, MemberAgent, DEFAULTS };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else {
    const g = globalThis;
    if (!g.__hybridAudio) {
      Object.defineProperty(g, '__hybridAudio', { value: {}, enumerable: false, configurable: true, writable: true });
    }
    g.__hybridAudio.coordinator = api;
  }
})();
