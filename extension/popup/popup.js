(() => {
  const MEET = 'https://meet.google.com/';
  const $ = (id) => document.getElementById(id);

  let tabId = null;
  let isMeet = false;
  let mode = 'auto';
  let status = null;
  let port = null;

  const fmt = (n, d = 0) => (typeof n === 'number' && isFinite(n) ? n.toFixed(d) : '-');

  // ---------- render ----------
  function renderMode() {
    for (const b of $('seg').children) {
      b.setAttribute('aria-checked', String(b.dataset.mode === mode));
      b.disabled = !isMeet;
    }
  }

  function derive() {
    const s = status;
    const m = (s && s.mode) || mode;
    if (!isMeet || !s || !s.inCall) return { c: 'gray', label: 'No call', meta: '' };
    if (m === 'off') return { c: 'gray', label: 'Off', meta: '' };
    const meta = s.roomSize > 0 ? `${s.roomSize} in room` : typeof s.rtt === 'number' && s.rtt > 0 ? `rtt ${Math.round(s.rtt)}ms` : '';
    if (s.state === 'solo') return { c: 'gray', label: 'Solo', meta };
    if (s.isHub) return { c: 'green', label: 'Hub', meta };
    if (s.state === 'remote') return { c: 'amber', label: 'Remote talking', meta };
    if ((s.gain || 0) > 0.3) return { c: 'blue', label: 'Mic live', meta };
    return { c: 'gray', label: 'Mic off', meta };
  }

  function warning() {
    const s = status;
    if (!isMeet || !s || !s.inCall) return '';
    const m = s.mode || mode;
    if (m === 'off') return '';
    if (s.ctxState === 'suspended') return 'Click the Meet tab to enable audio';
    if (s.everConnected && !s.connected) return 'Connection lost · fallback';
    if (m === 'auto' && !s.backendConfigured) return 'No backend · pick Hub or Member';
    if (m === 'auto' && !s.everConnected && !s.connected) return 'Offline · pick Hub or Member';
    return '';
  }

  const dbPct = (db) => (typeof db === 'number' && isFinite(db) ? Math.max(0, Math.min(1, (db + 70) / 70)) * 100 : 0);

  function render() {
    renderMode();
    const d = derive();
    $('dot').dataset.c = d.c;
    $('label').textContent = d.label;
    $('meta').textContent = d.meta;
    const w = warning();
    $('warn').hidden = !w;
    $('warn').textContent = w;
    const s = status && isMeet ? status : null;
    $('meterFill').style.width = (s ? dbPct(s.selfDb) : 0) + '%';
    const mk = $('gainMark');
    if (s && typeof s.gain === 'number') {
      mk.style.display = 'block';
      mk.style.left = `calc(${s.gain > 0 ? dbPct(20 * Math.log10(s.gain)) : 0}% - 1px)`;
    } else mk.style.display = 'none';
    renderReadouts();
  }

  /* TEST PANEL START */
  const DEFAULTS = {
    shareExponent: 2, idleDuckDb: -12, vadOnsetDb: 9,
    remoteOnDb: -50, remoteOnMs: 300, remoteHoldMs: 500, roomHoldMs: 500,
  };
  const SLIDERS = [
    ['shareExponent', 'shareExponent', 1, 4, 0.5],
    ['idleDuckDb', 'idleDuckDb', -30, 0, 1],
    ['vadOnsetDb', 'vadOnsetDb', 4, 16, 1],
    ['remoteOnDb', 'remoteOnDb', -70, -30, 1],
    ['remoteOnMs', 'remoteOnMs', 100, 800, 10],
    ['remoteHoldMs', 'remoteHoldMs', 200, 1500, 10],
    ['roomHoldMs', 'roomHoldMs', 200, 1500, 10],
  ];
  const sliderEls = {};
  let sending = null;
  const pending = {};

  function buildSliders() {
    const host = $('sliders');
    for (const [key, label, min, max, step] of SLIDERS) {
      const wrap = document.createElement('label');
      wrap.className = 'sl';
      const name = document.createElement('span');
      name.textContent = label;
      const out = document.createElement('output');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = min; input.max = max; input.step = step;
      input.value = DEFAULTS[key];
      out.textContent = input.value;
      input.addEventListener('input', () => {
        out.textContent = input.value;
        pending[key] = Number(input.value);
        clearTimeout(sending);
        sending = setTimeout(flushParams, 120);
      });
      wrap.append(name, out, input);
      host.append(wrap);
      sliderEls[key] = { input, out };
    }
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
      sliderEls[key].out.textContent = String(v);
    }
  }

  function srcSummary(src) {
    if (typeof src === 'number') return String(src);
    let list = [];
    if (Array.isArray(src)) list = src.map((x) => (x && (x.cls || x.class || x.kind)) || 'unknown');
    else if (src && typeof src === 'object') list = Object.values(src).map((x) => (typeof x === 'string' ? x : (x && (x.cls || x.class)) || 'unknown'));
    else return '-';
    const n = { remote: 0, room: 0, unknown: 0 };
    for (const c of list) n[c in n ? c : 'unknown']++;
    return `${n.remote}R ${n.room}M ${n.unknown}?`;
  }

  function renderReadouts() {
    const s = status && isMeet ? status : null;
    const set = (id, v) => { $(id).textContent = v; };
    set('r-state', s ? `${s.state || '-'}${s.isHub ? ' (hub)' : ''}` : '-');
    set('r-gain', s ? fmt(s.gain, 2) : '-');
    set('r-mic', s ? `${fmt(s.selfDb, 0)} / ${fmt(s.floorDb, 0)} dB` : '-');
    set('r-remote', s ? `${fmt(s.remoteDb, 0)} dB` : '-');
    set('r-ident', s ? String(!!s.identified) : '-');
    set('r-src', s ? srcSummary(s.sources) : '-');
    set('r-rtt', s && typeof s.rtt === 'number' ? `${Math.round(s.rtt)} ms` : '-');
    set('r-part', s ? String(!!s.participating) : '-');
  }

  function initTestPanel() {
    buildSliders();
    $('reset').addEventListener('click', () => {
      for (const k in pending) delete pending[k];
      send({ type: 'resetParams' });
      applyParams({});
    });
    $('copyLog').addEventListener('click', () => send({ type: 'getLog', tabId }));
    $('saveBackend').addEventListener('click', () => {
      send({ type: 'setBackend', url: $('backendUrl').value.trim() });
      flash($('saveBackend'), 'Saved');
    });
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

  function onParams(msg) {
    applyParams(msg.params || {});
    if (document.activeElement !== $('backendUrl')) $('backendUrl').value = msg.backendUrl || '';
  }
  /* TEST PANEL END */

  // ---------- wiring ----------
  function send(m) {
    try { port && port.postMessage(m); } catch (e) {}
  }

  function onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'status') {
      if (msg.tabId !== tabId) return;
      status = msg.status;
      if (msg.mode) mode = msg.mode;
      render();
    } else if (msg.type === 'log') {
      onLog(msg);
    } else if (msg.type === 'params') {
      onParams(msg);
    }
  }

  async function init() {
    initTestPanel();
    $('seg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      mode = b.dataset.mode;
      renderMode();
      send({ type: 'setMode', tabId, mode });
    });
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
