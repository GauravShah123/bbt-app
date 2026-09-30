# Hybrid Audio for Google Meet: Design Review

**Status:** v2 in build · Detailed module contracts: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## v2 revision (after senior review): what changed and why

v1 (sections 3–7 below) used distributed gain sharing: every laptop set its own mic gain, and each laptop decided the floor on its own. After review, we moved to **Hub-coordinated single-mic selection**.

| v1 | v2 | Why |
|---|---|---|
| Every laptop decides for itself | **The Hub is the only decision-maker**; handoffs wait for confirmation (open/close → applied) | No split-brain; two mics are never open because two laptops disagreed |
| Gain sharing (all mics partly open) | **One mic open**, kept open between speakers until a challenger is 6 dB better for 100 ms | No doubled/comb-filtered voice at all; the mic already open still carries a new speaker's first words |
| Remote detection by "active while the room is silent" | **Remote enrollment by elimination:** while the Hub owns the mic, any active incoming CSRC is remote (the Hub never receives its own audio, and member gates are closed). Room CSRCs are learned while a member owns the mic. Sound check as a fallback | Deterministic rather than a silence heuristic |
| Leak guard | Removed: room break-in is not allowed during a remote turn | Simpler; avoids the hard problem |
| Auto-join by Meet code | **One click, "Join room audio,"** per laptop per meeting; auto-rejoin on reload | Confirms physical presence (a teammate dialing in from home) |
| Fallback to plain Meet on errors | **Pause safely** (gates closed) with explicit recovery actions | Never risk an echo loop |
| Automatic Hub election | The first joiner is Hub; **automatic handover on intentional leave** (including leaving the Meet); unexpected Hub loss pauses with "Take over as Hub" | The team reshuffles breakouts every 15–20 minutes; the Hub's owner leaving must not need manual recovery |
| Relay socket in the service worker | Socket in the page's content script (direct), with the SW as proxy fallback | Avoid SW lifecycle issues; fallback in case Meet's CSP blocks it |
| — | **Meet audio is never replaced.** Only in-room mic input (gate) and in-room speaker output (tab mute) are touched. No playback buffer | Lowest coupling to Meet internals; the cost is ~40 ms + one round trip of the remote person's first word lost on interruptions |

Everything below is the original v1 analysis, kept for the record. Section 4's comparison of alternatives still applies.

## 1. Problem

Our team runs hybrid Google Meet sessions: 3–6 people in one large room, each on their own laptop, and usually one remote participant.

With every laptop's mic and speaker on:

- **Echo and feedback in the room.** Remote audio plays from every laptop.
- **Hollow, doubled voice for the remote person.** Every in-room mic picks up the same talker at slightly different delays. Meet forwards them as separate streams, so the remote client mixes N delayed copies (comb filtering), plus N copies of room noise.
- **Remote hears themselves.** In-room mics pick up remote audio from another laptop's speaker and send it back 200–400 ms late.

Manually coordinating (one laptop plays audio; everyone mutes and unmutes) fails in practice, because people get up, move around, and change groups.

**How we work:**
- The day starts with a standup, sitting in a close circle.
- Then small breakout groups spread around the room and reshuffle every 15–20 minutes.
- When the remote person joins a breakout, everyone else in the room leaves the Meet, so only one laptop remains.

**Requirements:**
- Anyone in the room can talk at any time with no manual action.
- Only one laptop plays audio.
- The remote person installs nothing.
- Setup is effectively zero: open Meet and that's it.

## 2. Constraints

- Chrome extension (MV3), plain JS, no heavy frameworks, minimal permissions.
- **No audio leaves a machine except through Meet.** Any backend sees only levels and state.
- Meet internals can change at any time, so all Meet-specific hooks live in one module and fail open to normal Meet behaviour.
- Free infrastructure. Team-only distribution (unpacked).

## 3. Approach

**Distributed gain-sharing automixer with speakerphone-style gating when the remote person talks.**

1. **Mic control without touching Meet's UI.** A MAIN-world script at `document_start` wraps `getUserMedia`.
   - The mic goes through WebAudio (`source → GainNode → MediaStreamDestination`), and Meet receives the processed track.
   - That track is disguised as the original: label, `getSettings`, `applyConstraints`, `stop`, `clone`, `ended`.
2. **Gain sharing (Dugan-style)**, recomputed every audio tick (~21 ms):
   `gain_self = amp_self^β / Σ amp_i^β`, with β = 2 (power-proportional).
   - Each laptop knows its own level instantly and receives peers' levels through a relay (~30 ms stale).
   - Each laptop computes only its own gain, so no central coordinator is needed.
   - The nearest mic dominates automatically, wherever the talker stands.
