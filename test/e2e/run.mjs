// End-to-end test: 3 "laptops" (persistent contexts) + local relay + fake Meet page.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
let failed = false;

function report(step, ok, detail = '') {
  results.push({ step, ok });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? ' - ' + detail : ''}`);
}

async function poll(fn, timeout, interval = 100) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = null; }
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
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
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
async function makeLaptop(i, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ha-e2e-${i}-`));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'],
  });
  const lp = { i, dir, context, page: null, sw: null, extId: null, name: `L${i}`, closed: false };
  const hookSW = (sw) => {
    sw.on('console', (m) => { if (m.type() === 'error') errors.push(`${lp.name} SW console.error: ${m.text()}`); });
  };
  lp.sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  hookSW(lp.sw);
  context.on('serviceworker', hookSW);
  lp.extId = new URL(lp.sw.url()).host;
  // extension APIs are bound slightly after the worker context appears
  if (!await poll(() => lp.sw.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.tabs && !!chrome.action), 5000)) {
    throw new Error('SW chrome APIs unavailable');
  }
  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_HTML }));
  await lp.sw.evaluate((url) => chrome.storage.local.set({ backendUrl: url }), `ws://127.0.0.1:${port}`);
  laptops.push(lp);
  return lp;
}

function hookPage(lp, page) {
  page.on('pageerror', (e) => errors.push(`${lp.name} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().startsWith('FAKE_MEET_ERROR')) {
      const loc = m.location() && m.location().url || '';
      errors.push(`${lp.name} console.${m.type()}: ${m.text()} @${loc}`);
    }
  });
}

async function openMeet(lp) {
  const page = await lp.context.newPage();
  hookPage(lp, page);
  lp.page = page;
  await page.goto(MEET_URL);
  return page;
}

const getState = (lp) => lp.page.evaluate(() => {
  const s = window.__hybridAudio.engine._debug.getState();
  return {
    isHub: s.isHub, size: s.room.size, connected: s.room.connected, everConnected: s.room.everConnected,
    state: s.lastOut && s.lastOut.state, gain: s.curGain, mode: s.mode, inCall: s.meet.inCall, hasConfig: s.hasConfig,
  };
});
const tabInfo = (lp) => lp.sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  const t = tabs[0];
  if (!t) return null;
  return { id: t.id, muted: !!(t.mutedInfo && t.mutedInfo.muted), badge: await chrome.action.getBadgeText({ tabId: t.id }) };
});
const live = () => laptops.filter((l) => !l.closed);
const safeState = async (lp) => { try { return await getState(lp); } catch { return null; } };
const safeTab = async (lp) => { try { return await tabInfo(lp); } catch { return null; } };

async function closeLaptopPage(lp) {
  lp.closed = true;
  try { await lp.page.close(); } catch {}
}

// Popup-protocol helper: open extension page and send through an ha-popup port.
async function popupSend(lp, msg) {
  const pg = await lp.context.newPage();
  pg.on('pageerror', (e) => errors.push(`${lp.name} popup pageerror: ${e.message}`));
  await pg.goto(`chrome-extension://${lp.extId}/popup/popup.html`);
  await pg.evaluate((m) => new Promise((res) => {
    const port = chrome.runtime.connect({ name: 'ha-popup' });
    port.postMessage(m);
    setTimeout(res, 300); // let the SW handle it before we drop the port
    window.__p = port;
  }), msg);
  await pg.close();
}

// ---------- main ----------
async function main() {
  const port = await freePort();
  console.log(`relay port ${port}`);
  await startRelay(port);

  for (let i = 0; i < 3; i++) await makeLaptop(i, port);
  // verify storage took effect
  for (const lp of laptops) {
    const v = await lp.sw.evaluate(() => chrome.storage.local.get('backendUrl'));
    if (v.backendUrl !== `ws://127.0.0.1:${port}`) throw new Error('backendUrl not stored');
  }

  // Step 1/2: open Meet in each, verify injection
  for (const lp of laptops) await openMeet(lp);
  let injected = true;
  for (const lp of laptops) {
    const ok = await poll(() => lp.page.evaluate(() => !!(window.__hybridAudio && window.__hybridAudio.engine)), 5000);
    if (!ok) injected = false;
  }
  report('1-2 content scripts inject, __hybridAudio exists (main world)', injected);
  if (!injected) return;
  const inCallOk = await poll(async () => (await Promise.all(laptops.map(safeState))).every((s) => s && s.inCall), 5000);
  report('2 fake Meet reaches inCall on all laptops', !!inCallOk);

  // Step 3
  let snap = null;
  const settled = await poll(async () => {
    const ss = await Promise.all(laptops.map(safeState));
    const ts = await Promise.all(laptops.map(safeTab));
    snap = { ss, ts };
    const hubs = ss.filter((s) => s && s.isHub).length;
    return hubs === 1 && ss.every((s) => s && s.size === 3 && s.connected);
  }, 5000);
  if (!settled) {
    report('3a exactly one hub, roomSize 3, all connected', false, JSON.stringify(snap && snap.ss));
  } else {
    report('3a exactly one hub, roomSize 3, all connected', true);
  }
  // mute + badges (poll: SW round trips take a moment)
  let mb = null;
  const muteOk = await poll(async () => {
    const ss = await Promise.all(laptops.map(safeState));
    const ts = await Promise.all(laptops.map(safeTab));
    mb = ss.map((s, k) => ({ hub: s && s.isHub, muted: ts[k] && ts[k].muted, badge: ts[k] && ts[k].badge }));
    return mb.every((x) => x.hub ? (x.muted === false && x.badge === 'HUB') : (x.muted === true && (x.badge === '·' || x.badge === 'MIC')));
  }, 5000);
  report('3b hub unmuted + HUB badge; non-hubs muted + (· or MIC)', !!muteOk, JSON.stringify(mb));

  // Step 4
  const gains = await Promise.all(laptops.map(safeState));
  console.log('gain/state:', gains.map((g) => g && `${g.isHub ? 'hub' : 'non'} state=${g.state} gain=${g.gain}`).join(' | '));
  const gainOk = gains.every((g) => g && Number.isFinite(g.gain) && (g.isHub || g.gain <= 1));
  report('4 gains finite, non-hub <= 1', gainOk);

  // Step 5: hub leaves
  let hub = laptops.find((l, k) => gains[k] && gains[k].isHub);
  await closeLaptopPage(hub);
  let rem = live(), st5 = null;
  const ok5 = await poll(async () => {
    const ss = await Promise.all(rem.map(safeState));
    const ts = await Promise.all(rem.map(safeTab));
    st5 = ss.map((s, k) => ({ hub: s && s.isHub, size: s && s.size, muted: ts[k] && ts[k].muted }));
    return st5.filter((x) => x.hub).length === 1 && st5.every((x) => x.size === 2) &&
      st5.filter((x) => x.hub).every((x) => x.muted === false);
  }, 3000);
  report('5 hub leaves: new hub elected & unmuted, roomSize 2', !!ok5, JSON.stringify(st5));

  // Step 6: solo
  const victim = live().find((l) => true);
  // close a non-hub-or-hub; the remaining one must be solo
  await closeLaptopPage(victim);
  const last = live()[0];
  let st6 = null;
  const ok6 = await poll(async () => {
    const s = await safeState(last), t = await safeTab(last);
    st6 = { ...s, muted: t && t.muted };
    return s && s.state === 'solo' && s.gain === 1 && t && t.muted === false;
  }, 4000);
  report('6 solo: state solo, gain 1, unmuted', !!ok6, JSON.stringify(st6));

  // Step 7: backend loss. Re-open two laptops (fresh pages).
  await closeLaptopPage(last);
  await sleep(300);
  const two = laptops.slice(0, 2);
  for (const lp of two) { lp.closed = false; await openMeet(lp); }
  let st7 = null;
  const up = await poll(async () => {
    const ss = await Promise.all(two.map(safeState));
    return ss.filter((s) => s && s.isHub).length === 1 && ss.every((s) => s && s.size === 2 && s.connected);
  }, 6000);
  report('7a two laptops reconnected, one hub', !!up);
  const ss0 = await Promise.all(two.map(safeState));
  const lastHub = two.find((l, k) => ss0[k] && ss0[k].isHub);
  const other = two.find((l) => l !== lastHub);
  await stopRelay();
  const tKill = Date.now();
  const ok7 = await poll(async () => {
    const ss = await Promise.all(two.map(safeState));
    const ts = await Promise.all(two.map(safeTab));
    st7 = ss.map((s, k) => ({ n: two[k].name, hub: two[k] === lastHub, connected: s && s.connected, state: s && s.state, gain: s && s.gain, muted: ts[k] && ts[k].muted }));
    return st7.every((x) => x.connected === false && x.state === 'fallback') &&
      st7.every((x) => x.hub ? (x.gain === 1 && x.muted === false) : (x.gain === 0 && x.muted === true));
  }, 12000);
  report('7b backend killed: both fallback; last hub gain 1 unmuted, other gain 0 muted', !!ok7, `${Date.now() - tKill}ms ${JSON.stringify(st7)}`);
  await startRelay(port);
  let st7c = null;
  const ok7c = await poll(async () => {
    const ss = await Promise.all(two.map(safeState));
    const ts = await Promise.all(two.map(safeTab));
    st7c = ss.map((s, k) => ({ n: two[k].name, hub: s && s.isHub, connected: s && s.connected, size: s && s.size, state: s && s.state, muted: ts[k] && ts[k].muted }));
    return st7c.every((x) => x.connected && x.size === 2) && st7c.filter((x) => x.hub).length === 1 &&
      st7c.find((x) => x.hub).muted === false && st7c.find((x) => !x.hub).muted === true &&
      st7c.every((x) => x.state !== 'fallback');
  }, 10000);
  report('7c relay restarted: both reconnect, roles recovered', !!ok7c, JSON.stringify(st7c));

  // Step 7d: Test panel "Copy log" path (popup -> SW -> page -> SW -> popup) and setParams reaching the page
  const tabHub = await safeTab(lastHub);
  const pg = await lastHub.context.newPage();
  await pg.goto(`chrome-extension://${lastHub.extId}/popup/popup.html`);
  const got = await pg.evaluate((tabId) => new Promise((res) => {
    const port = chrome.runtime.connect({ name: 'ha-popup' });
    port.onMessage.addListener((m) => { if (m.type === 'log') res(m.log); });
    port.postMessage({ type: 'subscribe', tabId });
    port.postMessage({ type: 'setParams', params: { shareExponent: 3 }, room: false });
    setTimeout(() => port.postMessage({ type: 'getLog', tabId }), 400);
    setTimeout(() => res(null), 4000);
  }), tabHub.id);
  await pg.close();
  const hasParam = !!(got && got.params && got.params.shareExponent === 3);
  report('7d Copy log returns log + summary; setParams applied', !!(got && Array.isArray(got.log) && got.log.length && got.summary && hasParam),
    got ? `entries=${got.log && got.log.length} summaryKeys=${Object.keys(got.summary || {})} shareExponent=${got.params && got.params.shareExponent}` : 'no log');

  // Step 8: mode override on `other` (non-hub in normal circumstances; use whichever is 'other')
  const tabOther = await safeTab(other);
  await popupSend(other, { type: 'setMode', tabId: tabOther.id, mode: 'member' });
  let st8 = null;
  const ok8a = await poll(async () => {
    const s = await safeState(other), t = await safeTab(other);
    st8 = { ...s, muted: t && t.muted };
    return s && s.mode === 'member' && s.gain === 0 && t && t.muted === true;
  }, 4000);
  report('8a member mode: muted, gain 0', !!ok8a, JSON.stringify(st8));
  await popupSend(other, { type: 'setMode', tabId: tabOther.id, mode: 'off' });
  let st8b = null;
  const ok8b = await poll(async () => {
    const s = await safeState(other), t = await safeTab(other);
    const peer = await safeState(lastHub);
    st8b = { ...s, muted: t && t.muted, peerRoom: peer && peer.size };
    return s && s.mode === 'off' && s.gain === 1 && t && t.muted === false && peer && peer.size === 1;
  }, 4000);
  report('8b off mode: gain 1, unmuted, socket closed (peer roster drops)', !!ok8b, JSON.stringify(st8b));

  // Step 9
  await sleep(500);
  const bad = errors.filter((e) => /chrome-extension:|hybridAudio|policy\.js|engine\.js|meet-hooks|bridge\.js|background\.js|SW /.test(e));
  if (errors.length) console.log('collected errors:\n  ' + errors.join('\n  '));
  report('9 no uncaught extension errors', bad.length === 0, bad.join(' || '));
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
