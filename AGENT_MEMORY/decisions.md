# Implementation decisions (and why)

Updated 24 Nov 2026 (evening). Dated where it matters; the newest line on a subject wins.

## Audio
- **24 Nov evening — the voice gate opens on evidence of a voice, not on a level** (`sv-gate`, `audio-modes.md`): a
  breath taken close to the microphone is as loud as quiet singing, and a level-based expander (threshold −34 dBFS /
  floor + 8) let the owner's breaths through at the voice's own level (PPD24_1.mp4, 01:33). Evidence: a period found
  (NSDF ≥ 0.6 on two agreeing hops, 75 Hz–1 kHz), a level within 3 dB of the voice's recent level, a bright sibilant near
  it, or a transient; voiced evidence holds 150 ms, the rest 60 ms; without evidence the gain goes to −range over the
  release. The range at full amount is 36 dB (27 at the default 0.75) because the parallel compressor behind the gate
  lifts anything near its −36 dB threshold ten to one: 27 dB before it is ≈ 20 at the chain's output (lab §0). Still an
  expander: a doubted phrase is softened, never cut; the singer can turn the amount down or the gate off (FxPanel).
- **24 Nov evening — a howl suppressor at the chain's start** (`sv-howl`): the squeals at 00:30 and 01:46 of PPD24_1.mp4
  were pure tones at 7.1 and 9.3 kHz growing 20 dB in two seconds — acoustic feedback (the earbud of a wired inline-mic
  earphone by the microphone). A 2048-point FFT every 512 frames; a lone peak (≥ 20 dB over the ±500 Hz median, no
  other peak within ±600 Hz inside 12 dB, no partial at f/2 or f/3) standing within a bin for ≥ 85 ms (190 ms and 28 dB
  under 1.5 kHz) without falling is notched (−36 dB, Q 24) for 10 s, up to four at a time; the look runs on the input
  so a tone still there keeps its notch. Always on; no latency; the lab switches it off for a pure-tone measurement
  (`chain.setHowl(false)`) because to it a lone 9 kHz tone IS a squeal.
- **24 Nov evening — the karaoke video is steered, not jumped**: a video element drifts from the audio clock; it used to
  be jumped back whenever it was a fifth of a second off (a visible stutter every few seconds on a slow device). Now its
  playback rate is bent by up to 4 % of the tempo to bring it back over 2 s, and only an offset past 0.5 s (a seek, a
  pause, the first frame) is a jump. The track's own speed was never in doubt: the backing plays from an
  AudioBufferSourceNode on the audio clock (the studio e2e now measures the saved file: 22 s of file = 22.000 s of song,
  drift 0.1 ms).
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
- **24 Nov evening — AUTOZOOM off = 'follow'**: the owner asked for head-to-chest framing kept "despite camera movement";
  'still' (the morning's default: framed once, the wide `STILL` margins, 6 s) let a bumped phone leave the singer off
  centre. 'follow' re-frames with one glide when the singer or the camera has moved beyond the seat's margins for 2.5 s;
  it never pushes in. Every 'still' save went to 'follow' once (`autozoomV2`); 'voice' stays. The geometry (head 22 % of
  the frame, crown 8 % down, the chest in) is unchanged: it IS head to chest; when the camera itself cuts the picture at
  the head (the owner's camera sits low), no frame can add what the camera does not see.
- **25 Nov — a meet page never turns its clock back** (`meetSession.ts` `stateAt`; app.ts `roomOf`): every room the
  stream pushes and every answer (heartbeat, action) carries the service's `serverEpochMs`, stamped as the state was
  read (not as the answer was finished); an older one than the state held is not applied as the room (its own lines
  — the video hours, the chat — are taken). A late answer to the host's own action had wiped a listener who came in
  meanwhile off the host's list until the next heartbeat; a heartbeat answered across a cued pause's landing had
  left the guest's stage "Pausing…" until the next change.
- **24 Nov evening — a frozen camera is caught on its pixels** (`video/stillness.ts`): four 16-px patches of every camera
  frame at the camera's own pixels (never a scaled copy: scaling averages the sensor's noise away) compared with the
  frame before; byte-identical for 3 s (`PIXELS_STILL_AFTER`) and three frames in a row at least (`SAME_FRAMES`: two
  frames alike seconds apart from a sampler that runs now and then — the model slow on a straining device — prove
  nothing; the live e2e's noiseless clip looped under load had read as frozen that way, and the clip now carries sensor
  noise like a real camera's) is frozen — a live camera's frames never repeat, a still singer's included. The
  model-measurement clock (15 s) stays as the fallback; frames stopping (5 s, as before — a shorter clock called a straining device's late frames frozen in the live e2e) too; a sampler that was itself starved for seconds judges nothing on that stretch. The owner's
  recording showed two 15-s freezes: exactly the old clock. The restart cadence is 15 s (was 60) and the restart is the
  camera alone (capture.ts): on iOS the camera is asked for by itself first and the microphone watched for 400 ms; only
  a microphone the browser ended is re-captured with the camera as before.
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

## Workflows, files, sharing
- **24 Nov evening — Save / Discard, Cancel, a review timeline**: the review's Keep became Save (the word the owner
  uses); Discard removes the Temp copy only and disappears once the take is saved (a saved performance is deleted from
  Performances, with its own confirmation — never from the review); Cancel stands beside Start (back to the list) and,
  during a take, in the Home icon's place (stops everything, throws the take away, no review); the review has a seek bar,
  Back / Forward 10 s and Pause (`TakePlayback` keeps a timeline; the show video follows it).
- **24 Nov evening — sound settings are files, shared through the service**: Drive's `drive.file` scope cannot list what
  another account shared, so sharing a saved sound (a few kilobytes of JSON) goes through the control service's sound
  catalog (`/catalog/sounds`, like `/catalog/tracks`); the file itself lives in the owner's Config folder under
  `<initials>_<date>_<time>.svsound.json`. Importing validates and clamps (`parseSoundSettings`) and applies through the
  same signals every control reads, so every control follows.
- **24 Nov evening — the Backgrounds folder is the record of the singer's backgrounds**: the built-in pictures are copied
  in once per account (stamped `svStock`), uploads go in scaled (≤ 1920 px), deletions go to the Drive bin, a deleted
  built-in is hidden on the account (`hiddenBackgrounds`, with the app settings) and restorable. The built-ins stay in
  the bundle too (every device has them offline; a meet's shared stage names only those). The 19 pictures the owner
  sent on 24 Nov are built-in (`public/backgrounds/<name>.webp` + thumbs) and so reach every account's folder.

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
