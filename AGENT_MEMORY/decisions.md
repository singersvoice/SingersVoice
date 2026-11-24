# Implementation decisions (and why)

Updated 24 Nov 2026. Dated where it matters; the newest line on a subject wins.

## Audio
- **24 Nov — the two modes' numbers are independent constants** (`PERFORMER_MONITOR.vocalDb = −15`, `.trackLufs = −16`;
  nothing derived from `PUBLISH_MIX`): a change to the published levels never moves the ears. The player's ears gain
  carries `EARS_TRACK_TRIM_DB` so the Backing level means the same whatever the published track is.
- **24 Nov — the published track at −14 LUFS with its own −4 dBFS limiter; the vocal target −7.8 K under a −1 dBFS
  ceiling; the mix ceiling −1.5; the guard −5.** The voice's loudness is ceiling-bound (≈ −9.5 K): the target is what
  the rider aims for, the limiter what the file gets. A density compressor was tried and removed (see audio-modes.md).
- **24 Nov — the chain's shapers are our own `sv-shaper` worklet** (2× oversampled, 31-tap half-band filters, 15 frames
  each) instead of WaveShaperNode '2x' (128 frames each): the chain holds the voice 3 ms instead of 10. The capture asks
  for its shortest buffer. The device's own delay is told in the Sound sheet; it is not the app's to remove.
- **23 Nov — two listening modes.** PERFORMER (the singer's ears) and PUBLISH (every output) have their own
  level sets (`PERFORMER_MONITOR`, `PUBLISH_MIX`); the monitor's rider never takes the bus's target. See
  `audio-modes.md`.
- **23 Nov — the riders and the guard measure K-weighted** (BS.1770 biquads passed into the `sv-leveler`
  worklet). A bass-heavy track is judged by its loudness, not its unweighted RMS; the guard's line sits above a
  record's loudness so it never pins a normal mix.
- **23 Nov — the music gets a pocket and a duck** (`trackPocket`, `sv-ducker`): the voice in front without
  being louder than it is. Static pocket EQ; the duck keyed by the voices after their riders and the Vocal offset.
- **23 Nov — a limiter per vocal** (`sv-dynamics`, 2 ms lookahead, −1.5 dBFS) after its rider: a record's vocal
  density; the sum limiter then works lightly (≈ 1.5 LU).
- **23 Nov — every preset mid-forward and level-matched** (makeups tuned by the audio lab, spread 0.6 dB).
- **23 Nov — controls start at 0 / 0**; the mix itself is right. Offsets set on earlier builds were reset once.
- **22 Nov — the review plays the take through the mix bus** (`TakePlayback`): the review is the file.
- **13 Nov — honest dynamics**: our own `sv-dynamics` worklet (explicit makeup, chosen lookahead) instead of the
  browser's DynamicsCompressorNode (hidden +7…+14 dB makeup, 6 ms lookahead); every parallel path delay-matched.
- The engine's input leveller (raw mic peaks −18…−6 dBFS) and the chain's rider (−16 dBFS RMS) are kept: they
  feed the mesh and the ears; the bus rider does the final publish level.

## Picture
- **24 Nov — AUTOZOOM is one switch, off by default** (`framing: 'still'`): the seat frames once and holds, stable and
  centred; on (`'voice'`) = the push-in with the voice and the seat following a move (the seat's own margins; 'still'
  keeps the wide ones). Every save went to off once (`autozoomV1`). The same component everywhere (`PictureChoices`).
- **24 Nov — the performer a fifth bigger in every stage mode, the crown near the top** (`rowTop`: the slot placed for
  the crown — 5 % down the solo take's frame, 8 % down the show's — so the picture is the singer from the crown to the
  chest, not air over the head); a fuller row still stands on the riser.
- **24 Nov — the row from the middle out** (`rowOrder`): slot 1 in the centre, then right, left, right… — a join or a
  meet fills in around the primary performer, who stays where they were. The row stays one straight line of equal
  singers; only the order changed.
- **22 Nov — the seat** frames the singer once (settle → glide → held), never breathes with the voice; the voice
  zoom is a crop of the held frame (×1.5 on the face, 0.6 s in / 1.1 s out, hysteresis 0.56/0.44, hold 1.4 s,
  clocks run on the frame clock so a meter reading 0 still ends the hold). Default framing 'voice' — until 24 Nov ('still').
- **22 Nov — stage modes** 'stage' (performer), 'show' (publisher, meets' film), 'solo' (the Studio's saved take:
  the show slot ×1.5, top at the row top). The live strip never changes with these.
- **22 Nov — NONE background** = the camera picture as it is (no cut-out, no backdrop); the model still measures
  the head so the frame and the zoom work.
- The stage is one straight row of equal singers; the live stream matches what the singer sees; no mirroring.

## Permissions, settings, layout
- **22 Nov — one getUserMedia for both at setup**; one capture per Studio visit on iOS (camera with mic, the
  engine adopts, the mic parked between songs); Permissions API read at launch/setup/Settings; recovery text per
  browser; a camera allowed again is re-opened without a reload.
- **22 Nov — settings restore at start**: localStorage at once; on Drive the Config copy pulled with newer-wins;
  "Save my sound" writes now.
- **22 Nov — every screen fits a phone**: bounded grid tracks (`minmax(0, 1fr)`), wrapping topbar/tabs/chips, a
  stage that keeps Start and two readable lyric lines on a 320 px phone at 2× text; audited by `fit-e2e`.
- **21–22 Nov — Worker-based encoders and audience mix player**; the stream issue was never the server.

## Testing strategy
- Nothing is claimed without a lab or e2e that measures it; audio changes are proven in the audio lab (offline
  renders of the real chain and bus) and in the Studio e2e (the saved take measured with ffmpeg R128) and the live
  e2e (the meet's film measured). See `verification.md`.
- Chromium's intermittent "VideoFrame was garbage collected" console note is listed, not counted, by the e2es
  (one source fixed: the packed track stopped before its writer; one intermittent case remains).