3. **Floor state machine**, evaluated locally on every laptop:
   - `idle`: mics shared at −12 dB, Hub speaker on.
   - `room`: someone in the room talking. Mics shared, Hub speaker **muted**, so the Hub doesn't replay in-room voices that Meet sends back ~200 ms late.
   - `remote`: all in-room mics at gain 0, Hub speaker on.
   - The remote person can interrupt: after 300 ms of sustained remote speech they win.
   - Hysteresis and hold times (300–500 ms); gain ramps of 5 ms attack and 30 ms release.
4. **Remote-speech detection from RTP metadata, not audio analysis.**
   - Meet delivers the 3 loudest speakers on 3 "virtual" SSRCs. It tags packets with a per-participant CSRC and a sender-computed audio level (RFC 6464).
   - `RTCRtpReceiver.getContributingSources()` exposes both.
   - A CSRC is classified *remote* once it has been active while no in-room laptop was speaking. In-room participants, heard back through Meet, never accrue that evidence.
   - This detects the remote person even while the room is talking, which is what makes interrupts possible.
5. **Leak guard.** While remote audio is active, a laptop's own voice detector needs its level to beat a learned estimate of how much Hub speaker it picks up, plus 10 dB. That stops Hub speaker pickup from counting as room speech.
6. **Zero setup.**
   - Room = SHA-256 of the Meet code; every laptop running the extension in that meeting is "in the room".
   - The Hub is elected by the relay: earliest joiner, and it keeps the role across reconnects.
   - One laptop left (breakout with the remote person) → `solo`: plain Meet behaviour.
   - Manual override: Auto / Hub / Member / Off.
7. **Relay: Cloudflare Worker + Durable Object** (WebSocket Hibernation API). A dumb relay plus Hub election.
   - Laptops send levels every 50 ms only while speaking, otherwise every 1 s, which fits the free tier.
   - **If the relay is lost:** fall back to the last known Hub on and everyone else silent, with a warning.

## 4. Why this approach

### Alternatives considered

| # | Approach | Verdict |
|---|---|---|
| 0 | Hardware speakerphone + Meet Companion mode | Solves the standup and adds a device, but doesn't follow people who move. Recommended as a fallback, not a replacement. |
| 1 | **Hard-gated switching** (only the loudest mic open; threshold/hold/hysteresis) | Rejected as the primary law. It clips 50–150 ms of each onset because the gate opens only after detection plus a network hop. It flickers when the talker is equidistant between laptops, and each room needs tuning. |
| 2 | **Gain-sharing automixer** ★ | **Chosen.** Industry standard for multi-mic rooms since Dugan's 1975 patent (US3992584). Total gain stays constant, so no noise pumping. Soft handoff means no flicker and no switching rule to tune. See the math below. |
| 3 | Cross-device acoustic echo cancellation (full duplex) | Deferred. Each laptop has the remote audio (Meet sends it), but independent jitter buffers make the reference misalign in jumps of 10–60 ms, and we'd need WebRTC AEC3 compiled to WASM. About 4–6 weeks and high risk. The upgrade path if half-duplex on remote speech feels bad. |
| 4 | Hub-central mixing (members stream mic audio to the Hub over the LAN; one uplink) | Best audio in theory, but it **violates the "audio only via Meet" constraint**. It also needs peer-to-peer on the LAN; client-isolated Wi-Fi forces a TURN relay, so audio leaves the room anyway. |
| 5 | Voice identity (personal VAD / speaker embeddings) | Rejected. Needs enrollment (setup friction) and an ML model in the browser. It identifies *who*, not *which mic is best*, and degrades when people walk away from their laptop. |
| — | Synchronized-array beamforming / TDOA localization | Infeasible. Needs sample-level clock sync (µs) across laptops; browsers over a network can't provide it. |

### Why gain sharing wins (numbers)

- **Near versus neighbor level.** A talker 0.5 m from their laptop and ~1.2 m from neighbors gives about 8 dB of direct-path difference. In a large classroom (critical distance ~1.5 m) the difference saturates around 10 dB.
- **Resulting gains.** With 3 laptops and β = 2: talker's mic ≈ 0.75, neighbors ≈ 0.13 each. The neighbor copies arrive about 16 dB down, so comb-filter ripple is about ±1.3 dB, which is barely audible.
- **Onset behaviour.** Each laptop's own level is fresh, so the talker's own gain jumps immediately. The worst case is about 30 ms of mild doubling (neighbors haven't yet seen the talker's level), instead of a clipped first syllable. Clipped onsets hurt intelligibility far more than brief doubling.
- **Cost.** A few multiply-adds per tick, with no model and no central state.

