// End-to-end test (v2): 3 "laptops" (persistent contexts) + local relay + fake Meet page.
//   node test/e2e/run.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const EXT = path.join(ROOT, 'extension');
const FAKE_HTML = fs.readFileSync(path.join(here, 'fake-meet.html'), 'utf8');
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const TOKEN = 'testtoken';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let failed = false;

function report(step, ok, detail = '') {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? ' - ' + detail : ''}`);
}

async function poll(fn, timeout, interval = 50) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const r = await fn(); if (r) return r; } catch (e) { /* retry */ }
    await sleep(interval);
  }
  return null;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

// ---------- relay ----------
let relay = null;
async function startRelay(port) {
  relay = spawn('node', [path.join(ROOT, 'backend/dev-server.js')], {
    env: { ...process.env, PORT: String(port), TEAM_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stderr.on('data', (d) => process.stderr.write('[relay] ' + d));
  const ok = await poll(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 8000, 100);
  if (!ok) throw new Error('relay did not start');
}
async function stopRelay() {
  if (!relay) return;
  const r = relay; relay = null;
  await new Promise((res) => { r.once('exit', res); r.kill('SIGKILL'); });
}

// ---------- laptops ----------
const laptops = [];
async function makeLaptop(i) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ha-e2e-${i}-`));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'],
  });
  const lp = { i, dir, context, page: null, popup: null, sw: null, extId: null, name: 'ABC'[i], tabId: null };
  const hookSW = (sw) => sw.on('console', (m) => { if (m.type() === 'error') errors.push(`${lp.name} SW console.error: ${m.text()}`); });
  lp.sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  hookSW(lp.sw);
  context.on('serviceworker', hookSW);
  lp.extId = new URL(lp.sw.url()).host;
  if (!await poll(() => lp.sw.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.tabs && !!chrome.action), 5000, 100)) {
    throw new Error('SW chrome APIs unavailable');
  }
  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_HTML }));
  laptops.push(lp);
  return lp;
}

