// Extra e2e paths: SW socket-proxy fallback, sound check, hub loss/reload, gUM re-call while gated, Meet mute, popup UI.
//   node test/e2e/extra.mjs   (helpers copied from run.mjs)
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
// E2E_CSP=strict: Google-style strict CSP (nonce + strict-dynamic + Trusted Types) and connect-src 'self',
// which blocks a direct relay socket from the page origin and forces the SW proxy if the isolated world is subject to it.
const CSP_MODE = process.env.E2E_CSP === 'strict';
const CSP_HEADER = "script-src 'nonce-e2e' 'strict-dynamic' 'unsafe-eval'; object-src 'none'; base-uri 'self'; " +
  "require-trusted-types-for 'script'; connect-src 'self'";
const TOKEN = 'testtoken';
const GRACE_MS = 8000; // hub-loss grace on the local relay (room-core default is 30 s)
const SHOTS = '/tmp/claude-0/-home-user-bbt-app/0309158d-bee3-53bf-a161-34fd24e59781/scratchpad/final-ui';

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
    env: { ...process.env, PORT: String(port), TEAM_TOKEN: TOKEN, GRACE_MS: String(GRACE_MS) }, stdio: ['ignore', 'pipe', 'pipe'],
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
    route.fulfill(CSP_MODE
      ? { status: 200, contentType: 'text/html', headers: { 'content-security-policy': CSP_HEADER }, body: FAKE_HTML.replace(/<script>/g, '<script nonce="e2e">') }
      : { status: 200, contentType: 'text/html', body: FAKE_HTML }));
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


// ---------- extra helpers ----------
async function setup(n, backendPort) {
  const ls = [];
  for (let i = 0; i < n; i++) ls.push(await makeLaptop(i));
  for (const lp of ls) { lp.page = await lp.context.newPage(); hookPage(lp, lp.page, 'meet'); await lp.page.goto(MEET_URL); }
  for (const lp of ls) {
    const ok = await poll(() => lp.page.evaluate(() => {
      const x = window.__hybridAudio; return !!(x && x.engine && x.main && x.hooks && x.RoomClient && x.coordinator && x.hooks.getMeetState().inCall);
    }), 8000, 100);
    if (!ok) throw new Error(`${lp.name}: modules/inCall not ready`);
    lp.tabId = (await tabInfo(lp)).id;
    await openPopup(lp);
    await lp.popup.evaluate((id) => { window.__tabId = id; }, lp.tabId);
    await popupSend(lp, { type: 'subscribe', tabId: lp.tabId });
    await popupSend(lp, { type: 'setBackend', url: `ws://127.0.0.1:${backendPort}`, token: TOKEN });
    await setLevel(lp, QUIET);
  }
  await sleep(300);
  return ls;
}
async function teardown() {
  for (const lp of laptops) { try { await lp.context.close(); } catch {} try { fs.rmSync(lp.dir, { recursive: true, force: true }); } catch {} }
  laptops.length = 0;
}
const waitDbg = (lp, pred, t = 5000, iv = 50) => poll(async () => { const s = await safeDbg(lp); return s && pred(s) ? s : null; }, t, iv);

// HTTP proxy in front of the relay: refuses the first `refuse` upgrades per cid (503), then pipes through.
function startFlakyProxy(port, relayPort, refuse) {
  const http = require('node:http');
  const counts = new Map();
  const srv = http.createServer((q, r) => { r.statusCode = 404; r.end(); });
  srv.on('upgrade', (req, socket, head) => {
    const cid = new URL(req.url, 'http://x').searchParams.get('cid') || '?';
    const n = (counts.get(cid) || 0) + 1; counts.set(cid, n);
    if (n <= refuse) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    const up = net.connect(relayPort, '127.0.0.1', () => {
      let h = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) h += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(h + '\r\n'); if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
    up.on('close', () => socket.destroy()); socket.on('close', () => up.destroy());
  });
  return new Promise((res) => srv.listen(port, '127.0.0.1', () => res({ srv, counts })));
}

// Peak |sample| of a stream's audio over `ms`, via an AnalyserNode in the page.
const peakOf = (lp, which, ms) => lp.page.evaluate(async ({ which, ms }) => {
  const stream = which === 'new' ? window.__gum2 : window.__fake.stream;
  const ctx = new AudioContext(); await ctx.resume();
  const an = ctx.createAnalyser(); an.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize); let peak = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    an.getFloatTimeDomainData(buf);
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    await new Promise((r) => setTimeout(r, 20));
  }
  ctx.close();
  return peak;
}, { which, ms });

