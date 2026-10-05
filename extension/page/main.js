/* Hybrid Audio — main.js (MAIN world). Glue: join/leave, role handling, routing, heartbeats, status, event log. */
(function () {
  'use strict';
  try {
    var W = window;
    if (!W.__hybridAudio) {
      Object.defineProperty(W, '__hybridAudio', { value: {}, enumerable: false, configurable: true, writable: true });
    }
    var NS = W.__hybridAudio;
    if (NS.main) return;

    var LOG_MAX = 3000;
    var STATUS_MS = 250, HB_MS = 500, MUTE_REASSERT_MS = 2000, MUTE_TIMEOUT_MS = 2000;
    var LEAVE_DEBOUNCE_MS = 1500, YIELD_TIMEOUT_MS = 3000, STEP_FALLBACK_MS = 200;
    var ENGINE_PARAMS = ['vadOnsetDb', 'minSpeechDb', 'actHoldMs'];

    // ---------- state ----------
    var cfg = { backendUrl: '', token: '', cid: '', autoJoin: null, workletUrl: '' };
    var params = {};
    var meet = { meeting: null, inCall: false };
    var joined = false, joining = false, leaving = false, joinTok = 0, userLeft = false;
    var client = null;
    var role = null;              // 'hub' | 'member' | null
    var curKey = null, txnTok = 0, transitioning = false;
    var c = null, m = null;       // Coordinator (hub) / MemberAgent (member)
    var lastOut = null, lastPauseSig = '';
    var hubOwned = false;         // member: gate open because the Hub told us to
    var lastGateReq = -1;         // member: last gate target we asked the engine for
    var lastHb = null;            // member: {e, s, o}
    var lastMemberOut = null;
    var yielding = false, yieldT = null;
    var lostMap = {};             // id -> n
    var nById = {};
    var tabMuted = null;          // last confirmed tab mute state
    var lastMuteReq = null, lastMuteReqAt = 0, muteSeq = 0, mutePending = {};
    var lastFreeze = null;
    var lastReady = null;
    var lastHbAt = 0, lastStatusAt = 0, lastStepAt = 0, lastRttLogAt = 0;
    var seenCmd = {};
    var pageLeaving = false, leaveTimer = null;
    var tickHooked = false;
    var log = [];
    var sums = { switchMs: [], remoteMs: [], rtt: [], stateCounts: {}, pauses: {} };
    var autoJoinTried = false;

    // ---------- helpers ----------
    function now() { try { return performance.now(); } catch (e) { return Date.now(); } }
    function eng() { return NS.engine || null; }
    function hooks() { return NS.hooks || null; }
    function coord() { return NS.coordinator || null; }

    function evt(k, data) {
      try {
        var e = { t: Date.now(), k: k };
        if (data) for (var x in data) e[x] = data[x];
        log.push(e);
        if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
      } catch (_) {}
    }
    function warn(where, e) {
      try { evt('error', { where: where, msg: String(e && e.message || e) }); console.warn('[hybrid-audio] main:', where, e); } catch (_) {}
    }
    function toExt(msg) {
      try { window.dispatchEvent(new CustomEvent('ha:to-ext', { detail: JSON.stringify(msg) })); return true; } catch (e) { return false; }
    }
    function pct(arr, p) {
      if (!arr.length) return null;
      var s = arr.slice().sort(function (a, b) { return a - b; });
      return s[Math.min(s.length - 1, Math.floor(p * s.length))];
    }
    function push(arr, v) { arr.push(v); if (arr.length > 2000) arr.shift(); }
    function measure() {
      try { var e = eng(); return (e && e.measure) || {}; } catch (_) { return {}; }
    }
    function labelOf(id) {
      if (client && id === client.you) return 'You';
      var n = nById[id];
      return 'Laptop ' + (n === undefined ? '?' : n);
    }

    // ---------- params ----------
    function setParams(p, origin) {
      try {
        if (!p || typeof p !== 'object') return;
        var clean = {};
        for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k) && typeof p[k] === 'number' && isFinite(p[k])) clean[k] = p[k];
        for (var k2 in clean) params[k2] = clean[k2];
        if (c && c.setParams) { try { c.setParams(clean); } catch (e) { warn('coord.setParams', e); } }
        if (m && m.setParams) { try { m.setParams(clean); } catch (e) { warn('member.setParams', e); } }
        var ep = {}, any = false;
        ENGINE_PARAMS.forEach(function (k) { if (k in clean) { ep[k] = clean[k]; any = true; } });
        var e = eng();
        if (any && e && e.setParams) { try { e.setParams(ep); } catch (err) { warn('engine.setParams', err); } }
        evt('params', { origin: origin || 'local', params: clean });
      } catch (e) { warn('setParams', e); }
    }

    // ---------- tab mute ----------
    function requestMute(muted) {
      var reqId = 'm' + (++muteSeq) + '-' + Math.floor(Math.random() * 1e6);
      lastMuteReq = muted; lastMuteReqAt = now();
      return new Promise(function (resolve) {
        var t = setTimeout(function () {
          if (mutePending[reqId]) { delete mutePending[reqId]; evt('muteTimeout', { muted: muted }); resolve(null); }
        }, MUTE_TIMEOUT_MS);
        mutePending[reqId] = { resolve: resolve, timer: t, muted: muted };
        toExt({ type: 'mute', muted: muted, reqId: reqId });
      });
    }
    function onMuted(msg) {
      var p = msg.reqId && mutePending[msg.reqId];
      if (typeof msg.muted === 'boolean') tabMuted = msg.muted;
      if (p) { clearTimeout(p.timer); delete mutePending[msg.reqId]; p.resolve(!!msg.muted); }
      evt('muted', { muted: msg.muted });
      maybeSendReady(false);
    }

    // ---------- ready ----------
    function computeReady() {
      if (!joined || !client || leaving || transitioning || !role) return 0;
      if (!measure().healthy) return 0;
      if (role === 'hub') return 1; // Hub gate/tab are driven by the coordinator; only health matters
      if (tabMuted !== true) return 0;
      var e = eng();
      if (e && e.gateApplied === 1 && !hubOwned) return 0;
      return 1;
    }
    function maybeSendReady(force) {
      if (!client) return;
      var r = computeReady();
      if (!force && r === lastReady) return;
      if (client.send({ t: 'ready', r: r })) { lastReady = r; evt('ready', { r: r }); }
    }

    // ---------- join flow ----------
    async function join(wasHub) {
      if (joined || joining || leaving) return;
      var e = eng(), CR = NS.RoomClient;
      if (!e || !CR) { evt('joinAbort', { why: 'modules' }); return; }
      if (!meet.meeting) { evt('joinAbort', { why: 'noMeeting' }); return; }
      if (!cfg.backendUrl || !cfg.token || !cfg.cid) { evt('joinAbort', { why: 'noBackend' }); return; }
      joining = true; userLeft = false;
      var tok = ++joinTok;
      try {
        evt('join', { meeting: meet.meeting, claim: wasHub ? 1 : 0 });
        e.setMode('controlled');
        await e.setGate(false);
        if (tok !== joinTok) return;
        var ok = await requestMute(true);
        if (ok === true) tabMuted = true;
        if (tok !== joinTok) return;
        client = new CR();
        wireClient(client);
        lastReady = null; role = null; curKey = null; hubOwned = false; lastGateReq = -1; lastHb = null;
        lostMap = {}; nById = {};
        joined = true;
        await client.connect({ url: cfg.backendUrl, meeting: meet.meeting, token: cfg.token, cid: cfg.cid, claim: wasHub ? 1 : 0 });
        if (tok !== joinTok) return;
        sendJoined();
      } catch (err) {
        warn('join', err);
        if (tok === joinTok) { try { await leave('joinError', { unmute: true }); } catch (_) {} }
      } finally {
        if (tok === joinTok) joining = false;
      }
    }

    function sendJoined() {
      toExt({ type: 'joined', joined: joined, meeting: meet.meeting, wasHub: role === 'hub' });
    }

    // ---------- leave ----------
    async function leave(reason, opts) {
      opts = opts || {};
      if ((!joined && !joining) || leaving) return;
      leaving = true;
      var myTok = ++joinTok; txnTok++;
      evt('leave', { reason: reason || 'ui' });
      var e = eng();
      try {
        try { if (e) await e.setGate(false); } catch (err) { warn('leave.gate', err); }
        if (client) {
          client.send({ t: 'leave' });
          client.close();
        }
      } catch (err) { warn('leave.close', err); }
      try { if (e) { e.setMode('passthrough'); if (e.setNoiseFreeze) e.setNoiseFreeze(false); } } catch (err) { warn('leave.mode', err); }
      joined = false; joining = false; role = null; c = null; m = null; client = null; curKey = null;
      transitioning = false; lastOut = null; lastMemberOut = null; lastFreeze = null; lastReady = null;
      yielding = false; if (yieldT) { clearTimeout(yieldT); yieldT = null; }
      userLeft = true;
      if (!opts.skipUnmute) {
        try { var ok = await requestMute(false); if (ok === false) tabMuted = false; } catch (err) { warn('leave.unmute', err); }
      }
      toExt({ type: 'joined', joined: false, meeting: meet.meeting, wasHub: false });
      leaving = false;
      sendStatus(true);
    }

    // ---------- room client wiring ----------
    function wireClient(cl) {
      cl.on('up', function () {
        evt('relayUp', { via: cl.via });
        if (c) { try { c.onRelay(true); } catch (e) { warn('onRelay', e); } }
      });
      cl.on('down', function (d) {
        evt('relayDown', d);
        if (c) { try { c.onRelay(false); } catch (e) { warn('onRelay', e); } }
      });
      cl.on('fatal', function (d) { evt('fatal', d); });
      cl.on('session', function (d) { evt('session', d); });
      cl.on('welcome', function () { lastReady = null; onRoomState('welcome'); });
      cl.on('roster', function () { onRoomState('roster'); });
      cl.on('pong', function (p) {
        if (p.rtt !== undefined) {
          push(sums.rtt, p.rtt);
          var t = Date.now();
          if (t - lastRttLogAt > 10000) { lastRttLogAt = t; evt('rtt', { ms: p.rtt }); }
        }
      });
      cl.on('lvl', function (x) {
        if (!c || transitioning) return;
        try {
          c.onLevel(x.from, { levelDb: x.l, noiseDb: x.z, act: !!x.a, healthy: !!x.h, userMuted: !!x.m, at: now() });
        } catch (e) { warn('onLevel', e); }
      });
      cl.on('applied', function (x) {
        if (!c || transitioning) return;
        if (client && x.e !== client.epoch) { evt('appliedStale', { from: x.from, e: x.e, g: x.g }); return; }
        evt('applied', { from: x.from, g: x.g, gate: x.gate });
        try { c.onApplied(x.from, x.g, x.gate); } catch (e) { warn('onApplied', e); }
      });
      cl.on('lost', function (x) {
        evt('lost', { id: x.cid });
        if (role === 'hub' && c) {
          if (nById[x.cid] !== undefined) lostMap[x.cid] = nById[x.cid];
          try { c.onLost(x.cid); } catch (e) { warn('onLost', e); }
        }
      });
      cl.on('left', function (x) {
        evt('left', { id: x.cid });
        delete lostMap[x.cid];
        if (role === 'hub' && c) { try { c.onLeft(x.cid); } catch (e) { warn('onLeft', e); } }
      });
      cl.on('want', function (x) { if (role === 'hub') yieldTo(x.from); });
      cl.on('cfg', function (x) { setParams(x.params, 'relay'); });
      cl.on('cmd', function (x) {
        if (role !== 'member' || !m || transitioning) return;
        try {
          var d = m.onCommand({ e: x.e, g: x.g, op: x.op });
          if (d === null || d === undefined) { evt('cmdStale', { e: x.e, g: x.g, op: x.op }); return; }
          evt('cmdIn', { op: x.op, e: x.e, g: x.g });
          applyMemberGate(d ? 1 : 0, { e: x.e, g: x.g });
        } catch (e) { warn('onCommand', e); }
      });
      cl.on('hb', function (x) {
        if (role !== 'member' || !m) return;
        lastHb = { e: x.e, s: x.s, o: x.o };
        try { m.onHeartbeat(now(), { e: x.e, s: x.s, o: x.o }); } catch (e) { warn('onHeartbeat', e); }
      });
    }

    function rosterForCoord() {
      var out = [], self = client.you, seenSelf = false;
      client.roster.forEach(function (r) {
        nById[r.cid] = r.n;
        delete lostMap[r.cid];
        if (r.cid === self) { seenSelf = true; out.push({ id: r.cid, ready: true, n: r.n }); }
        else out.push({ id: r.cid, ready: !!r.ready, n: r.n });
      });
      if (!seenSelf) out.push({ id: self, ready: true, n: 0 });
      return out;
    }

    function onRoomState(why) {
      try {
        if (!joined || !client || !client.you) return;
        client.roster.forEach(function (r) { nById[r.cid] = r.n; });
        var want = client.hub === client.you ? 'hub' : 'member';
        var key = want + '|' + client.epoch + '|' + client.sid;
        if (key !== curKey) { beginRole(want, key, why); return; }
        if (role === 'hub' && c && !transitioning) {
          try { c.onRoster(rosterForCoord()); } catch (e) { warn('onRoster', e); }
        }
        maybeSendReady(false);
      } catch (e) { warn('onRoomState', e); }
    }

    // On role / epoch / session change: close the gate first, then build the new role and re-ready.
    async function beginRole(want, key, why) {
      var tok = ++txnTok;
      var prevRole = role;
      curKey = key; transitioning = true; c = null; m = null; hubOwned = false; lastGateReq = -1; lastHb = null;
      lastOut = null; lastMemberOut = null; lastPauseSig = ''; seenCmd = {};
      evt('role', { from: prevRole, to: want, epoch: client.epoch, sid: client.sid, why: why });
      maybeSendReady(true); // r:0 while transitioning
      var e = eng();
      try { if (e) await e.setGate(false); } catch (err) { warn('beginRole.gate', err); }
      if (tok !== txnTok || !joined || !client) return;
      try {
        var C = coord();
        if (want === 'hub') {
          c = new C.Coordinator({ selfId: client.you, params: params });
          role = 'hub';
          lastFreeze = null; lastMuteReq = null;
          c.onRoster(rosterForCoord());
          c.onRelay(!!client.up);
        } else {
          m = new C.MemberAgent({ params: params });
          m.onEpoch(client.epoch);
          role = 'member';
          if (tabMuted !== true) requestMute(true);
        }
      } catch (err) { warn('beginRole.create', err); }
      transitioning = false;
      // Reconnects must claim the role we hold now, not the one we joined with.
      try { if (client && client.opts) client.opts.claim = role === 'hub' ? 1 : 0; } catch (_) {}
      if (prevRole !== role) sendJoined();
      maybeSendReady(true);
      sendStatus(true);
    }

    function yieldTo(to) {
      if (role !== 'hub' || yielding || !client) return;
      yielding = true;
      evt('yield', { to: to });
      (async function () {
        try { var e = eng(); if (e) await e.setGate(false); } catch (err) { warn('yield.gate', err); }
        if (client && role === 'hub') client.send({ t: 'yield', to: to });
      })();
      yieldT = setTimeout(function () { yielding = false; yieldT = null; }, YIELD_TIMEOUT_MS);
    }

    // ---------- member gate ----------
    function applyMemberGate(target, ack) {
      var e = eng();
      if (!e) return;
      lastGateReq = target;
      var tok = txnTok;
      e.setGate(!!target).then(function (r) {
        var g = r && r.gate ? 1 : 0;
        if (tok === txnTok) hubOwned = g === 1;
        if (ack && client && role === 'member' && tok === txnTok) {
          client.send({ t: 'applied', e: ack.e, g: ack.g, gate: g });
          evt('appliedOut', { g: ack.g, gate: g });
        }
        maybeSendReady(false);
      }, function (err) { warn('member.setGate', err); });
    }

    // ---------- tick ----------
    function step(t) {
      lastStepAt = t;
      try {
        if (!joined || !client || leaving) { maybeStatus(t); return; }
        client.pump(t);
        var meas = measure();
        if (!transitioning && role === 'hub' && c && !yielding) hubStep(t, meas);
        else if (!transitioning && role === 'member' && m) memberStep(t, meas);
        maybeSendReady(false);
      } catch (e) { warn('step', e); }
      maybeStatus(t);
    }

    function safeRemote() {
      try { var h = hooks(); if (h && h.pollRemote) return h.pollRemote(); } catch (e) {}
      return { identified: false, sources: [] };
    }

    function hubStep(t, meas) {
      var cc = c, e = eng();
      cc.onLevel(client.you, {
        levelDb: meas.levelDb, noiseDb: meas.noiseDb, act: !!meas.act, healthy: !!meas.healthy, userMuted: !!meas.userMuted, at: t
      });
      var out = cc.tick(t, safeRemote());
      if (cc !== c || !out) return;
      lastOut = out;
      var evs = out.events || [];
      for (var i = 0; i < evs.length; i++) logCoordEvent(evs[i]);
      var sig = out.pause ? (out.pause.reason + '|' + (out.pause.id || '')) : '';
      if (sig !== lastPauseSig) {
        lastPauseSig = sig;
        if (out.pause) {
          evt('pause', { reason: out.pause.reason, id: out.pause.id });
          sums.pauses[out.pause.reason] = (sums.pauses[out.pause.reason] || 0) + 1;
        } else evt('pauseEnd');
      }
      var cmds = out.commands || [];
      for (var j = 0; j < cmds.length; j++) {
        var cm = cmds[j], k = cm.to + '|' + cm.gen;
        if (!seenCmd[k]) { seenCmd[k] = 1; evt('cmd', { to: cm.to, op: cm.op, g: cm.gen }); if (Object.keys(seenCmd).length > 200) seenCmd = {}; }
        if (cm.to === client.you) applySelf(cc, cm);
        else client.send({ t: 'cmd', to: cm.to, op: cm.op, e: client.epoch, g: cm.gen });
      }
      // tab mute: on change, and re-asserted every 2 s
      if (typeof out.tabMuted === 'boolean' && (out.tabMuted !== lastMuteReq || t - lastMuteReqAt >= MUTE_REASSERT_MS)) {
        requestMute(out.tabMuted);
      }
      if (out.freezeNoise !== lastFreeze) {
        lastFreeze = out.freezeNoise;
        try { if (e && e.setNoiseFreeze) e.setNoiseFreeze(!!out.freezeNoise); } catch (err) { warn('freeze', err); }
      }
      if (t - lastHbAt >= HB_MS) {
        lastHbAt = t;
        client.send({ t: 'hb', e: client.epoch, s: out.state, o: out.owner || null });
      }
    }

    function applySelf(cc, cm) {
      var e = eng();
      if (!e) return;
      var want = cm.op === 'open';
      var tok = txnTok;
      e.setGate(want).then(function (r) {
        if (cc !== c || tok !== txnTok) return;
        var g = r && r.gate ? 1 : 0;
        try { cc.onApplied(client.you, cm.gen, g); } catch (err) { warn('self.onApplied', err); }
      }, function (err) { warn('self.setGate', err); });
    }

    function logCoordEvent(ev) {
      if (!ev) return;
      if (ev.type === 'state') { sums.stateCounts[ev.to] = (sums.stateCounts[ev.to] || 0) + 1; }
      else if (ev.type === 'switch' && typeof ev.ms === 'number') push(sums.switchMs, ev.ms);
      else if (ev.type === 'remote' && typeof ev.ms === 'number') push(sums.remoteMs, ev.ms);
      var d = {};
      for (var x in ev) if (x !== 'type') d[x] = ev[x];
      d.ev = ev.type;
      evt('coord', d);
    }

    function memberStep(t, meas) {
      var e = eng(), mm = m;
      var r = mm.tick(t, { relayUp: !!client.up });
      if (mm !== m || !r) return;
      lastMemberOut = r;
      if (e && e.setNoiseFreeze && r.freezeNoise !== lastFreeze) { lastFreeze = !!r.freezeNoise; try { e.setNoiseFreeze(lastFreeze); } catch (err) {} }
      var desired = r.gate ? 1 : 0;
      if (desired !== lastGateReq && (!e || e.gateApplied !== desired || lastGateReq === -1)) {
        if (e && e.gateApplied === desired) lastGateReq = desired; else applyMemberGate(desired, null);
      } else if (desired === 0 && e && e.gateApplied === 1) {
        applyMemberGate(0, null); // e.g. watchdog: make sure the gate really closed
      }
      if (r.watchdog && !lastMemberOut._logged) { evt('watchdog'); }
      if (tabMuted !== true && t - lastMuteReqAt >= MUTE_REASSERT_MS) requestMute(true);
      client.sendLevel(meas, t);
    }

    function maybeStatus(t) {
      if (t - lastStatusAt >= STATUS_MS) sendStatus(false);
    }

    // ---------- status (Contract E) ----------
    function sendStatus(force) {
      try {
        lastStatusAt = now();
        toExt({ type: 'status', status: buildStatus() });
      } catch (e) { warn('status', e); }
    }

    function buildStatus() {
      var meas = measure(), e = eng();
      var hub = role === 'hub';
      var out = hub ? lastOut : null;
      var you = client && client.you;
      var ownerId = hub ? (out && out.owner || null) : (lastHb && lastHb.o || null);
      var state = hub ? (out ? out.state : null) : (lastHb ? lastHb.s || null : null);
      var laptops = [];
      if (joined && client) {
        var seen = {};
        client.roster.forEach(function (r) {
          seen[r.cid] = 1;
          laptops.push({ id: r.cid, label: r.cid === you ? 'You' : 'Laptop ' + r.n, hub: r.cid === client.hub, owner: r.cid === ownerId,
            ready: r.cid === you ? !!computeReady() : !!r.ready, lost: false });
        });
        var lostIds = Object.keys(lostMap);
        if (client.hubLost && lostIds.indexOf(client.hubLost) < 0) lostIds.push(client.hubLost);
        lostIds.forEach(function (id) {
          if (seen[id]) return;
          laptops.push({ id: id, label: 'Laptop ' + (nById[id] === undefined ? '?' : nById[id]), hub: false, owner: false, ready: false, lost: true });
        });
      }
      var pause = null, actions = [];
      if (joined && role === 'hub') {
        pause = out ? out.pause || null : null;
        actions = out ? (out.actions || []).slice() : [];
      } else if (joined && role === 'member') {
        if (!client.up) pause = { reason: 'relay' };
        else if (lastMemberOut && lastMemberOut.watchdog) pause = { reason: 'hub' };
        actions = ['makeHub'];
        if (client.up && !client.hub) actions.push('takeOver');
      }
      var floor = null;
      if (joined && role) floor = (state === 'REMOTE' || state === 'REMOTE_PENDING') ? 'remote' : 'room';
      return {
        inCall: !!meet.inCall, meeting: meet.meeting || null, joined: !!joined, role: joined ? role : null,
        state: joined ? state : null, floor: floor, laptops: laptops,
        ownerLabel: ownerId ? labelOf(ownerId) : null, pause: pause, actions: actions,
        relayUp: !!(client && client.up), via: client ? client.via : null,
        sid: client ? client.sid : null, epoch: client ? client.epoch : null,
        remote: (out && out.remote) || { enrolled: 0, identified: false, learnedRoom: 0 },
        engine: {
          levelDb: meas.levelDb, noiseDb: meas.noiseDb, act: !!meas.act, gate: e ? e.gateApplied : null, meter: meas.meter || 'none',
          ctxState: meas.ctxState || null, healthy: !!meas.healthy, userMuted: !!meas.userMuted
        },
        rtt: client ? client.rtt : 0, backendConfigured: !!(cfg.backendUrl && cfg.token)
      };
    }

    // ---------- log dump ----------
    function buildDump() {
      return {
        params: Object.assign({}, params),
        log: log.slice(),
        summary: {
          switchMs: { p50: pct(sums.switchMs, 0.5), p95: pct(sums.switchMs, 0.95), n: sums.switchMs.length },
          remoteMs: { p50: pct(sums.remoteMs, 0.5), p95: pct(sums.remoteMs, 0.95), n: sums.remoteMs.length },
          rtt: { p50: pct(sums.rtt, 0.5), p95: pct(sums.rtt, 0.95), n: sums.rtt.length },
          stateCounts: Object.assign({}, sums.stateCounts),
          pauses: Object.assign({}, sums.pauses)
        }
      };
    }

    // ---------- UI actions ----------
    function onUi(action, arg) {
      try {
        evt('ui', { action: action, arg: arg === undefined ? null : arg });
        switch (action) {
          case 'join':
            if (!meet.inCall) { evt('joinAbort', { why: 'notInCall' }); break; }
            join(false);
            break;
          case 'leave': leave('ui'); break;
          case 'applyRoom':
            if (arg && typeof arg === 'object') {
              setParams(arg, 'applyRoom');
              if (client) client.send({ t: 'cfg', params: arg });
            }
            break;
          case 'makeHub': if (client && role === 'member') client.send({ t: 'want' }); break;
          case 'takeOver': if (client && role === 'member') client.send({ t: 'take' }); break;
          case 'hubOnly': case 'resume': case 'dropLost': case 'soundCheck': case 'continueSolo': case 'resetIds':
            if (role === 'hub' && c) {
              if (action === 'dropLost' && arg) delete lostMap[arg];
              c.action(action, arg);
            }
            break;
        }
      } catch (e) { warn('ui', e); }
    }

    // ---------- bridge messages ----------
    function onConfig(msg) {
      if (typeof msg.backendUrl === 'string') cfg.backendUrl = msg.backendUrl;
      if (typeof msg.token === 'string') cfg.token = msg.token;
      if (typeof msg.cid === 'string') cfg.cid = msg.cid;
      cfg.autoJoin = msg.autoJoin && typeof msg.autoJoin === 'object' ? msg.autoJoin : null;
      if (typeof msg.workletUrl === 'string' && msg.workletUrl !== cfg.workletUrl) {
        cfg.workletUrl = msg.workletUrl;
        try { var e = eng(); if (e && e.setWorkletUrl) e.setWorkletUrl(msg.workletUrl); } catch (err) { warn('workletUrl', err); }
      }
      if (msg.params) setParams(msg.params, 'config');
      evt('config', { backend: !!cfg.backendUrl, token: !!cfg.token, autoJoin: cfg.autoJoin });
      maybeAutoJoin();
    }

    function maybeAutoJoin() {
      try {
        var a = cfg.autoJoin;
        if (!a || joined || joining || leaving || userLeft || autoJoinTried) return;
        if (!meet.meeting || !meet.inCall || a.meeting !== meet.meeting) return;
        autoJoinTried = true;
        evt('autoJoin', { wasHub: !!a.wasHub });
        join(!!a.wasHub);
      } catch (e) { warn('autoJoin', e); }
    }

    function onBridge(ev) {
      var msg;
      try { msg = JSON.parse(ev.detail); } catch (e) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      try {
        switch (msg.type) {
          case 'config': onConfig(msg); break;
          case 'ui': onUi(msg.action, msg.arg); break;
          case 'muted': onMuted(msg); break;
          case 'getLog': toExt({ type: 'logDump', reqId: msg.reqId, log: buildDump() }); break;
          case 'sync': if (joined) sendJoined(); sendStatus(true); break;
          case 'cfgOut':
            if (client && msg.params) { client.send({ t: 'cfg', params: msg.params }); setParams(msg.params, 'cfgOut'); }
            break;
        }
      } catch (e) { warn('bridge', e); }
    }

    // ---------- meet state ----------
    function onMeetState(s) {
      try {
        if (!s) return;
        var prevIn = meet.inCall;
        meet = { meeting: s.meeting || null, inCall: !!s.inCall };
        if (meet.inCall !== prevIn) evt('meet', { meeting: meet.meeting, inCall: meet.inCall });
        if (meet.inCall) {
          if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
          maybeAutoJoin();
        } else if ((joined || joining) && !leaveTimer) {
          // debounce: Meet's connection state can flicker
          leaveTimer = setTimeout(function () {
            leaveTimer = null;
            if (meet.inCall || !(joined || joining)) return;
            if (pageLeaving) {
              // Reload/navigation: close the gate but keep the session (Hub grace reclaim) and the auto-rejoin memory.
              try { var e = eng(); if (e) e.setGate(false); } catch (_) {}
              return;
            }
            leave('callEnded', { skipUnmute: false });
          }, LEAVE_DEBOUNCE_MS);
        }
        sendStatus(true);
      } catch (e) { warn('onMeetState', e); }
    }

    // ---------- init ----------
    function hookTick() {
      if (tickHooked) return;
      var e = eng();
      if (e && e.onTick) { try { e.onTick(function () { step(now()); }); tickHooked = true; } catch (err) { warn('onTick', err); } }
    }

    function init() {
      window.addEventListener('ha:to-page', onBridge);
      window.addEventListener('pagehide', function () { pageLeaving = true; });
      window.addEventListener('beforeunload', function () { pageLeaving = true; });
      window.addEventListener('pageshow', function () { pageLeaving = false; });
      hookTick();
      try { var h = hooks(); if (h && h.getMeetState) { var s = h.getMeetState(); if (s) meet = { meeting: s.meeting || null, inCall: !!s.inCall }; } } catch (e) {}
      // Fallback driver if the audio clock stalls or timers are all we have.
      setInterval(function () {
        hookTick();
        var t = now();
        if (t - lastStepAt >= STEP_FALLBACK_MS) step(t);
        else maybeStatus(t);
      }, STATUS_MS);
    }

    // Read-only debug accessor (used by test/e2e/run.mjs).
    function _debug() {
      var st = buildStatus(), e = eng();
      var hub = role === 'hub';
      return {
        joined: !!joined, role: joined ? role : null, state: st.state, owner: hub ? (lastOut && lastOut.owner || null) : (lastHb && lastHb.o || null),
        epoch: client ? client.epoch : null, sid: client ? client.sid : null, you: client ? client.you : null,
        gate: e ? e.gateApplied : null, laptops: st.laptops, pause: st.pause, relayUp: st.relayUp, tabMuted: tabMuted
      };
    }

    var api = { onMeetState: onMeetState, _debug: _debug };
    Object.defineProperty(NS, 'main', { value: api, enumerable: false, configurable: true, writable: true });
    init();
  } catch (e) {
    try { console.warn('[hybrid-audio] main init failed', e); } catch (_) {}
  }
})();