### Why gate on remote speech (and not just duck)

- Gain sharing keeps total in-room gain at 1, so Hub-speaker pickup would go back to the remote person.
- ITU-T G.131 calls for roughly 45–50 dB of talker-echo loss at Meet-scale delays, which ducking can't reach.
- Full gating, standard speakerphone half-duplex, is the only echo-safe choice without real AEC (#3).

### Why CSRC-based detection over WebAudio or tabCapture

| | CSRC levels (chosen) | WebAudio on remote tracks | `chrome.tabCapture` |
|---|---|---|---|
| Identifies *who* is talking | Yes, per participant | No, only 3 virtual streams | No, post-mix |
| Works while the Hub tab is muted | Yes (metadata) | Yes | Uncertain |
| Chrome quirks | None known | Remote streams must be attached to a media element before WebAudio reads them | Needs a user gesture plus an offscreen document; extra permission |
| Cost | A synchronous getter | An audio graph per track | Full-tab capture |

The fallback when CSRCs are absent is "unidentified" mode: any remote audio counts only while the room is silent, and interrupts are disabled.

### Why Cloudflare Durable Objects for the relay

- **Supabase Realtime:** no server logic, and its message quota at 20 msg/s × N peers is tight.
- **Self-hosted WebSocket server:** needs a paid always-on host, or accepts cold starts on free tiers.
- **Durable Objects:** one global object per room, placed near the first connection (~10–30 ms each way). Free tier with SQLite-backed objects. One-command deploy.
- **Portability:** the relay logic is a pure module (`room-core.js`), so a Node `ws` server (`dev-server.js`) can run it anywhere as a fallback.

## 5. Key risks and how we verify them

| Risk | Impact if wrong | Verification |
|---|---|---|
| Meet rejects or mishandles the processed track (device picker, constraints, `ended`) | Mic broken for everyone | e2e test with a fake Meet page; first real call with a phone as the remote participant. Fails open to the original stream. |
| AudioContext suspended by autoplay policy | Silent mic | Resume on first gesture; the popup warns "Click the Meet tab to enable audio". |
| **Meet's web client doesn't populate CSRCs** (documented for the Meet Media API, not the web client) | No interrupts; slower remote detection | The popup's Test panel shows `identified` live on the first call. Falls back to unidentified mode. |
| Hub-speaker leakage triggers false room speech | Remote person cut off or echoed | Leak guard plus the Test-panel readouts. Tune `leakMarginDb` in the room. |
| Background-tab timer throttling (non-Hub tabs are muted, so not "audible") | Ticks drop to 1 Hz | Ticks come from a ScriptProcessor audio callback, not timers. |
| Relay latency too high for the Hub mute | Hub replays the first 100–200 ms of an in-room talker | RTT and hub-mute latency are logged (Test panel → Copy log). |
| Meet changes internals | Hooks break | All hooks live in `meet-hooks.js`; any error falls back to normal Meet. |

## 6. Known limitations

- **Half-duplex on remote speech.** While the remote person talks, the room can't be heard. The remote person wins interrupts after ~300 ms, and the room misses that first ~300 ms.
- **Two people talking at once in the room** share the gain. Fine for crosstalk, but each sounds roomier.
- **A talker far from every laptop** (>2–3 m) may fall under the speech threshold in a noisy room.
- **Voice colour changes** as a person moves between laptop mics. That's physics.
- **Chrome only.** A teammate dialing in from home with the extension installed must set it to Off.
- **The relay can see** the hashed meeting code, random client ids and mic levels. No audio.

## 7. Open questions for the reviewer

1. Is β = 2 (power-proportional) the right default, or would a Dugan-classic amplitude share (β = 1) be safer against doubling? It's tunable live in the Test panel.
2. Is the CSRC-evidence classifier (active-while-room-silent) robust enough, or should we also correlate CSRC level envelopes with each laptop's reported level?
3. Is `ScriptProcessorNode` (deprecated but unthrottled) acceptable, versus an `AudioWorklet` loaded from a Blob, which Meet's CSP may block?
4. How do we measure end-to-end switch latency without clock sync? Currently we estimate it as RTT/2 plus RTT/2 plus local processing.