// A popup that sees `lp`'s Meet tab as the active tab (popup.js queries active tab in the current window).
async function openRealPopup(lp) {
  const pg = await lp.context.newPage();
  hookPage(lp, pg, 'realpopup');
  await pg.addInitScript(({ id, url }) => { chrome.tabs.query = async () => [{ id, url, active: true }]; }, { id: lp.tabId, url: MEET_URL });
  await pg.setViewportSize({ width: 360, height: 520 });
  await pg.goto(`chrome-extension://${lp.extId}/popup/popup.html`);
  return pg;
}

// ---------- phase 1: SW socket-proxy fallback ----------
async function phase1() {
  const relayPort = await freePort(), proxyPort = await freePort();
  await startRelay(relayPort);
  const { srv, counts } = await startFlakyProxy(proxyPort, relayPort, 2);
  try {
    const [A, B] = await setup(2, proxyPort);
    await ui(A, 'join'); await sleep(200); await ui(B, 'join');
    let ss = null;
    const ok = await poll(async () => {
      ss = await snap([A, B]);
      const [a, b] = ss;
      return a.role === 'hub' && b.role === 'member' && a.state === 'ROOM' && b.gate === 0 && b.tab.muted === true && a.laptops.length === 2 && a.laptops.every((l) => l.ready);
    }, 20000, 100);
    const sa = await lastStatus(A), sb = await lastStatus(B);
    report('1a direct socket fails twice -> status.via === "sw" on both', !!(sa && sb && sa.via === 'sw' && sb.via === 'sw'),
      `via A=${sa && sa.via} B=${sb && sb.via} upgradeAttempts=${JSON.stringify([...counts.values()])}`);
    report('1b room works over SW proxy: hub/member roles, ROOM, B gate 0 muted', !!ok, fmt(ss || []));
    await setLevel(B, LOUD);
    const idB = ss && ss[1].you;
    const sw = await poll(async () => { const s = await snap([A, B]); return s[0].owner === idB && s[1].gate === 1 && s[0].gate === 0; }, 3000);
    report('1c switch to B over SW proxy', !!sw);
  } finally { srv.close(); await teardown(); await stopRelay(); }
}

