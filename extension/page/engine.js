/* Hybrid Audio — engine.js (MAIN world). Audio graph, tick loop, bridge messaging. */
(function () {
  'use strict';
  try {
    var W = window;
    if (!W.__hybridAudio) {
      Object.defineProperty(W, '__hybridAudio', { value: {}, enumerable: false, configurable: true, writable: true });
    }
    var NS = W.__hybridAudio;
    if (NS.engine) return;

    var FAIL_OPEN_MS = 3000;
    var LOG_MAX = 2000;

    // ---------- state ----------
    var ctx = null, tap = null, proc = null, zero = null, analyser = null, fbTimer = null, fbBuf = null;
    var gestureBound = false;
    var entries = [];   // orig entries {orig, src, users:[rec], onEnded}
    var records = [];   // processed records in creation order {entry, gain, dest, processed, live}
    var tapEntry = null;
    var curGain = 0;
    var firstStreamAt = 0;
    var hasConfig = false, mode = 'auto', backendConfigured = false;
    var params = {};
    var controller = null;
    var room = { connected: false, everConnected: false, you: null, hub: null, size: 0 };
    var isHub = false;
    var peers = {};     // id -> {a,s,r,rt,receipt}
    var rtt = 0;
    var meet = { meeting: null, inCall: false };
    var lastOut = null;
    var lastSelfAmp = 0;
    var prevTabMuted = false;
    var lastMuteSent = null, lastMuteAt = 0;
    var lastStAt = 0, lastStDb = -200, lastStS = 0, lastStR = 0;
    var lastRttLogAt = 0;
    var log = [];
    var errSeen = {};
    var lastCtxState = '';
    var identCache = false;

    function nowMs() { return performance.now(); }

    // ---------- log ----------
    function L(ev) {
      ev.t = Date.now();
      log.push(ev);
      if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
    }
    function err(where, e) {
      try {
        var msg = String(e && e.message || e);
        var key = where + msg, n = nowMs();
        if (errSeen[key] && n - errSeen[key] < 5000) return;
        errSeen[key] = n;
        L({ type: 'error', where: where, msg: msg });
      } catch (x) {}
    }

    // ---------- messaging ----------
    function send(obj) {
      try { W.dispatchEvent(new CustomEvent('ha:to-ext', { detail: JSON.stringify(obj) })); } catch (e) { err('send', e); }
    }
    function sendMeet() { send({ type: 'meet', meeting: meet.meeting, inCall: meet.inCall }); }

    function getPolicy() { return NS.policy || null; }
    function ensureController() {
      if (controller) return controller;
      var P = getPolicy();
      if (!P || typeof P.Controller !== 'function') return null;
      try { controller = new P.Controller(params); } catch (e) { err('controller', e); controller = null; }
      return controller;
    }
    function effectiveParams() {
      var P = getPolicy();
      var o = {};
      try { if (P && P.DEFAULTS) for (var k in P.DEFAULTS) o[k] = P.DEFAULTS[k]; } catch (e) {}
      for (var k2 in params) o[k2] = params[k2];
      return o;
    }
    function applyParams(p) {
      if (!p || typeof p !== 'object') return;
      if (Object.keys(p).length === 0) {
        // Empty params = reset to defaults (popup "Reset").
        params = {};
        var P = getPolicy();
        try { if (controller && P) controller.setParams(P.DEFAULTS); } catch (e) { err('setParams', e); }
        L({ type: 'params', params: {} });
        return;
      }
      for (var k in p) params[k] = p[k];
      try { if (controller) controller.setParams(p); } catch (e) { err('setParams', e); }
      L({ type: 'params', params: p });
    }

    function onToPage(ev) {
      var m;
      try { m = JSON.parse(ev.detail); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      try {
        switch (m.type) {
          case 'config':
            var modeChanged = m.mode !== mode || !hasConfig;
            if (typeof m.mode === 'string') mode = m.mode;
            backendConfigured = !!m.backendConfigured;
            hasConfig = true;
            if (m.params && typeof m.params === 'object') applyParams(m.params);
            if (modeChanged) L({ type: 'config', mode: mode, backendConfigured: backendConfigured });
            break;
          case 'cfg':
            applyParams(m.params);
            break;
          case 'room':
            onRoom(m);
            break;
          case 'peer':
            if (m.id != null) peers[m.id] = { a: +m.a || 0, s: m.s ? 1 : 0, r: m.r ? 1 : 0, rt: +m.rt || 0, receipt: nowMs() };
            break;
          case 'rtt':
            if (typeof m.ms === 'number' && isFinite(m.ms)) rtt = m.ms;
            break;
          case 'getLog':
            send({ type: 'logDump', reqId: m.reqId, log: dump() });
            break;
          case 'sync':
            sendMeet();
            break;
        }
      } catch (e) { err('onToPage', e); }
    }

    function onRoom(m) {
      var list = Array.isArray(m.peers) ? m.peers : [];
      var connected = !!m.connected;
      var changed = connected !== room.connected || m.hub !== room.hub || list.length !== room.size || m.you !== room.you;
      room.connected = connected;
      room.everConnected = !!m.everConnected;
      room.you = m.you != null ? m.you : room.you;
      room.hub = m.hub != null ? m.hub : null;
      room.size = list.length;
      if (connected) isHub = room.hub != null && room.hub === room.you;
      if (list.length) {
        var ids = {};
        for (var i = 0; i < list.length; i++) ids[list[i].id] = 1;
        for (var id in peers) if (!ids[id]) delete peers[id];
      }
      if (changed) L({ type: 'room', connected: connected, hub: room.hub, you: room.you, size: room.size, isHub: isHub });
    }

    // ---------- audio graph ----------
    function ensureCtx() {
      if (ctx) return ctx;
      var AC = W.AudioContext || W.webkitAudioContext;
      ctx = new AC({ latencyHint: 'interactive' });
      lastCtxState = ctx.state;
      L({ type: 'ctx', state: ctx.state });
      ctx.onstatechange = function () {
        try {
          if (ctx.state !== lastCtxState) { lastCtxState = ctx.state; L({ type: 'ctx', state: ctx.state }); }
          if (ctx.state === 'running') unbindGesture();
        } catch (e) {}
      };
      tap = ctx.createGain();
      zero = ctx.createGain();
      zero.gain.value = 0;
      zero.connect(ctx.destination);
      if (typeof ctx.createScriptProcessor === 'function') {
        proc = ctx.createScriptProcessor(1024, 1, 1);
        proc.onaudioprocess = function (e) {
          try {
            var d = e.inputBuffer.getChannelData(0), s = 0, n = d.length;
            for (var i = 0; i < n; i++) s += d[i] * d[i];
            lastSelfAmp = Math.sqrt(s / n);
            tick(nowMs());
          } catch (x) { err('onaudioprocess', x); }
        };
        tap.connect(proc);
        proc.connect(zero);
      } else {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        fbBuf = new Float32Array(1024);
        tap.connect(analyser);
        fbTimer = setInterval(function () {
          try {
            analyser.getFloatTimeDomainData(fbBuf);
            var s = 0;
            for (var i = 0; i < fbBuf.length; i++) s += fbBuf[i] * fbBuf[i];
            lastSelfAmp = Math.sqrt(s / fbBuf.length);
            tick(nowMs());
          } catch (x) { err('fallbackTick', x); }
        }, 20);
      }
      if (ctx.state !== 'running') bindGesture();
      return ctx;
    }

    function onGesture() {
      try { if (ctx && ctx.state !== 'running') ctx.resume().catch(function () {}); } catch (e) {}
    }
    function bindGesture() {
      if (gestureBound) return;
      gestureBound = true;
      W.addEventListener('pointerdown', onGesture, true);
      W.addEventListener('keydown', onGesture, true);
    }
    function unbindGesture() {
      if (!gestureBound) return;
      gestureBound = false;
      W.removeEventListener('pointerdown', onGesture, true);
      W.removeEventListener('keydown', onGesture, true);
    }

    function liveRecords(entry) {
      var n = 0;
      for (var i = 0; i < records.length; i++) if (records[i].live && (!entry || records[i].entry === entry)) n++;
      return n;
    }

    function rewireTap() {
      try {
        var want = null;
        for (var i = entries.length - 1; i >= 0; i--) { if (entries[i].live) { want = entries[i]; break; } }
        if (want === tapEntry) return;
        if (tapEntry) { try { tapEntry.src.disconnect(tap); } catch (e) {} }
        tapEntry = want;
        if (want) want.src.connect(tap);
        if (!want) lastSelfAmp = 0;
      } catch (e) { err('rewireTap', e); }
    }

    function buildRecord(entry) {
      var gain = ctx.createGain();
      gain.gain.value = curGain;
      var dest = ctx.createMediaStreamDestination();
      dest.channelCount = 1;
      dest.channelCountMode = 'explicit';
      entry.src.connect(gain);
      gain.connect(dest);
      var processed = dest.stream.getAudioTracks()[0];
      var rec = { entry: entry, gain: gain, dest: dest, processed: processed, live: true };
      var orig = entry.orig;
      var nativeStop = processed.stop.bind(processed);
      var nativeClone = null;
      try {
        Object.defineProperty(processed, 'label', { value: orig.label, configurable: true, enumerable: true });
        Object.defineProperty(processed, 'getSettings', { value: function getSettings() { return orig.getSettings(); }, configurable: true, writable: true });
        Object.defineProperty(processed, 'getCapabilities', { value: function getCapabilities() { return orig.getCapabilities(); }, configurable: true, writable: true });
        Object.defineProperty(processed, 'getConstraints', { value: function getConstraints() { return orig.getConstraints(); }, configurable: true, writable: true });
        Object.defineProperty(processed, 'applyConstraints', { value: function applyConstraints(c) { return orig.applyConstraints(c); }, configurable: true, writable: true });
        Object.defineProperty(processed, 'stop', {
          value: function stop() { releaseRecord(rec, nativeStop, true); },
          configurable: true, writable: true,
        });
        Object.defineProperty(processed, 'clone', {
          value: function clone() {
            if (!rec.live) { if (nativeClone) return nativeClone(); }
            var r2 = buildRecord(entry);
            records.push(r2);
            rewireTap();
            return r2.processed;
          },
          configurable: true, writable: true,
        });
        nativeClone = processed.clone;
      } catch (e) { err('disguise', e); }
      rec.nativeStop = nativeStop;
      entry.users.push(rec);
      return rec;
    }

    // stop a processed record; stop orig when last user. `explicit` = stop() called by page (no ended event)
    function releaseRecord(rec, nativeStop, explicit) {
      if (!rec.live) return;
      rec.live = false;
      try { nativeStop(); } catch (e) {}
      try { rec.entry.src.disconnect(rec.gain); } catch (e) {}
      try { rec.gain.disconnect(); } catch (e) {}
      var entry = rec.entry;
      var idx = entry.users.indexOf(rec);
      if (idx >= 0) entry.users.splice(idx, 1);
      var ri = records.indexOf(rec);
      if (ri >= 0) records.splice(ri, 1);
      if (!liveRecords(entry)) {
        entry.live = false;
        try { entry.orig.removeEventListener('ended', entry.onEnded); } catch (e) {}
        if (explicit) { try { entry.orig.stop(); } catch (e) {} }
        try { entry.src.disconnect(); } catch (e) {}
        var ei = entries.indexOf(entry);
        if (ei >= 0) entries.splice(ei, 1);
      }
      rewireTap();
    }

    function makeEntry(orig) {
      var src = ctx.createMediaStreamSource(new MediaStream([orig]));
      var entry = { orig: orig, src: src, users: [], live: true, onEnded: null };
      entry.onEnded = function () {
        try {
          var us = entry.users.slice();
          for (var i = 0; i < us.length; i++) {
            var r = us[i];
            releaseRecord(r, r.nativeStop, false);
            try { r.processed.dispatchEvent(new Event('ended')); } catch (e) {}
          }
          L({ type: 'track-ended', label: orig.label });
        } catch (e) { err('onEnded', e); }
      };
      orig.addEventListener('ended', entry.onEnded);
      entries.push(entry);
      return entry;
    }

    function processStream(stream) {
      try {
        var audio = stream.getAudioTracks();
        if (!audio.length) return stream;
        ensureCtx();
        try { if (ctx.state !== 'running') ctx.resume().catch(function () {}); } catch (e) {}
        if (!firstStreamAt) firstStreamAt = nowMs();
        var outTracks = [];
        for (var i = 0; i < audio.length; i++) {
          var entry = makeEntry(audio[i]);
          var rec = buildRecord(entry);
          records.push(rec);
          outTracks.push(rec.processed);
        }
        rewireTap();
        var vids = stream.getVideoTracks();
        for (var j = 0; j < vids.length; j++) outTracks.push(vids[j]);
        L({ type: 'stream', audio: audio.length, video: vids.length });
        return new MediaStream(outTracks);
      } catch (e) {
        err('processStream', e);
        return stream;
      }
    }

    // ---------- gain ----------
    function applyGain(target) {
      if (!(target >= 0)) target = 0;
      if (target > 1) target = 1;
      var d = target - curGain;
      if (!(Math.abs(d) > 0.01 || (d !== 0 && (target === 0 || target === 1)))) return;
      var tau = target > curGain ? 0.005 : 0.03;
      curGain = target;
      if (!ctx) return;
      var t = ctx.currentTime;
      for (var i = 0; i < records.length; i++) {
        try { records[i].gain.gain.setTargetAtTime(target, t, tau); } catch (e) {}
      }
    }

    // ---------- tick ----------
    function currentProcessed() {
      for (var i = records.length - 1; i >= 0; i--) if (records[i].live) return records[i].processed;
      return null;
    }

    function tick(now) {
      var hooks = NS.hooks;
      var remote = null;
      try { remote = hooks && hooks.pollRemote ? hooks.pollRemote() : null; } catch (e) { err('pollRemote', e); }
      if (!remote) remote = { identified: false, sources: [] };
      identCache = !!remote.identified;

      var failOpen = !hasConfig && firstStreamAt && (now - firstStreamAt) >= FAIL_OPEN_MS;
      var effMode = hasConfig ? mode : 'off';
      var inCall = meet.inCall;

      var pt = currentProcessed();
      var participating = !!(pt && pt.readyState === 'live' && pt.enabled);

      var out = null;
      var c = ensureController();
      if (c) {
        try {
          var parr = [];
          for (var id in peers) {
            var p = peers[id];
            parr.push({ id: id, amp: p.a, speaking: !!p.s, ageMs: now - p.receipt });
          }
          out = c.step({
            now: now,
            selfAmp: lastSelfAmp,
            participating: participating,
            mode: effMode,
            connected: room.connected,
            everConnected: room.everConnected,
            isHub: isHub,
            roomSize: room.size,
            peers: parr,
            remote: remote,
          });
        } catch (e) { err('policy.step', e); out = null; }
      }
      lastOut = out;

      var target;
      if (!hasConfig && !failOpen) target = 0;
      else if (!inCall || !out) target = 1;
      else target = out.gain;
      applyGain(target);

      if (!out) return;

      // events
      if (inCall && out.events && out.events.length) {
        for (var i = 0; i < out.events.length; i++) {
          var ev = out.events[i], copy = {};
          for (var k in ev) copy[k] = ev[k];
          L(copy);
        }
      }

      // hub mute latency estimate
      var muted = !!out.tabMuted;
      if (inCall && muted && !prevTabMuted && isHub) {
        var est = 0;
        if (out.trigger && out.trigger !== 'self') {
          var tp = peers[out.trigger];
          est = rtt / 2 + (tp ? (tp.rt || 0) / 2 + (now - tp.receipt) : 0);
        }
        L({ type: 'hub-mute', estMs: Math.round(est * 10) / 10, trigger: out.trigger || null });
      }
      prevTabMuted = inCall ? muted : false;

      if (inCall) {
        // mute
        var t2 = Date.now();
        if (lastMuteSent !== muted || t2 - lastMuteAt >= 2000) {
          lastMuteSent = muted; lastMuteAt = t2;
          send({ type: 'mute', muted: muted });
        }
        // st
        var amp = out.amp || 0;
        var db = 20 * Math.log10(amp + 1e-9);
        var s = out.speaking ? 1 : 0, r = out.remoteActive ? 1 : 0;
        var since = now - lastStAt;
        if ((since >= 50 && (s || lastStS || r !== lastStR || Math.abs(db - lastStDb) > 3)) || since >= 1000) {
          lastStAt = now; lastStDb = db; lastStS = s; lastStR = r;
          send({ type: 'st', a: Math.round(amp * 10000) / 10000, s: s, r: r, rt: Math.round(rtt) });
        }
      }

      if (now - lastRttLogAt >= 10000) {
        lastRttLogAt = now;
        if (rtt > 0) L({ type: 'rtt', ms: rtt });
      }
    }

    // ---------- meet state ----------
    function onMeetState(st) {
      try {
        if (!st) return;
        var was = meet.inCall;
        var changed = st.meeting !== meet.meeting || !!st.inCall !== meet.inCall;
        meet = { meeting: st.meeting || null, inCall: !!st.inCall };
        if (changed) L({ type: 'meet', meeting: meet.meeting, inCall: meet.inCall });
        if (was && !meet.inCall) {
          applyGain(1);
          prevTabMuted = false;
          lastMuteSent = false; lastMuteAt = Date.now();
          send({ type: 'mute', muted: false });
        }
        if (meet.inCall && !was) { lastMuteSent = null; lastStAt = 0; }
        if (changed) sendMeet();
      } catch (e) { err('onMeetState', e); }
    }

    // ---------- status ----------
    function num(x) { return typeof x === 'number' && isFinite(x) ? Math.round(x * 10) / 10 : null; }
    function sendStatus() {
      try {
        var o = lastOut, d = (o && o.debug) || {};
        var pt = currentProcessed();
        var failOpen = !hasConfig && firstStreamAt && (nowMs() - firstStreamAt) >= FAIL_OPEN_MS;
        send({
          type: 'status',
          state: o ? o.state : 'off',
          mode: hasConfig ? mode : (failOpen ? 'off' : mode),
          gain: Math.round(curGain * 1000) / 1000,
          isHub: isHub,
          roomSize: room.size,
          connected: room.connected,
          everConnected: room.everConnected,
          ctxState: ctx ? ctx.state : 'none',
          selfDb: num(d.selfDb),
          floorDb: num(d.floorDb),
          remoteDb: num(d.remoteDb),
          identified: identCache,
          sources: d.sources || {},
          rtt: Math.round(rtt),
          speaking: !!(o && o.speaking),
          participating: !!(pt && pt.readyState === 'live' && pt.enabled),
          meeting: meet.meeting,
          inCall: meet.inCall,
          backendConfigured: backendConfigured,
        });
      } catch (e) { err('status', e); }
    }
    // ---------- log dump ----------
    function pct(arr, p) {
      if (!arr.length) return null;
      var a = arr.slice().sort(function (x, y) { return x - y; });
      var i = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
      return a[i];
    }
    function dump() {
      var rt = [], rd = [], hm = [], sc = {};
      for (var i = 0; i < log.length; i++) {
        var e = log[i];
        if (e.type === 'rtt' && typeof e.ms === 'number') rt.push(e.ms);
        else if (e.type === 'remote-detect' && typeof e.ms === 'number') rd.push(e.ms);
        else if (e.type === 'hub-mute' && typeof e.estMs === 'number') hm.push(e.estMs);
        else if (e.type === 'state' && e.to) sc[e.to] = (sc[e.to] || 0) + 1;
      }
      return {
        params: effectiveParams(),
        log: log.slice(),
        summary: {
          rtt: { p50: pct(rt, 0.5), p95: pct(rt, 0.95), n: rt.length },
          remoteDetect: { p50: pct(rd, 0.5), p95: pct(rd, 0.95), n: rd.length },
          hubMute: { p50: pct(hm, 0.5), p95: pct(hm, 0.95), n: hm.length },
          stateCounts: sc,
        },
      };
    }

    // ---------- boot ----------
    try { W.addEventListener('ha:to-page', onToPage); } catch (e) {}
    try { setInterval(sendStatus, 250); } catch (e) {}

    NS.engine = {
      processStream: processStream,
      onMeetState: onMeetState,
      _debug: {
        getState: function () {
          return {
            curGain: curGain, hasConfig: hasConfig, mode: mode, room: room, isHub: isHub, meet: meet,
            ctxState: ctx ? ctx.state : 'none', records: records.length, entries: entries.length,
            lastOut: lastOut, logLen: log.length, peers: Object.keys(peers).length,
          };
        },
      },
    };
  } catch (e) { /* never break Meet */ }
})();
