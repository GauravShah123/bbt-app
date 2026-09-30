// Service worker v2: settings, per-tab joined memory, tab mute executor, badge, popup port, WebSocket proxy.
import { BACKEND_URL, TEAM_TOKEN } from './config.js';

const MEET_PREFIX = 'https://meet.google.com/';
const POPUP_MIN_MS = 150;
const LOG_TIMEOUT_MS = 2000;
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** @type {Map<number, any>} */
const tabs = new Map();
const popups = new Set(); // {port, tabId, last}
const pendingLogs = new Map(); // reqId -> {popup, tabId, timer}

let settings = { backendUrl: '', token: '', params: {} };
let globalsReady = null;
let logSeq = 0;

// ---------- helpers ----------
function safe(fn) {
  return (...a) => {
    try {
      const r = fn(...a);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {}
  };
}

function normalizeUrl(u) {
  u = String(u || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/^https:/i.test(u)) u = 'wss:' + u.slice(6);
  else if (/^http:/i.test(u)) u = 'ws:' + u.slice(5);
  return u;
}

function randomId(n = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (let i = 0; i < n; i++) s += ID_CHARS[bytes[i] % ID_CHARS.length];
  return s;
}

function sessionSet(o) {
  try { return chrome.storage.session.set(o).catch(() => {}); } catch (e) {}
}
function sessionRemove(k) {
  try { return chrome.storage.session.remove(k).catch(() => {}); } catch (e) {}
}

function loadGlobals() {
  if (!globalsReady) {
    globalsReady = chrome.storage.local
      .get(['backendUrl', 'token', 'params'])
      .then((r) => {
        r = r || {};
        settings = {
          backendUrl: normalizeUrl(typeof r.backendUrl === 'string' && r.backendUrl ? r.backendUrl : BACKEND_URL),
          token: typeof r.token === 'string' && r.token ? r.token : TEAM_TOKEN || '',
          params: r.params && typeof r.params === 'object' ? r.params : {},
        };
      })
      .catch(() => {});
  }
  return globalsReady;
}

// ---------- tab state ----------
function getTab(tabId) {
  let st = tabs.get(tabId);
  if (st) return st;
  st = {
    tabId,
    cid: null,
    jm: null, // joined memory {meeting, wasHub}
    status: null,
    port: null,
    weMuted: false,
    muteChain: Promise.resolve(),
    lastMuted: null,
    ws: null, // proxy socket
    badge: null,
    ready: null,
  };
  st.ready = hydrate(st);
  tabs.set(tabId, st);
  return st;
}

async function hydrate(st) {
  const id = st.tabId;
  try {
    await loadGlobals();
    const k = [`cid:${id}`, `jm:${id}`, `wm:${id}`];
    const r = (await chrome.storage.session.get(k)) || {};
    if (typeof r[k[0]] === 'string' && /^[A-Za-z0-9]{16}$/.test(r[k[0]])) st.cid = r[k[0]];
    else {
      st.cid = randomId(16);
      sessionSet({ [k[0]]: st.cid });
    }
    const jm = r[k[1]];
    if (jm && typeof jm.meeting === 'string' && jm.meeting) st.jm = { meeting: jm.meeting, wasHub: !!jm.wasHub };
    st.weMuted = !!r[k[2]];
  } catch (e) {
    if (!st.cid) st.cid = randomId(16);
  }
}

function sendPage(st, msg) {
  if (!st.port) return;
  try { st.port.postMessage(msg); } catch (e) {}
}

async function sendConfig(st) {
  await st.ready;
  sendPage(st, {
    type: 'config',
    backendUrl: settings.backendUrl,
    token: settings.token,
    params: settings.params,
    workletUrl: chrome.runtime.getURL('page/meter-worklet.js'),
    autoJoin: st.jm ? { meeting: st.jm.meeting, wasHub: st.jm.wasHub } : null,
    cid: st.cid,
  });
}

// ---------- WebSocket proxy (per tab) ----------
function proxyClose(st) {
  const ws = st.ws;
  st.ws = null;
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  try { ws.close(); } catch (e) {}
}

function proxyOpen(st, url) {
  proxyClose(st);
  const base = settings.backendUrl;
  if (typeof url !== 'string' || !base || !url.startsWith(base)) {
    sendPage(st, { type: 'wsproxy', ev: 'error' });
    sendPage(st, { type: 'wsproxy', ev: 'close', code: 1008 });
    return;
  }
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    sendPage(st, { type: 'wsproxy', ev: 'error' });
    sendPage(st, { type: 'wsproxy', ev: 'close', code: 1006 });
    return;
  }
  st.ws = ws;
  ws.onopen = safe(() => { if (st.ws === ws) sendPage(st, { type: 'wsproxy', ev: 'open' }); });
  ws.onmessage = safe((ev) => {
    if (st.ws === ws && typeof ev.data === 'string') sendPage(st, { type: 'wsproxy', ev: 'message', data: ev.data });
  });
  ws.onerror = safe(() => { if (st.ws === ws) sendPage(st, { type: 'wsproxy', ev: 'error' }); });
  ws.onclose = safe((ev) => {
    if (st.ws !== ws) return;
    st.ws = null;
    sendPage(st, { type: 'wsproxy', ev: 'close', code: ev.code });
  });
}