// ---------- phase 2: the rest, 3 laptops on the relay directly ----------
async function phase2() {
  const port = await freePort();
  await startRelay(port);
  const [A, B, C] = await setup(3, port);
  await ui(A, 'join'); await sleep(200); await ui(B, 'join'); await sleep(150); await ui(C, 'join');
  let ss = null;
  const ok = await poll(async () => {
    ss = await snap(laptops);
    return ss[0].role === 'hub' && ss[0].state === 'ROOM' && ss[1].gate === 0 && ss[2].gate === 0 && ss[0].laptops.length === 3 && ss[0].laptops.every((l) => l.ready);
  }, 8000);
  if (!ok) { report('setup: 3 laptops in ROOM', false, fmt(ss || [])); return; }
  const idA = ss[0].you, idB = ss[1].you, idC = ss[2].you;

  // ---- 2. sound check ----
  await setLevel(B, LOUD);
  const bOwn = await waitDbg(A, (s) => s.owner === idB && s.state === 'ROOM', 3000);
  await setLevel(B, QUIET); // B stays owner (keeps the mic through pauses) but is not talking
  const st0 = await lastStatus(A);
  await ui(A, 'soundCheck');
  let s2 = null;
  const listening = await poll(async () => {
    s2 = await snap(laptops);
    const a = s2[0];
    return a.state === 'SOUNDCHECK' && gateSum(s2) === 0 && a.tab.muted === false;
  }, 3000, 30);
  report('2a soundCheck: SOUNDCHECK, all gates closed, A tab unmuted while listening', !!(bOwn && listening),
    `B owner first=${!!bOwn} actions=${JSON.stringify(st0 && st0.actions)} ${fmt(s2 || [])}`);
  await setRemote(A, true);
  const enr = await poll(async () => {
    const l = await getLog(A);
    return l && l.log.some((e) => e.k === 'coord' && e.ev === 'enroll' && e.kind === 'remote' && e.id === 'c999');
  }, 3000, 150);
  await sleep(800);
  await setRemote(A, false);
  let s2b = null;
  const room2 = await poll(async () => {
    s2b = await snap(laptops);
    return s2b[0].state === 'ROOM' && s2b[0].tab.muted === true && gateSum(s2b) === 1;
  }, 4000);
  const st2 = await lastStatus(A);
  report('2b stubbed active source enrolls remote -> ROOM, A tab muted, one gate open', !!(enr && room2 && st2 && st2.remote.enrolled >= 1),
    `enrolled=${!!enr} remote=${JSON.stringify(st2 && st2.remote)} ${fmt(s2b || [])}`);

  // ---- 4. mic device switch while gated (member B, gate 0) ----
  await setLevel(B, QUIET); await setLevel(A, LOUD);
  const aOwn = await waitDbg(A, (s) => s.owner === idA && s.state === 'ROOM' && s.gate === 1, 3000);
  const bGate0 = await waitDbg(B, (s) => s.gate === 0, 2000);
  await B.page.evaluate(async () => {
    window.__gum2 = await navigator.mediaDevices.getUserMedia({ audio: true });
  });
  const hasTrack = await B.page.evaluate(() => window.__gum2.getAudioTracks().length);
  const peakGated = await peakOf(B, 'new', 2500);
  report('4a gUM re-call while gated: new processed track silent', !!(aOwn && bGate0) && hasTrack === 1 && peakGated < 1e-4,
    `peak=${peakGated} tracks=${hasTrack}`);
  await setLevel(A, QUIET); await setLevel(B, LOUD);
  const bOwn2 = await waitDbg(A, (s) => s.owner === idB && s.state === 'ROOM', 3000);
  await waitDbg(B, (s) => s.gate === 1, 2000);
  const peakOpen = await peakOf(B, 'new', 2500);
  report('4b B becomes owner -> new track carries audio', !!bOwn2 && peakOpen > 0.01, `peak=${peakOpen}`);

  // ---- 5. Meet's own mute on the owner ----
  // Real userMuted/healthy must show through: override only level fields.
  const lvlOnly = { levelDb: -20, noiseDb: -60, act: true };
  await setLevel(B, lvlOnly); await setLevel(A, { levelDb: -40, noiseDb: -60, act: true, healthy: true, userMuted: false });
  await sleep(500);
  const t5 = Date.now();
  await B.page.evaluate(() => { window.__gum2.getAudioTracks()[0].enabled = false; }); // newest live processed track = what Meet holds after a device change
  let s5 = null;
  const away = await poll(async () => {
    s5 = await snap(laptops);
    return s5[0].owner && s5[0].owner !== idB && s5[1].gate === 0 && gateSum(s5) === 1;
  }, 2500, 30);
  const dt5 = Date.now() - t5;
  const bm = await B.page.evaluate(() => window.__hybridAudio.main._debug().laptops);
  const sA5 = await safeDbg(A);
  const bRow = sA5 && sA5.laptops.find((l) => l.id === idB);
  report('5a Meet mute on owner B: ineligible, hub moves mic away within ~1s', !!away && dt5 <= 1500 && bRow && bRow.ready === false,
    `${dt5}ms bReady=${bRow && bRow.ready} ${fmt(s5 || [])}`);
  await B.page.evaluate(() => { window.__gum2.getAudioTracks()[0].enabled = true; });
  let s5b = null;
  const back5 = await poll(async () => {
    s5b = await snap(laptops);
    const row = s5b[0].laptops.find((l) => l.id === idB);
    return row && row.ready === true && s5b[0].owner === idB && s5b[1].gate === 1;
  }, 4000);
  report('5b re-enable: B eligible again (ready, regains mic)', !!back5, fmt(s5b || []));
  await setLevel(B, QUIET); await setLevel(A, QUIET);

  // ---- 6. popup UI smoke (A hub) ----
  await setLevel(A, LOUD); await waitDbg(A, (s) => s.owner === idA, 3000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const pop = await openRealPopup(A);
  const shown = await poll(async () => pop.evaluate(() => !document.getElementById('joined').hidden && /laptop/.test(document.getElementById('count').textContent)), 4000);
  const ui6 = await pop.evaluate(() => ({
    role: document.getElementById('role').textContent, count: document.getElementById('count').textContent,
    owner: document.getElementById('owner').textContent, rows: document.querySelectorAll('#laptops li').length,
  }));
  await pop.screenshot({ path: path.join(SHOTS, 'popup-hub.png') });
  report('6a popup (hub): shows Hub, "3 laptops", Mic label', !!shown && ui6.role === 'Hub' && ui6.count === '3 laptops' && ui6.owner && ui6.owner !== '-' && ui6.rows === 3, JSON.stringify(ui6));
  await pop.click('#leaveBtn');
  const left = await poll(async () => { const s = await safeDbg(A); const t = await safeTab(A); return s && !s.joined && t && t.muted === false; }, 4000);
  await sleep(300);
  await pop.screenshot({ path: path.join(SHOTS, 'popup-after-leave.png') });
  const hubNow = await poll(async () => { const s = await snap([B, C]); return s.some((x) => x.role === 'hub') && s; }, 5000);
  report('6b popup Leave: A actually leaves (not joined, tab unmuted), hub handed over', !!(left && hubNow), JSON.stringify(hubNow && hubNow.map((x) => [x.nm, x.role])));
  await pop.close();
  await setLevel(A, QUIET);

  // ---- 3. hub tab closed / reloaded ----
  // A rejoins as member; then close the hub's page.
  await ui(A, 'join');
  const hubL = (await snap([B, C])).find((x) => x.role === 'hub');
  const hub = hubL.nm === 'B' ? B : C, other = hub === B ? C : B;
  const rejoin = await poll(async () => { const s = await snap([A, B, C]); return s.every((x) => x.joined) && s.filter((x) => x.role === 'hub').length === 1 && s.find((x) => x.nm === hub.name).laptops.length === 3; }, 6000);
  if (!rejoin) { report('3 setup: A rejoined, 3 laptops', false); return; }
  const idHub = hubL.you;
  const tClose = Date.now();
  await hub.page.close();
  let pauseSt = null;
  const lost = await poll(async () => {
    pauseSt = await Promise.all([A, other].map((lp) => lastStatus(lp)));
    return pauseSt.every((s) => s && s.pause && s.pause.reason === 'hub' && s.actions.includes('takeOver') && !s.relayUp === false);
  }, 6000, 100);
  report('3a hub tab closed: members show pause hub-lost + takeOver', !!lost, `${Date.now() - tClose}ms ` + JSON.stringify(pauseSt && pauseSt.map((s) => s && [s.pause, s.actions])));
  // before grace expiry a take is rejected by the relay
  const mem1 = A, mem2 = other;
  await ui(mem1, 'takeOver'); await sleep(1500);
  const early = await safeDbg(mem1);
  const waitGrace = Math.max(0, GRACE_MS + 1200 - (Date.now() - tClose));
  await sleep(waitGrace);
  await ui(mem1, 'takeOver');
  let s3 = null;
  const took = await poll(async () => {
    s3 = await snap([mem1, mem2]);
    return s3[0].role === 'hub' && s3[1].role === 'member' && s3[0].state === 'ROOM' && gateSum(s3) === 1;
  }, 5000);
  report('3b take during grace ignored; after grace ui takeOver: member becomes hub, ROOM, one gate open', !!took && early && early.role === 'member', `earlyRole=${early && early.role} (take during grace should be ignored) ${fmt(s3 || [])}`);
  await setLevel(mem2, LOUD);
  const idM2 = s3 && s3[1].you;
  const works = await poll(async () => { const s = await snap([mem1, mem2]); return s[0].owner === idM2 && s[1].gate === 1 && s[0].gate === 0; }, 3000);
  report('3c new hub: room works (switch to the other member)', !!works);
  await setLevel(mem2, QUIET);

  // hub page reload -> reclaims within grace, no takeover
  const idNewHub = s3 && s3[0].you;
  await mem1.page.reload();
  const tRel = Date.now();
  let s3r = null;
  const reclaimed = await poll(async () => {
    try {
      await setLevel(mem1, QUIET);
      s3r = await snap([mem1, mem2]);
      return s3r[0].joined && s3r[0].role === 'hub' && s3r[1].role === 'member' && s3r[0].you === idNewHub && s3r[0].state === 'ROOM' && s3r[0].laptops.length === 2 && gateSum(s3r) === 1;
    } catch { return false; }
  }, GRACE_MS, 150);
  const acts = await lastStatus(mem1);
  report('3d hub page reload: reclaims hub within grace without takeOver', !!reclaimed, `${Date.now() - tRel}ms ${fmt(s3r || [])}`);
}

let code = 0;
try {
  await phase1();
  await phase2();
  await sleep(300);
  const bad = errors.filter((e) => !/WebSocket connection to|ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|Failed to load resource|503/.test(e));
  if (errors.length) console.log('collected console/page errors:\n  ' + errors.join('\n  '));
  report('7 no uncaught extension errors', bad.length === 0, bad.join(' || '));
} catch (e) {
  console.log('FAIL test-harness - ' + (e && e.stack || e));
  failed = true;
} finally {
  await teardown();
  await stopRelay();
  code = failed ? 1 : 0;
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(code);
}
