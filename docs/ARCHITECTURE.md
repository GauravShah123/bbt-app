# Hybrid Audio for Google Meet — Architecture & Contracts

Source of truth for module boundaries. If code and this doc disagree, fix one of them.

## Goal

Several laptops in one room + remote participant(s) on Google Meet. Every in-room laptop
runs this extension. Result: exactly one laptop (the **Hub**) plays Meet audio; in-room mics
are auto-mixed so the person talking is carried by the nearest laptop mic; remote speech
gates all in-room mics (no echo back to remote). Remote participants install nothing.
Zero setup: the room is derived from the Meet code; the Hub is elected automatically.

## Algorithm (summary)

Per laptop, every audio tick (~21 ms, ScriptProcessor 1024 frames @ 48 kHz):

1. **VAD** on raw mic RMS (dBFS) with a tracking noise floor, onset/release thresholds, hold.
2. **Gain sharing** (Dugan automixer, distributed): `gain_self = w_self / (w_self + Σ w_peer)`,
   `w = amp^β` (β = `shareExponent`, default 2 → power-proportional). Own amp is fresh;
   peer amps arrive via relay (~30 ms stale). Each laptop computes only its own gain.
3. **Floor state machine** (same on every laptop, computed locally):
   - `idle`   — nobody talking. Mics shared × `idleDuckDb`. Hub speaker on.
   - `room`   — someone in-room talking. Mics shared. Hub speaker **muted** (else Hub replays in-room voices from Meet ~200 ms late).
   - `remote` — remote talking. All in-room mics gain 0. Hub speaker on.
   - idle→remote after remote voice sustained `remoteOnIdleMs`; room→remote (interrupt; remote wins) after `remoteOnMs`; remote→idle/room after remote silent `remoteHoldMs`; room→idle after room silent `roomHoldMs`.
4. **Remote detection** from Meet's receive side, no WebAudio: `RTCRtpReceiver.getContributingSources()`
   gives per-participant CSRC + sender-computed `audioLevel` (RFC 6464). A CSRC is classified
   `remote` once it has been active ≥ `csrcEvidence` ticks while no in-room laptop was speaking in the
   last `csrcLookbackMs`. In-room CSRCs (our own laptops, as heard back through Meet) never accrue that
   evidence because their audio only exists while an in-room laptop is flagged speaking.
   If CSRCs are unavailable (only SSRC levels): "unidentified" mode — any active source counts as remote
   only when the room has been silent for `csrcLookbackMs`; interrupts are not possible.
5. **Leak guard**: while any remote source is active, own VAD requires `amp > leakDb + leakMarginDb`
   (leakDb = EMA of own mic level during remote speech) so Hub-speaker pickup is not mistaken for room speech.

Special cases: room size 1 → `solo` (plain Meet: gain 1, speaker on). Manual modes `hub`/`member`
override (Phase-1 behaviour). `off` → passthrough. Backend lost after connecting → `fallback`
(last known Hub: gain 1/speaker on; others gain 0/muted) + warning. Never connected → silent + warning
until the user picks Hub/Member.

## Files

```
extension/
  manifest.json            MV3. permissions: storage. host: https://meet.google.com/*
  config.js                export const BACKEND_URL = '' (wss://… of the deployed worker)
  background.js            (module SW) per-tab state, WebSocket to relay, tab mute, badge, popup port
  content/bridge.js        ISOLATED world, document_start. Page <-> SW relay.
  page/policy.js           MAIN world + Node. Pure logic (VAD, gain sharing, floor FSM, CSRC classifier). No DOM/audio APIs.
  page/engine.js           MAIN world. AudioContext graph, tick loop, calls policy, applies gains, talks to bridge.
  page/meet-hooks.js       MAIN world. ALL Meet/WebRTC-specific hooks. Nothing else touches Meet internals.
  popup/popup.html|css|js  UI
  icons/                   16/32/48/128 png
backend/
  src/room-core.js         Pure relay/election logic (Node-testable)
  src/index.js             Cloudflare Worker + Durable Object adapter
  dev-server.js            Node `ws` adapter for local testing (same room-core)
  wrangler.toml, package.json
test/
  policy.test.js           node:test scenarios for policy.js
  room-core.test.js        node:test for relay
  e2e/                     Playwright multi-"laptop" test against a fake Meet page + dev-server
```

