# In-room test checklist (v2)

**Setup:** 3 laptops in the room (A, B, C), 1 remote person (R) on headphones or a phone, somewhere else. The backend URL and team token are set on every laptop (popup → Debug).
**Logs:** after each section, on every laptop: Debug → **Copy log** → save it as `log-<laptop>-<section>.json`. Send them all to me.
**Marking:** ✅ / ❌ plus a one-line note per item.

## M1. Integration probes (do these first, ~10 min). They decide whether the rest can work.
- [ ] A joins the Meet and clicks **Join room audio**. It shows **Hub** and **1 laptop**, and behaves like normal Meet (solo). R hears A, and A hears R.
- [ ] Debug on A: `meter` = `worklet` or `script` (note which). `via` = `direct` or `sw` (note which).
- [ ] B joins the Meet and clicks **Join**. A shows 2 laptops. B's tab is muted and its badge is `·`.
- [ ] R talks while A owns the mic. On A, Debug → `enrolled` becomes 1 within a few seconds. **Critical.** If it stays 0, try **Sound check** and note the result.
- [ ] B talks close to B's laptop. A's popup shows **Mic: Laptop 2**; B's badge shows `MIC`; R hears B.
- [ ] While B talks, R talks over B. The room hears R within about half a second, and B's mic is cut. **Critical:** this tells us whether Meet reports who is talking while a room mic is open.
- [ ] Switch the mic in Meet's settings on B while B is not the owner: R hears nothing from B. Then B talks: B gets selected again.
- [ ] B presses Meet's mute button. B is never selected. Unmute: B is eligible again.

## 1. Echo
- [ ] With all 3 joined, exactly one laptop plays R (the Hub).
- [ ] R talks for 30 s: R hears no echo of themselves.
- [ ] No howling or feedback at any time.

## 2. Doubled or hollow voice
- [ ] A, B and C each talk in turn. R rates each: clean, slightly roomy, or doubled/hollow.
- [ ] Count to 5 across people (one number each, fast). R reports whether any first word was cut off.
- [ ] Handoff mode: repeat the count with Debug → `handoffOverlap` off (Apply to room). R reports which sounded better: overlap or gap.

## 3. Switching between in-room speakers
- [ ] Standup circle, 10 s each around the room. Handoffs follow the speaker. Note the `switch` ms from the log.
- [ ] A walks from A's laptop to C's laptop while talking. The mic follows within about 0.5 s of arriving.
- [ ] A stands midway between two laptops for 20 s. No flicker (the log shows at most 1–2 switches).
- [ ] A stands 3 m from every laptop. Is A still picked up, and at what distance does it drop?
- [ ] Two people talk at once. One is favoured; R can still follow.
- [ ] The Hub never replays in-room voices (listen for a delayed "ghost").

## 4. Remote speaking
- [ ] R talks into a silent room. The Hub plays R; the popup shows **Remote**.
- [ ] R says short words: "yes", "no", "wait". Are they intelligible in the room? (We expect a slightly clipped start.)
- [ ] R stops talking. The room replies, and R hears the reply's start clearly.

## 5. Interruptions
- [ ] A talks and R interrupts. Note the `remote` ms from the log; the room hears R.
- [ ] R talks and A tries to interrupt. Expected: A isn't transmitted until R stops (by design).
- [ ] Fast back-and-forth between A and R for 1 minute: natural, annoying, or unusable?

## 6. Breakouts and Hub handover
- [ ] The Hub laptop leaves the Meet. Within about 2 s another laptop becomes **Hub** and plays R, with no action needed.
- [ ] B clicks **Make this the Hub**. B becomes Hub and the old Hub becomes a member.
- [ ] Everyone except one laptop leaves the Meet. The remaining laptop is solo: plain Meet.
- [ ] A left laptop rejoins the Meet and clicks **Join**. It joins as a member.
- [ ] Reload the Meet tab on a member while in the call. It rejoins automatically, with no click.

## 7. Failures
- [ ] Turn Wi-Fi off on the laptop that owns the mic. The Hub shows **Laptop N lost** with **Continue without Laptop N**. Click it: the room continues.
- [ ] Close the Hub laptop's lid (unexpected loss). Members show **Take over as Hub**. Click it on one: the room continues.
- [ ] Block the backend for everyone (for example, a wrong URL, then Save). All laptops pause with gates closed. On the Hub, **Use Hub only** gives normal Meet audio on the Hub.
- [ ] Fix the URL: everyone recovers without reloading.

## 8. Tuning (only if sections 2–5 had problems)
Debug sliders with **Apply to room** checked. Note which values fixed each problem:
- Wrong mic picked or slow switching → `switchAdvantageDb`, `switchSustainMs`.
- Flicker → raise `minOwnMs`.
- R detected late or not at all → lower `remoteOnDb`.
- R's turn ends too early → raise `remoteHoldMs`.
- Room hears a ghost after R stops → raise `settleMs`.
- Quiet talkers missed → lower `vadOnsetDb` / `minSpeechDb`.

## Send back
- This checklist, marked up.
- All the `log-*.json` files.
- Any slider values you changed.
