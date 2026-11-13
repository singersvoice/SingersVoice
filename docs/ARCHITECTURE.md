# Architecture (v2, short form)

The authoritative plan is the Claude Doc *SingersVoice Implementation Plan → v2 plan*. This page keeps the pieces
that the code depends on.

## Principles

1. **Lyrics first.** The stage is 16 % stage strip · 60 % lyrics · 24 % controls (portrait); 5 visible lines
   (1 done grey, 1 active green with progress fill, 3 upcoming orange); singer-slot badges; personal cue deck.
2. **Local-first, clock-anchored.** Every device plays the backing track from a scheduled `AudioContext` time
   (locally) or a shared wall-clock instant (meets — the *GMT kickstart*). The vocal is captured by an
   AudioWorklet that reports the exact clock time of its first frame, so vocal, video and lyrics align without
   round-trips. No performer waits on the network to sing.
3. **Drive is the system of record.** `SingersVoice/{Tracks, Performances/{Live,Offline}, Temp, Config,
   Backgrounds, Exports}`, one sub-folder per task, `appProperties` on every file, resumable + md5-verified uploads,
   Temp auto-deletes after 7 days unless kept.
4. **No session can fail silently.** Takes are secured in Temp as soon as they end; uploads resume; token expiry
   surfaces as a one-tap *Reconnect*; the stage keeps the screen awake and warns before leaving mid-take.
5. **Lightweight.** First load ≈ 58 KB gzipped (Preact + signals + the app). Backgrounds, the cut-out model and
   Google scripts load on demand. The same `dist/` runs on GitHub Pages, Cloudflare or any static host.

## Portals (loosely coupled)

| Portal | Route | State it owns | Talks to |
| --- | --- | --- | --- |
| Tracks | `/tracks` | track files in Drive, catalog entries | Drive API, `sv-control /catalog/*` |
| Studio | `/studio/*` | tracks, takes, audio settings | Drive API (works offline); the catalog only to publish a saved track or pull one to sing |
| Live Meets | `/meets`, `/meet/:id` | meet session (poll), personal take, the saved show | `sv-control /meets/*`, Drive for the take and the show |
| Publishing | `/publishing`, `/publishing/show/:id`, `/watch/:id` | destinations, jobs, the show view | `sv-control /publishing/*`, `/meets/:id/*` (as a publisher), `/watch/*` |

No portal imports another's screens; they share only `packages/protocol`, `lib/` (storage, api, audio) and
`state/` (session, settings). The SVT DB (sv-control) is the only shared backend and holds no media.

### A track's life (every step is self-contained)

1. **Save** (Track Maker, or an import in Tracks): `StorageProvider.saveTrack` writes `track.json` + the
   backing audio to Google Drive `SingersVoice/Tracks/<title>/` (IndexedDB in developer preview). Both
   files carry `appProperties` (`svType`, `svTrackId`) so they are found by id, never by path.
2. **Publish** (`lib/catalog.ts: publishTrack`): the Drive folder gets an *anyone with the link* permission
   and the catalog (SVT DB) gets the entry with the public Drive file ids. Offered right after saving in
   Track Maker, in Tracks, and inline in Live Meets when a private track is picked.
3. **Pull** (`lib/catalog.ts: pullCatalogTrack` / `fetchCatalogTrack`): any signed-in singer fetches the
   two files straight from the owner's Drive (own token → API key → public download URL) and saves a copy
   in their own storage. The Sing picker ("Add & sing"), Tracks ("Add to my Drive") and a meet room
   (streamed for the performance, no copy) all use the same two functions.

`lib/catalog.ts` is the only place that knows how publishing and pulling work; portals call it and never
each other, so any portal can be removed or replaced without touching the others.

## Live meet: who is on stage