MAIN-world script order (manifest): `page/policy.js`, `page/engine.js`, `page/meet-hooks.js`.
They share one namespace: `window.__hybridAudio` (define non-enumerable), holding
`{ policy, engine, hooks }`.

## Contract 1 — policy.js (pure)

UMD-style: sets `globalThis.__hybridAudio.policy` in browsers AND `module.exports` in Node.

```js
policy.DEFAULTS = {
  vadOnsetDb: 9, vadReleaseDb: 5, vadHoldMs: 300,
  floorInitDb: -60, floorMinDb: -90, floorRiseDbPerSec: 1.0,
  shareExponent: 2, idleDuckDb: -12,
  remoteOnDb: -50,            // dBov threshold on CSRC/SSRC audioLevel (20*log10(level))
  remoteOnIdleMs: 60, remoteOnMs: 300, remoteHoldMs: 500, roomHoldMs: 500,
  remoteFreshMs: 300, peerStaleMs: 1500,
  leakMarginDb: 10, leakTauMs: 2000,
  csrcEvidence: 10, csrcLookbackMs: 800,
};
const c = new policy.Controller(overrides);   // overrides merged onto DEFAULTS
c.setParams(partial);                         // live tuning
const out = c.step(input);
```

input:
```js
{
  now,                 // ms, monotonic (performance.now())
  selfAmp,             // linear RMS 0..1 of RAW mic (pre-gate); 0 if no mic
  participating,       // mic track live && enabled (Meet not muted). false => never speaking, weight 0, gain 0
  mode,                // 'auto'|'hub'|'member'|'off'
  connected,           // relay socket open AND roster received
  everConnected,       // has ever been connected this call
  isHub,               // from roster (auto) — last known value while disconnected
  roomSize,            // roster size incl. self (0 if unknown)
  peers: [{ id, amp, speaking, ageMs }],        // other laptops; ageMs since relay receipt
  remote: { identified, sources: [{ id, level, ageMs }] }  // level linear 0..1
}
```

output:
```js
{
  state,        // 'off'|'manual'|'solo'|'fallback'|'idle'|'room'|'remote'
  gain,         // target amplitude gain 0..1 for own outgoing mic
  tabMuted,     // desired tab mute. Non-hub in auto: always true. Hub: true only in 'room'.
  speaking,     // own VAD (false if !participating)
  amp,          // amp to broadcast (0 if !participating)
  remoteActive, // any remote-classified (or, unidentified+silent-room) source above threshold now
  trigger,      // for 'room' entry on hub: id of peer (or 'self') whose speech triggered; else null
  events,       // array, e.g. {type:'state', from, to, at}, {type:'remote-detect', ms, at} (ms = first active remote frame -> 'remote' state)
  debug: { floorDb, leakDb, selfDb, remoteDb, sources: {id: 'remote'|'room'|'unknown'} }
}
```
Rules for manual/off/solo/fallback exactly as in the Algorithm summary. Gains ∈ [0,1]. NaN-safe.
Peers with `ageMs > peerStaleMs` are ignored. Sources with `ageMs > remoteFreshMs` are inactive.

## Contract 2 — page <-> bridge (window CustomEvents, `detail` is a JSON string)

Page dispatches `ha:to-ext`; bridge dispatches `ha:to-page`. (Strings cross worlds safely.)

page → ext:
- `{type:'meet', meeting: 'abc-defg-hij'|null, inCall: bool}` — on change and on bridge `sync`.
- `{type:'st', a, s, r, rt}` — level to relay. a = amp (4 decimals), s/r = 0|1 speaking/remoteActive, rt = own RTT ms. Cadence: every 50 ms while speaking or |ΔdB| > 3; else every 1000 ms.
- `{type:'mute', muted}` — desired tab mute (send on change + every 2 s re-assert).
- `{type:'status', ...}` every 250 ms: `{state, mode, gain, isHub, roomSize, connected, everConnected, ctxState, selfDb, floorDb, remoteDb, identified, sources, rtt, speaking, participating, meeting, inCall, backendConfigured}`.
- `{type:'logDump', reqId, log}` reply to getLog.
- `{type:'cfg', params}` — test panel "apply to room" originating locally is sent by SW, not page.

