// Service worker: per-tab state, relay WebSocket, tab mute, badge, popup port.
import { BACKEND_URL } from './config.js';

const MEET_PREFIX = 'https://meet.google.com/';
const BACKOFF = [500, 1000, 2000, 4000, 8000];
const POPUP_MIN_MS = 230;
const LOG_TIMEOUT_MS = 2000;

/** @type {Map<number, any>} */
const tabs = new Map();
const popups = new Set(); // {port, tabId, last}
const pendingLogs = new Map(); // reqId -> {popup, tabId, timer}
const keyCache = new Map();

let params = {};
let backendUrl = '';
let globalsReady = null;
let logSeq = 0;

function loadGlobals() {
  if (!globalsReady) {
    globalsReady = chrome.storage.local
      .get(['params', 'backendUrl'])
      .then((r) => {
        params = r && r.params && typeof r.params === 'object' ? r.params : {};
        backendUrl = typeof (r && r.backendUrl) === 'string' ? r.backendUrl : '';
      })
      .catch(() => {});
  }
  return globalsReady;
}

// ---------- helpers ----------
function wsBase() {
  let u = (backendUrl || BACKEND_URL || '').trim();
  if (!u) return '';
  u = u.replace(/\/+$/, '');
  if (/^https:/i.test(u)) u = 'wss:' + u.slice(6);
  else if (/^http:/i.test(u)) u = 'ws:' + u.slice(5);
  return u;
}

function randomId(n = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (let i = 0; i < n; i++) s += chars[bytes[i] % chars.length];
  return s;
}

async function roomKey(code) {
  if (keyCache.has(code)) return keyCache.get(code);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hybrid-audio:' + code));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  keyCache.set(code, hex);
  return hex;
}

function safe(fn) {
  return (...a) => {
    try {
      const r = fn(...a);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {}
  };
}

function sessionSet(o) {
  try { return chrome.storage.session.set(o).catch(() => {}); } catch (e) {}
}
function sessionRemove(k) {
  try { return chrome.storage.session.remove(k).catch(() => {}); } catch (e) {}
}

// ---------- tab state ----------
function getTab(tabId) {
  let st = tabs.get(tabId);
  if (st) return st;
  st = {
    tabId,
    mode: 'auto',
    cid: null,
    meeting: null,
    inCall: false,
    status: null,
    ws: null,
    wsMeeting: null,
    seq: 0,
    backoffIdx: 0,
    reconnectTimer: null,
    pingTimer: null,
    lastMuted: false,
    weMuted: false,
    port: null,
    connected: false,
    everConnected: false,
    room: { you: null, hub: null, peers: [] },
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
    const k = [`mode:${id}`, `cid:${id}`, `wm:${id}`];
    const r = (await chrome.storage.session.get(k)) || {};
    const m = r[k[0]];
    if (m === 'auto' || m === 'hub' || m === 'member' || m === 'off') st.mode = m;
    if (typeof r[k[1]] === 'string' && r[k[1]].length >= 8) st.cid = r[k[1]];
    else {
      st.cid = randomId(16);
      sessionSet({ [k[1]]: st.cid });
    }
    st.weMuted = !!r[k[2]];
  } catch (e) {
    if (!st.cid) st.cid = randomId(16);
  }
}

function sendPage(st, msg) {
  if (!st.port) return;
  try { st.port.postMessage(msg); } catch (e) {}
}

function sendConfig(st) {
  sendPage(st, { type: 'config', mode: st.mode, params, backendConfigured: !!wsBase() });
  sendPage(st, { type: 'cfg', params });
}

function pref(st) {
  return st.mode === 'hub' || st.mode === 'member' ? st.mode : 'auto';
}

function eligible(st) {
  return st.mode !== 'off' && !!st.meeting && st.inCall && !!wsBase();
}

// ---------- relay socket ----------
function clearSocketTimers(st) {
  clearInterval(st.pingTimer);
  st.pingTimer = null;
}

function sendRoom(st) {
  sendPage(st, {
    type: 'room',
    connected: st.connected,
    everConnected: st.everConnected,
    you: st.room.you,
    hub: st.room.hub,
    peers: st.room.peers,
  });
}

function closeSocket(st, { reset = false } = {}) {
  st.seq++;
  clearTimeout(st.reconnectTimer);
  st.reconnectTimer = null;
  clearSocketTimers(st);
  const ws = st.ws;
  st.ws = null;
  st.wsMeeting = null;
  const was = st.connected;
  st.connected = false;
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch (e) {}
  }
  if (reset) {
    st.everConnected = false;
    st.room = { you: null, hub: null, peers: [] };
    st.backoffIdx = 0;
  }
  if (ws || was || reset) sendRoom(st);
}

