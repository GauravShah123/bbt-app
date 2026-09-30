# Hybrid Audio for Google Meet — Architecture v2

**Status:** Implementing · **Scope:** one team, 3–8 laptops in one room, usually one remote participant · **Cost:** $0.
Rationale and alternatives: [`DESIGN.md`](./DESIGN.md). This file is the source of truth for module contracts.

## 1. Decision

**Hub-coordinated automatic mic selection, with remote-priority half-duplex audio.**

- Exactly **one in-room mic transmits** at a time. The Hub picks it automatically as people speak and move.
- The **Hub is the only laptop whose speaker plays Meet**. Every other joined laptop keeps its Meet tab muted.
- When the remote person talks, the Hub closes the open room mic, waits for confirmation, then unmutes its tab.
- **We never replace Meet audio.** We only (a) gate each in-room laptop's outgoing mic via a wrapped `getUserMedia` track, and (b) mute or unmute each in-room laptop's Meet tab (`chrome.tabs.update`).
- The Hub alone makes floor decisions. The relay forwards small JSON messages (levels, commands, acks) and never sees audio.
- Changes vs the reviewed proposal:
  1. The Hub role **hands over automatically on intentional leave**, including leaving the Meet.
  2. Room laptops' CSRCs are **learned by elimination**. The sound check is only a fallback.
  3. **No playback buffer.**
  4. Handoff order is configurable: overlap (default) or gap.

## 2. User flow

- **Join.** In a Meet call, the popup shows **Join room audio**. Clicking it:
  - closes this laptop's mic gate and mutes its tab;
  - joins the room.
  The first laptop to join becomes Hub.
- **Automatic operation.** Everything after that is automatic, including remote enrollment, which happens while the Hub owns the mic.
- **Reloads and reconnects** automatically rejoin with gates closed, for the same tab and meeting.
- **Leaving.** Clicking **Leave** or leaving the Meet sends `leave` after the gate has closed. If that laptop was Hub, the relay promotes the earliest-joined ready member.
- **Solo.** When the Hub is the only laptop left and every departure was clean, it switches to `SOLO`: plain Meet.
- **Recovery actions** appear only when needed:
  - Hub: **Use Hub only**, **Continue without {laptop}**, **Resume**, **Sound check**;
  - member: **Take over as Hub**;
  - member: **Make this the Hub** (intentional transfer, always available).
- **Laptops that aren't joined** are untouched: plain Meet. Anyone in the room who hasn't joined must use Companion mode or stay muted.

## 3. Files

```
extension/
  manifest.json          MV3. permissions: storage. host: https://meet.google.com/*. WAR: page/meter-worklet.js
  config.js              export const BACKEND_URL = '', TEAM_TOKEN = ''  (team fills in locally)
  background.js          (module SW) settings, per-tab joined memory, tab mute executor, badge, popup port, socket-proxy fallback
  content/bridge.js      ISOLATED. Page<->SW relay + WebSocket pipe (direct; SW proxy fallback)
  page/meet-hooks.js     MAIN. ALL Meet/WebRTC-specific code: gUM wrap, PC tracking, pollRemote, meet state
  page/audio-engine.js   MAIN. Audio graph: measurement branch + gate. Applied-acks on the audio clock.
  page/meter-worklet.js  AudioWorkletProcessor (RMS of band-passed mic). Optional; ScriptProcessor fallback.
  page/coordinator.js    MAIN + Node. PURE: Coordinator (Hub FSM, selection, CSRC learning) + MemberAgent
  page/room-client.js    MAIN. Relay protocol over the bridge pipe: session/epoch/seq, reconnect
  page/main.js           MAIN. Glue: join/leave, routing, heartbeats, status, event log
  popup/                 UI
backend/src/room-core.js pure relay (sessions, hub grant/promotion, auth, limits, usage cap)
backend/src/index.js     Cloudflare Worker + Durable Object (ordinary WebSockets)
backend/dev-server.js    Node `ws` host of the same core
test/coordinator.test.js, test/room-core.test.mjs, test/e2e/run.mjs
```