function onWsProxy(st, msg) {
  switch (msg.op) {
    case 'open': proxyOpen(st, msg.url); break;
    case 'send':
      if (st.ws && st.ws.readyState === 1 && typeof msg.data === 'string') {
        try { st.ws.send(msg.data); } catch (e) {}
      }
      break;
    case 'close': proxyClose(st); break;
  }
}

// ---------- tab mute ----------
function doMute(st, muted, reqId) {
  st.muteChain = st.muteChain
    .then(async () => {
      let actual;
      try {
        const tab = await chrome.tabs.get(st.tabId);
        const was = !!(tab.mutedInfo && tab.mutedInfo.muted);
        actual = was;
        if (was !== muted) {
          const t = await chrome.tabs.update(st.tabId, { muted });
          actual = t && t.mutedInfo ? !!t.mutedInfo.muted : muted;
          if (muted && actual) {
            st.weMuted = true;
            sessionSet({ [`wm:${st.tabId}`]: true });
          }
        }
        if (!muted && !actual && st.weMuted) {
          st.weMuted = false;
          sessionSet({ [`wm:${st.tabId}`]: false });
        }
      } catch (e) {
        actual = st.lastMuted === null ? !muted : st.lastMuted;
      }
      st.lastMuted = actual;
      sendPage(st, { type: 'muted', muted: actual, reqId });
    })
    .catch(() => {});
}

async function restoreMute(st) {
  if (!st.weMuted) return;
  st.weMuted = false;
  st.lastMuted = null;
  sessionSet({ [`wm:${st.tabId}`]: false });
  try { await chrome.tabs.update(st.tabId, { muted: false }); } catch (e) {}
}

// ---------- badge ----------
function computeBadge(st) {
  const s = st.status;
  if (!s || !s.inCall || !s.joined) return ['', '#71717a'];
  const acts = Array.isArray(s.actions) ? s.actions.map((a) => (typeof a === 'string' ? a : a && a.action)) : [];
  if (s.pause || acts.some((a) => a && a !== 'soundCheck')) return ['!', '#dc2626'];
  if (s.role === 'hub') return ['HUB', '#16a34a'];
  const mine = s.ownerLabel === 'You' || (Array.isArray(s.laptops) && s.laptops.some((l) => l && l.label === 'You' && l.owner));
  if (s.role === 'member' && mine) return ['MIC', '#2563eb'];
  return ['·', '#71717a'];
}

function updateBadge(st) {
  const [text, color] = computeBadge(st);
  const key = text + '|' + color;
  if (st.badge === key) return;
  st.badge = key;
  try {
    chrome.action.setBadgeText({ tabId: st.tabId, text }).catch(() => {});
    if (text) chrome.action.setBadgeBackgroundColor({ tabId: st.tabId, color }).catch(() => {});
  } catch (e) {}
}

// ---------- popups ----------
function pushStatus(tabId, status, force) {
  const now = Date.now();
  for (const p of popups) {
    if (p.tabId !== tabId) continue;
    if (!force && status && now - p.last < POPUP_MIN_MS) continue;
    p.last = now;
    try { p.port.postMessage({ type: 'status', tabId, status }); } catch (e) {}
  }
}

function settingsMsg() {
  return { type: 'settings', backendUrl: settings.backendUrl, tokenSet: !!settings.token, params: settings.params };
}

function pushSettingsAll(exceptTabId) {
  for (const st of tabs.values()) if (st.tabId !== exceptTabId) sendConfig(st);
  for (const p of popups) {
    try { p.port.postMessage(settingsMsg()); } catch (e) {}
  }
}

// ---------- cleanup ----------
function cleanup(tabId, { unmute = true } = {}) {
  const st = tabs.get(tabId);
  if (st) {
    proxyClose(st);
    if (unmute) restoreMute(st);
    tabs.delete(tabId);
    try { chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}); } catch (e) {}
  }
  sessionRemove([`cid:${tabId}`, `jm:${tabId}`, `wm:${tabId}`]);
  pushStatus(tabId, null, true);
}

