# History: bugs, misunderstandings, corrections, outstanding

Updated 24 Nov 2026. Newest first. Each entry: what was wrong → what was done → what proves it.

## 24 Nov 2026 — refinement: latency, levels, the performer's picture, AUTOZOOM
- The owner (23 Nov, 23:57): "the latest fixes are better"; then: the monitoring delay ("a fraction of a second") to
  go; default TRACK +25 %; PERFORMER vocals untouched ("already perfect"); PUBLISH vocal +15 %; the performer image
  +20 % and framed down to the chest; an explicit AUTOZOOM switch, off by default, the primary performer stable and
  centred, joiners to the left and right; all of it the same in LIVE MEETS.
- Done: `sv-shaper` (the chain 10 → 3 ms), the capture's `latency` ideal, the delay note in the Sound sheet; track
  −14 with its own ceiling, vocal target −7.8 / ceilings −1 and −1.5 / guard −5, the ears held exactly where they
  were (`PERFORMER_MONITOR` independent, `EARS_TRACK_TRIM_DB`); slots a fifth bigger, the crown near the top, the
  row from the middle out; AUTOZOOM switch (`PictureChoices`, every stage), every save to off once (`autozoomV1`).
- **Not fully deliverable, said so:** the PUBLISH vocal rose 0.3–0.6 dB, not 1.2 — a voice under a −1 dBFS ceiling
  cannot be louder than ≈ −9.5 K-weighted (the lab's §6 limiter column shows where the rest goes). A density
  compressor was tried and removed (it lost loudness). The device's own delay (20–60 ms wired, 100–200 more on
  Bluetooth) remains; the app's part is now 3 ms.
