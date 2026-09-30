/* Hybrid Audio — meet-hooks.js (MAIN world). The ONLY file with Meet/WebRTC-specific knowledge.
 * Wraps getUserMedia + RTCPeerConnection, exposes hooks = {pollRemote, getMeetState}. */
(function () {
  'use strict';
  try {
    var W = window;
    if (!W.__hybridAudio) {
      Object.defineProperty(W, '__hybridAudio', { value: {}, enumerable: false, configurable: true, writable: true });
    }
    var NS = W.__hybridAudio;
    if (NS.hooks) return; // already installed

    var MEET_RE = /\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/;
    var pcs = []; // [{ref: WeakRef}]
    var hasWeakRef = typeof WeakRef === 'function';

    function getEngine() { return NS.engine || null; }

    // ---------- getUserMedia ----------
    function wrapGUM() {
      var proto = (typeof MediaDevices !== 'undefined' && MediaDevices.prototype) || null;
      var holder = proto && typeof proto.getUserMedia === 'function' ? proto : (navigator.mediaDevices || null);
      if (!holder || typeof holder.getUserMedia !== 'function') return;
      var orig = holder.getUserMedia;
      var wrapped = function getUserMedia() {
        var p;
        try { p = orig.apply(this, arguments); } catch (e) { return Promise.reject(e); }
        return p.then(function (stream) {
          try {
            var eng = getEngine();
            if (eng && stream && stream.getAudioTracks && stream.getAudioTracks().length > 0) {
              var out = eng.processStream(stream);
              if (out) return out;
            }
          } catch (e) { /* fall through to original */ }
          return stream;
        });
      };
      try { Object.defineProperty(wrapped, 'length', { value: orig.length, configurable: true }); } catch (e) {}
      try { Object.defineProperty(wrapped, 'name', { value: 'getUserMedia', configurable: true }); } catch (e) {}
      try {
        wrapped.toString = function () { return Function.prototype.toString.call(orig); };
        Object.defineProperty(wrapped, 'toString', { enumerable: false });
      } catch (e) {}
      Object.defineProperty(holder, 'getUserMedia', { value: wrapped, writable: true, configurable: true, enumerable: true });
    }

    // ---------- RTCPeerConnection ----------
    function track(pc) {
      try {
        var rec = { ref: hasWeakRef ? new WeakRef(pc) : { deref: function () { return pc; } } };
        pcs.push(rec);
        pc.addEventListener('connectionstatechange', function () { try { checkMeet(); recvStamp = 0; } catch (e) {} });
      } catch (e) {}
    }

    function wrapPC(name) {
      var Orig = W[name];
      if (typeof Orig !== 'function') return null;
      var P = new Proxy(Orig, {
        construct: function (target, args, newTarget) {
          var pc = Reflect.construct(target, args, newTarget);
          track(pc);
          return pc;
        },
      });
      try { Object.defineProperty(W, name, { value: P, writable: true, configurable: true, enumerable: false }); } catch (e) { try { W[name] = P; } catch (e2) {} }
      return P;
    }

    // ---------- remote polling ----------
    var recvList = [];
    var recvStamp = 0;
    var REFRESH_MS = 500;
    var result = { identified: false, sources: [] };
    var pool = [];
    var count = 0;

    function refreshReceivers(now) {
      recvList.length = 0;
      var keep = [];
      for (var i = 0; i < pcs.length; i++) {
        var pc = pcs[i].ref.deref();
        if (!pc) continue;
        var cs;
        try { cs = pc.connectionState; } catch (e) { cs = ''; }
        if (cs === 'closed') continue;
        keep.push(pcs[i]);
        try {
          var rs = pc.getReceivers();
          for (var j = 0; j < rs.length; j++) {
            var r = rs[j];
            if (r && r.track && r.track.kind === 'audio') recvList.push(r);
          }
        } catch (e) {}
      }
      pcs = keep;
      recvStamp = now;
    }

    function ageOf(ts, nowPerf, nowEpoch) {
      if (typeof ts !== 'number' || !isFinite(ts)) return 0;
      var a1 = nowEpoch - ts, a2 = nowPerf - ts, best = Infinity;
      if (a1 >= -50 && a1 < best) best = a1;
      if (a2 >= -50 && a2 < best) best = a2;
      if (best === Infinity) best = 0;
      return best < 0 ? 0 : best;
    }

    function add(id, level, age) {
      for (var i = 0; i < count; i++) {
        var e = result.sources[i];
        if (e.id === id) {
          if (age < e.ageMs || (age === e.ageMs && level > e.level)) { e.level = level; e.ageMs = age; }
          return;
        }
      }
      var o = pool[count] || (pool[count] = { id: '', level: 0, ageMs: 0 });
      o.id = id; o.level = level; o.ageMs = age;
      result.sources[count] = o;
      count++;
    }

    function pollRemote() {
      count = 0;
      result.identified = false;
      try {
        var nowPerf = performance.now();
        var nowEpoch = performance.timeOrigin + nowPerf;
        if (nowPerf - recvStamp > REFRESH_MS || recvStamp === 0) refreshReceivers(nowPerf);
        for (var i = 0; i < recvList.length; i++) {
          var r = recvList[i];
          var got = false, list;
          try { list = r.getContributingSources(); } catch (e) { list = null; }
          if (list && list.length) {
            for (var k = 0; k < list.length; k++) {
              var s = list[k];
              if (typeof s.audioLevel === 'number') {
                got = true;
                add('c' + s.source, s.audioLevel, ageOf(s.timestamp, nowPerf, nowEpoch));
              }
            }
            if (got) result.identified = true;
          }
          if (!got) {
            // CSRCs without per-CSRC levels: each Meet virtual stream carries one participant at a
            // time, so attribute the stream's (SSRC) level to its most recent CSRC.
            var latest = null;
            if (list && list.length) {
              for (var c = 0; c < list.length; c++) {
                if (!latest || list[c].timestamp > latest.timestamp) latest = list[c];
              }
            }
            var ss;
            try { ss = r.getSynchronizationSources(); } catch (e) { ss = null; }
            if (ss && ss.length) {
              for (var m = 0; m < ss.length; m++) {
                var q = ss[m];
                if (typeof q.audioLevel !== 'number') continue;
                if (latest) {
                  add('c' + latest.source, q.audioLevel, ageOf(q.timestamp, nowPerf, nowEpoch));
                  result.identified = true;
                } else {
                  add('s' + q.source, q.audioLevel, ageOf(q.timestamp, nowPerf, nowEpoch));
                }
              }
            }
          }
        }
      } catch (e) { count = 0; result.identified = false; }
      result.sources.length = count;
      return result;
    }

    // ---------- meeting state ----------
    function getMeetState() {
      var meeting = null;
      try {
        var m = MEET_RE.exec(location.pathname);
        meeting = m ? m[1] : null;
      } catch (e) {}
      var connected = false;
      if (meeting) {
        for (var i = 0; i < pcs.length; i++) {
          var pc = pcs[i].ref.deref();
          if (!pc) continue;
          try { if (pc.connectionState === 'connected') { connected = true; break; } } catch (e) {}
        }
      }
      return { meeting: meeting, inCall: !!(meeting && connected) };
    }

    var lastKey = null;
    function checkMeet() {
      try {
        var st = getMeetState();
        var key = (st.meeting || '') + '|' + (st.inCall ? 1 : 0);
        if (key === lastKey) return;
        lastKey = key;
        var eng = getEngine();
        if (eng && typeof eng.onMeetState === 'function') eng.onMeetState(st);
      } catch (e) {}
    }

    // ---------- install ----------
    try { wrapGUM(); } catch (e) {}
    try {
      var origRTC = W.RTCPeerConnection, origWk = W.webkitRTCPeerConnection;
      var PP = wrapPC('RTCPeerConnection');
      if (typeof origWk === 'function') {
        if (origWk === origRTC && PP) {
          Object.defineProperty(W, 'webkitRTCPeerConnection', { value: PP, writable: true, configurable: true, enumerable: false });
        } else {
          wrapPC('webkitRTCPeerConnection');
        }
      }
    } catch (e) {}

    NS.hooks = { pollRemote: pollRemote, getMeetState: getMeetState };
    try { setInterval(checkMeet, 500); } catch (e) {}
    checkMeet();
  } catch (e) { /* never break Meet */ }
})();