MAIN-world load order: `coordinator.js, audio-engine.js, meet-hooks.js, room-client.js, main.js`, all at document_start.
They share the non-enumerable namespace `window.__hybridAudio` = `{coordinator, engine, hooks, RoomClient, main}`.
The old `policy.js` and `engine.js` are deleted.

## 4. Contract A: audio-engine.js (`NS.engine`)

Graph per wrapped mic track `orig`:
- **Transmit path:** `src → gateGain → MediaStreamDestination`. Meet receives the processed track, which is disguised as `orig` (label, getSettings/getCapabilities/getConstraints/applyConstraints delegate; stop/clone/`ended` handled; keep the existing proven implementation).
- **Measurement branch,** tapped before the gate: `src → highpass 200 Hz → lowpass 4 kHz → meter`.
  - The meter is an AudioWorklet (`meter-worklet.js`, loaded from the `workletUrl` in config).
  - If `addModule` fails (Meet CSP), fall back to ScriptProcessor(1024).
  - A zero-gain node to the destination keeps it pulling.
- Only the most recent live `orig` feeds the meter. All live gates share one target.

API:
```js
engine.processStream(stream) -> MediaStream        // called by meet-hooks; audio tracks processed, video passed through
engine.setMode('passthrough'|'controlled')         // passthrough = gate forced open (not joined / SOLO / HUB_ONLY handled by caller via setGate)
engine.setGate(open) -> Promise<{gate, at}>        // ramps 8 ms; resolves when the ramp has completed on the audio clock
                                                   // (checked in meter callbacks). Latest call wins; a superseded promise
                                                   // resolves with the final applied state.
engine.gateApplied -> 0|1                          // last completed state
engine.measure -> { levelDb, noiseDb, act, healthy, userMuted, hasMic, ctxState, meter:'worklet'|'script'|'none', tickAgeMs }
engine.setNoiseFreeze(bool)                        // freeze noise estimate (Hub playback / remote floor)
engine.setParams({ vadOnsetDb, minSpeechDb, actHoldMs })
engine.onTick(fn)                                  // fn(nowMs) on every meter callback (~20 ms), audio-clock driven
engine.setWorkletUrl(url); engine.resume()
```
- **Measurement:**
  - levelDb = 20·log10(RMS of band-passed 20 ms window).
  - noiseDb falls fast (τ 200 ms), rises 1 dB/s. It is frozen while `act`, and while frozen by the caller. It starts with a 1 s warm-up.
  - act = levelDb > noiseDb + vadOnsetDb (9) && levelDb > minSpeechDb (-55), with hold actHoldMs (200).
