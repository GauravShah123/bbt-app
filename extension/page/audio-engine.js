/* Hybrid Audio — audio-engine.js (MAIN world). Audio graph + measurement + gate only (Contract A). */
(function () {
  'use strict';
  try {
    var W = window;
    if (!W.__hybridAudio) {
      Object.defineProperty(W, '__hybridAudio', { value: {}, enumerable: false, configurable: true, writable: true });
    }
    var NS = W.__hybridAudio;
    if (NS.engine) return;

    var RAMP_S = 0.008;
    var WORKLET_TIMEOUT_MS = 2000;
    var DB_FLOOR = -120;
    var WARMUP_MS = 1000;
    var GATE_FALLBACK_MS = 300;

    // ---------- state ----------
    var ctx = null, hp = null, lp = null, zero = null;
    var meterNode = null, meterKind = 'none', meterStarted = false, pollTimer = null;
    var gestureBound = false;
    var workletUrl = null;
    var entries = [];   // {orig, src, users:[rec], live, onEnded}
    var records = [];   // {entry, gain, dest, processed, live}
    var tapEntry = null;

    var mode = 'passthrough';
    var gateTarget = 1;     // latest requested/recorded gate
    var gateApplied = 1;    // last completed state
    var pending = null;     // {target, rampEnd, resolvers:[]}

    var params = { vadOnsetDb: 9, minSpeechDb: -55, actHoldMs: 200 };
    var noiseFreeze = false;
    var tickCbs = [];

    // measurement
    var levelDb = DB_FLOOR, noiseDb = DB_FLOOR, noiseInit = false;
    var firstTickAt = 0, lastTickAt = 0, lastTickPerf = 0;
    var act = false, lastActRaw = -Infinity;

    function nowMs() { return performance.now(); }

    // ---------- audio graph ----------
    function ensureCtx() {
      if (ctx) return ctx;
      var AC = W.AudioContext || W.webkitAudioContext;
      if (!AC) return null;
      var c = new AC({ latencyHint: 'interactive' });
      ctx = c;
      c.onstatechange = function () {
        try { if (c.state === 'running') unbindGesture(); } catch (e) {}
      };
      zero = c.createGain();
      zero.gain.value = 0;
      zero.connect(c.destination);
      hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 200;
      lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 4000;
      hp.connect(lp);
      startMeter();
      if (c.state !== 'running') bindGesture();
      return c;
    }

    function startMeter() {
      if (meterStarted) return;
      meterStarted = true;
      var c = ctx;
      var useWorklet = !!(workletUrl && c.audioWorklet && typeof c.audioWorklet.addModule === 'function' && typeof AudioWorkletNode === 'function');
      if (!useWorklet) { startScriptMeter(); return; }
      // until the worklet is up (or has failed) only gate completion is polled
      startPoll();
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; startScriptMeter(); } }, WORKLET_TIMEOUT_MS);
      var p;
      try { p = c.audioWorklet.addModule(workletUrl); } catch (e) { p = Promise.reject(e); }
      p.then(function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          var node = new AudioWorkletNode(c, 'ha-meter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
          node.port.onmessage = function (ev) {
            var d = ev.data;
            if (d && typeof d.rms === 'number') onMeter(d.rms);
          };
          lp.connect(node);
          node.connect(zero);
          meterNode = node;
          meterKind = 'worklet';
          stopPoll();
        } catch (e) { startScriptMeter(); }
      }, function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        startScriptMeter();
      });
    }

    function startScriptMeter() {
      try {
        if (meterKind !== 'none') return;
        if (typeof ctx.createScriptProcessor !== 'function') { startPoll(); return; }
        var sp = ctx.createScriptProcessor(1024, 1, 1);
        sp.onaudioprocess = function (e) {
          try {
            var d = e.inputBuffer.getChannelData(0), s = 0, n = d.length;
            for (var i = 0; i < n; i++) s += d[i] * d[i];
            onMeter(Math.sqrt(s / n));
          } catch (x) {}
        };
        lp.connect(sp);
        sp.connect(zero);
        meterNode = sp;
        meterKind = 'script';
        stopPoll();
      } catch (e) { startPoll(); }
    }

    // Gate-completion polling while no meter is delivering ticks.
    function startPoll() {
      if (pollTimer) return;
      pollTimer = setInterval(function () { try { checkGate(); } catch (e) {} }, 20);
    }
    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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

    function latestLiveRecord() {
      for (var i = records.length - 1; i >= 0; i--) if (records[i].live) return records[i];
      return null;
    }

    function rewireTap() {
      try {
        var want = null;
        for (var i = entries.length - 1; i >= 0; i--) { if (entries[i].live) { want = entries[i]; break; } }
        if (want === tapEntry) return;
        if (tapEntry) { try { tapEntry.src.disconnect(hp); } catch (e) {} }
        tapEntry = want;
        if (want) want.src.connect(hp);
      } catch (e) {}
    }

    function buildRecord(entry) {
      var gain = ctx.createGain();
      gain.gain.value = gateTarget;   // new tracks start at the recorded gate (closed stays closed)
      var dest = ctx.createMediaStreamDestination();
      dest.channelCount = 1;
      dest.channelCountMode = 'explicit';
      entry.src.connect(gain);
      gain.connect(dest);
      var processed = dest.stream.getAudioTracks()[0];
      var rec = { entry: entry, gain: gain, dest: dest, processed: processed, live: true };
      var orig = entry.orig;
      var nativeStop = processed.stop.bind(processed);
      // capture BEFORE the override below, or cloning a stopped track would recurse into itself
      var nativeClone = typeof processed.clone === 'function' ? processed.clone.bind(processed) : null;
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
      } catch (e) {}
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
        } catch (e) {}
      };
      orig.addEventListener('ended', entry.onEnded);
      entries.push(entry);
      return entry;
    }

    function processStream(stream) {
      try {
        var audio = stream.getAudioTracks();
        if (!audio.length) return stream;
        if (!ensureCtx()) return stream;
        try { if (ctx.state !== 'running') ctx.resume().catch(function () {}); } catch (e) {}
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
        return new MediaStream(outTracks);
      } catch (e) {
        return stream;
      }
    }

    // ---------- gate ----------
    function resolveGate() {
      if (!pending) return;
      var p = pending;
      pending = null;
      gateApplied = p.target;
      var r = { gate: gateApplied, at: nowMs() };
      for (var i = 0; i < p.resolvers.length; i++) { try { p.resolvers[i](r); } catch (e) {} }
    }

    function checkGate() {
      if (pending && ctx && ctx.currentTime >= pending.rampEnd) resolveGate();
    }

    function applyGate(open) {
      var target = open ? 1 : 0;
      var prev = pending;
      var resolvers = prev ? prev.resolvers : [];
      var done = new Promise(function (res) { resolvers.push(res); });
      gateTarget = target;
      var haveMic = !!(ctx && latestLiveRecord());
      if (!haveMic) {
        pending = { target: target, rampEnd: 0, resolvers: resolvers };
        resolveGate();
        return done;
      }
      if (!prev && target === gateApplied) {
        pending = { target: target, rampEnd: 0, resolvers: resolvers };
        resolveGate();
        return done;
      }
      var t = ctx.currentTime;
      var end = t + RAMP_S;
      for (var i = 0; i < records.length; i++) {
        if (!records[i].live) continue;
        try {
          var g = records[i].gain.gain;
          var cur = g.value;
          g.cancelScheduledValues(t);
          g.setValueAtTime(cur, t);
          g.linearRampToValueAtTime(target, end);
        } catch (e) {}
      }
      pending = { target: target, rampEnd: end, resolvers: resolvers };
      // Wall-clock fallback, unconditional: the ramp is scheduled on the audio thread and applies
      // at its time regardless of main-thread or meter stalls (and a suspended context renders
      // nothing, so nothing can leak). Never let leave()/role changes hang on a stalled meter.
      setTimeout(function () {
        try { if (pending && pending.rampEnd === end) resolveGate(); } catch (e) {}
      }, GATE_FALLBACK_MS);
      return done;
    }

    function setGate(open) {
      try {
        if (mode === 'passthrough') return Promise.resolve({ gate: 1, at: nowMs() });
        return applyGate(!!open);
      } catch (e) {
        return Promise.resolve({ gate: gateApplied, at: nowMs() });
      }
    }

    function setMode(m) {
      try {
        if (m !== 'passthrough' && m !== 'controlled') return;
        var was = mode;
        mode = m;
        if (m === 'passthrough' && was !== m) applyGate(true);
      } catch (e) {}
    }

    // ---------- measurement (runs in the meter callback = the tick) ----------
    function onMeter(rms) {
      var perf = nowMs();
      try {
        var dt = lastTickPerf ? Math.min(100, Math.max(1, perf - lastTickPerf)) : 20;
        lastTickPerf = perf;
        lastTickAt = perf;
        if (!firstTickAt) firstTickAt = perf;

        var lv = 20 * Math.log10(rms + 1e-9);
        if (!(lv > DB_FLOOR)) lv = DB_FLOOR;
        levelDb = lv;

        var rec = latestLiveRecord();
        var muted = !!(rec && (rec.processed.enabled === false || rec.processed.readyState === 'ended'));

        // noise tracker
        if (!noiseInit) { noiseDb = lv; noiseInit = true; }
        else if (!act && !noiseFreeze) {
          if (perf - firstTickAt < WARMUP_MS) {
            noiseDb += (lv - noiseDb) * (1 - Math.exp(-dt / 200));
          } else if (lv < noiseDb) {
            noiseDb += (lv - noiseDb) * (1 - Math.exp(-dt / 200));
          } else {
            noiseDb += Math.min(lv - noiseDb, dt / 1000);
          }
        }

        // activity with hold
        var warm = perf - firstTickAt < WARMUP_MS;
        var raw = !warm && !muted && lv > noiseDb + params.vadOnsetDb && lv > params.minSpeechDb;
        if (raw) lastActRaw = perf;
        act = !muted && (raw || (perf - lastActRaw) < params.actHoldMs);

        checkGate();
      } catch (e) {}
      for (var i = 0; i < tickCbs.length; i++) {
        try { tickCbs[i](perf); } catch (e) {}
      }
    }

    function getMeasure() {
      var rec = latestLiveRecord();
      var hasMic = !!(rec && rec.entry.orig.readyState === 'live');
      var userMuted = !!(rec && (rec.processed.enabled === false || rec.processed.readyState === 'ended'));
      var age = lastTickPerf ? Math.round(nowMs() - lastTickPerf) : 99999;
      var state = ctx ? ctx.state : 'none';
      return {
        levelDb: levelDb,
        noiseDb: noiseDb,
        act: userMuted ? false : act,
        healthy: state === 'running' && age < 500 && hasMic && !userMuted,
        userMuted: userMuted,
        hasMic: hasMic,
        ctxState: state,
        meter: meterKind,
        tickAgeMs: age,
      };
    }

    // ---------- public API ----------
    var engine = {
      processStream: processStream,
      setMode: setMode,
      setGate: setGate,
      setNoiseFreeze: function (b) { noiseFreeze = !!b; },
      setParams: function (p) {
        try {
          if (!p || typeof p !== 'object') return;
          ['vadOnsetDb', 'minSpeechDb', 'actHoldMs'].forEach(function (k) {
            if (typeof p[k] === 'number' && isFinite(p[k])) params[k] = p[k];
          });
        } catch (e) {}
      },
      onTick: function (fn) {
        if (typeof fn !== 'function') return function () {};
        tickCbs.push(fn);
        return function () { var i = tickCbs.indexOf(fn); if (i >= 0) tickCbs.splice(i, 1); };
      },
      setWorkletUrl: function (url) { if (typeof url === 'string' && url) workletUrl = url; },
      resume: function () {
        try { if (ctx && ctx.state !== 'running') return ctx.resume().catch(function () {}); } catch (e) {}
        return Promise.resolve();
      },
    };
    Object.defineProperty(engine, 'gateApplied', { get: function () { return gateApplied; }, enumerable: true });
    Object.defineProperty(engine, 'measure', { get: getMeasure, enumerable: true });
    Object.defineProperty(engine, 'mode', { get: function () { return mode; }, enumerable: true });

    NS.engine = engine;
  } catch (e) { /* never break Meet */ }
})();
