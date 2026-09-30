// ISOLATED-world relay between the page (MAIN world) and the service worker.
(() => {
  let port = null;
  let dead = false;
  let delay = 100;
  let timer = null;

  function toPage(msg) {
    try {
      window.dispatchEvent(new CustomEvent('ha:to-page', { detail: JSON.stringify(msg) }));
    } catch (e) {}
  }

  function invalidated(e) {
    try {
      return !chrome.runtime?.id || /context invalidated/i.test(String(e && e.message));
    } catch (_) {
      return true;
    }
  }

  function die() {
    dead = true;
    clearTimeout(timer);
    try { window.removeEventListener('ha:to-ext', onPage); } catch (e) {}
    port = null;
  }

  function connect() {
    if (dead) return;
    timer = null;
    try {
      if (!chrome.runtime?.id) return die();
      const p = chrome.runtime.connect({ name: 'ha-tab' });
      port = p;
      p.onMessage.addListener((m) => toPage(m));
      p.onDisconnect.addListener(() => {
        if (port === p) port = null;
        try { void chrome.runtime.lastError; } catch (e) {}
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
    if (!port) { schedule(); return; }
    try {
      port.postMessage(msg);
    } catch (e) {
      if (invalidated(e)) return die();
      port = null;
      schedule();
    }
  }

  window.addEventListener('ha:to-ext', onPage);
  connect();
})();
