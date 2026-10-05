# Hybrid Audio for Google Meet

Chrome extension for hybrid Meet calls where several people join from laptops in the same room.
Exactly one laptop plays the call audio, and the mic nearest whoever is talking carries their voice.
When the remote person talks, the in-room mics are silenced.
No echo, no doubled voice, no manual muting. Remote participants install nothing.

- Design and rationale: [`docs/DESIGN.md`](docs/DESIGN.md)
- Module contracts: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- In-room test plan: [`docs/TEST_CHECKLIST.md`](docs/TEST_CHECKLIST.md)

## How it works (30 seconds)

- **Join once per meeting.** Each in-room laptop clicks **Join room audio**. The first to join becomes the **Hub**.
- **Mic.** The Hub picks exactly one in-room mic to transmit: whichever hears the current speaker clearly best. The choice follows people as they move, and the mic stays open between speakers.
- **Speaker.** Only the Hub plays the call audio. Every other joined laptop keeps its Meet tab muted.
- **Remote person talking.** The Hub closes the room mic, waits for confirmation, then unmutes its tab. The remote person can interrupt.
- **Hub leaves.** If the Hub's owner leaves the Meet (breakouts), the next laptop becomes Hub automatically.
- **Breakout with only one laptop left:** it behaves like plain Meet.
- **What's touched.** Meet's audio itself is never replaced. The extension only gates in-room mic input and mutes in-room speakers.

**Deploying? Follow [`docs/DEPLOY.md`](docs/DEPLOY.md)** (relay, team build of the extension, install). The sections below are the reference.

## Install (each in-room laptop, ~1 minute)

1. Get the code: `git clone` this repo, or download the ZIP and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the extension (puzzle icon → pin).
5. Set the backend URL and team token once (see below):
   - **Either:** edit `extension/config.js` before loading;
   - **or:** open the popup → **Debug** → paste both → **Save**.
6. In a Meet call, open the popup → **Join room audio**. After a tab reload, it rejoins automatically.

To update, pull the latest code, then click ↻ on the extension card in `chrome://extensions` and reload the Meet tab.

## Backend setup (once per team, ~5 minutes, free)

The backend is a tiny relay that passes mic *levels* (never audio) between laptops in the same meeting and elects the Hub.

### Option A: Cloudflare (recommended)
```bash
cd backend
npm install
npx wrangler login      # opens browser; free Cloudflare account
npx wrangler secret put TEAM_TOKEN   # paste a long random string, e.g. from: openssl rand -hex 16
npx wrangler deploy     # prints https://hybrid-audio-relay.<you>.workers.dev
```
Put `wss://hybrid-audio-relay.<you>.workers.dev` and the same token in `extension/config.js` (or the popup's Debug panel). **Don't commit the real token.**
- Check it's up: `https://hybrid-audio-relay.<you>.workers.dev/health` → `ok`.
- Free-tier headroom: the extension sends levels only while someone is speaking (20/s), otherwise 1/s per laptop. That comfortably fits a team's daily meetings.

### Option B: any machine with Node
```bash
cd backend && npm install && TEAM_TOKEN=<token> PORT=8787 node dev-server.js
```
Use `ws://<host>:8787`, or a `wss://` URL behind TLS. Laptops must be able to reach it.

## Popup

| Control | When it appears | Meaning |
|---|---|---|
| **Join room audio** | In a call, not joined | This laptop is physically in the room. It mutes its speaker and hands its mic to the Hub. |
| **Leave** | Joined | Back to plain Meet on this laptop. |
| **Make this the Hub** | Member | Move the speaker role here, for example to a louder laptop. |
| **Take over as Hub** | Hub lost unexpectedly | Restart coordination from this laptop. |
| **Use Hub only** | Hub, paused | All other laptops silent; the Hub runs plain Meet audio. |
| **Continue without Laptop N** | Hub, a laptop was lost | Drop that laptop and resume. |
| **Sound check** | Hub, remote not detected yet | Closes the room mics; ask the remote person to say hello. |

**Badge:**

| Badge | Meaning |
|---|---|
| `HUB` (green) | This laptop plays the audio |
| `MIC` (blue) | This laptop's mic is transmitting |
| `·` (gray) | Joined member |
| `!` (red) | Paused; open the popup |

The **Debug** section has live readouts, tuning sliders (**Apply to room** pushes them to every laptop), **Copy log**, and the backend URL and token. It exists for the in-room test and will be trimmed afterwards.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Remember each tab's mode, the backend URL and tuning values. |
| Host access to `https://meet.google.com/*` | Run inside Meet (mic wrapper, Meet connection hook) and find the Meet tab. No other site is touched. |

Tab muting (`chrome.tabs.update`), the badge and the WebSocket to the backend need no extra permissions.

## Privacy

- No audio leaves your machine except through Meet itself. Mic processing happens locally in the Meet tab.
- The backend receives:
  - a SHA-256 hash of the team token plus the meeting code;
  - random per-tab IDs;
  - mic level and noise numbers (≤ 10×/s while someone talks);
  - gate commands and acknowledgements;
  - heartbeats and tuning values.
- It stores only a daily usage counter (minutes).

## Development

```bash
npm test                 # unit tests (no deps)
npm run test:e2e         # 3 simulated laptops in headless Chromium (normal + strict CSP + extra paths)
node backend/dev-server.js                                 # local relay on ws://localhost:8787
```

| Path | What |
|---|---|
| `extension/page/meet-hooks.js` | **All** Meet/WebRTC-specific hooks. When Google changes Meet, fixes go here. |
| `extension/page/audio-engine.js` + `meter-worklet.js` | Audio graph: level measurement and the mic gate. |
| `extension/page/coordinator.js` | Pure Hub decision logic (unit-tested). |
| `extension/page/room-client.js`, `main.js` | Relay protocol and glue. |
| `extension/background.js` | Settings, tab mute, badge, socket-proxy fallback. |
| `extension/content/bridge.js` | Page ↔ extension relay and WebSocket pipe. |
| `extension/popup/` | UI. |
| `backend/src/room-core.js` | Relay and Hub election (shared by the Worker and the Node server). |

## Known limitations

- **Half-duplex while the remote person talks.** The room can't break in until they stop.
  - They win interrupts after ~40 ms plus one network round trip.
  - The room misses about that much of their first word.
- **One mic at a time.** Two people talking at once in the room: one of them is favoured.
- **Remote interruption depends on Meet exposing per-participant IDs (CSRCs)** while a room mic is open. This is verified in the first in-room test (checklist M1).
- **One click per laptop per meeting** (Join), which confirms the laptop is physically in the room.
- **Closing the Hub's tab** (instead of leaving the Meet) gives a 30 s grace period before the next laptop becomes Hub automatically.
- **Chrome only**, unpacked. Meet changes can break `meet-hooks.js`; the safe failure is paused, gates closed.
- **Daily usage cap:** 240 team minutes by default (`MAX_MINUTES_PER_DAY`).
