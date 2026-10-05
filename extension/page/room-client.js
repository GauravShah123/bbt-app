/* Hybrid Audio — room-client.js (MAIN world). Relay protocol (Contract D) over the bridge pipe (Contract E).
 * The page never opens a WebSocket itself: ha:to-ext {type:'ws', op} / ha:to-page {type:'ws', ev}. */
(function () {
  'use strict';
  try {
    var W = window;
    if (!W.__hybridAudio) {
      Object.defineProperty(W, '__hybridAudio', { value: {}, enumerable: false, configurable: true, writable: true });
    }
    var NS = W.__hybridAudio;
    if (NS.RoomClient) return;

    var BACKOFF = [500, 1000, 2000, 4000, 8000];
    var PING_MS = 2000, DEAD_MS = 6000;
    var LVL_ACTIVE_MS = 100, LVL_IDLE_MS = 1000;

    function nowMs() { try { return performance.now(); } catch (e) { return Date.now(); } }
    function isStr(s, max) { return typeof s === 'string' && s.length > 0 && s.length <= (max || 64); }
    function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= 0; }
    function isBit(n) { return n === 0 || n === 1; }
    function num(n, lo, hi, dflt) {
      n = Number(n);
      if (!isFinite(n)) return dflt;
      return n < lo ? lo : n > hi ? hi : n;
    }
    function r1(n) { return Math.round(n * 10) / 10; }

    async function sha256Hex(s) {
      var buf = new TextEncoder().encode(s);
      var d = await crypto.subtle.digest('SHA-256', buf);
      var a = new Uint8Array(d), out = '';
      for (var i = 0; i < a.length; i++) out += (a[i] < 16 ? '0' : '') + a[i].toString(16);
      return out;
    }

    function toBridge(msg) {
      try { window.dispatchEvent(new CustomEvent('ha:to-ext', { detail: JSON.stringify(msg) })); return true; } catch (e) { return false; }
    }

    function normRoster(arr) {
      var out = [];
      if (!Array.isArray(arr)) return out;
      for (var i = 0; i < arr.length && i < 16; i++) {
        var r = arr[i];
        if (!r || !isStr(r.cid) || !isInt(r.n)) continue;
        out.push({ cid: r.cid, n: r.n, ready: r.ready ? 1 : 0 });
      }
      return out;
    }

    // Message validators: return a cleaned message or null.
    var VALID = {
      welcome: function (m) {
        if (!isStr(m.sid) || !isStr(m.you) || !isInt(m.epoch) || !Array.isArray(m.roster)) return null;
        if (m.hub !== null && m.hub !== undefined && !isStr(m.hub)) return null;
        return { t: 'welcome', sid: m.sid, you: m.you, hub: m.hub || null, epoch: m.epoch, roster: normRoster(m.roster) };
      },
      roster: function (m) {
        if (!isStr(m.sid) || !isInt(m.epoch) || !Array.isArray(m.roster)) return null;
        if (m.hub !== null && m.hub !== undefined && !isStr(m.hub)) return null;
        var hl = isStr(m.hubLost) ? m.hubLost : (m.hubLost && isStr(m.hubLost.cid) ? m.hubLost.cid : null);
        return { t: 'roster', sid: m.sid, hub: m.hub || null, epoch: m.epoch, roster: normRoster(m.roster), hubLost: hl };
      },
      lvl: function (m) {
        if (!isStr(m.from)) return null;
        return { t: 'lvl', from: m.from, q: isInt(m.q) ? m.q : 0, l: num(m.l, -200, 50, -120), z: num(m.z, -200, 50, -120), a: m.a ? 1 : 0, h: m.h ? 1 : 0, m: m.m ? 1 : 0 };
      },
      cmd: function (m) {
        if ((m.op !== 'open' && m.op !== 'close') || !isInt(m.e) || !isInt(m.g)) return null;
        return { t: 'cmd', op: m.op, e: m.e, g: m.g };
      },
      applied: function (m) {
        if (!isStr(m.from) || !isInt(m.e) || !isInt(m.g) || !isBit(m.gate)) return null;
        return { t: 'applied', from: m.from, e: m.e, g: m.g, gate: m.gate };
      },
      hb: function (m) {
        if (!isInt(m.e)) return null;
        return { t: 'hb', e: m.e, s: typeof m.s === 'string' ? m.s.slice(0, 24) : '', o: isStr(m.o) ? m.o : null };
      },
      want: function (m) { return isStr(m.from) ? { t: 'want', from: m.from } : null; },
      lost: function (m) { return isStr(m.cid) ? { t: 'lost', cid: m.cid } : null; },
      left: function (m) { return isStr(m.cid) ? { t: 'left', cid: m.cid } : null; },
      cfg: function (m) {
        if (!m.params || typeof m.params !== 'object') return null;
        var p = {}, n = 0;
        for (var k in m.params) {
          if (!Object.prototype.hasOwnProperty.call(m.params, k)) continue;
          var v = m.params[k];
          if (typeof v !== 'number' || !isFinite(v) || k.length > 40) continue;
          if (++n > 20) break;
          p[k] = v;
        }
        return { t: 'cfg', params: p, from: isStr(m.from) ? m.from : null };
      },
      pong: function (m) { return typeof m.ts === 'number' ? { t: 'pong', ts: m.ts } : null; }
    };

    class RoomClient {
      constructor() {
        this._h = Object.create(null);
        this.opts = null;
        this.wanted = false;
        this.state = 'idle';       // idle | connecting | open | closed
        this.up = false;           // socket open
        this.welcomed = false;
        this.attempt = 0;
        this.sid = null; this.epoch = null; this.hub = null; this.you = null;
        this.roster = []; this.hubLost = null;
        this.rtt = 0; this.via = null;
        this.key = null;
        this._reconnectT = null; this._pingT = null;
        this._lastPing = 0; this._lastRx = 0; this._lastLvlAt = 0; this._lastAct = -1; this._seq = 0;
        this._gen = 0;
        this._onPage = this._onPage.bind(this);
        this._listening = false;
      }

      // ---- emitter ----
      on(type, fn) {
        (this._h[type] || (this._h[type] = [])).push(fn);
        var self = this;
        return function () { self.off(type, fn); };
      }
      off(type, fn) {
        var a = this._h[type];
        if (!a) return;
        var i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      }
      _emit(type, a, b) {
        var arr = this._h[type];
        if (!arr) return;
        arr = arr.slice();
        for (var i = 0; i < arr.length; i++) {
          try { arr[i](a, b); } catch (e) { try { console.warn('[hybrid-audio] room handler', type, e); } catch (_) {} }
        }
      }

      // ---- lifecycle ----
      async connect(opts) {
        try {
          this.opts = opts || {};
          this.wanted = true;
          this.attempt = 0;
          var gen = ++this._gen;
          if (!this._listening) { window.addEventListener('ha:to-page', this._onPage); this._listening = true; }
          if (!this._pingT) this._pingT = setInterval(() => this.pump(nowMs()), PING_MS);
          var o = this.opts;
          this.key = (await sha256Hex('ha2|' + o.token + '|' + o.meeting)).slice(0, 32);
          if (!this.wanted || gen !== this._gen) return false;
          this._open();
          return true;
        } catch (e) {
          this._emit('error', e);
          return false;
        }
      }

      _url() {
        var o = this.opts, base = String(o.url || '').replace(/\/+$/, '').replace(/^http(s?):/i, 'ws$1:');
        return base + '/room/' + this.key + '?cid=' + encodeURIComponent(o.cid) + '&tok=' + encodeURIComponent(o.token) +
          '&claim=' + (o.claim ? 1 : 0) + '&v=2';
      }

      _open() {
        if (!this.wanted) return;
        this._clearReconnect();
        this.state = 'connecting';
        toBridge({ type: 'ws', op: 'open', url: this._url() });
      }

      close() {
        this.wanted = false;
        this._gen++;
        this._clearReconnect();
        if (this._pingT) { clearInterval(this._pingT); this._pingT = null; }
        var was = this.state !== 'idle';
        this.state = 'idle';
        var wasUp = this.up;
        this.up = false; this.welcomed = false;
        if (was) toBridge({ type: 'ws', op: 'close' });
        if (this._listening) { window.removeEventListener('ha:to-page', this._onPage); this._listening = false; }
        if (wasUp) this._emit('down', { code: 1000, reason: 'closed' });
      }

      _clearReconnect() { if (this._reconnectT) { clearTimeout(this._reconnectT); this._reconnectT = null; } }

      _scheduleReconnect() {
        if (!this.wanted || this._reconnectT) return;
        var d = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
        this.attempt++;
        this._reconnectT = setTimeout(() => { this._reconnectT = null; this._open(); }, d);
      }

      _closed(code, reason) {
        if (this.state !== 'connecting' && this.state !== 'open') return;
        var wasUp = this.up;
        this.state = 'closed';
        this.up = false; this.welcomed = false;
        this.hubLost = this.hubLost; // unchanged; next welcome refreshes
        if (wasUp) this._emit('down', { code: code || 0, reason: reason || '' });
        this._emit('closed', { code: code || 0, reason: reason || '', wasUp: wasUp });
        if (code === 4000 || (code >= 4001 && code <= 4004)) { // replaced / full / bad params / auth / daily cap: retrying cannot help
          this.wanted = false;
          this._emit('fatal', { code: code, reason: reason || '' });
          return;
        }
        this._scheduleReconnect();
      }

      // ---- bridge pipe ----
      _onPage(ev) {
        var msg;
        try { msg = JSON.parse(ev.detail); } catch (e) { return; }
        if (!msg || msg.type !== 'ws' || !this.wanted) return;
        try {
          if (msg.via) this.via = msg.via;
          switch (msg.ev) {
            case 'open':
              if (this.state !== 'connecting') return;
              this.state = 'open'; this.up = true; this._lastAct = -1;
              this._lastPing = 0; this._lastRx = nowMs();
              this._emit('up');
              break;
            case 'message': this._onData(msg.data); break;
            case 'close': this._closed(typeof msg.code === 'number' ? msg.code : 0, msg.reason); break;
            case 'error': this._emit('wserror', msg); this._closed(0, 'error'); break;
          }
        } catch (e) { /* never throw into Meet */ }
      }

      _onData(data) {
        this._lastRx = nowMs();
        if (typeof data !== 'string' || data.length > 8192) return;
        var m;
        try { m = JSON.parse(data); } catch (e) { return; }
        if (!m || typeof m.t !== 'string') return;
        var v = VALID[m.t];
        if (!v) return;
        var c = v(m);
        if (!c) return;
        switch (c.t) {
          case 'welcome': {
            var prevSid = this.sid, prevEpoch = this.epoch;
            this.sid = c.sid; this.you = c.you; this.hub = c.hub; this.epoch = c.epoch; this.roster = c.roster; this.hubLost = null;
            this.welcomed = true; this.attempt = 0;
            if (prevSid !== null && prevSid !== c.sid) this._emit('session', { sid: c.sid, prev: prevSid });
            if (prevEpoch !== null && prevEpoch !== c.epoch) this._emit('epoch', c.epoch, prevEpoch);
            break;
          }
          case 'roster': {
            var ps = this.sid, pe = this.epoch;
            this.sid = c.sid; this.hub = c.hub; this.epoch = c.epoch; this.roster = c.roster; this.hubLost = c.hubLost;
            if (ps !== null && ps !== c.sid) this._emit('session', { sid: c.sid, prev: ps });
            if (pe !== null && pe !== c.epoch) this._emit('epoch', c.epoch, pe);
            break;
          }
          case 'pong': {
            var rtt = nowMs() - c.ts;
            if (rtt >= 0 && rtt < 60000) { this.rtt = Math.round(rtt); c.rtt = this.rtt; }
            break;
          }
        }
        this._emit(c.t, c);
      }

      // ---- sending ----
      send(obj) {
        if (!this.up || this.state !== 'open') return false;
        try {
          var s = JSON.stringify(obj);
          if (s.length > 512) return false;
          return toBridge({ type: 'ws', op: 'send', data: s });
        } catch (e) { return false; }
      }

      isMember() { return !!(this.up && this.welcomed && this.you && this.hub && this.hub !== this.you); }
      isHub() { return !!(this.up && this.welcomed && this.you && this.hub === this.you); }
      get connected() { return this.up; }

      // Periodic work (ping). Called from a timer and from the audio tick.
      pump(now) {
        if (!this.up) return;
        if (this._lastRx && now - this._lastRx > DEAD_MS) { // no pong or anything from the server: socket is dead
          toBridge({ type: 'ws', op: 'close' });
          this._closed(1006, 'timeout');
          return;
        }
        if (now - this._lastPing >= PING_MS) {
          this._lastPing = now;
          this.send({ t: 'ping', ts: now });
        }
      }

      // Level sender: 10/s while act, 1/s otherwise, immediately on an act change. Members only.
      sendLevel(meas, now) {
        if (!this.isMember() || !meas) return false;
        var act = meas.act ? 1 : 0;
        var interval = act ? LVL_ACTIVE_MS : LVL_IDLE_MS;
        var changed = act !== this._lastAct;
        if (!changed && now - this._lastLvlAt < interval) return false;
        var ok = this.send({
          t: 'lvl', q: ++this._seq,
          l: r1(num(meas.levelDb, -160, 20, -120)), z: r1(num(meas.noiseDb, -160, 20, -120)),
          a: act, h: meas.healthy ? 1 : 0, m: meas.userMuted ? 1 : 0
        });
        if (ok) { this._lastLvlAt = now; this._lastAct = act; }
        return ok;
      }
    }

    Object.defineProperty(NS, 'RoomClient', { value: RoomClient, enumerable: false, configurable: true, writable: true });
  } catch (e) {
    try { console.warn('[hybrid-audio] room-client init failed', e); } catch (_) {}
  }
})();