Everyone who enters a meet is **audience** — except the host, who is seated on S1 by the meet itself
the moment they start it (their first arrival; stepping off later sticks). A running song belongs
to the singers on stage: from the count-in to the end nobody new steps on (`claimSlot` →
`song_in_progress`, the host's *let them sing* waits too); the wait list is served between songs.
The host (the meet's admin) takes any slot freely; anyone else **asks to sing** (`POST /meets/:id/requests`) and the host **lets them on** or declines
(`…/requests/:pid/decide` — the server seats them in the first free slot, so the singer touches
nothing), clears a slot (`…/stage/:pid/remove`) or opens the stage to everyone
(`…/policy` → `stagePolicy: 'open'`, default `'ask'`). Requests live on the meet (`meet.requests`),
the member's own state on their participant (`stageRequest: none | pending | declined`); requests
from members who left are dropped by the reconcile. The stage is live from the moment the meet
exists: a slot may be taken during the song too (a late singer starts mid-song).

**The stage runs before, during and after the song.** `portals/meets/roomStage.ts` owns one
camera feed, one compositor and one performer mesh for the whole room: whoever takes a slot opens
their camera with that tap, sees their cut-out on the lobby's stage strip at once and streams it to
the other performers and to any Publishing show view — the song is one activity on that stage, in
parallel with the show. The lobby strip draws in `show` layout (no lyrics); the live stage switches
the same compositor to `stage` layout; nothing reconnects at the kickstart. Audience devices draw
the performers' placeholders (video is private to the stage and the publisher).

## The room follows you

`portals/meets/activeRoom.ts` + `RoomLayer` in `app.tsx`: the room component is mounted once at
the app root, keyed by meet; `/meet/:id` only points it at a meet. On any other page it is hidden
(`display: none`) but alive — heartbeat, camera, cut-out, video mesh — with a floating pill to
return or leave; leaving unmounts it (the session says goodbye to its peers, then leaves the meet,
freeing the slot at once). The two siblings are keyed, room first: the pill coming and going must
never re-create the room element. Meets home: at most `MAX_OPEN_MEETS` (3) open meets per host
(`POST /meets` → 409 `too_many_meets`), `POST /meets/:id/end` and `DELETE /meets/:id` by the host's
account for list maintenance. A signal to a participant who left answers `{ gone: true }` (no
error) and the sender forgets the link.

## The set list

A karaoke event is many songs. The meet's current song is `trackId` / `catalogTrackId` /
`trackTitle`; `setList` queues the rest (`SetListEntry`: who picked it). The host and everyone on
stage add songs (`POST /meets/:id/songs` — the first one of a meet becomes current at once; `now`
lets the host swap the current song between songs, the replaced one going back to the top); the
host orders the queue (`…/songs/:sid` remove / up / now; the one who added a song may remove it);
`…/songs/next` (host) ends the current song: the meet goes back to the lobby with stage, slots and
cameras untouched, ready flags cleared and the next queued song up. The host's device calls it when
the backing track ends, so a song ending anywhere ends it for everyone; the 15-minute cap does the
same. `start` needs a song. Every device resolves the current song itself (`loadMeetTrack`:
library, then catalog); the picker (`SongPicker.tsx`) offers to publish a private track through
`lib/catalog.ts` first. A take in progress keeps the live stage mounted until it wraps up, even
once the meet is back in the lobby. The full walk-through is in [LIVE_MEET_FLOW.md](LIVE_MEET_FLOW.md).

## Live meet timing

1. Each client measures its clock offset to the server (5 samples of `GET /time`, median of the fastest).
2. The host presses Start → the server stores `kickstartEpochMs = now + 8 s`.
3. Every performer's device converts that instant to its own AudioContext time and schedules the backing
   track (and the sample-accurate recorder) there. Nobody waits for anybody; network jitter only affects
   when a device *learns* the instant, not when it plays.
4. **Pause / resume / seek / restart** are cued the same way (`Meet.playback`), whoever asks: a pause
   takes effect at `pauseAtEpochMs = now + 3 s`, so every device freezes at the same track position
   (`pausedAtMs`); resume, seek and restart set a new `kickstartEpochMs` with `offsetMs` = the position to
   continue from and bump `playback.epoch`, which is what clients key their re-scheduling on. The host
   and any singer on stage may pause, resume and seek (the song belongs to the stage); restart from the
   top is the host's. A seek while playing is a **cued jump**: every device keeps playing and switches
   to the new position at the shared instant (`BackingPlayer.cue`, a second buffer source scheduled
   sample-accurately against the first); a seek while paused moves the paused position for everyone.
   The recorder worklet drops frames between the pause and resume instants and, at a jump, inserts
   that much silence (forward) or keeps only the frames before the new position (backward: the part sung
   again replaces the old one), so a personal take stays on the track timeline across any number of
   pauses and jumps; its alignment is anchored to the timeline origin captured at the first cue. The
   show recording runs on in wall time (the song simply jumps in it). Performers poll every 1.5 s while
   live; the audience's lyrics and "listen" player follow `playbackPositionMs()`.

## The virtual stage

Nobody is shown as a boxed camera tile. `video/segmenter.ts` cuts the singer out of their camera with
MediaPipe Selfie Segmentation (bundled under `/mediapipe`, ~6 MB, cached by the service worker after
the first use; CDN fallback). The model's mask comes back either in the alpha channel or only as
brightness with opaque alpha depending on the browser/GPU path, so — as in the original SingersVoice
app — `alphaFromMaskPixels` uses whichever channel varies, normalises and feathers it, and falls back
to a soft head-and-shoulders silhouette when the mask is unusable (never a rectangle). `video/stage.ts` draws every
performer, left to right by stage slot, evenly spaced over the stage background — one shared stage
whether there is 1 singer or 10, on every device — under **one rule: a singer is drawn exactly as
their own camera frames them.** The frame a device sends (the cut-out with the singer's own framing)
is drawn whole, the same crop and proportions, on every stage: what a singer sees of themselves in
Performer mode is what the audience gets, only bigger. The stage never finds a person and zooms in
on its own (an earlier version did — it filled the slot with whatever the mask found, and a singer
close to the camera went out to YouTube as a head three times the size of the stage). The two modes
differ in the slots alone: **Publisher mode** ('show': Publishing, the lobby stage, the saved
performance) — slots as tall as the picture, the frame's bottom edge (the camera's cut) on the
picture's bottom edge like a TV shot, ten in one even row; **Performer mode** ('stage': the live
stage, Studio) — the lyrics are the picture, big, and each frame sits small in the lower ~45 %.
A frame that arrived small (a weak link) is never blown up past 2.5× its pixels. Framing
(`video/framing.ts`) is the singer's choice, on the live stage next to the camera button (and in
Studio / Settings). The default, **Chest**, frames the singer from the person: the feed reads its
own mask a few times a second (a 96×128 probe; the body width is the width most rows have, so a
stretched arm never widens it), and crops 1.35 bodies wide in the frame's own proportions with the
top of the head a tenth of the way down — head to chest, like a news anchor, from wherever the
singer sits; never past the camera frame (a singer already close gets the whole frame), never
tighter than 0.3 of it (a far singer is brought up, not into a blur); deadbanded and eased so it
never breathes. Wide (the whole frame), Mid and Close (fixed crops around the face) remain, and a
vocal-driven auto zoom eases a little closer while a singer sings and back out when they fall
silent. The sender crops its own stream at full resolution, so whoever takes the vocal comes closer
on everyone's screen.