function wsSend(st, obj) {
  if (st.ws && st.ws.readyState === 1) {
    try { st.ws.send(JSON.stringify(obj)); return true; } catch (e) {}
  }
  return false;
}

async function openSocket(st) {
  if (st.ws || !eligible(st)) return;
  const seq = ++st.seq;
  const meeting = st.meeting;
  let key;
  try {
    await st.ready;
    key = await roomKey(meeting);
  } catch (e) { return; }
  if (seq !== st.seq || st.ws || !eligible(st) || st.meeting !== meeting) return;
  let ws;
  try {
    ws = new WebSocket(`${wsBase()}/room/${key}?id=${encodeURIComponent(st.cid)}&p=${pref(st)}`);
  } catch (e) {
    scheduleReconnect(st);
    return;
  }
  st.ws = ws;
  st.wsMeeting = meeting;
  ws.onopen = safe(() => {
    if (st.ws !== ws) return;
    clearInterval(st.pingTimer);
    st.pingTimer = setInterval(() => wsSend(st, { t: 'ping', ts: Date.now() }), 2000);
    wsSend(st, { t: 'ping', ts: Date.now() });
  });
  ws.onmessage = safe((ev) => {
    if (st.ws !== ws) return;
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'roster':
        st.connected = true;
        st.everConnected = true;
        st.backoffIdx = 0;
        st.room = {
          you: m.you ?? null,
          hub: m.hub ?? null,
          peers: Array.isArray(m.peers) ? m.peers : [],
        };
        sendRoom(st);
        updateBadge(st);
        break;
      case 'st':
        sendPage(st, { type: 'peer', id: m.id, a: m.a, s: m.s, r: m.r, rt: m.rt });
        break;
      case 'pong':
        if (typeof m.ts === 'number') sendPage(st, { type: 'rtt', ms: Math.max(0, Date.now() - m.ts) });
        break;
      case 'cfg':
        if (m.params && typeof m.params === 'object') {
          params = { ...params, ...m.params };
          chrome.storage.local.set({ params }).catch(() => {});
          pushParamsAll();
        }
        break;
    }
  });
  ws.onclose = safe(() => {
    if (st.ws !== ws) return;
    st.ws = null;
    st.wsMeeting = null;
    st.connected = false;
    clearSocketTimers(st);
    sendRoom(st);
    updateBadge(st);
    scheduleReconnect(st);
  });
  ws.onerror = () => {};
}

function scheduleReconnect(st) {
  if (st.reconnectTimer || !eligible(st)) return;
  const d = BACKOFF[Math.min(st.backoffIdx, BACKOFF.length - 1)];
  st.backoffIdx++;
  st.reconnectTimer = setTimeout(() => {
    st.reconnectTimer = null;
    openSocket(st);
  }, d);
}

function evaluate(st) {
  if (!eligible(st)) {
    if (st.ws || st.connected || st.reconnectTimer) closeSocket(st, { reset: !st.meeting || !st.inCall });
    return;
  }
  if (st.ws && st.wsMeeting !== st.meeting) closeSocket(st, { reset: true });
  if (!st.ws) openSocket(st);
}

