(() => {
  const MEET = 'https://meet.google.com/';
  const $ = (id) => document.getElementById(id);

  let tabId = null;
  let isMeet = false;
  let status = null;
  let settings = { backendUrl: '', tokenSet: false, params: {} };
  let port = null;

  const fmt = (n, d = 0) => (typeof n === 'number' && isFinite(n) ? n.toFixed(d) : '-');

  const ACTION_LABELS = {
    hubOnly: 'Use Hub only',
    resume: 'Resume',
    soundCheck: 'Sound check',
    continueSolo: 'Continue on this laptop',
    takeOver: 'Take over as Hub',
  };

  function send(m) {
    try { port && port.postMessage(m); } catch (e) {}
  }

  function ui(action, arg) {
    send({ type: 'ui', tabId, action, arg: arg ?? null });
  }

  function laptopOf(s, id) {
    return (s.laptops || []).find((l) => l && l.id === id);
  }

  function reasonText(s) {
    const p = s.pause;
    if (!p) return '';
    switch (p.reason) {
      case 'relay': return 'Relay lost';
      case 'ownerLost': {
        const l = p.id != null ? laptopOf(s, p.id) : (s.laptops || []).find((x) => x && x.lost);
        return `${l ? l.label : 'Laptop'} lost`;
      }
      case 'ackTimeout': return 'No confirmation';
      case 'unhealthy': return 'Audio not running';
      default: return 'Paused';
    }
  }

  function actionList(s) {
    const out = [];
    for (const a of Array.isArray(s.actions) ? s.actions : []) {
      const name = typeof a === 'string' ? a : a && a.action;
      if (!name) continue;
      if (name === 'dropLost') {
        const id = (a && a.id) ?? (s.pause && s.pause.id) ?? ((s.laptops || []).find((l) => l && l.lost) || {}).id;
        const l = id != null ? laptopOf(s, id) : null;
        out.push({ name, arg: id ?? null, label: `Continue without ${l ? l.label : 'laptop'}` });
      } else if (ACTION_LABELS[name]) out.push({ name, arg: null, label: ACTION_LABELS[name] });
    }
    return out;
  }

  // ---------- render ----------
  function render() {
    const s = isMeet && status && status.inCall ? status : null;
    const joined = !!(s && s.joined);
    $('none').hidden = !!s;
    $('join').hidden = !(s && !joined);
    $('joined').hidden = !joined;
    if (s && !joined) {
      const w = $('joinWarn');
      if (!w.dataset.t) w.dataset.t = w.textContent;
      const noBackend = !(s.backendConfigured != null ? !!s.backendConfigured : !!settings.backendUrl);
      w.textContent = s.error || w.dataset.t;
      w.hidden = !(s.error || noBackend);
    }
    if (joined) renderJoined(s);
    renderReadouts();
  }

  function renderJoined(s) {
    const role = s.role === 'member' ? 'member' : 'hub';
    const chip = $('role');
    chip.dataset.role = role;
    chip.textContent = role === 'hub' ? 'Hub' : 'Member';
    const n = (s.laptops || []).length;
    $('count').textContent = `${n} laptop${n === 1 ? '' : 's'}`;
    $('owner').textContent = s.ownerLabel || '-';
    const f = s.floor === 'remote' ? 'remote' : s.floor === 'room' ? 'room' : null;
    const pill = $('floor');
    pill.hidden = !f;
    if (f) {
      pill.dataset.f = f;
      pill.textContent = f === 'remote' ? 'Remote' : 'Room';
    }

    const ul = $('laptops');
    ul.textContent = '';
    for (const l of s.laptops || []) {
      const li = document.createElement('li');
      li.dataset.lost = l.lost ? '1' : '0';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = l.label || '-';
      const dots = document.createElement('span');
      dots.className = 'dots';
      for (const [k, on, t] of [['hub', l.hub, 'Hub'], ['owner', l.owner, 'Mic'], ['ready', l.ready, 'Ready'], ['lost', l.lost, 'Lost']]) {
        const d = document.createElement('i');
        if (on) {
          d.className = 'd';
          d.dataset.k = k;
          d.title = t;
        }
        dots.append(d);
      }
      li.append(name, dots);
      ul.append(li);
    }

    const reason = reasonText(s);
    const acts = actionList(s);
    $('issue').hidden = !reason && !acts.length;
    $('reason').hidden = !reason;
    $('reason').textContent = reason;
    const host = $('acts');
    host.textContent = '';
    for (const a of acts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = a.label;
      b.addEventListener('click', () => ui(a.name, a.arg));
      host.append(b);
    }
    $('makeHubBtn').hidden = role !== 'member';
  }

  /* DEBUG PANEL START */
  const DEFAULTS = {
    switchAdvantageDb: 6, switchSustainMs: 100, minOwnMs: 300,
    remoteOnDb: -50, remoteOnMs: 40, remoteHoldMs: 300, settleMs: 150,
    vadOnsetDb: 9, minSpeechDb: -55, handoffOverlap: 1,
  };
  const SLIDERS = [
    ['switchAdvantageDb', 2, 12, 0.5],
    ['switchSustainMs', 40, 400, 10],
    ['minOwnMs', 100, 1000, 10],
    ['remoteOnDb', -70, -30, 1],
    ['remoteOnMs', 20, 200, 5],
    ['remoteHoldMs', 100, 1000, 10],
    ['settleMs', 50, 500, 10],
    ['vadOnsetDb', 4, 16, 1],
    ['minSpeechDb', -70, -30, 1],
  ];
  const sliderEls = {};
  let sending = null;
  const pending = {};

  function buildSliders() {
    const host = $('sliders');
    for (const [key, min, max, step] of SLIDERS) {
      const wrap = document.createElement('label');
      wrap.className = 'sl';
      const name = document.createElement('span');
      name.textContent = key;
      const out = document.createElement('output');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = min; input.max = max; input.step = step;
      input.value = DEFAULTS[key];
      out.textContent = input.value;
      input.addEventListener('input', () => {
        out.textContent = input.value;
        queue(key, Number(input.value));
      });
      wrap.append(name, out, input);
      host.append(wrap);
      sliderEls[key] = { input, out };
    }
    $('handoffOverlap').addEventListener('change', () => queue('handoffOverlap', $('handoffOverlap').checked ? 1 : 0));
  }

  function queue(key, val) {
    pending[key] = val;
    clearTimeout(sending);
    sending = setTimeout(flushParams, 120);
  }

  function flushParams() {
    const p = { ...pending };
    for (const k in pending) delete pending[k];
    if (!Object.keys(p).length) return;
    send({ type: 'setParams', params: p, room: $('applyRoom').checked });
  }

  function applyParams(p) {
    for (const key in sliderEls) {
      if (key in pending) continue;
      const v = p && typeof p[key] === 'number' ? p[key] : DEFAULTS[key];
      sliderEls[key].input.value = v;
      sliderEls[key].out.textContent = String(sliderEls[key].input.value);
    }
    if (!('handoffOverlap' in pending)) {
      const h = p && typeof p.handoffOverlap === 'number' ? p.handoffOverlap : DEFAULTS.handoffOverlap;
      $('handoffOverlap').checked = !!h;
    }
  }

  function renderReadouts() {
    const s = status && isMeet ? status : null;
    const e = (s && s.engine) || {};
    const r = (s && s.remote) || {};
    const set = (id, v) => { $(id).textContent = v; };
    set('r-state', s ? String(s.state || '-') : '-');
    set('r-gate', s && e.gate != null ? String(e.gate) : '-');
    set('r-level', s ? `${fmt(e.levelDb)} / ${fmt(e.noiseDb)} dB` : '-');
    set('r-act', s && e.act != null ? String(e.act ? 1 : 0) : '-');
    set('r-meter', s ? String(e.meter || '-') : '-');
    set('r-via', s ? String(s.via || '-') : '-');
    set('r-rtt', s && typeof s.rtt === 'number' ? `${Math.round(s.rtt)} ms` : '-');
    set('r-sid', s ? `${s.sid ? String(s.sid).slice(0, 6) : '-'} / ${s.epoch ?? '-'}` : '-');
    set('r-ident', s ? String(!!r.identified) : '-');
    set('r-enrolled', s ? `${r.enrolled ?? '-'} / ${r.learnedRoom ?? '-'}` : '-');
    set('r-ctx', s ? String(e.ctxState || '-') : '-');
  }

  function flash(btn, text) {
    const old = btn.dataset.t || btn.textContent;
    btn.dataset.t = old;
    btn.textContent = text;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = old; }, 1200);
  }

  async function onLog(msg) {
    if (msg.tabId !== tabId) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(msg.log, null, 2));
      flash($('copyLog'), msg.log == null ? 'No log' : 'Copied');
    } catch (e) {
      flash($('copyLog'), 'Failed');
    }
  }

  function onSettings(msg) {
    settings = { backendUrl: msg.backendUrl || '', tokenSet: !!msg.tokenSet, params: msg.params || {} };
    applyParams(settings.params);
    if (document.activeElement !== $('backendUrl')) $('backendUrl').value = settings.backendUrl;
    if (document.activeElement !== $('token')) $('token').placeholder = settings.tokenSet ? 'Token (set)' : 'Token';
    render();
  }

  function initDebug() {
    buildSliders();
    $('resetParams').addEventListener('click', () => {
      for (const k in pending) delete pending[k];
      send({ type: 'resetParams' });
      applyParams({});
    });
    $('resetIds').addEventListener('click', () => { ui('resetIds'); flash($('resetIds'), 'Done'); });
    $('copyLog').addEventListener('click', () => send({ type: 'getLog', tabId }));
    $('saveBackend').addEventListener('click', () => {
      send({ type: 'setBackend', url: $('backendUrl').value.trim(), token: $('token').value.trim() });
      $('token').value = '';
      flash($('saveBackend'), 'Saved');
    });
  }
  /* DEBUG PANEL END */

  // ---------- wiring ----------
  function onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'status') {
      if (msg.tabId !== tabId) return;
      status = msg.status;
      render();
    } else if (msg.type === 'log') {
      onLog(msg);
    } else if (msg.type === 'settings') {
      onSettings(msg);
    }
  }

  async function init() {
    initDebug();
    $('joinBtn').addEventListener('click', () => ui('join'));
    $('leaveBtn').addEventListener('click', () => ui('leave'));
    $('makeHubBtn').addEventListener('click', () => ui('makeHub'));
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab ? tab.id : null;
      isMeet = !!(tab && tab.url && tab.url.startsWith(MEET));
    } catch (e) {}
    render();
    port = chrome.runtime.connect({ name: 'ha-popup' });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => { port = null; });
    if (tabId != null) send({ type: 'subscribe', tabId });
  }

  init();
})();
