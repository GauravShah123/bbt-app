// ISOLATED-world bridge: page (MAIN) <-> service worker relay, plus the WebSocket pipe
// (direct first; falls back to a service-worker proxy after two failed attempts in a row).
(() => {
  let port = null;
  let dead = false;
  let delay = 100;
  let timer = null;

  // WebSocket pipe state
  let ws = null; // direct socket
  let proxyOpen = false; // SW owns a socket for this tab
  let mode = 'direct'; // 'direct' | 'sw'
  let fails = 0;

  function toPage(msg) {
    try {
      window.dispatchEvent(new CustomEvent('ha:to-page', { detail: JSON.stringify(msg) }));
    } catch (e) {}
  }

  function wsEv(ev, extra, via) {
    toPage({ type: 'ws', ev, via, ...(extra || {}) });
  }

  function invalidated(e) {
    try {
      return !chrome.runtime?.id || /context invalidated/i.test(String(e && e.message));
    } catch (_) {
      return true;
    }
  }

  function toSw(msg) {
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch (e) {
      if (invalidated(e)) die();
      else {
        port = null;
        schedule();
      }
      return false;
    }
  }

  // ---------- direct socket ----------
  function dropDirect() {
    const w = ws;
    ws = null;
    if (!w) return;
    w.onopen = w.onmessage = w.onclose = w.onerror = null;
    try { w.close(); } catch (e) {}
  }

  function dropProxy() {
    if (!proxyOpen) return;
    proxyOpen = false;
    toSw({ type: 'wsproxy', op: 'close' });
  }

  function openDirect(url) {
    let w;
    let opened = false;
    let counted = false;
    const failed = () => {
      if (opened || counted) return;
      counted = true;
      if (++fails >= 2) mode = 'sw';
    };
    try {
      w = new WebSocket(url);
    } catch (e) {
      failed();
      wsEv('error', {}, 'direct');
      wsEv('close', { code: 1006 }, 'direct');
      return;
    }
    ws = w;
    w.onopen = () => {
      if (ws !== w) return;
      opened = true;
      fails = 0;
      wsEv('open', {}, 'direct');
    };
    w.onmessage = (ev) => {
      if (ws !== w) return;
      wsEv('message', { data: typeof ev.data === 'string' ? ev.data : '' }, 'direct');
    };
    w.onerror = () => {
      if (ws !== w) return;
      failed();
      wsEv('error', {}, 'direct');
    };
    w.onclose = (ev) => {
      if (ws !== w) return;
      ws = null;
      failed();
      wsEv('close', { code: ev.code }, 'direct');
    };
  }

  function onWsOp(msg) {
    switch (msg.op) {
      case 'open': {
        if (typeof msg.url !== 'string') return;
        dropDirect();
        dropProxy();
        if (mode === 'sw') {
          proxyOpen = true;
          if (!toSw({ type: 'wsproxy', op: 'open', url: msg.url })) {
            proxyOpen = false;
            wsEv('error', {}, 'sw');
            wsEv('close', { code: 1006 }, 'sw');
          }
        } else openDirect(msg.url);
        break;
      }
      case 'send':
        if (typeof msg.data !== 'string') return;
        if (ws && ws.readyState === 1) {
          try { ws.send(msg.data); } catch (e) {}
        } else if (proxyOpen) toSw({ type: 'wsproxy', op: 'send', data: msg.data });
        break;
      case 'close':
        dropDirect();
        dropProxy();
        break;
    }
  }

  // ---------- SW port ----------
  function die() {
    dead = true;
    clearTimeout(timer);
    try { window.removeEventListener('ha:to-ext', onPage); } catch (e) {}
    dropDirect();
    port = null;
  }

  function onSwMessage(m) {
    if (m && m.type === 'wsproxy') {
      if (!proxyOpen) return;
      if (m.ev === 'close') proxyOpen = false;
      wsEv(m.ev, { data: m.data, code: m.code }, 'sw');
      return;
    }
    toPage(m);
  }

  function connect() {
    if (dead) return;
    timer = null;
    try {
      if (!chrome.runtime?.id) return die();
      const p = chrome.runtime.connect({ name: 'ha-tab' });
      port = p;
      p.onMessage.addListener(onSwMessage);
      p.onDisconnect.addListener(() => {
        if (port === p) port = null;
        try { void chrome.runtime.lastError; } catch (e) {}
        if (proxyOpen) {
          // the SW-side socket died with the port
          proxyOpen = false;
          wsEv('close', { code: 1006 }, 'sw');
        }
        schedule();
      });
      delay = 100;
      toPage({ type: 'sync' });
    } catch (e) {
      if (invalidated(e)) return die();
      schedule();
    }
  }

  function schedule() {
    if (dead || timer) return;
    if (invalidated()) return die();
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 2000);
  }

  function onPage(ev) {
    if (dead) return;
    let msg;
    try { msg = JSON.parse(ev.detail); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ws') return onWsOp(msg);
    if (!port) { schedule(); return; }
    toSw(msg);
  }

  window.addEventListener('ha:to-ext', onPage);
  connect();
})();