- **Other fields:**
  - userMuted = the processed track is `enabled === false` or ended (Meet's own mute). When muted: act = 0.
  - healthy = ctx running && tickAgeMs < 500 && hasMic && !userMuted.
- **Defaults before main configures it:** mode `passthrough` (plain Meet). Nothing is gated until the user joins.

## 5. Contract B: meet-hooks.js (`NS.hooks`)

Keep the current implementation (gUM wrap on the MediaDevices.prototype → `engine.processStream`; RTCPeerConnection Proxy tracking; the CSRC/SSRC `pollRemote` including SSRC-level attribution to the latest CSRC; meeting code from the URL; inCall = a tracked PC is `connected`). It calls `NS.main.onMeetState({meeting, inCall})` on change; if main isn't loaded yet, it retries on the next poll.
```js
hooks.pollRemote() -> { identified, sources: [{ id, level /*0..1*/, ageMs }] }
hooks.getMeetState() -> { meeting, inCall }
```

## 6. Contract C: coordinator.js (pure; `NS.coordinator` and `module.exports`)

```js
const { Coordinator, MemberAgent, DEFAULTS } = coordinator;
DEFAULTS = {
  switchAdvantageDb: 6, switchSustainMs: 100, minOwnMs: 300, idleTakeoverMs: 60,
  levelFreshMs: 400, minSpeechDb: -55,
  remoteOnDb: -50, remoteOnMs: 40, remoteHoldMs: 300, remoteFreshMs: 150,
  settleMs: 150, ackTimeoutMs: 1000, handoffOverlap: 1,
  learnTicks: 15, enrollTicks: 3, learnSettleMs: 600,
  hbIntervalMs: 500, watchdogMs: 1500,
};
```

### Coordinator (runs on the Hub only)

```js
const c = new Coordinator({ selfId, params });
c.setParams(partial)
c.onRoster([{ id, ready, n }])            // current members incl. self; ready = gate closed + muted + healthy
c.onLevel(id, { levelDb, noiseDb, act, healthy, userMuted, at })   // self measurements too (id = selfId)
c.onApplied(id, gen, gate)                // ack from member (or self via local engine)
c.onLeft(id)                              // clean leave: gate was closed before leaving
c.onLost(id)                              // disconnected without leave: gate state unknown
c.onRelay(up)
c.action(name, arg)                       // 'hubOnly' | 'resume' | 'dropLost' (arg id) | 'soundCheck' | 'continueSolo' | 'resetIds'
const out = c.tick(now, remote)           // remote = hooks.pollRemote() result
```

`out`:
```js
{
  state,          // 'ROOM'|'SWITCHING'|'REMOTE_PENDING'|'REMOTE'|'SETTLING'|'SOUNDCHECK'|'PAUSED'|'HUB_ONLY'|'SOLO'
  owner,          // id whose gate is open (or being opened) | null
  commands,       // [{ to, op: 'open'|'close', gen }]; to may be selfId (caller applies locally)
  tabMuted,       // Hub tab: false only in REMOTE, HUB_ONLY, SOLO (and SOUNDCHECK)
  freezeNoise,    // true in REMOTE_PENDING/REMOTE/SETTLING/SOUNDCHECK
  pause,          // null | { reason: 'relay'|'ownerLost'|'ackTimeout'|'unhealthy', id? }
  actions,        // UI actions available now, e.g. ['hubOnly','dropLost'] ; ['soundCheck'] when no remote enrolled
  remote: { enrolled: n, identified, learnedRoom: n },
  events,         // [{ type:'state', from, to, at } | { type:'switch', from, to, ms } | { type:'remote', ms } | { type:'enroll', id, kind:'remote'|'room', owner? } | { type:'timeout', id, op }]
  debug
}
```

Rules:
- **Generations.** `gen` is a monotonic counter per Coordinator. A command's ack only counts if its gen equals the latest gen sent to that id. The Coordinator re-sends an un-acked command every 250 ms until `ackTimeoutMs` runs out. After that, it emits a `timeout` event and handles it as in "Failures".
- **Start.** Owner = self; the Coordinator opens self, state ROOM.
  - If the roster has only self and no lost members → **SOLO**: self open, tab unmuted. It leaves SOLO when any other member becomes ready → SETTLING → ROOM with owner self.
- **Candidates.** Candidates = ready roster members plus self, where healthy && !userMuted && the level is fresh (`now - at ≤ levelFreshMs`).
  - score = levelDb − noiseDb. Usable = act && levelDb > minSpeechDb.
- **Selection in ROOM.** The best usable challenger must beat the owner's score by switchAdvantageDb for switchSustainMs, and the owner must have held the mic ≥ minOwnMs.
  - If the owner is not usable (silent, stale, unhealthy), the challenger needs only idleTakeoverMs.
  - The owner keeps the mic through pauses. The mic is never closed for silence.
- **Handoff (SWITCHING).**
  - Overlap: open(new) → applied → close(old) → applied → ROOM.
  - Gap: close(old) → applied → open(new) → applied.
  - A `switch` event reports ms from decision to the final ack.
  - Remote activity during SWITCHING preempts it: close every gate that is open or has an open pending.
- **Remote detection.** A source is *remote-active* when its id is enrolled remote, it is fresh (ageMs ≤ remoteFreshMs) and its levelDb > remoteOnDb.
  - Sustained for remoteOnMs in ROOM or SWITCHING → REMOTE_PENDING: close all gates.
  - When every close is acked → REMOTE (tabMuted false).
  - If acks don't arrive by ackTimeoutMs → PAUSED{ackTimeout}. Never unmute through an unconfirmed gate.
- **Ending a remote turn.** In REMOTE, remote silent (no enrolled remote active) for remoteHoldMs → SETTLING (tabMuted true), then after settleMs → reopen the previous owner if it's still a candidate, else the best candidate, else self → ROOM.
- **Enrollment.** `roomOf: Map<csrc, memberId>`, `remoteIds: Set`. Only evaluated in ROOM, with the owner's open acked ≥ learnSettleMs ago. For an active fresh source not in either set:
  - If owner === self: count enrollTicks → enroll as **remote**. (The Hub never receives its own audio, so any active source is someone else. Members' gates are closed, so it isn't them.)
  - Else, if the owner has a known CSRC in roomOf: → count enrollTicks → **remote**.
  - Else, if the owner is act and exactly one unknown source is active: count learnTicks → **room** (roomOf[csrc] = owner).
  - Otherwise ambiguous: reset its counters.
  - In SOUNDCHECK: all gates closed (acked), tab unmuted, up to 8 s. Any active fresh unknown source for enrollTicks → remote. Exit to SETTLING.
  - `resetIds` clears both maps.
  - Enrollment also runs in SOLO.
  - **Self-correction.** The rule: a room laptop's CSRC carries audio only while that laptop's gate is open.
    - A learned room CSRC active more than `verifyLatencyMs` (1 s) after its laptop's gate closed → reclassified as remote.
    - A remote turn can be triggered within `newOwnerWindowMs` (3 s) of a member taking the mic while that member is talking. If that turn ends within `verifyWindowMs` (2 s) and the member is still talking, the trigger CSRCs are reclassified as that member's, and it gets the mic back.
    - This fixes the "laptop was in the Meet before clicking Join" mis-enrollment after one short glitch.
- **Failures.**
  - `onLost(owner)`, or of a member with an open or pending gate → PAUSED{ownerLost}: close everything reachable, tab muted.
  - `onLost` of a closed member → drop it.
  - `onRelay(false)` → PAUSED{relay}; self gate closed.
  - The owner becoming unhealthy → handled as an unusable owner (switch away); if there's no other candidate, self.
  - Self unhealthy → PAUSED{unhealthy}.
- **Actions.**
  - `hubOnly` → close all members (wait for acks; if the relay is down, members' own watchdogs have closed them) → HUB_ONLY: self open, tab unmuted.
  - `resume` → SETTLING → ROOM.
  - `dropLost id` → forget it and resume.
  - `continueSolo` → SOLO even with lost members.
- **Heartbeat.** The caller sends `{state, owner, epoch}` to all members every hbIntervalMs.

### MemberAgent (runs on non-Hub joined laptops)

```js
const m = new MemberAgent({ params });
m.onEpoch(epoch)                 // new Hub epoch: desired gate -> closed
m.onCommand({ e, g, op })        // -> desired gate or null if stale. Accepts op 'close' from any epoch; 'open' only if e === current epoch && g > last g
m.onHeartbeat(now, { e, s, o })  // records hub contact; s drives freezeNoise (REMOTE/REMOTE_PENDING/SETTLING)
m.tick(now, { relayUp }) -> { gate: 0|1, freezeNoise, watchdog: bool }   // watchdog: no heartbeat for watchdogMs or relay down => gate 0
```

## 7. Contract D: relay (room-core.js + adapters)

Connect: `GET /room/<key>?cid=<cid>&tok=<token>&claim=0|1&v=2` (WebSocket).
- key = first 32 hex chars of SHA-256(`'ha2|' + teamToken + '|' + meetingCode`).
- cid = random 16 chars [A-Za-z0-9], stable per tab via SW session storage.
- The token must equal the `TEAM_TOKEN` env/secret (constant-time compare). If `TEAM_TOKEN` is unset on the server, any token is accepted, and the dev server logs a warning. A mismatch → close 4003 'auth'.

Relay state per room: `sid` (random; new when the room goes empty→occupied or the object restarts), `epoch` (+1 on every Hub grant), `hub` (cid|null), `hubLost` ({cid, until} grace 30 s), and `clients` Map cid → {n (join order), ready}.

server → client:
- `{t:'welcome', sid, you, hub, epoch, roster}` on connect.
- `{t:'roster', sid, hub, epoch, roster:[{cid, n, ready}], hubLost: cid|null}` to all, only when something changes.
- Relayed messages, listed below.

client → server:

| msg | from | effect |
|---|---|---|
| `{t:'ready', r:0\|1}` | any | set ready; roster broadcast |
| `{t:'lvl', q, l, z, a, h, m}` | member | forwarded to the Hub only as `{t:'lvl', from, q, l, z, a, h, m}` (l, z = dB rounded to 0.1; a/h/m = 0\|1) |
| `{t:'cmd', to, op, e, g}` | Hub only, e === epoch | forwarded to `to` as `{t:'cmd', op, e, g}` |
| `{t:'applied', e, g, gate}` | member | forwarded to the Hub as `{t:'applied', from, e, g, gate}` |
| `{t:'hb', e, s, o}` | Hub only | broadcast to members |
| `{t:'leave'}` | any | clean leave: remove; if Hub → promote the earliest-joined ready member (else earliest member, else null); epoch+1; close 1000 |
| `{t:'yield', to}` | Hub | promote `to` (must be a member); epoch+1 |
| `{t:'want'}` | member | forwarded to the Hub as `{t:'want', from}` |
| `{t:'take'}` | member | if hub === null (grace over or none): become Hub; epoch+1 |
| `{t:'ping', ts}` | any | `{t:'pong', ts}` to the sender |
| `{t:'cfg', params}` | any | broadcast to others as `{t:'cfg', params, from}` (≤20 numeric params) |

- **Hub grant on connect.** The client becomes Hub if hub === null and the grace period isn't active and (claim=1 or no other clients). If `hubLost.cid === cid` within the grace period, it reclaims. Any grant sets epoch+1.
- **Unexpected close of the Hub socket.** hub = null, hubLost = {cid, 30 s}, roster broadcast. After the grace period with no reclaim: hubLost = null, broadcast.
- **Unexpected close of a member.** Remove it and broadcast a roster with the member gone. The Hub infers `lost` because the member disappeared without `leave`; the relay also sends `{t:'lost', cid}` to the Hub.
- **Clean leave.** The relay sends `{t:'left', cid}` to the Hub before the roster broadcast.
- **Duplicate cid.** Close the older socket (4000 'replaced'), treated as neither leave nor lost.
- **Limits:** ≤ 8 clients (4001 'full'); message ≤ 512 bytes; ≤ 60 msgs/s/socket (drop excess); schema validation on every field.
- **Usage cap:** team session-minutes per UTC day counted while the room is occupied, stored in DO storage. Default cap is 240 minutes (`MAX_MINUTES_PER_DAY` env). Over the cap → refuse joins with 4004 'daily cap'. Existing sessions continue.
- `GET /health` → `ok`.
- Durable Object: ordinary `server.accept()` WebSockets. One object per room key (`idFromName(key)`).

## 8. Contract E: page ↔ bridge ↔ SW ↔ popup

Page ↔ bridge: window CustomEvents `ha:to-ext` / `ha:to-page`, with `detail` = a JSON string.

page → ext:
- `{type:'ws', op:'open', url}` / `{type:'ws', op:'send', data}` / `{type:'ws', op:'close'}`
- `{type:'mute', muted, reqId}` → SW applies `chrome.tabs.update` and replies `{type:'muted', muted, reqId}`.
- `{type:'status', ...}` at 4 Hz (see the popup).
- `{type:'joined', joined, meeting, wasHub}` → SW remembers it per tab in session storage (auto-rejoin after a reload).
- `{type:'logDump', reqId, log}`
- `{type:'cfgOut', params}` → the Test panel's "apply to room" goes out via the page's room socket, not the SW.

ext → page:
- `{type:'ws', ev:'open'|'message'|'close'|'error', data?, code?, via:'direct'|'sw'}`
- `{type:'config', backendUrl, token, params, workletUrl, autoJoin:{meeting, wasHub}|null, cid}` — sent on connect and on change.
- `{type:'ui', action, arg}` — actions: `join`, `leave`, `makeHub`, `takeOver`, `hubOnly`, `resume`, `dropLost`, `soundCheck`, `continueSolo`, `resetIds`.
- `{type:'getLog', reqId}`, `{type:'sync'}` (bridge reconnected: the page re-sends `joined`/`status`), `{type:'muted', ...}`.

WebSocket pipe: the bridge tries a direct `new WebSocket(url)` in the ISOLATED world. If it errors before `open` twice in a row, it switches to a proxy through the SW (the SW owns the socket and pipes frames over the port). It reports `via` so the Debug panel can show which is in use.

Popup ↔ SW: port `ha-popup`.
- popup → SW: `{type:'subscribe', tabId}`, `{type:'ui', tabId, action, arg}`, `{type:'setParams', params, room}`, `{type:'resetParams'}`, `{type:'getLog', tabId}`, `{type:'setBackend', url, token}`.
- SW → popup: `{type:'status', tabId, status}`, `{type:'log', tabId, log}`, `{type:'settings', backendUrl, tokenSet, params}`.

`status` (page → popup):
```js
{ inCall, meeting, joined, role:'hub'|'member'|null, state, floor:'room'|'remote'|null,
  laptops: [{ id, label /* 'You' | 'Laptop N' */, hub, owner, ready, lost }],
  ownerLabel, pause, actions, relayUp, via, sid, epoch,
  remote: { enrolled, identified, learnedRoom },
  engine: { levelDb, noiseDb, act, gate, meter, ctxState, healthy, userMuted },
  rtt, backendConfigured }
```

Badge:
- `HUB` green: joined Hub.
- `MIC` blue: member that owns the mic.
- `·` gray: joined member.
- `!` red: paused or needs action.
- empty: not joined.

## 9. Timing targets and logging

- **Switch:** challenger sustained 100 ms + RTT + ack ≈ 200–300 ms. **Remote floor:** 40 ms + close ack (≈ RTT) + tab unmute.
- **The event log** is a ring of 3000 entries in the page. It records state changes, switches with ms, remote-floor ms, enrollments, timeouts, commands/acks (gen), pauses, RTT samples and relay events.
- `logDump` = `{params, log, summary:{switchMs p50/p95, remoteMs p50/p95, rtt p50/p95, stateCounts, pauses}}`.

## 10. Free-tier budget (Cloudflare)

Only members send levels (10/s while active, 1/s idle, plus immediate act changes), and only to the Hub.
- **Two-hour meeting, 5 laptops:** ≲ 100k incoming messages → ≈ 5k request-equivalents at the 20:1 accounting.
- **Durable Object duration:** ≈ 922 GB-s.
- **Daily cap:** 240 minutes by default.

## 11. Non-goals (this version)

- No custom echo cancellation.
- No playback buffer or replacing Meet audio.
- No multi-remote enrollment UI (the remote set supports several remote sources, but the sound check targets one).
- No spatial breakout routing.
