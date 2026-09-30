# In-room test checklist

**Setup:** 3 laptops in the room (A, B, C), all running the extension on Auto. 1 remote person (R), ideally in a different building, wearing headphones or using a phone.
**Before starting:** every laptop is on the same Meet link, and the backend URL is set. Open each popup's **Test** panel and keep it open on one laptop during the tests.
**After each section:** on every laptop, click **Test → Copy log** and paste it into a file named `log-<laptop>-<section>.json`. Send the files to me.

Mark each ✅ / ❌ with a one-line note.

## 0. Smoke (single laptop, 2 min)
- [ ] A joins alone. Popup shows **Solo** and the badge is empty or green. R hears A normally, and A hears R.
- [ ] The Test panel shows `identified: yes` while R talks. **Critical:** if it shows `no`, note it; interrupts (section 5) won't work.
- [ ] Switching the mic in Meet settings still works, and R still hears A.
- [ ] Meet's own mute button still mutes A.

## 1. Echo (all 3 join)
- [ ] Exactly one laptop shows **HUB**. The others show `·` or `MIC`.
- [ ] Only the Hub plays R's audio in the room.
- [ ] R talks for 30 s. **R hears no echo of themselves.**
- [ ] No howling or feedback at any point.

## 2. Doubled / hollow voice
- [ ] A talks while sitting at A. R rates the sound: clean, slightly roomy, or hollow/doubled.
- [ ] Repeat for B and C.
- [ ] A, B and C count to 5 in turn with no gaps. R reports whether the first word of each person is cut off.

## 3. Switching between in-room speakers
- [ ] Standup circle: go around the circle, 10 s each. R reports clean handoffs, with no pumping or noise jumps.
- [ ] A walks from their laptop to B's laptop while talking. R reports that the voice stays audible the whole time (a change in tone is expected).
- [ ] A stands halfway between A and B and talks for 20 s. R reports no flickering or warbling.
- [ ] A stands 3 m from every laptop. R reports whether A is still audible, and at what distance A drops out.
- [ ] Two people talk at once. R hears both.
- [ ] The Hub laptop's speaker doesn't replay in-room voices (listen for a delayed "ghost" of the in-room talker).

## 4. Remote speaking
- [ ] R talks while the room is silent. All in-room laptops show **Remote talking** within about 0.3 s.
- [ ] R talks while someone in the room coughs or types. R hears no echo.
- [ ] R stops talking. The room can reply straight away, and R hears the reply without its start cut off.

## 5. Interruptions
- [ ] A talks continuously and R interrupts. Within about 0.3–0.5 s, the room hears R and A's mic is cut. Note how long it took.
- [ ] R talks and A tries to interrupt. Expected: A isn't heard until R pauses (known limitation). Confirm the behaviour is exactly that.
- [ ] Fast back-and-forth between A and R for 1 minute. R reports whether the conversation felt natural, annoying, or unusable.

## 6. Group changes
- [ ] B and C leave the Meet. A shows **Solo** within 2 s, and A's mic and speaker both work.
- [ ] B rejoins. Roles re-form within 2 s.
- [ ] The Hub laptop leaves the Meet. Another laptop becomes Hub within 2 s and starts playing R.
- [ ] Close the Hub laptop's lid for 30 s, then reopen it. No echo storm, and roles settle.

## 7. Backend loss
- [ ] Turn off Wi-Fi on B only. B shows **Connection lost · fallback**; B's mic is silent and its tab muted. A and C keep working.
- [ ] Block the backend for everyone (for example, set a wrong Backend URL on all three). The last Hub keeps its mic and speaker on, the others go silent, and all show a warning.
- [ ] Restore the backend. All laptops recover without a reload.

## 8. Manual override
- [ ] Set C to **Hub** manually. C becomes the only speaker.
- [ ] Set B to **Member**. B is silent and muted.
- [ ] Set A to **Off**. A behaves like plain Meet (expect echo; this confirms Off really is off).

## 9. Tuning (only if sections 2–5 had problems)
Try these in the Test panel with **Apply to room** checked, and note which values fixed it:
- Doubled voice → raise `shareExponent` to 3–4.
- Cut-off first words → raise `idleDuck` toward 0 dB.
- Speech not detected → lower `vadOnset`.
- R cut off or detected late → lower `remoteOn` dB.
- Flicker between R and the room → raise `remoteHold` / `roomHold`.

## Results to send back
- This checklist, marked up.
- All the `log-*.json` files.
- The Test panel values if you changed any.