// ---------- tab mute ----------
async function applyMute(st, muted) {
  st.lastMuted = muted;
  if (st.mode === 'off') muted = false;
  try {
    const tab = await chrome.tabs.get(st.tabId);
    const actual = !!(tab.mutedInfo && tab.mutedInfo.muted);
    if (muted) {
      if (!actual) {
        await chrome.tabs.update(st.tabId, { muted: true });
        st.weMuted = true;
        sessionSet({ [`wm:${st.tabId}`]: true });
      }
    } else if (st.weMuted) {
      if (actual) await chrome.tabs.update(st.tabId, { muted: false });
      st.weMuted = false;
      sessionSet({ [`wm:${st.tabId}`]: false });
    }
  } catch (e) {}
}

async function restoreMute(st) {
  st.lastMuted = false;
  if (!st.weMuted) return;
  st.weMuted = false;
  sessionSet({ [`wm:${st.tabId}`]: false });
  try { await chrome.tabs.update(st.tabId, { muted: false }); } catch (e) {}
}

// ---------- badge ----------
function computeBadge(st) {
  const s = st.status;
  if (st.mode === 'off' || !st.inCall) return ['', '#71717a'];
  if (!s) return ['', '#71717a'];
  const connected = s.connected ?? st.connected;
  if ((st.mode === 'auto' && !connected) || s.ctxState === 'suspended') return ['!', '#dc2626'];
  if (s.isHub) return ['HUB', '#16a34a'];
  if ((s.gain ?? 0) > 0.3) return ['MIC', '#2563eb'];
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

// ---------- cleanup ----------
function cleanup(tabId, { unmute = true } = {}) {
  const st = tabs.get(tabId);
  if (st) {
    closeSocket(st);
    if (unmute) restoreMute(st);
    tabs.delete(tabId);
    try { chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}); } catch (e) {}
  }
  sessionRemove([`mode:${tabId}`, `cid:${tabId}`, `wm:${tabId}`]);
  pushStatus(tabId, null);
}

// ---------- popups ----------
function pushStatus(tabId, status, force) {
  const now = Date.now();
  for (const p of popups) {
    if (p.tabId !== tabId) continue;
    if (!force && status && now - p.last < POPUP_MIN_MS) continue;
    p.last = now;
    const st = tabs.get(tabId);
    try { p.port.postMessage({ type: 'status', tabId, status, mode: st ? st.mode : 'auto' }); } catch (e) {}
  }
}

function paramsMsg() {
  return { type: 'params', params, backendUrl, backendConfigured: !!wsBase() };
}

function pushParamsAll() {
  for (const st of tabs.values()) sendConfig(st);
  for (const p of popups) {
    try { p.port.postMessage(paramsMsg()); } catch (e) {}
  }
}

// ---------- tab port ----------
async function onTabMessage(st, port, msg) {
  await st.ready;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'meet': {
      const meeting = typeof msg.meeting === 'string' && msg.meeting ? msg.meeting : null;
      const inCall = !!msg.inCall && !!meeting;
      const changed = meeting !== st.meeting;
      st.meeting = meeting;
      const left = st.inCall && !inCall;
      st.inCall = inCall;
      if (changed) closeSocket(st, { reset: true });
      if (left) restoreMute(st);
      evaluate(st);
      updateBadge(st);
      break;
    }
    case 'st':
      wsSend(st, { t: 'st', a: msg.a, s: msg.s, r: msg.r, rt: msg.rt });
      break;
    case 'mute':
      if (st.inCall || !msg.muted) applyMute(st, !!msg.muted);
      break;
    case 'status': {
      st.status = msg;
      if (typeof msg.inCall === 'boolean' && msg.meeting !== undefined) {
        // page status is informational; meet message drives eligibility
      }
      updateBadge(st);
      pushStatus(st.tabId, msg);
      break;
    }
    case 'logDump': {
      const p = pendingLogs.get(msg.reqId);
      if (p) {
        clearTimeout(p.timer);
        pendingLogs.delete(msg.reqId);
        try { p.popup.port.postMessage({ type: 'log', tabId: p.tabId, log: msg.log ?? null }); } catch (e) {}
      }
      break;
    }
    case 'cfg':
      if (msg.params && typeof msg.params === 'object') {
        params = { ...params, ...msg.params };
        chrome.storage.local.set({ params }).catch(() => {});
        pushParamsAll();
        wsSend(st, { t: 'cfg', params: msg.params });
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
      port.onMessage.addListener(safe((m) => onTabMessage(st, port, m)));
      port.onDisconnect.addListener(
        safe(() => {
          try { void chrome.runtime.lastError; } catch (e) {}
          if (st.port !== port) return;
          st.port = null;
          st.meeting = null;
          st.inCall = false;
          st.status = null;
          closeSocket(st, { reset: true });
          restoreMute(st);
          updateBadge(st);
          pushStatus(st.tabId, null, true);
        })
      );
      st.ready.then(safe(() => sendConfig(st)));
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
      loadGlobals().then(safe(() => port.postMessage(paramsMsg())));
    }
  })
);