ext → page:
- `{type:'config', mode, params, backendConfigured}` — on connect and on change.
- `{type:'room', connected, everConnected, you, hub, peers: [{id, p}]}`.
- `{type:'peer', id, a, s, r, rt}` — page stamps receipt time itself.
- `{type:'rtt', ms}`.
- `{type:'getLog', reqId}`.
- `{type:'sync'}` — bridge (re)connected to SW; page must re-send `meet`.

Fail-open: if the page has not received `config` within 3000 ms of the first wrapped track, behave as mode `off` until it does. Before that, gain 0.

## Contract 3 — bridge <-> SW (chrome.runtime port named `ha-tab`)

Bridge forwards page→ext messages verbatim over the port and ext→page messages verbatim to the page.
On port disconnect (SW restart) bridge reconnects (backoff 100 ms→2 s) and sends `{type:'sync'}` to the page.

## Contract 4 — SW <-> relay (WebSocket)

URL: `${BACKEND_URL}/room/${roomKey}?id=${clientId}&p=${pref}`
- `roomKey` = first 32 hex chars of SHA-256(`'hybrid-audio:' + meetingCode`).
- `clientId` = random 16-char [A-Za-z0-9] per tab, kept in `chrome.storage.session` for the tab's life (stable across SW restarts so Hub seniority survives reconnects).
- `pref` = 'auto'|'hub'|'member'. Mode 'off' → no socket.
- Connect only when mode ≠ off, meeting ≠ null, inCall, BACKEND_URL set. Reconnect backoff 0.5,1,2,4,8 s.

client → server: `{t:'st', a, s, r, rt}` | `{t:'p', p}` | `{t:'ping', ts}` (every 2 s) | `{t:'cfg', params}`
server → client: `{t:'roster', you, hub, peers:[{id,p}]}` (on any join/leave/pref change; peers includes self)
               | `{t:'st', id, a, s, r, rt}` (relayed from others) | `{t:'pong', ts}` | `{t:'cfg', params, from}`

Hub election (server): among connected peers, `p:'hub'` with earliest firstSeen; else `p:'auto'` earliest firstSeen; else null.
firstSeen persists per (room, id) for 6 h so a reconnecting Hub keeps the role. Duplicate id → close the older socket.
Limits: key `^[a-f0-9]{32}$`, id `^[A-Za-z0-9_-]{8,40}$`, ≤16 peers, message ≤512 bytes, ≤40 msg/s/socket (drop excess).
`GET /health` → `ok`.

## Contract 5 — popup <-> SW (port named `ha-popup`)

popup → SW: `{type:'subscribe', tabId}`, `{type:'setMode', tabId, mode}`, `{type:'setParams', params, room: bool}`,
`{type:'resetParams'}`, `{type:'getLog', tabId}` , `{type:'setBackend', url}`.
SW → popup: `{type:'status', tabId, status|null}` (≤4 Hz), `{type:'log', tabId, log}`, `{type:'params', params}`.

Mode per tab in `chrome.storage.session` (`mode:<tabId>`), default `'auto'`. Params (test overrides) in
`chrome.storage.local` `params`, pushed to all Meet tabs; `room: true` also sends `{t:'cfg'}` to the relay so
every laptop in the room applies them.

## Badge

hub → `HUB` green `#16a34a`; non-hub mic passing (gain > 0.3) → `MIC` blue `#2563eb`; non-hub silent → `·` gray `#71717a`;
warning (auto & !connected, or AudioContext suspended) → `!` red `#dc2626`; off / not in call → empty.

## Privacy

No audio leaves the machine except through Meet. The relay sees: hashed meeting code, random client ids,
mic RMS (4 decimals), speaking/remote flags, RTT, test params.