function hookPage(lp, page, tag) {
  page.on('pageerror', (e) => errors.push(`${lp.name} ${tag} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().startsWith('FAKE_MEET_ERROR')) {
      errors.push(`${lp.name} ${tag} console.${m.type()}: ${m.text()}`);
    }
  });
}

// Popup-protocol session: an extension page holding an ha-popup port; records status/log messages.
async function openPopup(lp) {
  const pg = await lp.context.newPage();
  hookPage(lp, pg, 'popup');
  await pg.goto(`chrome-extension://${lp.extId}/popup/popup.html`);
  await pg.evaluate(() => {
    window.__status = null; window.__log = null;
    const port = chrome.runtime.connect({ name: 'ha-popup' });
    port.onMessage.addListener((m) => {
      if (m.type === 'status' && m.tabId === window.__tabId) window.__status = m.status;
      else if (m.type === 'log') window.__log = m.log;
    });
    window.__port = port;
  });
  lp.popup = pg;
}
const popupSend = (lp, msg) => lp.popup.evaluate((m) => window.__port.postMessage(m), msg);
const ui = (lp, action, arg) => popupSend(lp, { type: 'ui', tabId: lp.tabId, action, arg: arg ?? null });
const lastStatus = (lp) => lp.popup.evaluate(() => window.__status);
async function getLog(lp) {
  await lp.popup.evaluate(() => { window.__log = null; });
  await popupSend(lp, { type: 'getLog', tabId: lp.tabId });
  return poll(() => lp.popup.evaluate(() => window.__log), 3000, 50);
}

// Page-side helpers
const dbg = (lp) => lp.page.evaluate(() => window.__hybridAudio.main._debug());
const safeDbg = async (lp) => { try { return await dbg(lp); } catch { return null; } };
const tabInfo = (lp) => lp.sw.evaluate(async () => {
  const t = (await chrome.tabs.query({ url: 'https://meet.google.com/*' }))[0];
  if (!t) return null;
  return { id: t.id, muted: !!(t.mutedInfo && t.mutedInfo.muted), badge: await chrome.action.getBadgeText({ tabId: t.id }) };
});
const safeTab = async (lp) => { try { return await tabInfo(lp); } catch { return null; } };
const snap = async (ls) => Promise.all(ls.map(async (lp) => ({ nm: lp.name, ...(await safeDbg(lp)), tab: await safeTab(lp) })));

// Deterministic mic levels: wrap the `measure` getter (the real one is non-configurable) on a derived engine object.
const QUIET = { levelDb: -70, noiseDb: -75, act: false, userMuted: false };
const LOUD = { levelDb: -20, noiseDb: -60, act: true, healthy: true, userMuted: false };
const setLevel = (lp, patch) => lp.page.evaluate((p) => {
  const NS = window.__hybridAudio;
  if (!window.__ovrInstalled) {
    const real = NS.engine;
    const o = Object.create(real);
    Object.defineProperty(o, 'measure', {
      configurable: true, enumerable: true,
      get() { const m = real.measure; return window.__ovr ? Object.assign({}, m, window.__ovr) : m; },
    });
    NS.engine = o;
    window.__ovrInstalled = true;
  }
  window.__ovr = p;
}, patch);

const setRemote = (lp, on) => lp.page.evaluate((v) => {
  const NS = window.__hybridAudio;
  if (!window.__remStubbed) { NS.hooks.pollRemote = () => window.__rem || { identified: true, sources: [] }; window.__remStubbed = true; }
  window.__rem = { identified: true, sources: v ? [{ id: 'c999', level: 0.5, ageMs: 5 }] : [] };
}, on);

const gateSum = (ss) => ss.reduce((a, s) => a + (s && s.gate === 1 ? 1 : 0), 0);
const fmt = (ss) => JSON.stringify(ss.map((s, k) => s && ({ n: s.nm, role: s.role, st: s.state, g: s.gate, own: s.owner && s.owner.slice(0, 3), muted: s.tab && s.tab.muted, badge: s.tab && s.tab.badge })));

// ---------- main ----------
async function main() {
  const port = await freePort();
  console.log(`relay port ${port}`);
  await startRelay(port);
  const [A, B, C] = [await makeLaptop(0), await makeLaptop(1), await makeLaptop(2)];

  for (const lp of laptops) {
    lp.page = await lp.context.newPage();
    hookPage(lp, lp.page, 'meet');
    await lp.page.goto(MEET_URL);
  }
  for (const lp of laptops) {
    const ok = await poll(async () => (await lp.page.evaluate(() => {
      const n = window.__hybridAudio; return !!(n && n.engine && n.main && n.hooks && n.RoomClient && n.coordinator && n.hooks.getMeetState().inCall);
    })), 8000, 100);
    if (!ok) throw new Error(`${lp.name}: modules/inCall not ready`);
    lp.tabId = (await tabInfo(lp)).id;
    await openPopup(lp);
    await popupSend(lp, { type: 'subscribe', tabId: lp.tabId });
    await lp.popup.evaluate((id) => { window.__tabId = id; }, lp.tabId);
    await popupSend(lp, { type: 'subscribe', tabId: lp.tabId });
    await popupSend(lp, { type: 'setBackend', url: `ws://127.0.0.1:${port}`, token: TOKEN });
    await setLevel(lp, QUIET);
  }
  // config reaches pages
  await sleep(300);

  // Step 1
  let ss = await snap(laptops);
  report('1 before join: passthrough gate 1, unmuted, badge empty',
    ss.every((s) => s.gate === 1 && !s.joined && s.tab && s.tab.muted === false && s.tab.badge === ''), fmt(ss));

  // Step 2
  await ui(A, 'join');
  const ok2 = await poll(async () => {
    const s = (await snap([A]))[0]; ss = [s];
    return s.role === 'hub' && s.state === 'SOLO' && s.gate === 1 && s.tab.muted === false && s.tab.badge === 'HUB';
  }, 5000);
  report('2 A joins: hub, SOLO, gate 1, unmuted, badge HUB', !!ok2, fmt(ss));
  if (!ok2) return;

  // Step 3
  await ui(B, 'join'); await sleep(150); await ui(C, 'join');
  let a3 = null, all3 = null;
  const ok3 = await poll(async () => {
    all3 = await snap(laptops);
    const [a, b, c] = all3; a3 = a;
    return a.role === 'hub' && a.state === 'ROOM' && a.owner === a.you && a.gate === 1 && a.tab.muted === true &&
      b.role === 'member' && c.role === 'member' && b.gate === 0 && c.gate === 0 &&
      b.tab.muted === true && c.tab.muted === true && b.tab.badge === '·' && c.tab.badge === '·' &&
      a.laptops.length === 3 && a.laptops.every((l) => l.ready);
  }, 8000);
  report('3 B,C join: ROOM owner A, A gate1 muted; B,C gate 0 muted badge ·; roster 3 ready', !!ok3,
    fmt(all3) + (a3 ? ' roster=' + JSON.stringify(a3.laptops.map((l) => [l.label, l.ready])) : ''));
  if (!ok3) return;
  const idA = a3.you, idB = all3[1].you, idC = all3[2].you;

  // Step 4: B loud -> owner B
  const t4 = Date.now();
  await setLevel(B, LOUD);
  let s4 = null;
  const ok4 = await poll(async () => {
    s4 = await snap(laptops);
    return s4[0].owner === idB && s4[1].gate === 1 && s4[0].gate === 0 && s4[2].gate === 0;
  }, 2000);
  const dt4 = Date.now() - t4;
  report('4a switch: owner B, gates B=1 A=0 C=0 within 2s', !!ok4, `${dt4}ms ${fmt(s4 || [])}`);
  const logA = await getLog(A);
  if (logA) {
    const L = logA.log;
    let iOpen = -1, iAck = -1, iClose = -1;
    for (let i = L.length - 1; i >= 0 && iOpen < 0; i--) if (L[i].k === 'cmd' && L[i].to === idB && L[i].op === 'open') iOpen = i;
    const gOpen = iOpen >= 0 ? L[iOpen].g : null;
    for (let i = iOpen + 1; i < L.length; i++) {
      if (iAck < 0 && L[i].k === 'applied' && L[i].from === idB && L[i].g === gOpen && L[i].gate === 1) iAck = i;
      if (iClose < 0 && L[i].k === 'cmd' && L[i].to === idA && L[i].op === 'close') iClose = i;
    }
    const sw = L.filter((e) => e.k === 'coord' && e.ev === 'switch' && e.to === idB).pop();
    report('4b overlap order: open(B) acked before close(A) sent', iOpen >= 0 && iAck > iOpen && iClose > iAck, `idx open=${iOpen} ack=${iAck} close=${iClose}`);
    report('4c switch ms recorded', !!sw, sw ? `switch=${sw.ms.toFixed(0)}ms (hub p50=${logA.summary.switchMs.p50})` : 'no switch event');
  } else report('4b/4c getLog', false, 'no log');

  // Step 5: remote
  // 5a. A (self) must own the mic so the unknown source enrolls as remote: B quiet, A loud.
  await setLevel(B, QUIET); await setLevel(A, LOUD);
  let s5 = null;
  const ok5a = await poll(async () => {
    s5 = await snap(laptops);
    return s5[0].state === 'ROOM' && s5[0].owner === idA && s5[0].gate === 1 && s5[1].gate === 0;
  }, 2500);
  report('5a A regains ownership (B quiet, A loud)', !!ok5a, fmt(s5 || []));
  await setLevel(A, QUIET);
  await setRemote(A, true); // active source, unknown CSRC, owner=self -> enrolls as remote after learnSettleMs + 3 ticks
  const enrolled = await poll(async () => {
    const l = await getLog(A);
    return l && l.log.some((e) => e.k === 'coord' && e.ev === 'enroll' && e.kind === 'remote' && e.id === 'c999');
  }, 4000, 200);
  report('5b source c999 enrolled as remote (owner self)', !!enrolled);
  await setRemote(A, false);
  const back = await poll(async () => { const s = await safeDbg(A); return s && s.state === 'ROOM' && s.owner === idA && s.gate === 1; }, 3000);
  report('5c enrollment turn ends -> ROOM, A reopened', !!back);
  // 5d. B loud again (owner B), then remote speaks
  await setLevel(B, LOUD);
  const ownB = await poll(async () => { const s = await safeDbg(A); return s && s.state === 'ROOM' && s.owner === idB; }, 2500);
  await sleep(300);
  const t5 = Date.now();
  await setRemote(A, true);
  let s5d = null;
  const okR = await poll(async () => {
    s5d = await snap(laptops);
    return s5d[0].state === 'REMOTE' && gateSum(s5d) === 0 && s5d[0].tab.muted === false;
  }, 1000, 30);
  const dtR = Date.now() - t5;
  report('5d remote floor: REMOTE, all gates 0, A unmuted within 1s', !!(ownB && okR), `${dtR}ms ownB=${!!ownB} ${fmt(s5d || [])}`);
  await setRemote(A, false);
  let s5e = null;
  const okE = await poll(async () => {
    s5e = await snap(laptops);
    return s5e[0].state === 'ROOM' && s5e[0].owner === idB && s5e[1].gate === 1 && s5e[0].tab.muted === true;
  }, 3000);
  const lg = await getLog(A);
  const seq = lg && lg.log.filter((e) => e.k === 'coord' && e.ev === 'state').map((e) => e.from + '>' + e.to).join(',');
  const viaSettling = !!seq && /REMOTE>SETTLING,SETTLING>ROOM$/.test(seq);
  report('5e remote ends: SETTLING -> ROOM, A muted, B reopened', !!(okE && viaSettling), `${fmt(s5e || [])} seq...${(seq || '').slice(-60)}`);

  // Step 6: A leaves the call
  await A.page.evaluate(() => { window.__fake.pc1.close(); window.__fake.pc2.close(); });
  let s6 = null;
  const ok6 = await poll(async () => {
    s6 = await snap([B, C]);
    const [b, c] = s6;
    return b.role === 'hub' && c.role === 'member' && b.state === 'ROOM' && b.tab.muted === true && gateSum(s6) === 1 &&
      b.laptops.length === 2;
  }, 5000);
  const sA = await safeDbg(A);
  report('6 hub handover: B hub (ROOM, muted), exactly one gate open', !!ok6, `A.joined=${sA && sA.joined} ${fmt(s6 || [])}`);

  // Step 7: make-hub
  await setLevel(B, QUIET);
  await ui(C, 'makeHub');
  let s7 = null;
  const ok7 = await poll(async () => {
    s7 = await snap([B, C]);
    const [b, c] = s7;
    return c.role === 'hub' && b.role === 'member' && b.gate === 0 && c.gate === 1 && c.state === 'ROOM' && c.tab.muted === true;
  }, 5000);
  report('7 makeHub: C hub, B member gate 0', !!ok7, fmt(s7 || []));

  // Step 8: relay loss
  await setLevel(B, LOUD);
  const bOwn = await poll(async () => { const s = await snap([B, C]); return s[0].gate === 1 && s[1].gate === 0 && s[1].owner === idB; }, 3000);
  if (!bOwn) console.log('warn: B did not become owner before relay kill');
  await stopRelay();
  const tKill = Date.now();
  let s8 = null, st8 = null;
  const ok8 = await poll(async () => {
    s8 = await snap([B, C]); st8 = await lastStatus(C);
    const [b, c] = s8;
    return st8 && st8.pause && st8.pause.reason === 'relay' && c.gate === 0 && c.tab.muted === true && b.gate === 0;
  }, 3000);
  report('8a relay killed: hub PAUSED{relay}, gate 0, muted; member gate 0', !!ok8, `${Date.now() - tKill}ms pause=${JSON.stringify(st8 && st8.pause)} ${fmt(s8 || [])}`);
  await startRelay(port);
  const tUp = Date.now();
  let s8b = null;
  const ok8b = await poll(async () => {
    s8b = await snap([B, C]);
    const hubs = s8b.filter((s) => s.role === 'hub').length;
    return s8b.every((s) => s.relayUp) && hubs === 1 && gateSum(s8b) === 1 && s8b.every((s) => s.state !== 'PAUSED');
  }, 14000, 100);
  report('8b relay restarted: reconnect, one hub, one gate open', !!ok8b, `${Date.now() - tUp}ms ${fmt(s8b || [])}`);

  // Step 8c: member reload -> automatic rejoin (no click), gate closed until selected
  await B.page.reload();
  const tReload = Date.now();
  let s8c = null;
  const ok8c = await poll(async () => {
    try {
      s8c = await snap([B, C]);
      const [b, c] = s8c;
      return b.joined && b.role === 'member' && b.tab.muted === true &&
        c.laptops.length === 2 && gateSum(s8c) === 1;
    } catch { return false; }
  }, 15000, 200);
  report('8c member reload: auto-rejoins as member, muted, one gate open', !!ok8c, `${Date.now() - tReload}ms ${fmt(s8c || [])}`);

  // Step 9: B leaves
  await ui(B, 'leave');
  let s9 = null;
  const ok9 = await poll(async () => {
    s9 = await snap([B, C]);
    const [b, c] = s9;
    return !b.joined && b.gate === 1 && b.tab.muted === false && b.tab.badge === '' &&
      c.laptops.length === 1 && !c.laptops.some((l) => l.id === idB);
  }, 5000);
  report('9 B leaves: passthrough, unmuted, badge empty; roster drops B', !!ok9, fmt(s9 || []) + ' roster(C)=' + JSON.stringify(s9 && s9[1].laptops && s9[1].laptops.map((l) => l.label)));

  // Step 10
  await sleep(500);
  // Browser-level network noise while the relay is down is expected, not an extension error.
  const bad = errors.filter((e) => !/WebSocket connection to|ERR_CONNECTION_REFUSED|Failed to load resource/.test(e));
  if (errors.length) console.log('collected console/page errors:\n  ' + errors.join('\n  '));
  report('10 no uncaught extension errors', bad.length === 0, bad.join(' || '));
}

let code = 0;
try { await main(); } catch (e) {
  console.log('FAIL test-harness - ' + (e && e.stack || e));
  failed = true;
} finally {
  for (const lp of laptops) { try { await lp.context.close(); } catch {} try { fs.rmSync(lp.dir, { recursive: true, force: true }); } catch {} }
  await stopRelay();
  code = failed ? 1 : 0;
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(code);
}
