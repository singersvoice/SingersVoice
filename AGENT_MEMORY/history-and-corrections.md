# History: bugs, misunderstandings, corrections, outstanding

Updated 24 Nov 2026 (evening). Newest first. Each entry: what was wrong → what was done → what proves it.

## 24 Nov 2026 (evening) — enhancements & fixes from PPD24_1.mp4
- The owner (20:51, with PPD24_1.mp4 and 19 background pictures): squeaks at 00:30 and 01:46; breaths too loud (01:33,
  the interlude); shareable sound settings files named initials_date_time with an Import dropdown; the track's speed
  never to drift; head-to-chest framing kept despite camera movement; frozen performer pictures found and recovered
  without touching the audio; Cancel everywhere, Save / Discard in place of Keep; seeking in the review; backgrounds in
  Drive › Backgrounds with upload / select / delete; the 19 pictures made selectable.
- What the recording showed (331 s, −10.9 LUFS, true peak +0.1): the squeaks were pure tones at 7.1 kHz (29.4–30.7 s)
  and 9.25→9.43 kHz (106.4–108.5 s) growing 20→41 dB over the voice — acoustic feedback (the singer wears a wired
  earphone with an inline microphone; a hand at the earbud in both frames); the performer's picture froze twice for
  15.3 and 15.5 s (180 s, 297 s) — the old measurement clock (15 s) plus a restart; the picture is "My camera as it is"
  with the crown at the camera's top edge (the camera sits low: no frame can add headroom the camera does not see);
  no dropouts in the audio, the track's speed in the file steady (video 331.0 s / audio 331.0 s).
- Done: the voice-evidence gate and the howl suppressor (audio-modes.md); 'follow' the AUTOZOOM-off framing
  (`autozoomV2`); the pixel stillness clock (3 s) with a 15-s restart cadence and a camera-only restart (iOS: the
  camera alone tried first); the karaoke video steered by rate; Cancel / Home on the stage, Save / Discard and a
  seekable review; sound settings files + the service's sound catalog + Import; the Backgrounds folder as the record
  with upload / select / delete / restore; the 19 pictures bundled (webp, thumbs) and copied to every account's folder.
- Proof: audio lab (§0: the room −26 dB, a breath in a break −17 dB and one right after a phrase −16 dB at the chain's
  output, the phrase / its first 30 ms / its last 100 ms / a leading "s" untouched; §0a: a 9.3 kHz squeal −36 dB by
  2.2 s, −74 dBFS at 1 s on its way up, the voice beside it untouched, a voice alone never notched); studio e2e (the
  track's speed in the file: drift 0.1 ms over 22 s; the frozen camera found in 5.1 s and restarted 5.5 s after the
  freeze with one video-only capture, the microphone / recorder / song untouched, the vocal whole; the review's
  forward / back / pause / seek; Save / Discard; Cancel); tracks e2e (the sound file in Drive › Config with the whole
  sound, shared and listed for bob, applied — every control follows; deleted and withdrawn; the 36 built-in pictures
  copied into Drive › Backgrounds, an upload scaled to WebP and chosen, Select → Delete to the Drive bin, Restore);
  protocol tests (initials, names, parsing and clamping); control tests (the sound catalog: validation, owner-only
  withdrawal, 16 KB cap).
- Correction on the way: the live e2e's stages had shown "Your camera froze" during the second song in every run
  (since before this change): the test's synthetic person — a noiseless 2-s clip, its four patches alike over its last
  seven frames — read as a frozen camera to the pixel clock whenever the starved model sampled it two seconds apart.
  Two frames alike seconds apart prove nothing: the clock now wants the same frame three times in a row
  (`SAME_FRAMES`), and the clip carries sensor noise of its own like a real camera's; the live e2e logs every change
  of the cameras' health with the clock that spoke (`frozenBy`) and fails on a live camera called frozen on its
  picture — and on the fixed build the health log reads "ok throughout" on both singers' devices, no freeze called at
  all (every earlier run had shown "Your camera froze" during the second song).
- Correction on the way (25 Nov, 00:30): the roles e2e failed twice at "the host blocks erin": her chip showed and
  was gone a moment later, back 30 s on. Not the service (reproduced clean against it alone): the host's page had
  applied the answer to its own members-only switch — built before erin came in, read after the room the stream
  pushed with her in it — over the newer room. `MeetSession.stateAt`: every state is stamped `serverEpochMs`, an
  older answer leaves the room alone and gives up only its own lines (the video hours, the chat). Unit-tested
  (`test/meetSession.test.ts`); roles e2e 100 again. The same race the other way round in the live e2e (the guest's
  stage "Pausing…" 17 s after the pause landed, twice): a heartbeat whose state was read before the landing but
  whose answer was finished — and stamped — after the room that carried it. The stamp is now taken as the state is
  read (app.ts `roomOf`), so a slow answer never outranks a room read after it.
- **Not verifiable here, said so:** real acoustic feedback on the owner's earphones (the lab's squeal is synthetic);
  iOS's answer to a second, video-only capture (the fallback re-captures the pair as before); the owner's own Drive
  (the copies of the built-in pictures are made at the next sign-in, by the app).

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