- Proof: audio lab 132 ok (§1 latency 2.96 ms; §6 the music −14.3, the voice 3.9–6.0 LU over it, limiter ≤ 2.1 LU,
  peaks ≤ −1.44; §7 ears −15.1); the studio e2e (AUTOZOOM off: the head ×1.00 sung or not and one size in the file
  until the switch; on: ×1.51 live and in the file; the crown at row 135 of 720, the chin about 491; the stage: ears
  −15.0 / the bus's voice −9.0 dBFS RMS, duck −3; the take −10.7 LUFS, sung −9.1, breaks −13.5, true peak −0.9); join
  e2e 58 ok (the row carol · alice · bob); live e2e 184 ok (the same switch and seat on the live stage; the film
  −7.9 LUFS, true peak −1.1).
- The live e2e under the sandbox's stalls: the playlist is read again when a read lands mid-rewrite; a held segment
  (the picture stalled through it) is passed over for an earlier whole one; the show view is given 20 s to follow a
  song change. The Studio e2e's song is 34 s so two push-outs land in the file after the Auto zoom switch.

## 23 Nov 2026 — the two listening modes (PERFORMER / PUBLISH)
- **Misunderstanding corrected:** "stronger vocals" was always meant for PUBLISH MODE (the saved recordings),
  never for PERFORMER MODE (what the singer hears). The 23 Nov morning build (7dfcb2a) had put the mix's vocal
  level on the monitor too — the owner heard themselves "boosted" on stage while the recordings stayed weak.
- Done: PERFORMER = half the published voice (−15 K-weighted; "Your voice in your ears" control, ±24 dB);
  PUBLISH vocal −9 K-weighted (limiter −1.5 dBFS, duck 3 dB); every stored Track/Vocal balance reset to 0/0 once
  (`mixV4`) since balances set for the old mix pushed the sum into the guard (PPD23Nov.mp4: −8.8 LUFS, flat,
  the track dominating).
- Proof: audio lab §6–7 (every preset: the voice 5.2–7.0 LU over the music; the ears 6.0 dB under the publish
  voice); Studio e2e on the stage (ears −15.0 dB, the bus's voice −9.8 dBFS RMS, duck −3 dB) and the saved take
  (−11.6 LUFS, sung −9.6, 5.7 LU over the breaks, true peak −1.6); live e2e (the meet's film at a record's loudness).

## 23 Nov 2026 — the mix rebuilt (commit 7dfcb2a)
- Wrong: the guard measured plain RMS at −15 dBFS; a bass-heavy backing filled it alone; the vocal could never
  rise over the music (PPD22Nov.mp4: pinned at −15.5 dBFS RMS, LRA 2.2 LU). The vocal target −17 dBFS RMS and the
  track −19 LUFS were quiet and in mismatched units; no pocket, no duck; presets not mid-forward.
- Done: K-weighted riders and guard; track −16; pocket EQ; `sv-ducker`; per-vocal limiter; presets mid-forward and
  level-matched; controls 0/0 (`mixV3`); the preview mutes the monitor while it runs.

## 22 Nov 2026 — the seven-issue brief (commit 0485780)
- Voice zoom never showed: default framing was 'still' and the Zoom field was disabled during the song → default
  'voice', the button "Camera & zoom" enabled during the song; the detection clocks run on the frame clock.
- Pages ran wider than phones (unbounded `1fr`/`auto` grid tracks at large text sizes) → bounded tracks, wrapping
  topbar/tabs, a 320 px-safe stage; `fit-e2e` (480 combinations, 0 overflow).
- The review played the raw vocal at full level (louder than the saved file) → `TakePlayback` through the bus.
  (The +1.6/+4.6 dB control defaults of this commit were a superficial fix, reverted on 23 Nov.)
- NONE background added; permissions asked once (iOS one capture per visit); the saved take's 'solo' stage (the
  singer 1.5× the show's); the Performances player uses the window; Preview / Save my sound.

## 21–22 Nov 2026 — the YouTube stream (commit 8edacfa)
- The stream stuttered: the encoders on the main thread; the audience mix player restarted on gaps → Worker-based
  broadcast and mix encoders, Worker-based audience player with fades, canvasTrack writer-first stop. The server
  was never the cause.

## Earlier (Nov 2026)
- Honest dynamics (13 Nov): the browser's compressor added hidden makeup and lookahead; replaced by `sv-dynamics`.
- The rider once lifted a dead-quiet mic's hiss by 18 dB and the guard then held the mix under it → the floor rule
  (`floorMargin`, `floorKeep`) and the rider lab.
- Recordings landed late on Bluetooth/phones → the measured round trip (`audio/sync.ts`, the sync check).

## Outstanding / known limitations
- Real iOS Safari not available in the sandbox: the one-capture flow is verified in Chromium with an iPhone UA.
- The vocal cannot be pushed past ≈ −9.5 K-weighted under the −1 dBFS ceiling (the energy goes into limiting);
  further "strength" must come from balance (track level, duck) and tone. The owner's "+15 %" of 24 Nov is only
  partly delivered for this reason — if more is wanted, the levers are a deeper duck or a lower track, not the target.
- YouTube normalises playback to −14 LUFS; only the balance survives there.
- Chromium's intermittent "VideoFrame was garbage collected" note on a stage (cosmetic; listed, not counted — in
  `screenshots.mjs` too since 23 Nov).
- The sandbox (two cores, four browsers) stalls the live e2e for seconds at a time: a sender's encoder then scales its
  picture ('cpu' or 'bandwidth' limitation) and the show view's full-size and top-of-frame picture checks stand down and
  say so; the pause notices are waited for (the pause is cued, the word comes with the next poll). The roles e2e's
  block step once lost erin's chip on a stalled run (passes alone; a diagnostic prints the audience list on failure).
- The owner has not pushed since 10 Nov (as of 23 Nov): GitHub Pages still serves the 10 Nov build; the owner
  tests from the working tree on the PC. Every ship ends with the push instruction.
- Wanted, not done: `www.singersvoice.com` for the whole site; the Super Admin pricing portal and payments
  (Stripe + UPI/PhonePe) are specified in the owner's master prompt.
