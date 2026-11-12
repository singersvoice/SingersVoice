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
| Live Meets | `/meets`, `/meet/:id` | meet session (poll), personal take | `sv-control /meets/*`, Drive for the take |
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
4. **Pause / resume / restart** are host-only and cued the same way (`Meet.playback`): a pause takes
   effect at `pauseAtEpochMs = now + 3 s`, so every device freezes at the same track position
   (`pausedAtMs`); resume and restart set a new `kickstartEpochMs` with `offsetMs` = the position to
   continue from and bump `playback.epoch`, which is what clients key their re-scheduling on. The
   recorder worklet drops frames between the pause and resume instants, so a personal take stays on the
   track timeline across any number of pauses. Performers poll every 1.5 s while live; the audience's
   lyrics and "listen" player follow `playbackPositionMs()`.

## The virtual stage

Nobody is shown as a boxed camera tile. `video/segmenter.ts` cuts the singer out of their camera with
MediaPipe Selfie Segmentation (bundled under `/mediapipe`, ~6 MB, cached by the service worker after
the first use; CDN fallback). The model's mask comes back either in the alpha channel or only as
brightness with opaque alpha depending on the browser/GPU path, so — as in the original SingersVoice
app — `alphaFromMaskPixels` uses whichever channel varies, normalises and feathers it, and falls back
to a soft head-and-shoulders silhouette when the mask is unusable (never a rectangle). `video/stage.ts` draws every
performer, left to right by stage slot, evenly spaced over the stage background — one shared stage
whether there is 1 singer or 10, on every device — and **frames each of them itself**: a small probe
reads the cut-out's alpha a few times a second, finds the person (top to bottom of the opaque
pixels; across, the width most rows have, so a stretched arm never shrinks anyone) and scales them to
fill their slot — head near the top, the camera's cut edge on the picture's bottom edge, feet on the
floor line when the camera sees them. The box is moved only when it really changed and eased, so
nothing breathes with mask noise. Across a row, heads are levelled: whoever's head stands clearly
above the median head line (a camera that sees them whole) is scaled down, feet staying put, so
nobody towers over the bust shots beside them. Show mode (Publishing, the lobby stage) gives every
slot the full frame height; stage mode (lyrics above) the lower ~60 %. Framing
(`video/framing.ts`) is therefore only the crop: wide (the whole frame; the default), mid, close
(around the face), and a vocal-driven auto zoom that eases towards "close" while a singer sings and
back out when they fall silent. The sender crops its own stream at full resolution, so whoever takes
the vocal comes closer on everyone's screen.

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
(`AudioEngine.vocalStream()`, a MediaStreamAudioDestinationNode) from the moment their mic is open
— singer-to-singer links never carry audio (Solo foldback), so latency never pulls singers apart.
The show view plays the vocals (hidden audio elements) and the backing track a quarter second
behind the shared clock to meet them; Preview tiles are muted unless asked to listen.

**Preview** (admin monitoring) lists every open meet the account may publish (hosted or joined,
any other by link / code) as a monitor tile: the exact broadcast picture (`showStage.tsx`, the
same feed and compositor as the show view) in a 16:9 box, status (meet state, LIVE / requested,
performers linked) in the card and never in the frame, with *Show view* and *Publish* at hand.
Every publisher view — the show view, each tile — is its own participant resumed only by its own
token, so monitoring a meet and running its show view at the same time never fight over one video
link; the first four tiles connect by themselves, the rest on request.
4. Performers hear only themselves + the track (Solo foldback). The composed mix for the audience comes from
   the session container (next increment); until then the watch page shows lyrics in sync and chat.
5. Inactivity (no join/heartbeat/chat/slot/start for 5 minutes) expires the meet; a live take is capped at 15 minutes.

## Components

| Component | Where | Runs on |
| --- | --- | --- |
| PWA client | `apps/web` | iOS Safari (installable), Android Chrome (installable), desktop browsers |
| Shared protocol | `packages/protocol` | client + services |
| sv-control (SVT DB) | `services/control` | Hono on Node 22 (node:sqlite) or Cloudflare Workers (one SQLite-backed Durable Object): users (privileged flag), catalog, meets, chat, recordings, publishing destinations/jobs; Google access-token auth |
| sv-session (V3) | `services/session` (planned) | one pod per meet: mediasoup ingest → VoxForge C++ mixer-composer → FFmpeg encoder → RTMPS / LL-HLS |

## Audio chain (VoxForge, web twin of the JUCE plugin)

trim → pitch worklet (granular shifter + NSDF auto-tune) → HPF → low shelf 120 Hz / peak 1.2 kHz / high shelf
6.5 kHz → compressor → saturation → chorus/doubler → ping-pong delay → convolution reverb → out. Parameters and
presets live in `packages/protocol/src/audio.ts` and round-trip with the plugin's `APVTS` layout.

## Data formats

- `track.json` — `singersvoice.track.v2` (imports `singersvoice.trackmaker.v1` and LRC).
- `manifest.json` — `singersvoice.performance.v2` with timeline offsets, FX used, file hashes.
- `audio_plugin_settings.json`, `app_settings.json` — `SingersVoice/Config/`.