// ---------- popup messages ----------
async function onPopupMessage(pop, msg) {
  if (!msg || typeof msg !== 'object') return;
  await loadGlobals();
  switch (msg.type) {
    case 'subscribe': {
      pop.tabId = msg.tabId;
      const st = tabs.get(msg.tabId);
      if (st) await st.ready;
      else if (typeof msg.tabId === 'number') {
        // lazily read persisted mode without creating state for non-Meet tabs
        try {
          const r = await chrome.storage.session.get(`mode:${msg.tabId}`);
          const m = r[`mode:${msg.tabId}`];
          pop.port.postMessage({ type: 'status', tabId: msg.tabId, status: null, mode: m || 'auto' });
          break;
        } catch (e) {}
      }
      pushStatus(msg.tabId, st ? st.status : null, true);
      break;
    }
    case 'setMode':
      await setMode(msg.tabId, msg.mode);
      pushStatus(msg.tabId, tabs.get(msg.tabId)?.status ?? null, true);
      break;
    case 'setParams': {
      if (!msg.params || typeof msg.params !== 'object') break;
      params = { ...params, ...msg.params };
      await chrome.storage.local.set({ params });
      pushParamsAll();
      if (msg.room) {
        const target = tabs.get(pop.tabId);
        if (target) wsSend(target, { t: 'cfg', params: msg.params });
        else for (const st of tabs.values()) wsSend(st, { t: 'cfg', params: msg.params });
      }
      break;
    }
    case 'resetParams':
      params = {};
      await chrome.storage.local.remove('params');
      pushParamsAll();
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
      const url = typeof msg.url === 'string' ? msg.url.trim() : '';
      if (url) await chrome.storage.local.set({ backendUrl: url });
      else await chrome.storage.local.remove('backendUrl');
      backendUrl = url;
      for (const st of tabs.values()) {
        closeSocket(st, { reset: true });
        evaluate(st);
      }
      pushParamsAll();
      break;
    }
  }
}

async function setMode(tabId, mode) {
  if (!['auto', 'hub', 'member', 'off'].includes(mode) || typeof tabId !== 'number') return;
  const st = getTab(tabId);
  await st.ready;
  st.mode = mode;
  await sessionSet({ [`mode:${tabId}`]: mode });
  sendConfig(st);
  if (mode === 'off') {
    closeSocket(st, { reset: true });
    restoreMute(st);
  } else if (st.ws) {
    wsSend(st, { t: 'p', p: pref(st) });
  } else {
    evaluate(st);
  }
  updateBadge(st);
}

// ---------- tabs events ----------
chrome.tabs.onRemoved.addListener(safe((tabId) => cleanup(tabId, { unmute: false })));
chrome.tabs.onUpdated.addListener(
  safe((tabId, info) => {
    if (info.url && !info.url.startsWith(MEET_PREFIX) && (tabs.has(tabId))) cleanup(tabId);
  })
);