// ---------- tab port ----------
async function onTabMessage(st, msg) {
  await st.ready;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'wsproxy': onWsProxy(st, msg); break;
    case 'mute': doMute(st, !!msg.muted, msg.reqId); break;
    case 'status':
      st.status = msg;
      updateBadge(st);
      pushStatus(st.tabId, msg);
      break;
    case 'joined':
      if (msg.joined && typeof msg.meeting === 'string' && msg.meeting) {
        st.jm = { meeting: msg.meeting, wasHub: !!msg.wasHub };
        sessionSet({ [`jm:${st.tabId}`]: st.jm });
      } else {
        st.jm = null;
        sessionRemove(`jm:${st.tabId}`);
      }
      break;
    case 'logDump': {
      const p = pendingLogs.get(msg.reqId);
      if (p) {
        clearTimeout(p.timer);
        pendingLogs.delete(msg.reqId);
        try { p.popup.port.postMessage({ type: 'log', tabId: p.tabId, log: msg.log ?? null }); } catch (e) {}
      }
      break;
    }
    case 'cfgOut':
      if (msg.params && typeof msg.params === 'object') {
        settings.params = { ...settings.params, ...msg.params };
        chrome.storage.local.set({ params: settings.params }).catch(() => {});
        pushSettingsAll(st.tabId);
      }
      break;
  }
}

chrome.runtime.onConnect.addListener(
  safe((port) => {
    if (port.name === 'ha-tab') {
      const tabId = port.sender && port.sender.tab && port.sender.tab.id;
      if (typeof tabId !== 'number') return;
      const st = getTab(tabId);
      st.port = port;
      port.onMessage.addListener(safe((m) => onTabMessage(st, m)));
      port.onDisconnect.addListener(
        safe(() => {
          try { void chrome.runtime.lastError; } catch (e) {}
          if (st.port !== port) return;
          st.port = null;
          st.status = null;
          proxyClose(st);
          restoreMute(st);
          updateBadge(st);
          pushStatus(st.tabId, null, true);
        })
      );
      sendConfig(st);
    } else if (port.name === 'ha-popup') {
      const pop = { port, tabId: null, last: 0 };
      popups.add(pop);
      port.onDisconnect.addListener(
        safe(() => {
          try { void chrome.runtime.lastError; } catch (e) {}
          popups.delete(pop);
        })
      );
      port.onMessage.addListener(safe((m) => onPopupMessage(pop, m)));
      loadGlobals().then(safe(() => port.postMessage(settingsMsg())));
    }
  })
);

// ---------- popup messages ----------
async function onPopupMessage(pop, msg) {
  if (!msg || typeof msg !== 'object') return;
  await loadGlobals();
  switch (msg.type) {
    case 'subscribe': {
      if (typeof msg.tabId !== 'number') break;
      pop.tabId = msg.tabId;
      const st = tabs.get(msg.tabId);
      pushStatus(msg.tabId, st ? st.status : null, true);
      break;
    }
    case 'ui': {
      const st = tabs.get(msg.tabId);
      if (st && typeof msg.action === 'string') sendPage(st, { type: 'ui', action: msg.action, arg: msg.arg ?? null });
      break;
    }
    case 'setParams': {
      if (!msg.params || typeof msg.params !== 'object') break;
      settings.params = { ...settings.params, ...msg.params };
      await chrome.storage.local.set({ params: settings.params });
      pushSettingsAll();
      if (msg.room) {
        const st = tabs.get(pop.tabId);
        // deviation: page applies these to the room via its own socket
        if (st) sendPage(st, { type: 'ui', action: 'applyRoom', arg: msg.params });
      }
      break;
    }
    case 'resetParams':
      settings.params = {};
      await chrome.storage.local.remove('params');
      pushSettingsAll();
      break;
    case 'getLog': {
      const st = tabs.get(msg.tabId);
      const reply = (log) => {
        try { pop.port.postMessage({ type: 'log', tabId: msg.tabId, log }); } catch (e) {}
      };
      if (!st || !st.port) return reply(null);
      const reqId = `${Date.now()}-${++logSeq}`;
      const timer = setTimeout(() => {
        pendingLogs.delete(reqId);
        reply(null);
      }, LOG_TIMEOUT_MS);
      pendingLogs.set(reqId, { popup: pop, tabId: msg.tabId, timer });
      sendPage(st, { type: 'getLog', reqId });
      break;
    }
    case 'setBackend': {
      const url = normalizeUrl(msg.url);
      const token = typeof msg.token === 'string' ? msg.token.trim() : null;
      if (url) await chrome.storage.local.set({ backendUrl: url });
      else await chrome.storage.local.remove('backendUrl');
      // empty token field keeps the current token; send a value to replace it
      if (token) await chrome.storage.local.set({ token });
      settings.backendUrl = url || normalizeUrl(BACKEND_URL);
      if (token) settings.token = token;
      else if (!settings.token) settings.token = TEAM_TOKEN || '';
      pushSettingsAll();
      break;
    }
  }
}

// ---------- tab events ----------
chrome.tabs.onRemoved.addListener(safe((tabId) => cleanup(tabId, { unmute: false })));
chrome.tabs.onUpdated.addListener(
  safe((tabId, info) => {
    if (info.url && !info.url.startsWith(MEET_PREFIX)) cleanup(tabId);
  })
);