Other performers' video arrives over a WebRTC mesh (`video/peers.ts`, video only — singers never hear
each other, by design): each device sends its cut-out **alpha-packed** (left half colour, right half
the mask as grey, `video/alphaPack.ts`), which survives compression far better than chroma keying, and
receivers unpack it with a one-line WebGL shader. Signalling is relayed by the SVT DB
(`POST /meets/:id/signal`, polled) so no socket server is needed; ICE servers come from `GET /ice`
(Google STUN by default; set `ICE_SERVERS` on the service to add TURN for strict NATs). Per-peer
bitrate is capped and scaled with the mesh size (≈1.6 Mbit/s total uplink). The mesh heals itself:
signals to a peer go out in order (an offer always lands before its ICE candidates; the relay assigns
its per-meet sequence inside one INSERT so simultaneous signals never collide), candidates that
overtake a description are queued, an offer nobody answers within 9 s is made again from a fresh
connection, a link that failed its ICE restarts is re-made, and a new DTLS fingerprint from a peer
(a reload, a re-made link) is mirrored by re-making ours.

## Publishing mode (the show view)

Publishing is its own portal (`/publishing`) for privileged accounts (`PRIVILEGED_EMAILS` on the
service): per-platform destinations (YouTube, Facebook, Instagram, Twitch — RTMPS ingest URL +
stream key, stored sealed — and the in-house portal), a publish job per meet, history. **Publish**
opens the **show view** (`/publishing/show/:id`): the broadcast picture. It joins the meet as a
*publisher* participant — its own kind: never on stage, never counted as audience, one per account
and meet, separate from the same account's performer participant on another device — pulls every
performer's video over the same mesh (receive-only; performers keep a publisher's link even though
it is not on the stage list), and draws them with the compositor in `show` mode: performers fill
the frame (≈96 % of its height for one or two, 92 % up to four, 86 % beyond), bigger name tags, no
lyrics, no controls in the picture. The chrome (title, LIVE badge, destinations, Go live / Stop,
backing track in sync with the meet's transport, full screen) fades out while the show plays and
comes back on any pointer movement. Only the host, or a privileged account that joined the meet
(the show view does), may queue a job for it. The singers' rooms are untouched: they keep their
lyrics, cue deck and transport; the show view only listens to the meet and pulls video. Because
the performers' stage runs from the lobby on, the show view (and Preview) carry the singers before
the host starts the song — the show is its own process, the song and the host's transport are
events on it.

**The broadcast sound.** A publisher's offers carry an audio line (`recvonly`); a singer's mesh
answers it `sendonly` and feeds it their vocal after the VoxForge chain
(`AudioEngine.vocalStream()`, a MediaStreamAudioDestinationNode) from the moment their mic is open.
Singer-to-singer links carry each other's vocal too (`wantAudio`: `sendrecv`) — **for the saved
show only**: a vocal that arrives on a singer's device goes to the recording's mix and nowhere
else, so singers still never hear each other (Solo foldback) and latency never pulls them apart.
Every vocal sender is capped at 96 kbps (`RTCRtpSender.setParameters`, re-applied when the link
connects and when the track is attached) — music quality rather than WebRTC's ~32 kbps phone-call
default. Video: a link to another singer shares the uplink (2.4 Mbps over the singer links, 300 kbps
to 1.2 Mbps each, 15 fps, scaled down only past six singers); a link to a *publisher* — a peer the
singer did not ask for, i.e. a show view or Preview tile — is the broadcast's source and gets its
own 2 Mbps at 24 fps, resolution kept. The cut-out itself is 720×960 on computers (480×640 on
phones; the packed frame twice as wide), so a singer standing full-height in a 720p show is drawn
near 1:1; the general selfie model (256×256) replaces the landscape one (256×144) on computers and
the mask is drawn with a 1.2 px blur — a soft edge instead of a staircase. The show layout never
blows a cut-out up past 2.5× its own pixels, and gives one or two singers a little stage around them. The show view plays the vocals (hidden audio elements) and the backing track a quarter
second behind the shared clock to meet them; Preview tiles are muted unless asked to listen.

**The saved performance (`video/showRecorder.ts`).** Every singer's device records the show while
a song runs: its own 1280×720 canvas (the meet's background drawn as the show view shows it, then
a 'show' compositor over the same cut-outs the stage draws — the remote frames are unpacked once
and shared, `UnpackedFrame`), its own audio bus on the engine's context (backing track + own vocal
after FX, held back by the same quarter second through a DelayNode — and this device's own cut-out
through a frame ring, so its picture is in step with its sound — plus every other singer's vocal as
it arrives — through the shared **mix bus** (`audio/mixBus.ts`, below), one MediaRecorder — **MP4
first** (`pickShowMime`: H.264 + AAC where the browser has an AAC encoder — Windows, Mac, iOS —
else H.264 + Opus in MP4, WebM only where MP4 is not offered, i.e. Firefox; audio at 192 kbps) so
a saved show plays wherever its Drive link is opened; the Drive file is named *song · meet ·
date.mp4* (`performanceVideoName`), found again by its app property — from the kickstart to the
end of the song, paused with the transport. The take's video
is that recording (`videoOffsetMs` = its first frame's place on the track timeline, lag included).
A live take never waits for a review: the stage hands it to the **background saver**
(`lib/saveQueue.ts`, one job at a time, each stage memoised so a retry never uploads twice, three
automatic retries then a Retry chip; `portals/meets/liveTake.ts` is the job) and the singer is
already back on the stage. The take is kept at once in `Performances/Live`, registered as the
singer's take (`POST /meets/:id/recordings`, by account — the singer may have left the room by
then), and the host's copy is **the meet's performance**: shared from the host's Drive
anyone-with-the-link and with each member's Google account, registered with the meet
(`POST /meets/:id/performances`, host by account → the `performances` table; `meet_members`
remembers everyone who was ever in the meet). `GET /performances` lists every show of every meet
the account hosted or was in — the Performances page, with the shareable links. The PWA never
applies an update while a save is pending.

**Preview** (admin monitoring) lists every open meet the account may publish (hosted or joined,
any other by link / code) as a monitor tile: the exact broadcast picture (`showStage.tsx`, the
same feed and compositor as the show view) in a 16:9 box, status (meet state, LIVE / requested,
performers linked) in the card and never in the frame, with *Show view* and *Publish* at hand.
Every publisher view — the show view, each tile — is its own participant resumed only by its own
token, so monitoring a meet and running its show view at the same time never fight over one video
link; the first four tiles connect by themselves, the rest on request.
4. Performers hear only themselves + the track (Solo foldback). **The audience hears the mix**
   (`audio/mixBroadcast.ts` → `/meets/:id/mix` → `audio/mixPlayer.ts`): on the host's device an
   AudioWorklet (`sv-mix-tap`) taps the show recorder's limiter output in 20 ms blocks, a WebCodecs
   `AudioEncoder` (Opus, 48 kHz mono, 64 kbps) encodes them, and one batch a second is POSTed to the
   relay (host by account; each batch tagged with the track position of its first frame, a rolling
   window of 40 batches per meet in the `mix` table). Audience devices in the room (and the public
   watch page, `/watch/:id/mix`) poll it every second, decode with `AudioDecoder` and schedule the
   packets back to back on the audio clock 1.6 s behind the newest batch (a jitter buffer), so the
   sound runs ~2–3 s behind the stage; the position of what is being heard drives the lyrics. Needs
   WebCodecs on both ends (Chrome, Edge, Safari 16.4+, Firefox 130+); otherwise — or when no batch
   has arrived for 6 s — the device plays the backing track alone, in sync.
5. **The show to the audience and to YouTube — from the publisher's browser.** The show view
   (`portals/publishing/broadcast.ts`) runs a `PublisherBus` (the track element and every vocal off
   the mesh through the same mix bus; two monitor switches that never touch the broadcast — the
   monitor has a guard and a safety stage of its own), draws the show on a `ShowRecorder` canvas, and `broadcast/liveEncoder.ts` turns it
   into a stream: `VideoEncoder` (H.264 Annex B, `avc1.4d401f`, 3 Mbps, 30 fps backing off to 15
   when the encoder falls behind, a keyframe every 2 s by time) and `AudioEncoder` (AAC-LC ADTS,
   48 kHz stereo, 128 kbps; absent on Linux Chrome / Firefox → video only), cut at the keyframes
   and muxed by `broadcast/tsMuxer.ts` (PAT/PMT first, PES with PTS, PCR on video, AUDs, continuity
   across segments — unit-tested against ffmpeg-made streams and decoded back by ffmpeg).
   `broadcast/liveSender.ts` PUTs each segment to `PUT /publishing/jobs/:id/live/:name` (raw body,
   `?seq&dur&audio`), a queue of four, retries with back-off. The service (`live.ts`) keeps a rolling
   window of eight per job in `live_segments` (BLOBs; node:sqlite takes typed arrays, Durable
   Object SQL ArrayBuffers — the driver converts), serves `GET /watch/:id/live` (status),
   `/watch/:id/live.m3u8` and `/watch/:id/live/:name` publicly, and when the job includes YouTube
   PUTs the segment then a four-entry media playlist to `YOUTUBE_HLS_BASE` (default
   `https://a.upload.youtube.com/http_upload_hls`) with `cid=<stream key>` — 200/202 ok, 401 key
   rejected, 400 refused, 5xx error — recorded on the job (`live.youtube`, `youtubeNote`). The job
   goes `live` on the first segment and is off air 20 s after the last. The audience plays the
   playlist with hls.js (lazy chunk; Safari natively) in `components/LiveShow.tsx`, on the watch
   page and in the room's audience view — no lyrics there. Tests: `SV_FAKE_YOUTUBE_DIR` makes the
   Node service serve a stand-in at `/fake/youtube/http_upload_hls`; the live e2e goes live from
   the show view, ffprobes a segment the fake received and watches the show on both pages. RTMP
   platforms (Facebook, Instagram, Twitch) remain the session container's job.
5. Inactivity (no join/heartbeat/chat/slot/start for 5 minutes) expires the meet; a live take is capped at 15 minutes.

## Components

| Component | Where | Runs on |
| --- | --- | --- |
| PWA client | `apps/web` | iOS Safari (installable), Android Chrome (installable), desktop browsers |
| Shared protocol | `packages/protocol` | client + services |
| sv-control (SVT DB) | `services/control` | Hono on Node 22 (node:sqlite) or Cloudflare Workers (one SQLite-backed Durable Object): users (privileged flag), catalog, meets, chat, recordings, publishing destinations/jobs; Google access-token auth |
| sv-session (V3) | `services/session` (planned) | RTMPS relay for Facebook / Instagram / Twitch: takes the browser's segments, speaks RTMPS (the browser already encodes the show) |

## The mix bus (`audio/mixBus.ts`) — every listener gets the same balance

The saved show, the audience's "Hear the stage" and the broadcast are mixed by one bus, built so
the result never depends on which file the track came from, which microphone a singer has or how
they set their effects:

```
track  ─ normalisation ─ Track offset ─┐
vocal₁ ─ rider ─┐                      ├─ sum ─ guard ─ limiter ─ soft clip ─ out
vocal₂ ─ rider ─┴─ Vocal offset ───────┘
```

- **The track is normalised to −19 LUFS** (`audio/loudness.ts`: ITU-R BS.1770 / EBU R128 —
  K-weighting re-derived for the device's sample rate, 400 ms blocks, the absolute and relative
  gates — unit-tested against the standard's 48 kHz table). A singer's device measures the decoded
  buffer in `BackingPlayer.load`; the show view decodes its blob once; both remember the result per
  track id (`sv.loudness` in localStorage). The player has two levels on purpose: `out` (normalised —
  what the recording and the audience take) and `gain` (the singer's **Backing level in your ears**),
  so turning the music down in your headphones never turns it down in the show — which is what used
  to make the recorded track "bleak" and the knobs go to +12.
- **Each vocal has a rider** (the `sv-leveler` worklet): a two-second RMS view of what is *sung*
  (a 50 ms gate at −45 dBFS stops it the moment the singer stops and keeps the pause out of the
  average), steered toward **−17 dBFS** at 1 dB/s up, 2 dB/s down, three times faster until within
  6 dB — a singer's offset, not their phrasing; +18 dB lift at most, −12 dB cut.
- **Track volume / Vocal volume** (±30 dB, 3 dB steps, kept per device) are offsets on top of that
  balance: 0 / 0 is already right.
- **The guard** (another `sv-leveler`, on the sum) only ever turns *down*, toward a −13 dBFS
  average: push both controls to +30 and the mix comes back to the target in a few seconds instead
  of living in the limiter.
- **The safety stage** (`audio/dynamics.ts`): a limiter at **−1.5 dBFS** (the `sv-dynamics`
  worklet, 2 ms lookahead over a sliding-max detector, 0.3 ms attack, a wall of a ratio) and a tanh
  soft clipper straight up to −1.4 dB behind it. Nothing above full scale reaches an encoder; a
  clipped encoder is what crackles.

**What the browser's compressor really does** (measured in `tools/ci/audio-lab.mjs`; the Blink/WebKit
kernel that Chrome, Edge, Safari and Firefox all run): `DynamicsCompressorNode` adds an **automatic
makeup gain**, (1 / its gain at 0 dBFS)^0.6 — +6.9 dB on a −20 dB / 3:1 vocal compressor, **+14.5 dB
on a −30 dB / 6.5:1 de-esser** (the old de-esser *boosted* the top band by 14 dB, which is the
sizzle and crackle on every "s") — and a fixed **6 ms lookahead delay**, so a dry path summed with
it lands 6 ms early and comb-filters (the old parallel compressor and de-esser both did). `Q` on a
lowpass / highpass BiquadFilter is in **decibels**, not a quality factor (a Butterworth section is
−3.01 dB there; the old 0.7071 was a +0.7 dB resonance, and the Linkwitz-Riley split summed 3.8 dB
hot at 8 kHz). A WaveShaper with 2x oversampling is 128 frames late. `compressorMakeupDb`
reproduces the kernel's knee maths exactly (unit-tested against the measured values), so the native
node can be corrected where the worklets are not available; everywhere else the chain and the buses
use `sv-dynamics`, with an honest makeup and no hidden delay.

## Audio chain (VoxForge, web twin of the JUCE plugin)

The microphone is opened **raw** — no browser echo cancellation, noise suppression or automatic
gain (all three chop and thin a singing voice; AGC pumps, AEC ducks the voice whenever it
correlates with the music) — mono, at the device's own rate. Echo cancellation is on only when the
singer says *I'm on speakers* (the track would otherwise leak into the mic). `AudioEngine.inputInfo`
reports the device, its sample rate and channels; a rate under 32 kHz is a phone-call line (a
Bluetooth headset's HFP mic) and the `MicStatus` component says so and offers another mic. The
**leveller** (`startLeveller`) replaces AGC: the raw peaks are watched 10× a second; quiet
*singing* (a raw peak above −34 dBFS, gained below −18 dBFS, for three readings) lifts the trim 1 dB
at a time up to +12 dB — room noise between phrases never does, which is what used to drive the gain
to the ceiling and the noise floor with it; past −6 dBFS it drops 2 dB at once (floor −6 dB) — slow
up, fast down, no pumping, never clipped. Then: trim → pitch worklet (granular shifter + NSDF
auto-tune) → HPF → low shelf 120 Hz / peak 1.2 kHz / **presence peak 3.2 kHz** / high shelf 6.5 kHz
→ compressor → **parallel compression** (a crushed copy, 10:1 from −36 dB with +16 dB of its own
makeup, blended under the dry vocal: soft phrases up, transients kept — punch without
over-compression; the dry side is delayed to meet it) → **de-esser** (Linkwitz-Riley split at
5 kHz, the top band through its own 1 ms compressor; the low band and the bypass wait for it) →
**exciter** (harmonics made from the voice above 3 kHz, blended in — air, not a treble boost; the
dry side waits for the oversampled shaper) → saturation (same) → chorus/doubler → ping-pong delay →
convolution reverb → **vocal rider** (an RMS meter every 50 ms; below −50 dBFS it holds, otherwise
it steers toward −20 dBFS: up to +12 dB lift, −6 dB cut, a few dB a second at most — every phrase up
front) → **safety** (limiter at −3 dBFS + soft clip: the voice never clips on its way to the mesh or
the recorder, whatever the preset and the singer do) → out. Every dynamics stage is our own
`sv-dynamics` worklet (see the mix bus above for why), every parallel path is delay-matched — the
audio lab checks the chain's impulse response has one arrival and no echo — and the whole chain is
**10 ms** (the limiter's 2 ms lookahead and three oversampled shapers; 32 ms on the native fallback);
the pitch stage alone holds one 46 ms grain while it corrects, and keeps its correction through a
300 ms unvoiced gap (a consonant, a breath) instead of falling back to the untuned pitch on every
"t". The chain runs live on the captured voice: what is recorded, sent to the publisher and
the other singers' recordings, and heard in the monitor is the processed vocal. Parameters and
presets live in `packages/protocol/src/audio.ts` and round-trip with the plugin's `APVTS` layout;
**Studio** is the default for a new singer (HPF 95 Hz, presence +2.5 dB, air +2 dB, 3:1
compression, parallel 0.25, de-ess 0.5, exciter 0.25, rider 0.6, a short room); Natural Tune,
Punch, Up Front, Radio-Ready and Vibrant are the other finished-vocal presets. A singer's preset
choice is kept on their device (`audio_plugin_settings`, localStorage, mirrored to
`SingersVoice/Config/` in Drive) until they change it.

## Data formats

- `track.json` — `singersvoice.track.v2` (imports `singersvoice.trackmaker.v1` and LRC).
- `manifest.json` — `singersvoice.performance.v2` with timeline offsets, FX used, file hashes.
- `audio_plugin_settings.json`, `app_settings.json` — `SingersVoice/Config/`.
