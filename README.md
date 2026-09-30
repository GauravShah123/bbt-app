# Hybrid Audio for Google Meet

Chrome extension for hybrid Meet calls where several people join from laptops in the same room.
Exactly one laptop plays the call audio, and the mic nearest whoever is talking carries their voice.
When the remote person talks, the in-room mics are silenced.
No echo, no doubled voice, no manual muting. Remote participants install nothing.

- Design and rationale: [`docs/DESIGN.md`](docs/DESIGN.md)
- Module contracts: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- In-room test plan: [`docs/TEST_CHECKLIST.md`](docs/TEST_CHECKLIST.md)

## How it works (30 seconds)

- **Room detection.** Every laptop in the same Meet with the extension on joins the same room. The room is derived from the Meet code, so there's nothing to configure.
- **The Hub.** One laptop is elected Hub (first to join) and plays the call audio. The others mute their Meet tab.
- **Mic mixing.** Every laptop mic stays partly open. Each takes a share of the volume proportional to how loud it hears the talker, so the nearest laptop dominates. This follows you as you walk around.
- **Remote talking.** In-room mics go silent (no echo) and the Hub plays the remote person. The remote person can interrupt the room.
- **Someone in the room talking.** The Hub stops playing, so it doesn't replay the in-room voice that Meet sends back.
- **Only one laptop left in the Meet** (for example, a breakout with the remote person): it behaves like plain Meet.

## Install (each in-room laptop, ~1 minute)

1. Get the code: `git clone` this repo, or download the ZIP and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the extension (puzzle icon → pin).
5. Set the backend URL once (see below):
   - **Either:** edit `extension/config.js` before loading, so it's baked in for the whole team;
   - **or:** open the popup → **Test** → paste the URL → **Save**.
6. Join a Meet as usual. The mode defaults to **Auto**, so there's nothing else to do.

To update, pull the latest code, then click ↻ on the extension card in `chrome://extensions` and reload the Meet tab.

## Backend setup (once per team, ~5 minutes, free)

The backend is a tiny relay that passes mic *levels* (never audio) between laptops in the same meeting and elects the Hub.

### Option A: Cloudflare (recommended)
```bash
cd backend
npm install
npx wrangler login      # opens browser; free Cloudflare account
npx wrangler deploy     # prints https://hybrid-audio-relay.<you>.workers.dev
```
Put `wss://hybrid-audio-relay.<you>.workers.dev` in `extension/config.js` (or the popup's Test panel).
- Check it's up: `https://hybrid-audio-relay.<you>.workers.dev/health` → `ok`.
- Free-tier headroom: the extension sends levels only while someone is speaking (20/s), otherwise 1/s per laptop. That comfortably fits a team's daily meetings.

### Option B: any machine with Node
```bash
cd backend && npm install && PORT=8787 node dev-server.js
```
Use `ws://<host>:8787`, or a `wss://` URL behind TLS. Laptops must be able to reach it.

## Popup

| Control | Meaning |
|---|---|
| **Auto** | Default. Automatic Hub election and mic mixing. |
| **Hub** | Force this laptop to be the speaker, with its mic always on. |
| **Member** | Force this laptop silent: mic off, tab muted. |
| **Off** | Extension does nothing (plain Meet). Use this if you dial in from somewhere else. |

**Badge:**

| Badge | Meaning |
|---|---|
| `HUB` (green) | This laptop plays the audio |
| `MIC` (blue) | This laptop's mic is currently carrying a talker |
| `·` (gray) | Idle member |
| `!` (red) | Needs attention; open the popup |

The **Test** section is for tuning during the in-room test and will be removed afterwards. It has live readouts, tuning sliders (**Apply to room** pushes them to every laptop), **Copy log** and the backend URL field.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Remember each tab's mode, the backend URL and tuning values. |
| Host access to `https://meet.google.com/*` | Run inside Meet (mic wrapper, Meet connection hook) and find the Meet tab. No other site is touched. |

Tab muting (`chrome.tabs.update`), the badge and the WebSocket to the backend need no extra permissions.

## Privacy

- No audio leaves your machine except through Meet itself. Mic processing happens locally in the Meet tab.
- The backend receives:
  - a SHA-256 hash of the meeting code;
  - random per-tab IDs;
  - mic loudness (a single number, 20×/s at most);
  - speaking and remote flags;
  - network round-trip time;
  - tuning values.
- It stores only "first seen" times per random ID (6 h) so the Hub keeps its role across reconnects.

## Development

```bash
node --test test/policy.test.js test/room-core.test.mjs   # unit tests (no deps)
node test/e2e/run.mjs                                      # 3 simulated laptops in headless Chromium
node backend/dev-server.js                                 # local relay on ws://localhost:8787
```

| Path | What |
|---|---|
| `extension/page/meet-hooks.js` | **All** Meet/WebRTC-specific hooks. When Google changes Meet, fixes go here. |
| `extension/page/engine.js` | Audio graph, tick loop, messaging. |
| `extension/page/policy.js` | Pure decision logic (unit-tested). |
| `extension/background.js` | Relay socket, tab mute, badge. |
| `extension/content/bridge.js` | Page ↔ extension relay. |
| `extension/popup/` | UI. |
| `backend/src/room-core.js` | Relay and Hub election (shared by the Worker and the Node server). |

## Known limitations

- **Half-duplex on remote speech.** While the remote person talks, the room can't be heard. The remote person wins interrupts after ~0.3 s, and the room misses that first ~0.3 s.
- **Remote interruption depends on Meet sending per-participant IDs** (CSRC). If the Test panel shows `Identified: false`, the remote person can only take over once the room is quiet.
- **Tuning.** Two people in the room talking at once share the mic volume and sound roomier. A talker more than ~2–3 m from every laptop may not be picked up in a noisy room.
- **One speaker.** Audio comes from a single laptop's speaker, so use the loudest laptop as Hub (set it to **Hub**).
- **Chrome only.** Unpacked extension. Meet changes can break the hooks; the fallback is plain Meet behaviour.
- **Backend lost:** the last Hub keeps its mic and speaker on, the other laptops go silent, and a warning is shown. If the backend was never reachable, all laptops stay silent until someone picks Hub or Member.
- **Chrome "Energy saver" / sleeping tabs:** keep the Meet tab open. The audio loop runs on the audio clock, not timers, but a discarded tab stops entirely.
