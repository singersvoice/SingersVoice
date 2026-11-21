# Architecture (v2, short form)

The authoritative plan is the Claude Doc *SingersVoice Implementation Plan → v2 plan*. This page keeps the pieces
that the code depends on.

## Principles

1. **Lyrics first.** The stage is 16 % stage strip · 60 % lyrics · 24 % controls (portrait); 5 visible lines
   (1 done grey, 1 active with a fill, 3 upcoming), every line in its singer's colour, whole — the song's
   parts divided among the singers in the song (`planParts`: two singers, two colours; ten on five parts,
   1 and 6 share), a chip per line naming the slot(s); personal cue deck. The
   lyrics follow the sound, not the clock: the position is the player's minus the output latency.
   A line lights up 150 ms before it starts (a breath to read it) and fills over the time its words
   take — the song's own pace, the median ms per sung character over its timed lines
   (`lyricsPace`) — never stretched over the pause after it, so the fill is at the word being sung.
   Track Maker sets a mark 200 ms before the tap (hearing a line start, then tapping, takes that
   long) and has *All earlier / All later* for a song that still lights up late.
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
   Google scripts load on demand. The same code builds for Cloudflare Pages (www.singersvoice.com, from `/`) and GitHub Pages (from `/SingersVoice/`) — docs/HOSTING.md.

## Portals (loosely coupled)

| Portal | Route | State it owns | Talks to |
| --- | --- | --- | --- |
| Tracks | `/tracks` | track files in Drive, catalog entries, YouTube song tracks | Drive API, `sv-control /catalog/*`, `/yt/*` (the relay behind it) |
| Studio | `/studio/*` | tracks, takes, audio settings | Drive API (works offline); the catalog only to publish a saved track or pull one to sing |
| Live Meets | `/meets`, `/meet/:id` | meet session (poll), the virtual stage, the film of the meet (the host's device) | `sv-control /meets/*`, Drive for the film |
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
   two files and saves a copy in their own storage. Own token first (it reads the singer's own files; a
   `drive.file` token of another account cannot see someone else's shared file), then the app's Google
   API key when the build has one (public files straight from Drive), else **the service fetches the
   file from the owner's Drive for the app** (`GET /catalog/tracks/:id/file/:which`,
   `services/control/src/driveFiles.ts`: the service's own `GOOGLE_API_KEY` if set, else Drive's public
   download endpoint — which has no CORS for a browser, the "Load failed" of old). The Sing picker
   ("Add & sing"), Tracks ("Add to my Drive") and a meet room (streamed for the performance, no copy)
   all use the same two functions.

`lib/catalog.ts` is the only place that knows how publishing and pulling work; portals call it and never
each other, so any portal can be removed or replaced without touching the others.

### The SingersVoice track database (`packages/protocol/registry.ts`, `lib/registry.ts`, `track_registry`)

The master database of every karaoke track singers have sung — one **record per source file**: a
YouTube video (`yt:<videoId>`), a singer's Drive folder (`drive:<folderId>`), a catalog entry
(`catalog:<id>`; every published entry is mirrored, and the entry learns its `registryId`). A record
holds the **song's search name, artist(s), movie, year, language**, a **12-character id** — 8 random
characters from an alphabet without 0/O/1/I and the month it was minted, `YYMM`, minted by the service
and nobody else (`newRegistryId`) — the owner's **shareable Google Drive URL** (their track folder,
shared anyone-with-the-link) with the file ids behind it, and the global **last accessed** instant
(UTC: the most recent *successful* access by anyone). Beside it, `track_access` keeps **every singer's
own history** (first, last, count) and, when they made one, their **shared copy's** file ids.

- **Sing registers.** The first Sing of a track of your own (`ensureRegistered`, from the Sing screen
  once the track has loaded — Drive only) shares its folder, registers the song with its metadata
  (title → song, artist, the Track Maker's Movie and Year, language) and writes the id into the
  `track.json` (and the file's `svRegistry` property), so every device knows it from then on. A
  YouTube import registers at import, with what the video's title says (`parseSongTitle`: "Song |
  Movie | Singers | 2019 | Telugu Karaoke", "Song - Artist (Karaoke)", "(From "Movie")", a year, a
  language word — anything it cannot tell stays empty, the owner or a super admin can set it,
  `PATCH /tracks/:id`). A second registration of the same source — or of the same Drive folder —
  answers the first record, filling blanks and never blanking what it had.
- **Sing on somebody's record** (`singRecord`): the track of your library that is it (by id), else its
  files fetched (your own token for your files, the app's API key if any, else the service —
  `GET /tracks/:id/file/:which`, which tries the owner's Drive and then **every singer's shared copy**,
  newest first, and marks the record `unavailable` only when none hands the files over), a copy saved
  into **your** Drive under `Tracks/<title>` carrying the id (`reg-<id>-<you>`: stable, so it is never
  made twice), shared, and registered as a copy (`POST /tracks/:id/copies`) — one more place the song
  outlives its first Drive from. A catalog pull does the same with the entry's `registryId`.
- **Access** (`POST /tracks/:id/access`, `how: sing | play`) is reported by the device only after the
  fact: the Sing screen once the track loaded (solo), the meet room once the song loaded on that
  device (every singer's device, each song start — `meet.registryId` travels with the song pick), the
  All tab's preview once it plays. Searches, results, browsing, a failed copy or an unavailable link
  never count. The service moves the record's global instant and the singer's own row to now.
- **Search** (`GET /tracks/search?q=`): every word must appear (song, artists, movie, year, language,
  source, owner); the answer is **groups by song name** (`songKey`: lowercased, the karaoke-file words
  and brackets dropped, combining marks kept), the groups ordered by the latest access in them (the
  never-sung last), the versions in a group the same way; `GET /tracks/history` is the singer's own.
  The All tab (`portals/tracks/AllTracks.tsx`) draws the groups as a tree — a song with one file is its
  row; several open on a tap; several artists cascade one level more — beside the singer's own Drive
  matches, the catalog entries the database does not answer with already, and (on Search) YouTube.

### Songs you prefer, bookmarks, Recommended (`packages/protocol/prefs.ts`, `lib/prefs.ts`, `lib/bookmarks.ts`)

- **The preference** (Settings → *Songs you prefer*): the **languages** a singer sings in and the
  **countries** whose songs they like, as chips — tap to pick, tap again to drop — kept on the account
  (`users.prefs`, `GET/PUT /prefs`, replaced whole; only known names are kept: `SONG_LANGUAGES`, the
  list the title parser reads languages off, and `SONG_COUNTRIES`, each country standing for the
  languages its songs are mostly in). The device remembers a copy (`sv.songPrefs`) so the portal has
  it the moment it opens. A singer who set nothing is **asked on the spot**: the Recommended tab and
  the public catalog show a dropdown (*Which songs do you prefer?* — a language or a country, with
  *Set it once in Settings* beside it); the pick lives in the session on that device (`sv.songPick`),
  never on the account.
- **Recommended** (`portals/tracks/Recommended.tsx`, `GET /tracks/recommended?languages=`): the songs
  of the track database in those languages — `track_registry.language`, as the title parser read it,
  the Track Maker set it or the owner corrected it — **the most sung first** (`SUM(access_count)` by
  song, then the latest access), grouped and drawn as the All tab's tree, with the same Sing and
  preview (`useRecordActions`). The **public catalog** keeps to the same languages (`GET
  /catalog/tracks?languages=`, by the language the entry was published with), with *Every language*
  one tap away; with nothing set, the dropdown is there too.
- **Bookmarks**: the **star on every song's row** — a record of the database (All, Recommended), a
  public catalog entry, a YouTube result, a track of your own Drive (registered with the database on
  the first tap, as a Sing would, so the others on a stage can sing it from your bookmark) — keeps the
  song on the account (`bookmarks`: one row per song per singer, keyed `<kind>:<ref>`, `PUT /bookmarks/
  :key` to keep or replace, `DELETE` to drop, `GET /bookmarks` the latest first). The browser holds
  them as one map (`lib/bookmarks.ts`), so every star everywhere shows the same state, kept at once
  on a tap and put back if the service refuses. The **Bookmarks tab** lists them, each saying what it
  is (track database · public catalog · YouTube) and singable from there the way its kind is sung
  (`singBookmark`: the copy you have, else the record fetched and kept, the entry pulled, the video
  fetched into your Drive).
- **On a live stage, bookmarks are shared**: `GET /meets/:id/bookmarks` answers every stage singer's
  bookmarks together (the singers in the stage slots, by account), each saying **whose** (`by`), to
  anyone in the meet — so five singers on stage see five singers' bookmarks. The Recommended tab, while
  the room is mounted (the room follows you), shows them first, named for the meet, read every few
  seconds; the **song picker** in the room offers them above the list (*Bookmarked by the singers on
  stage*), each a Pick away — a database record or a catalog entry as a pick of its own, a YouTube
  bookmark fetched into the picker's Drive first and shared on the way like any track of yours.

### A YouTube song track (`lib/ytTracks.ts`, `packages/protocol/ytTracks.ts`, `services/relay/src/yt.mjs`)

A karaoke video found on YouTube becomes a track of the singer's own, with its words in the picture:

1. **Search** (Tracks → YouTube): `GET /yt/search?q=` → sv-control → the relay runs `yt-dlp` on the
   words (`ytsearch12:`; a pasted link or id is that one video) — no YouTube API key anywhere; the first
   dozen results with title, channel, duration, views and thumbnail.
2. **Fetch** ("Add to my Drive"): the browser makes the track's folder `SingersVoice/Tracks/YT/<title>`
   (`DriveProvider.createYtTrackFolder`, stamped `trackFolder`/`svTrackId` like any track folder) and
   asks `POST /yt/fetch { videoId, trackId, folderId, name }`; sv-control hands the ask to the relay with
   the singer's own Google token (the request's bearer — the one the browser uses for Drive), which lives
   in the job for its duration and is never logged or answered back. The relay's job: `yt-dlp` downloads
   the best H.264 + AAC mp4 at 720p or under (20 minutes at most, no live streams), `ffprobe` reads it,
   `ffmpeg` takes the sound out (`backing.m4a`, AAC copied) and makes the mp4 start fast (re-encoding
   only a picture that is not H.264, so every browser plays it), then both files go into the folder by
   resumable upload with the app's properties (`svType: trackVideo` / `trackAudio`, `svTrackId`,
   `svYoutubeId`) and the video gets an *anyone with the link* permission. The browser polls
   `GET /yt/jobs/:id` (the relay's own words on the progress bar: *downloading · 42 %*, *uploading the
   video · 12 MB of 40 MB*) and, when the job is done, writes the `track.json` beside the two files
   (`saveTrack(track, null)` — the relay's `backing.m4a` is found by its properties as the backing
   layer). A failed job removes the folder again; nothing half-made stays. `TrackPackageV2.video`
   (`TrackVideo`: the Drive file id, size, the YouTube id) and `origin: 'youtube'` mark the track; the
   list shows a *video* chip.
3. **Sing** (Studio Sing, the live stage): a track with `video` shows `KaraokeVideo` where the
   `LyricsPanel` would be — a muted `<video>` kept on the song's clock (a jump whenever it drifts past a
   fifth of a second, play/pause with the song, the tempo as its playback rate, the count-in over it);
   the sound the singers hear and record is the backing layer in the audio engine, on the shared clock
   of a meet, as for any track. The video comes in whole from Drive (`lib/trackVideo.ts`): the owner's
   token, else the app's API key, else the service (`GET /catalog/tracks/:id/file/video`) — the same
   three ways a published track's audio comes in — and the last three stay in memory as object URLs.
   Until it arrives, and if it cannot, the song still runs. The show picture and the broadcast carry no
   lyrics and so no video either: the performers, as before.
4. **Share / publish**: the video file's own link plays for anyone (the permission above); publishing
   to the catalog carries `videoId`/`videoMime` in the entry so every singer of a meet can show it, and
   a pulled copy keeps pointing at the owner's video.

The relay (docs/RELAY.md) is the one place that can run `yt-dlp`; without it `GET /yt` says so and the
YouTube section explains what is missing. `yt-dlp` updates itself when the relay starts and once a day.

## Live meet: who is on stage

Everyone who enters a meet is **audience** — except the host, who is seated on S1 by the meet itself
the moment they start it (their first arrival; stepping off later sticks). A running song belongs
to the singers on stage: from the count-in to the end nobody new steps on (`claimSlot` →
`song_in_progress`, the host's *let them sing* waits too); the wait list is served between songs.
The host (the meet's admin) takes any slot freely; anyone else **asks to sing** (`POST /meets/:id/requests`) and the host **lets them on** or declines
(`…/requests/:pid/decide` — the server seats them in the first free slot, so the singer touches
nothing), clears a slot (`…/stage/:pid/remove`) or opens the stage to everyone
(`…/policy` → `stagePolicy: 'open' | 'ask'`; **a new meet is open** — whoever has the link takes a
free slot — and the host switches to `'ask'` to decide each one). Only the host **removes anyone
from the meet** (`…/participants/:pid/kick`): off the stage and wait list, out of the room, and the
account is on the meet's `bannedUserIds`, which `join` and `heartbeat` refuse with 403 `removed`.
Requests live on the meet (`meet.requests`),
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

## The song of the stage (one at a time)

A karaoke event is many songs, sung one at a time. The meet's song is `trackId` / `catalogTrackId` /
`trackTitle` (`currentDurationMs`); `setList` holds the songs *put forward* (`SetListEntry`: who
picked it) — never a queue. The host and everyone on stage pick (`POST /meets/:id/songs`): nothing
up → the pick is up at once (ready flags reset, every device loads it); a song up → the pick is put
forward and the stage chooses. `…/songs/:sid {action:'choose'}` (any singer on stage; `sid` =
an entry, or `current` for the song up) settles it: with no song running, the chosen song is up and
every other entry is dropped; while a song runs, the chosen entry is the only one waiting for its
end. `{action:'remove'}` withdraws an entry (anyone on stage, or the one who put it forward); a
withdrawal that leaves one entry with nothing up and nothing running makes it the song up. `start`
needs a song and refuses with `choice_pending` while entries wait with no song running
(`choicePending` in `meets.ts`; the client mirrors it with `songChoicePending` in the protocol).
`…/songs/next` (host or any singer; the host's device calls it when the backing track ends, the
15-minute cap does the same) ends the current song: the meet goes back to the lobby with stage,
slots and cameras untouched, ready flags cleared — one entry comes up by itself, several stay for
the stage to choose with nothing up, none leaves nothing up. A song is never listed twice:
`songPlace` / `sameSong` (protocol) tell a repeat by its ids (a pulled copy `<id>-copy-<who>` is its
catalog entry) or by title and length, and the service answers a repeat with `X-Song-Duplicate:
current | proposed` and no change. Every device resolves the current song itself (`loadMeetTrack`:
library, then catalog); the picker (`SongPicker.tsx`) offers to publish a private track through
`lib/catalog.ts` first and marks songs that are up or put forward instead of offering them again;
the panel (`SetListPanel.tsx`) renders the choice card. A take in progress keeps the live stage
mounted until it wraps up, even once the meet is back in the lobby. The full walk-through is in
[LIVE_MEET_FLOW.md](LIVE_MEET_FLOW.md).

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
   (The recorder worklet — a Studio take's — drops frames between a pause and a resume and, at a jump,
   inserts that much silence or keeps only the frames before the new position, so a take stays on the
   track timeline; in a live meet nothing records per song.) The film of the meet runs on in wall time
   (the song simply jumps in it, a chapter mark at the jump). **The service pushes** (`events.ts`,
   `GET /meets/:id/events`): every device in a meet keeps one event stream open (SSE — the resume
   token in its query is the credential, the browser's EventSource sends no header; it is the meet's
   own token, never the Google one), and after every action of any device the service says *changed*
   on every stream of that meet (told once per turn of the service, though an action may write the
   meet twice) — each device fetches its snapshot at once (`MeetSession.poke`); *signal* tells the one
   device a WebRTC signal waits for, and its mesh polls now (`PerformerMesh.pollNow`). With the stream
   open the heartbeat polls are the safety net and the clock report: every 4 s while the room forms or
   counts down, 3 s on stage and in the show view while live, 4 s in the audience while live, 8 s
   otherwise (`POLL_PUSHED`); without it (a browser that cannot keep a stream, a proxy that will not)
   the old pace — 2 / 1.5 / 2 / 5 s. The stream is pinged every 25 s, re-made by the browser when it
   drops (a snapshot is fetched on every open, so nothing said meanwhile is missed), and closed by
   the service when the meet ends. On Cloudflare every request of every meet goes through the one
   Durable Object, so an in-memory map of who listens is the whole truth there too; on Node one
   process serves every meet. Every link of the mesh also carries a small negotiated data channel
   (`sv`, id 1, made on both sides before the first offer so it never renegotiates): after any
   action of a device (`MeetSession.onActed`) it says *changed* to every linked peer as well, and
   each one fetches the snapshot at once — belt and braces: the singers and the show view follow a
   background switch, a song pick or a transport cue in a few hundred milliseconds (the probe
   below: a slot taken on a phone shows on the host's screen in 0.3 s, a resume in 0.04 s), the poll
   remaining the safety net (neither channel carries state, only the word). The audience's lyrics
   and "listen" player follow `playbackPositionMs()` (the mix player's own clock when the mix plays).

   **What a tap costs on the device itself** (`tools/ci/latency-probe.mjs`: two performers and an
   audience device on the local service, click → DOM timing, a CPU profile of the host around the
   song start): an action's round trip is 15–60 ms; the singing screen is in the DOM 70 ms after
   the tap. What used to stand between a tap and the screen was the main thread: the cut-out model
   and its GPU readbacks ran on the page (100–120 ms long tasks every 200 ms on a two-core machine),
   the whole singing screen re-rendered on every animation frame for the song's clock, and the stage
   canvas filled the whole phone screen. All three are gone: the camera pipeline runs in a worker
   (below), the clock is a signal only the lyrics and the seek bar read (`components/clocked.ts`),
   the stage is a strip under the lyrics, and the riser with its glow and the name tags is drawn
   once per layout and laid over the row every frame (`StageCompositor.drawRiserLayer`).

## The virtual stage

Nobody is shown as a boxed camera tile. `video/segmenter.ts` cuts the singer out of their camera with
MediaPipe Selfie Segmentation (bundled under `/mediapipe`, ~6 MB, cached by the service worker after
the first use; CDN fallback). **The whole camera pipeline runs in a worker** wherever it can
(`video/feed.worker.ts`, its page end `video/feedWorker.ts`): the camera's frames go to the worker
as a stream (`MediaStreamTrackProcessor`, Chrome / Edge — the page never sees a frame) or one bitmap
at a time (Safari), the model, the feathering, the stage frame, the lift and the alpha-packing all
happen there, and the page gets one bitmap per frame to draw (the framed cut-out) plus what was
measured (`FeedMeta`: the seat's state, the lift, the distance note, the mask's coverage); the
outgoing packed track is fed straight from the worker where the browser hand-feeds video tracks
(`MediaStreamTrackGenerator`, `AlphaPacker.startRemote`), so the stage, the lyrics and every tap stay
quick on a phone. The legacy solution's own worker path is half there, and the worker makes up for it:
it `importScripts` every file it lists (the model's data files too), so scripts are fetched and
evaluated by a shim that skips those; it asks its wasm for a GL context without a version (a name
lost in its own minification) and gets WebGL 1, on which the model's GPU inference answers noise, so
the context maker is wrapped to ask for WebGL 2 (what the page branch gets); and it never keeps the
context it makes, so the worker keeps it. Where a worker cannot do the work (no OffscreenCanvas, the
worker failing to start) the same pipeline runs on the page as before (`PersonSegmenter`,
`LocalFeed.pipeline` says which; `localStorage['sv.feedWorker'] = '0'` keeps it on the page for
support). `segmentCore.ts` is the arithmetic both share (the mask into feathered alpha, the
silhouette, the centre crop). The model's mask comes back either in the alpha channel or only as
brightness with opaque alpha depending on the browser/GPU path, so — as in the original SingersVoice
app — `alphaFromMaskPixels` uses whichever channel varies, normalises and feathers it, and falls back
to a soft head-and-shoulders silhouette when the mask is unusable (never a rectangle). The model is
never allowed to freeze the singer: frames go to it one at a time, a frame unanswered for
`SEND_TIMEOUT_MS` gets as long again and then the silhouette takes over (`modelStuck`: the picture
keeps moving off the camera) until the model answers or `MODEL_RETRY_MS` pass; every `start()` is a
new generation, so a late answer or a frame the old camera still owes never blocks the new one.
`video/localFeed.ts` watches the camera itself (`health`, `onHealth`): the track's mute / ended
events, and the video's `requestVideoFrameCallback` — frames that were flowing (ten at least) and
then stop for `FROZEN_AFTER` seconds while the page is visible and the track calls itself live is
`'frozen'` (never a raw-pixel heuristic: a plain wall or a synthetic camera shows the same bytes for
ever and is perfectly alive; a browser without frame callbacks is not judged by frames) — and so
is a camera that keeps presenting the same picture: the model's measurement of the singer (head
and body, to the probe pixel) identical across new cut-outs for `STILL_AFTER` seconds, which a
real person never is (the mask's own edge moves), while a camera pointed at nobody measures
nothing and the silhouette is never the model's word. The room
(`roomStage.ts`) and the studio restart the camera once by themselves and then offer a button;
every other stage tells a still picture too — `StageCompositor` samples each remote performer's
picture (16×21, once a second) and marks `still` after `STILL_AFTER_MS` of the very same bytes
(`onStill`), the room's strip and the show view say so in words, and the strip offers
**Reconnect** (`PerformerMesh.remake`: the link to that performer dropped and made again);
`video/capture.ts` is the one place the mic is opened: on iOS always together with the camera
(one capture per page there — a second getUserMedia ends the first), so a mic re-opened for another
setting never leaves the camera dark. `video/stage.ts` places every
performer in **one straight row**, as performers stand in a line across a stage: slots of one size,
evenly spaced by stage slot, all on one floor (`ARC_LIFT` is 0 — no curve; `arcLift` remains the one
place a curve would come from), every head at the same height, each behind a **riser** drawn in
front of them (`drawRiser`: a level band from its lit edge to the bottom of the picture, a pool of
each singer's colour, the names on it) that hides the lower 40 % of every frame (`RISER_COVER`) —
the way a stage's front edge hides what is below the chest. One shared stage
whether there is 1 singer or 10, on every device — under **one rule: a singer is drawn exactly as
their own device frames them, and every device frames its singer the same way.** That framing is
the **stage frame** (`video/framing.ts`, applied by `video/localFeed.ts` before the cut-out leaves
the device): the feed measures its own mask on every new cut-out, at most a few times a second, on
a 120×160 probe (`measureMask`: the person is the biggest blob of lit pixels — a plant or a poster
the model also lit is left out; the body as the width most rows have, so a stretched arm never
counts; the head from the top of the figure down its middle — its width tops out at the ears or the
hair, settled by the first row narrower than that (the jaw) or by the width standing still, so a
collar or a sweater the model lit along with the room never counts as head, and it ends where the
figure narrows to the neck or widens to the shoulders, always 1.1–1.6× as tall as wide) and crops
(`stageCrop`) in the frame's own proportions so the head is 22 % of the frame tall with its top 8 %
down, centred on the head — brought up for a singer sitting back (never past 3.3×), brought back
for one sitting close (up to 2.4×; the crop then reaches past the camera picture and that part is
transparent, `visiblePart`; the camera's bottom edge is feathered when it would show above the
riser). The crop is never steered after the measurement: the **seat** (`Seat`, `SEAT`) is how a
stage camera is framed on a seated performer and left alone. Only a measurement of a real cut-out
counts (the model's, with a plausible person in it, `plausibleHead` — never the stand-in
silhouette, never a fragment of a figure the model lost); the seat takes the median of a 1.5 s
window of measurements that agree with each other, sets the frame once (one 0.9 s glide from the
whole camera frame) and holds it. It re-frames only when the singer has clearly moved — the head's
centre, top or size away from where the frame has it by more than a margin (12 % of the frame
across, 6 % up / 14 % down, the size under 0.76× or over 1.3×) — and stayed there 2.5 s, the
measurements again agreeing: then one glide to the new frame, held again. A sway, a gesture, a
hand near the face, the model losing and finding the figure, the mask's edge wobbling: none of it
moves the picture. A distance note (`distanceNote`: *sit back* past 1.3×, *come closer* under 0.4×)
follows the frame the seat holds. So every frame carries a head of one size at one place, every
slot is one size, and every singer comes out one size — the stage never finds a person and zooms in
on its own, nothing steers the camera picture (the FaceDetector auto-frame is gone), and nobody
chooses a framing (the Chest / Wide / Mid / Close / Auto presets are gone). `tools/ci` has no lab for
this; the measurement and the seat were tuned on the real model's masks of real singers (the show
recording's cut-outs played back as a fake camera) — the old crop re-targeted on 45 of 58 frames
and zoomed between 0.85× and 1.19× in 16 s; the seat glides once and holds. The two modes differ in the slots
alone: **Publisher mode** ('show': Publishing, the lobby stage, the saved performance) — slots
taller than the picture (1.2×, width permitting), their lower part behind the riser and below the
picture, the heads from a tenth down, the riser band bounded to 9–40 % of the picture so ten small
slots sit lower rather than behind a wall; **Performer mode** ('stage', kept for a stage that wants
the lyrics drawn over the performers) — each frame sits small in the lower part over a slim riser.
The live stage and the Studio draw the singers in 'show' mode in **a strip of their own under the
lyrics** (`.sing`: the status strip · the lyrics, large, the words up from the count-in · the stage
strip, a quarter of a phone's screen, a third of a wide one, little in landscape · one row of
controls, the sound settings — the voice preset and its tweaks, the microphone, the track and vocal
volumes — in a drawer behind one button), so the lyrics have the screen and the stage canvas is a
fraction of what it was.
A frame that arrived tiny (a weak link) is never blown up past 4.5× its pixels — the packed stream
itself is never capped, so a phone's frame is as big as a computer's. The cut-out
itself is the camera picture **centre-cropped to 3:4** (`drawCover` in the segmenter — a 16:9
webcam loses its sides, a 9:16 phone its top and bottom), never stretched: a face is the shape it is.

Other performers' video arrives over a WebRTC mesh (`video/peers.ts`, video only — singers never hear
each other, by design): each device sends its cut-out **alpha-packed** (left half colour, right half
the mask as grey, `video/alphaPack.ts`), which survives compression far better than chroma keying, and
receivers unpack it with a one-line WebGL shader. Signalling is relayed by the SVT DB
(`POST /meets/:id/signal`, polled) so no socket server is needed; ICE servers come from `GET /ice`
(Google STUN by default; set `ICE_SERVERS` on the service to add TURN for strict NATs). Per-peer
bitrate is capped and scaled with the mesh size (≈1.6 Mbit/s total uplink). The mesh heals itself:
signals to a peer go out in order (an offer always lands before its ICE candidates; the relay assigns
its per-meet sequence inside one INSERT so simultaneous signals never collide), candidates that
overtake a description are queued, an offer nobody answers within 12 s is made again from a fresh
connection, a link that failed its ICE restarts is re-made, and a new connection on a peer's side
(a reload, a re-made link) is mirrored by re-making ours. **Every connection has a name** (`token`,
eight random characters) carried on every signal it sends; an answer names the offer it answers
(`forToken`). A signal from a connection a peer has since replaced, or an answer to an offer we gave
up on and re-made, is left alone — never applied to the new connection — because applying it
married the new connection to a dead one and the two sides re-made each other without end (a slow
host that answered in ten seconds was enough to start it). An untagged signal (an older build) is
taken as before, with the DTLS fingerprint telling a new connection from an old one.

## Roles, the Admin page and the club owner year

Every account has one **role**, kept in the SVT DB (`users.role`) and read on every request
(`packages/protocol/src/roles.ts`): **audio** (sings with sound only — the camera is never opened
on stage on their device, and every other device draws their name card whatever arrives, by the
`media` the room carries for each participant), **dual** (sound and picture — every new account),
**club owner** (dual, and Publishing mode while the yearly subscription is active) and **super
admin** (everything, always: Publishing without a subscription, and the **Admin page**). The first
account ever seen is the super admin; an address in `PRIVILEGED_EMAILS` is one whatever its row
says. Beside the role, every account is on a **plan** (`packages/protocol/src/plans.ts`,
docs/BILLING.md): **Free** (live meets with the voice; the Studio with the camera is everyone's),
**SVV** (a picture on stage in live meets, 10 hours a calendar month), **SVVPro** (100 hours) and
**Club owner** (300 hours a month shared with up to 15 members named by email, and Publishing mode)
— the prices per currency (USD; INR for UPI), the period (a month or a year), the hours, the seats
and whether a plan is for sale are the super admin's (`settings.billing`, Admin → Plans & payments).
The **subscription** row is the plan with a start, an expiry and a status (`active`, `revoked`, or
`none`; `expired` is computed from the date on every read — after the **grace days** the super admin
allows, none by default — so a period runs out by itself with nobody touching anything) — paid for
through Stripe on the Plans page (`/plans`: Checkout at the admin's price, the webhook's word opens
the plan; docs/global-payments-architecture.md) or granted on the Admin page (`/admin`, super admins
only: a plan for its period or for months, *Renew*, *Set dates*, *Revoke*; `GET /admin/users`,
`PATCH /admin/users/:id`, the last super admin cannot be demoted). What an account may do is the
**entitlement** computed on the service on every request (`entitlementOf`): the plan in force is the
account's own active subscription, else the club it belongs to by email (`club_members`) while that
club's plan is active, else Free; a super admin has everything without limit. `media` — the picture
in a live meet — follows it: the plan has video hours and some are left this month, and the role is
not audio only. **Video hours** are counted on the service on every heartbeat while a singer is on
stage with the picture on (`video_usage`, by pool — the account's, or the club owner's — and
calendar month, UTC; two minutes at most per gap); at the limit the next heartbeat sets the
participant's `media` to `audio` (every device draws the name card, the singer's camera closes) with
the reason on the room's chip (`yourVideo` on the snapshot: the hours used up, an audio-only account),
and the first of the month starts the count again. A free account on stage simply sings — its camera
button is off and the stage says nothing about it (the Plans page says what a plan brings; the strip
carries `data-video-allowed` / `data-video-why` for the tests). `canPublish` is the entitlement's: a super admin, or an own active plan that carries
Publishing (Club owner) — enforced on every `/publishing/*` route and the publisher join
(`403 publishing_closed` with the reason in words, which the app shows on its gate). The app only
mirrors the verdict (`role`, `media`, `entitlement`, `subscription`, `publishingNote` from `/me`,
refreshed on every portal and when entering a room) — and keeps what an account cannot use off its
menus: Publishing is listed (side menu, More panel, Home card, Settings) only for the accounts it is
open to, Admin for super admins alone, Plans for everyone else, My club for club owners
(`components/Shell.tsx`, `NAV[].when`). Tests: `packages/protocol/test/plans.test.ts` and
`roles.test.ts` (the plans, the entitlement, the standing with grace, the reasons),
`apps/web/test/navGating.test.ts` (the menus by account), `services/control/test/app.test.ts`
("plans": the settings, grants, the metering, the club; "payments through Stripe": Checkout, the
webhook's every event, refunds, reconciliation), `tools/ci/roles-e2e.mjs` (the whole of it in the
browser: the picture coming and going with the plan and the hours, the Plans page, the club, the
Admin page), `tools/ci/live-duet.mjs` (two performers with video on SVV).

## Coupons: who may use SingersVoice

The super admin's gate (`packages/protocol/src/coupons.ts`, `coupons` and `settings.coupons` rows,
Admin → **Coupons**): a coupon — a code and an expiry date (and a note) — is issued per **email
address**. A singer signing in with that address meets the **Coupon screen** before anything else of
the app (`app.tsx` Guard: every page shows it while the account is out) and enters the code; the
service keeps it on the account (`users.coupon_code`) and decides on **every request**
(`accessOf` → `UserRecord.access`): the gate on, the coupon issued for the address, the code entered
is the one issued, the date not passed — else `403 coupon_required` with the reason in words on every
route but `/me` and `/coupon`. So the admin changing the code or the date, or deleting the coupon,
puts the holder out on their very next request (the app lands on the Coupon screen from any 403
`coupon_required`, and a room leaves). Super admins are never out. The requirement itself is a switch
on the Coupons page (`COUPONS_REQUIRED` is only its start value: on unless `0`); off, everyone who
signs in is in. The Coupons page lists every coupon with who holds the address, whether they are in
(the code they entered matches, the date stands), the days left, and Save (a new code or date), New
code, Delete. Tests: `packages/protocol/test/coupons.test.ts`, `services/control/test/app.test.ts`
("coupons"), `tools/ci/coupons-e2e.mjs`.

## Joining a performance (`packages/protocol/join.ts`, `lib/joins.ts`, the Studio)

A solo take is sung alone; anyone with its link can sing their part over it — the Smule idea, on
the virtual stage. Every Studio take records, beside the show, **the singer's own cut-out**
(`ShowRecorder.setCutoutSource`: the local feed's person canvas and grey mask, alpha-packed as the
mesh packs them — `alphaPack.ts` — at the packed frame's size (720×960 on a computer, 480×640 on a phone, 320×426 on a weak device), 15 fps, a second MediaRecorder started and paused
with the show's; one more file in Drive, `svType performanceCutout`, named from the show's own
properties `svCutoutId`, shared, kept and deleted with it; `timeline.cutoutOffsetMs` is its frame
0 on the song). **Invite others to join** (the review after a take, or any take on Performances):
the take is kept (a Temp take would vanish), both files are shared anyone-with-the-link, the song is
in the track database (registered on the first Sing of a track of one's own), and the service keeps
the **invite** (`invites`: `PUT /performances/:id/invite`, the owner's alone; read by anyone signed
in; its files through `GET …/invite/file/show` and `…/cutout-<slot>`, fetched from the singers'
Drives by the service as a published track's are): the show's file, its frame 0 on the song and the
pace it was sung at (`offsetMs`, `tempo`), and one **layer** per singer on it — slot, name, cut-out
file, and where the cut-out's frame 0 falls on the show's own clock (`atShowMs`). The link is the
app's own page, `/studio/join/<id>`: a landing first — the song, who sang it, how many joined,
**Watch it first** (the show played right there) — then **Join — sing your part**. Share is still
the file's view link; the join link is the one to send.

A joiner's device (`Sing` with `joinId`) fetches the invite, the show and every cut-out, and the
song from the track database (a copy into their own library, as singing any record does). The show
is the backing track — its sound is the whole mix so far — played at 1× (tempo and key fixed); the
lyrics line up by `songTimeMs`; the earlier singers stand on the stage as **recorded frame sources**
(`JoinLayers`: a <video> per cut-out, unpacked like a remote singer's, `recorded: true` so a still
picture is a picture, never a dropped link; a MediaRecorder's WebM has no duration in its header,
so each is sent past its end once to make it seekable), held on the show's clock by `layerTimeS`
from the stage's tick — behind the show's sound by the lag and the singer's round trip, as the mix
has it — playing while the song plays, still while it is paused, seeked back whenever they drift.
The joiner takes the slot after the last one (`nextSlot`; ten is the stage) and, by default, the
first part of the song nobody sang. No seeking within a join (the layers would lose their place);
pause, resume and restart work as ever. The camera is the Studio's: **a plan gates the picture in
live meets alone** — a free account joins with its picture.

The joined take is a show with everyone on it, in the joiner's Drive, with its own cut-out: its
manifest's `join` names the performance it sang over and carries every earlier layer **moved onto
its clock** (`inheritLayers`, `inheritOffsetMs`: the saved show's frame 0 fell `videoOffsetMs −
latencyCompMs` after the show it joined, the recorder's offset already carrying the lag), and its
own layer at `cutoutOffsetMs − videoOffsetMs` (`ownLayerAt`), the two recorders having run on one
clock — so a cut-out keeps its place on the song through every generation (the protocol's test
checks the invariant). Opened for joining in turn, it counts as a join of the one it sang over;
`GET /performances/invites` lists a singer's open takes and the performances that joined them
(**Joined yours** on Performances: Watch, Join too). Closing an invite stops the link; the files
stay with whoever has them.

## Publishing mode (the show view)

Publishing is its own portal (`/publishing`) for club owners with an active yearly subscription and for super admins (above; docs/BILLING.md for the paid way): per-platform destinations (YouTube, Facebook, Instagram, Twitch — RTMPS ingest URL +
stream key, stored sealed — and the in-house portal), a publish job per meet, history. **Publish**
opens the **show view** (`/publishing/show/:id`): the broadcast picture. It joins the meet as a
*publisher* participant — its own kind: never on stage, never counted as audience, one per account
and meet, separate from the same account's performer participant on another device — pulls every
performer's video over the same mesh (receive-only; performers keep a publisher's link even though
it is not on the stage list), and draws them with the compositor in `show` mode: performers fill
the frame (≈96 % of its height for one or two, 92 % up to four, 86 % beyond), bigger name tags, no
lyrics, no controls in the picture. The chrome (title, LIVE badge, destinations, Go live / Stop,
backing track in sync with the meet's transport, full screen) fades out while the show plays and
comes back on any pointer movement. Only the host, or a publishing account that joined the meet
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
to 1.2 Mbps each, 15 fps, the frame scaled down to 320 wide — half as much again past six singers);
a link to a *publisher* — a peer the singer did not ask for, i.e. a show view — is the broadcast's
source and gets the whole packed frame at its own 3 Mbps, 24 fps (a strained sender gives up
resolution and frame rate by turns there, never a frozen picture); a Preview tile says over the
mesh's channel that it draws a small picture (`announceWant`, `{type:'want'}`) and its link is
scaled down like a singer's.
The cut-out itself is 720×960 on computers (480×640 on phones), so a singer standing full-height in
a 720p show is drawn near 1:1; the general selfie model (256×256) replaces the landscape one
(256×144) on computers and the mask is drawn with a 1.2 px blur — a soft edge instead of a
staircase. The show layout is the chaired row above: one or two singers stand big in the middle,
ten make one even row. The show view plays the vocals (hidden audio elements) and the backing track
a quarter second behind the shared clock to meet them; Preview tiles are muted unless asked to listen.

**Picture quality** (`video/enhance.ts`). At the source: a computer asks its camera for 1080p (a 3:4
crop of 810×1080 real pixels; a phone keeps to 720p, its pipeline light), makes the cut-out at
720×960 and sends it at that size, 1:1 — no resampling between the model and the packed frame;
phones send 480×640 (a weak device, three cores or fewer, keeps to 320×426) — it was 320×426
everywhere once, half the detail gone before it was sent and blown up two to three times on a show
stage; each singer link scales it back down on the way (`scaleResolutionDownBy`), so the mesh costs
what it did, and the publisher's link gets it whole, at 4.5 Mbps. Every video transceiver prefers
**H.264** (`preferredVideoCodecs`: hardware-encoded on nearly every phone and computer, so a 1440×960
packed frame costs the stage's device little and the picture stays steady), then VP9, VP8, AV1; the
answerer's order decides, and both sides set it. The exposure is lifted at the source too: the face's
brightness — the brighter quarter of the pixels in the head box the framing measures (of the whole
person when the model has no head), weighted by the mask so the room behind them counts for
nothing — is read off a 48×64 sample of the cut-out every half second; a gain towards a lit face
(target 0.5, never past ×1.5) glides to it frame by frame, and the picture is drawn through
`brightness() contrast(1.05) saturate(1.08)` once, in the feed — so the singer's own stage, every
other singer's, the show, the broadcast, the saved show and the cut-out recordings all get the same
picture (the stage strip says "lifted +N%"); a dark shirt in a lit room asks for nothing. At the receiver (`alphaPack.ts`): a frame that still arrives small — an older build,
a link the browser scaled down, a Studio cut-out recording at 320×426 — is unpacked at twice its
size through a Catmull-Rom bicubic upscaler, and every frame gets an unsharp mask on its luminance
(one texel wide, half strength, a hair of threshold so flat skin stays flat) — on a real GPU only: a
software renderer (SwiftShader, llvmpipe — CI's headless browser, a machine without acceleration)
gets the plain unpack, every texel it fetches costing a CPU the stage needs elsewhere; the
compositor draws the result with the canvas's high-quality resampling. The broadcast encodes at
4.5 Mbps (720p30 H.264). **The show's own size** (`showSize`): 1920×1080 at 30 fps on a computer
with a hardware encoder (the browser offers H.264 in MP4 only with one — Windows, Mac, iOS, Android),
1280×720 at 24 fps on a phone or where the encoder is software (a software encoder at 1080p would
take the stage's own frames), recorded at 8 / 4.5 Mbps (`showBitrate`) in H.264 **High** profile
where the browser has it (Main next, Baseline last: the same bitrate buys a cleaner picture). A Studio
take's cut-out recording is at the packed frame's size (720×960 on a computer) at a bitrate for it.

**The show (`video/showRecorder.ts`).** Every singer's device draws the show beside its stage: its
own canvas — 1920×1080 or 1280×720, `showSize` — (the meet's background drawn as the show view shows it, then a 'show'
compositor over the same cut-outs the stage draws — the remote frames are unpacked once and
shared, `UnpackedFrame`), its own audio bus on the engine's context (backing track + own vocal
after FX, held back by the same quarter second through a DelayNode — and this device's own cut-out
through a frame ring, so its picture is in step with its sound — plus every other singer's vocal as
it arrives — through the shared **mix bus** (`audio/mixBus.ts`, below)). In the **Studio** that is
what a take records: one MediaRecorder on a **hand-fed video track** (`video/canvasTrack.ts`: a
`MediaStreamTrackGenerator` that gets every frame the drawing loop draws, as a VideoFrame, where
the browser has it — Chrome, Edge — the canvas capture elsewhere; `canvas.captureStream()` alone
hands out a frame only when the page renders one, and a hidden tab — a window covered by another —
renders nothing, which once left a saved show with one picture and five minutes of song; the film
of the meet and the alpha-packed video the other singers get go down the same kind of track) —
**MP4 first** (`pickShowMime`: H.264 + AAC where the browser has an AAC encoder — Windows, Mac, iOS
— else H.264 + Opus in MP4, WebM only where MP4 is not offered, i.e. Firefox; audio at 192 kbps) so
a saved show plays wherever its Drive link is opened; the Drive file is named *song · meet ·
date.mp4* (`performanceVideoName`), found again by its app property. In a **live meet nothing is
recorded per song**: the live stage plays the song in step with the shared transport and that is
all; the host's device keeps the one mix bus up the whole time it is on stage (`startTalk`: the
talk between songs, the count-in, the song — so what the audience hears never breaks off), and the
**film of the meet** (4c below) reads the show's picture (`takeTrack`) and that bus (`setTap`) for
the whole meet — one file, a chapter mark per song. Every frame the show draws ends with **the
brand's mark** (`video/brandMark.ts`): the app's own small animated loop (`brand/sv-loop-sm.mp4`,
the one the page's corner watermark plays) as a rounded tile in the top-right corner, an eighth of
the picture tall — so a Studio take, the film of a meet and the broadcast all carry it; the loop's
poster stands in until it plays. Because the mark is in the broadcast picture itself, the show view
draws no page watermark while that picture is mirrored on it, and the watch page drops its own
corner logo while the stream plays: **one mark, never two**. The film lands in Drive as the meet
goes and is registered once at the meet's end (`portals/meets/meetFilm.ts`, through the
**background saver** `lib/saveQueue.ts`: shared from the host's Drive anyone-with-the-link and with
each member's Google account, registered with the meet — `POST /meets/:id/performances`, host by
account → the `performances` table, `chapters` on the row; `meet_members` remembers everyone who was
ever in the meet). `GET /performances` lists the film of every meet the account hosted or was in —
the Performances page, with the shareable link, the marks and the in-app player. The PWA never
applies an update while a save is pending.

**Preview** (admin monitoring) lists every open meet the account may publish (hosted or joined,
any other by link / code) as a monitor tile: the exact broadcast picture (`showStage.tsx`, the
same feed and compositor as the show view) in a 16:9 box, status (meet state, LIVE / requested,
performers linked) in the card and never in the frame, with *Show view* and *Publish* at hand.
Every publisher view — the show view, each tile — is its own participant resumed only by its own
token, so monitoring a meet and running its show view at the same time never fight over one video
link; the first four tiles connect by themselves, the rest on request.
4. Performers hear only themselves + the track (Solo foldback) from the count-in to the end of the
   song — and from a resume on; **while the song is paused** (from the cued instant it stops on a
   device until the resume is cued) and between songs, the singers on stage hear each other again
   (talk-back; the live stage bar says *talk-back on until Resume*). **The mix is timed at every
   count-in** (`video/align.ts`): each singer announces their round trip over the mesh's channel,
   each link's latency is read off its statistics (half the round trip time, the jitter buffer's
   recent average, encode and decode), and half a second into the count-in every other singer's voice
   and picture are held back in the browser's own jitter buffer (`jitterBufferTarget`) by what they
   are early by against the track in the mix — the lag plus this singer's round trip — so every voice
   lands on the beat it was sung to; a voice arriving later than the lag allows makes the lag grow
   for that song (never past 1.5 s); a singer linking up mid-song is fitted to the plan as it stands;
   the holds are lifted between songs. **The audience hears the mix**
   (`audio/mixBroadcast.ts` → `/meets/:id/mix` → `audio/mixPlayer.ts`): on the host's device an
   AudioWorklet (`sv-mix-tap`) taps the show recorder's limiter output in 20 ms blocks, a WebCodecs
   `AudioEncoder` (Opus, 48 kHz mono, 64 kbps) encodes them, and one batch a second is POSTed to the
   relay (host by account; each batch tagged with the track position of its first frame — taken
   from the block that frame arrived in, so the tag is the sound's own even when the encoder runs
   behind on a starved device; the service numbers the batches, one past the newest, so a listener
   never waits for a device's restarted count to catch up; a rolling window of 40 batches per meet
   in the `mix` table). An encoder that cannot keep up (a starved device) is never allowed to queue
   sound without end: past two seconds of backlog the broadcaster leaves blocks out — the audience
   hears a skip and stays near, instead of drifting ever further behind (`MixBroadcaster.dropped`
   counts them). The broadcast's AAC encoder is never starved of a block, on purpose: a browser's
   AAC encoder stamps its output by counting samples from the first block, so a block left out
   would move every later sound earlier than its picture for good — the live encoder stamps the
   sound itself the same way (the clock of the first block in, plus the AAC frames out since) and
   only counts how far behind the encoder is (`stats.audioQueue`). The host's device keeps one mix bus from the moment its mic opens on stage
   through the talk, the count-in and every song (the song's recording hooks onto the same bus), so
   the audience's sound never breaks off at a song's start. Audience devices in the room and the public
   watch page poll it every second through the public `/watch/:id/mix` route (cached at the edge for
   a second — a hundred listeners cost the relay one answer), decode with `AudioDecoder` and hand
   the PCM to one AudioWorklet, `sv-mix-out` (`public/worklets/mix-out.js`), which plays it as a
   single continuous stream on the audio clock: a resampler that carries its place across every
   block (the mix is 48 kHz; the device may run at 44.1), so there is never a seam between packets,
   behind a 3 s cushion (room for a batch that comes a poll late, and for the host's main thread holding its breath for a couple of seconds) and silent — never noisy — when it
   runs dry until the cushion is back. It reports how far it has played a few times a second, so the
   track position of what is being heard (`MixPlayer.positionMs`) drives the lyrics. An earlier
   version scheduled fifty `AudioBufferSourceNode`s a second back to back and clicked at every seam
   on a 44.1 kHz device. The host's tap resamples the same way (`audio/resample.ts`,
   `LinearResampler`: stateful, one curve across blocks) when the engine does not run at 48 kHz,
   and the engine asks the browser for 48 kHz in the first place (`ENGINE_RATE`). Needs
   WebCodecs on both ends (Chrome, Edge, Safari 16.4+, Firefox 130+); otherwise — or when no batch
   has arrived for 6 s — the device plays the backing track alone, in sync.
5. **The show to the audience and to YouTube — from the publisher's browser.** The show view
   (`portals/publishing/broadcast.ts`) runs a `PublisherBus` (the track element and every vocal off
   the mesh through the same mix bus; two monitor switches that never touch the broadcast — the
   monitor has a guard and a safety stage of its own), draws the show on a `ShowRecorder` canvas, and `broadcast/liveEncoder.ts` turns it
   into a stream: `VideoEncoder` (H.264 Annex B, `avc1.4d401f`, 3 Mbps, 30 fps backing off to 15
   when the encoder falls behind, a keyframe every second by time (`LIVE_SEGMENT_S`)) and `AudioEncoder` (AAC-LC ADTS,
   48 kHz stereo, 128 kbps — the bus runs at 48 kHz itself, so nothing is resampled on the way,
   and a bus at another rate goes through the same stateful resampler as the host's tap; absent on
   Linux Chrome / Firefox → video only), cut at the keyframes (each segment declared as the whole
   span it covers, its first frame to the next keyframe — a slow machine that skipped frames before
   the keyframe still hands the player a steady second, never a shorter one and a jump)
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
   goes `live` on the first segment and is off air 20 s after the last; *Stop publishing* ends it at
   once and clears the window, and a segment still on its way when the stop lands (its body arriving,
   the relay or YouTube being asked) is refused with `409 not_live` and nothing of it kept — the
   handler reads the job again after every wait, so its stale copy can never be saved as live over
   the stop (the sender takes the 409 as the end it already knows about). The audience plays the
   playlist with hls.js (lazy chunk; Safari natively) in `components/LiveShow.tsx`, on the watch
   page and in the room's audience view — no lyrics there. Beside the encoder, the broadcast films
   itself: `Broadcast.film` is a `MeetRecorder` (`video/meetRecorder.ts`, the same recorder as the
   host's film of the meet, with `busSound(bus)` as its sound instead of the stage mix) on the
   encoder's own canvas, from Go live to Stop — the footage goes into the publisher's Drive as it
   is recorded (`PerformanceStream`, ten-second pieces, a resumable upload), one file with the same
   chapter marks as the host's film, and is listed under the publisher's Performances as
   *Broadcast*; the show view's bar says nothing of it (its state rides on the bar's data
   attributes for support). The bar itself is a few chips — **LIVE** with the time on air (the kbps
   and segment count in its tooltip), YouTube's own word on the stream, the stream check, and
   whatever is wrong — and the **live links** written out in full, each with a Copy button, the
   watch page's among them (`LiveLinks.tsx`). Tests: `SV_FAKE_YOUTUBE_DIR` makes the
   Node service serve a stand-in at `/fake/youtube/http_upload_hls`; the live e2e goes live from
   the show view, ffprobes a segment the fake received, watches the show on both pages, records six
   seconds of the bus and of an audience device's output and measures them (`tools/ci/audio-measure.mjs`),
   and finds the footage under the publisher's Performances.
4b. **The RTMP relay** (`services/relay`, docs/RELAY.md) is the low-latency road: with
   `RELAY_URL` + `RELAY_SECRET` set, the service (`src/relay.ts`) starts one stream per job on the
   relay with the job's RTMP targets (ingest url + key, opened from the sealed store — the only
   place a key is ever in the clear, and it goes service → relay only), hands every segment on
   (`POST /streams/:id/segments`, the raw TS bytes) and stops it with the job. The relay pipes the
   bytes into one `ffmpeg -f mpegts -i pipe:0 -c copy -bsf:a aac_adtstoasc -f flv rtmps://…` per
   show (`-f tee` for several targets, `onfail=ignore` so one platform's refusal never ends the
   others), with back-pressure on stdin and a sweep of streams idle for a minute. YouTube then rides
   RTMP (its *ultra-low latency* setting: 3–5 s behind the stage instead of 15–30 s on HLS
   ingestion, which is skipped when the relay carries YouTube); Facebook, Instagram and Twitch go
   live at all. `live.relay` / `relayNote` on the job say how it goes: a 404 from the relay (it
   restarted, or swept the stream) starts the stream again at once and resends the segment; a relay
   that is down backs off six seconds between attempts; nothing of it ever stops the in-house
   portal. `GET /publishing/destinations` returns `relay: true` so the web knows which destinations
   the browser can feed (`fedDestinations` in the protocol). Tests: the control test drives the
   service against a fake relay (`deps.relay.fetchImpl`), the relay's own test runs the server
   against a stub ffmpeg.
4b′. **YouTube, run by the app** (`lib/youtube.ts`, the YouTube Data API v3 with a token of its own
   carrying `YOUTUBE_SCOPE` alone — asked for by **Connect YouTube**, a button right in the show
   view's bar and under Destinations, in an authorization of its own: Google refuses `drive.file`
   and `youtube` together, so `requestYoutubeToken` asks for `youtube` by itself with
   `include_granted_scopes` off — the library's default would merge the Drive grant back in — and
   keeps the token apart (`sv.youtube.token`; the sign-in's token never carries YouTube, and the
   sign-in never asks for it); a re-issue wants a tap (Go live, Stop), the status poll uses the token
   in hand or waits): Connect (`portals/publishing/destinations.ts`,
   `connectYoutubeDestination`) finds the channel's reusable HLS `liveStream` or makes one
   (`ensureHlsStream`) and hands its key to the service like a pasted one
   (`PUT /publishing/destinations/youtube` with `auto: true`); **Go live** finds that very stream
   again (by the key's last characters, `keyHint` — a channel may hold a Studio-made HLS stream
   too, and a broadcast bound to the wrong one goes live on that stream's own broadcast, private
   as Studio makes them; a key that changed on YouTube's side is saved again), makes a
   `liveBroadcast` in the show's name — **unlisted** by default (anyone with the link can watch;
   the channel's page does not list it) or **public**, chosen in a select beside the destination
   chips, never private: the visibility is read back after the insert and put right if YouTube did
   not take it (`setBroadcastPrivacy`) — `enableAutoStart`/`AutoStop`, low latency, binds it to
   the stream (`startBroadcast`) and puts its page on the job (`PublishJob.links.youtube`,
   `PublishJob.youtube` — `POST /publishing/jobs` takes both; the live links prefer a job's own to
   the destination's standing link); should the broadcast fail to be made, YouTube is left out of
   that show and the bar says why (never a silent fall-back to the pasted key, whose visibility
   nobody chose). While the job runs the show view reads the broadcast's `lifeCycleStatus` and
   `privacyStatus` and the stream's `streamStatus` / `healthStatus` every 15 s (`youtubeStatus` →
   `youtubeWord`: *receiving · going live…*, *live · unlisted (anyone with the link) · stream good*,
   *not receiving the stream yet*; a video YouTube reports **private** is said first, with a
   *Make it unlisted* button); **Stop** transitions the broadcast to `complete` (`endBroadcast`; a
   broadcast that never went live is left as it is) and the YouTube link stays on the bar — the
   video is there. A Publish from the portal's Publish tab opens the show view with `go=1` and it
   goes live by itself: one tap. YouTube's refusals come back in the publisher's words
   (`youtubeReason`: live streaming not enabled on the channel, the API not enabled in the Cloud
   project, the daily quota, a missing permission). A pasted YouTube link of any shape — a Studio
   dashboard link above all, which viewers cannot open — becomes the page viewers open
   (`youtubeWatchUrl`). Tests: `apps/web/test/youtube.test.ts` on a fake API.
4c. **The film of the meet** (`video/meetRecorder.ts`): on the host's device, from the host on
   stage with the mic open until the meet is over — **never stopped by the song's transport**: a
   singer's Start, Pause, Stop, Restart or seek changes nothing about the film running — on the
   room's ShowRecorder canvas (drawn for the whole meet — `keepDrawing`; the show's size and rate — 1080p30 on a
   computer, 720p24 on a phone — where the browser has hardware H.264 in MP4 — Windows, Mac, iOS, Android — and a 960×540, 15 fps copy
   of it where it only encodes WebM in software, so the stage itself never slows down) with a tap
   (`setTap`) on the mix bus the host's device keeps up the whole time it is on stage (the talk
   between songs, the count-in, the song: one bus, `startTalk`). **The film is ONE file** — one
   MediaRecorder for the whole meet, one `PerformanceStream` (the Drive provider's
   `beginPerformanceStream`: one resumable upload session fed in order, pieces in 256 KiB multiples
   as 4 MiB fill, the last with the total; the session and the confirmed offset are remembered in
   localStorage, and a film whose tab died is completed by the next start — `finishDanglingFilms`:
   Drive is asked what it holds, the file is closed there, the marks up to then on it). What the
   stage did is written on the file as **chapter marks** (`video/chapters.ts`, read off the meet's
   shared transport every poll): a mark when a song starts — at its kickstart instant, not when the
   poll that announced it landed, so the mark is where the song begins — and again for every
   restart, seek and resume (each a new epoch: *Ammo*, *Ammo (from 1:12)* where a jump or a resume
   picked it up, `songMs`), one for every pause (*Paused — Ammo*, cut at the cued instant), one for
   the stage between songs (*On stage*). The marks ride on the manifest as it grows
   (`PerformanceManifest.chapters`: the index, the kind, the song, the instant, the offset from
   the film's start; `PerformanceStream.update` rewrites the Drive file's description every time
   one is added, so even a film that is never closed carries its marks). When the meet ends the film
   is registered once with the meet (`POST /meets/:id/performances`, `chapters` on the row,
   `portals/meets/meetFilm.ts`), shared anyone-with-the-link and with every member's Google
   account, and listed under Performances for everyone who was in the meet: one row, the marks on a
   line (*▪ On stage 0:00 · ♪ Ammo 3:18 · ⏸ Paused — Ammo 7:40 · …*), **Watch** (the file streamed
   from Drive) and **Chapters** (the in-app player with a button per mark that seeks to it). Nothing
   is saved per song on any singer's device: the live stage plays the song and talks to the
   transport, and the film is the record of every song.
4d. **Orientation.** The screen mirrors the singer's own camera (a selfie, as a mirror does); the
   `ShowRecorder` draws everyone **unmirrored** (`mirror: false` on every performer it is handed),
   so a Studio take, the film of the meet and the broadcast show the singers as the camera saw them
   — a name on a shirt reads the right way round. Test: `apps/web/test/showMirror.test.ts`, and the
   live e2e checks a frame of the film (two badges the fake person wears).
5. Inactivity (no join/heartbeat/chat/slot/start for 5 minutes) expires the meet.

## A hundred in a meet — what each one costs

A meet is light by construction, and light in a different way for each kind of participant:

- **A singer on stage** (up to ten) carries the heavy part on their own device: their cut-out,
  their vocal chain, the mesh links to the other singers and the publisher (video only, capped
  and scaled with the mesh size), and their own stage. Nothing of that grows with the audience.
- **The publisher** (one device) receives the ten and makes the one picture and the one mix
  everyone else gets. Nothing of that grows with the audience either.
- **The audience** (any number) receives no video and no mesh: the stage with placeholders, the
  chat, the song of the stage, the show as HLS when the publisher is on air, and the stage mix a second at
  a time. All of that is read-only, carries no sign-in and is the same for everyone — so the Worker
  answers it from **the edge cache** (`services/control/src/worker.ts`, `EDGE_CACHE`): a show
  segment (immutable) for two minutes, the playlist, the live status, the mix batches and the
  public meet page for a second or two. A hundred viewers in a city cost the single Durable Object
  one request per segment, not a hundred — the DO's own load stays what ten singers and a
  publisher make of it (their polls, every 3–8 s with the push stream open, are per user and
  small). Every participant also holds one event stream open to the DO (a few bytes per change,
  a ping every 25 s, re-made every 20 minutes): a hundred idle connections cost the object next
  to nothing, and a change is told to all of them in one loop. The public watch
  routes answer every origin (`*`), which is what makes one cached answer serve everyone.
- **What every participant's poll carries is independent of the crowd**: a snapshot names the
  stage, the host, the publishers, the wait list and the first dozen of the audience
  (`visibleParticipants`), the rest is `meet.audienceCount` — so a heartbeat answer is a few
  kilobytes whether three or three hundred are in the room; a heartbeat writes the participant's
  row and rewrites the meet row only when something changed (a performer's clock) or the idle-expiry
  extension is due (`TOUCH_COALESCE_MS`, 2 s), not for every heartbeat of every listener.
- **An audience phone draws nothing it does not have to**: the stage compositor redraws a still
  stage (placeholders — no video reaches the audience) twice a second instead of 24 times.

## Components

| Component | Where | Runs on |
| --- | --- | --- |
| PWA client | `apps/web` | iOS Safari (installable), Android Chrome (installable), desktop browsers |
| Shared protocol | `packages/protocol` | client + services |
| sv-control (SVT DB) | `services/control` | Hono on Node 22 (node:sqlite) or Cloudflare Workers (one SQLite-backed Durable Object): users (admin flag, plan via `subscriptions`), catalog, meets, chat, recordings, publishing destinations/jobs, Stripe billing; Google access-token auth |
| sv-relay | `services/relay` | Node 22 + ffmpeg in one container (Fly.io scale-to-zero, or any Docker host): takes the browser's segments from sv-control and speaks RTMP(S) to YouTube (ultra-low latency), Facebook, Instagram, Twitch — `-c copy`, no transcoding (docs/RELAY.md) |

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
- **The voice leaves the engine through one node** (`AudioEngine.voice`): the FX chain's output (through
  the take recorder, which passes it on) feeds it, and the mesh (`vocalStream`), the stage mix
  (`ShowRecorder.buildAudio`) and the monitor all take it from there. The engine watches it beside
  the leveller, ten times a second: the raw microphone sung into (a peak over −34 dBFS) while the
  voice stays under −80 dBFS, three seconds running, is a processed voice gone silent (a browser's
  audio worklet gone wrong — a host once reached nobody's mix for a whole meet while her microphone
  worked), and the raw microphone (through the trim) is switched into `voice` instead; the mic line
  says *voice effects off — your voice goes out plain* (`voiceFallback`), and the next opening of the
  mic tries the effects again. The mix bus meters every source (`MixBus.levels`: the track after
  normalisation and offset, each voice after its rider) and the stage strip and the live stage show
  the **mix line** once a second — *mix: you −18 dB · Team −22 dB · track −20 dB* — so a voice that
  does not reach the mix is seen on the spot, never found in a file afterwards.
- **Each vocal has a rider** (the `sv-leveler` worklet): a two-second RMS view of what is *sung*
  (a 50 ms gate at −45 dBFS stops it the moment the singer stops and keeps the pause out of the
  average), steered toward **−17 dBFS** at 1 dB/s up, 2 dB/s down, three times faster until within
  6 dB — a singer's offset, not their phrasing; +18 dB lift at most, −12 dB cut. **It knows the
  microphone's floor**: the quietest 50 ms of the last eight seconds (two buckets' minimum — a
  phrase's own breath dips keep it under the voice, a louder floor is followed within a bucket, the
  first 200 ms are the view filling up and never a floor). Only sound standing **8 dB above the
  floor** counts as a voice — a steady hiss (a laptop's fan, a built-in mic's floor at −40 dBFS, well
  above the gate) never opens the rider and is never riden up — and the lift is capped so the
  **floor stays 12 dB under the target**: a noisy microphone gets a quieter voice rather than a loud
  hiss between the phrases. Without this a film of a meet once carried a dead-quiet mic's floor at
  −22 dBFS (its −40 raised by the full +18) and the guard then held the whole mix — the track, the
  voices — under it. `tools/ci/rider-lab.mjs` measures all of it on the real worklet.
- **Track volume / Vocal volume** (±30 dB, 3 dB steps, kept per device) are offsets on top of that
  balance: 0 / 0 is already right.
- **The guard** (another `sv-leveler`, on the sum) only ever turns *down*, toward a −15 dBFS
  average (about −13 LUFS for a bright mix): push both controls to +30 and the mix comes back to the
  target in a few seconds instead of living in the limiter.
- **The safety stage** (`audio/dynamics.ts`): a limiter at **−2 dBFS** (the `sv-dynamics`
  worklet, 2 ms lookahead over a sliding-max detector, 0.3 ms attack, a wall of a ratio) and a tanh
  soft clipper straight up to −1.4 dB behind it. Nothing above full scale reaches an encoder — an
  AAC encoder overshoots a dense mix by about a dB, which the ceiling leaves room for; a clipped
  encoder is what crackles.
- **In time**: a singer's own vocal lands in the graph a round trip behind the track they sang to
  (the track out to their ears, their voice in through the microphone, the chain) — `engine.roundTripMs`
  — so the recording holds the track back by that much (on top of the lag) and a Studio take carries it
  as `latencyCompMs`. The chain's part is known (its stages' lookaheads, and the pitch stage's hold while
  it works, which the worklet reports: `chainLatencyMs`). The device's part — speakers out, microphone in
  — is where recordings used to land late: the browser's figures (`outputLatency`, the track's `latency`)
  miss what Bluetooth adds (100–250 ms) and much of what phones add, so the voice sat behind the beat in
  every saved performance. It is now **measured** (`audio/sync.ts`): the **sync check** (Settings → Audio)
  sends four clicks out of the speakers and times them in the microphone's recording — the round trip
  itself — and after every Studio take the recorded voice is laid against the track at the alignment
  the figures gave and the two are cross-correlated by their envelopes (what the microphone heard of the
  track through the speakers, and the singer's phrasing, sung to the beat they heard): a clear lag corrects
  the take and, when strong, is remembered for the device and microphone (`sv.audio.rtt`,
  `AudioEngine.measuredDeviceMs`), and every later take and live mix on the device uses it (`deviceLatencyMs`
  prefers the measurement to the browser's figures). The review says which figure aligned the take and
  keeps the nudge.

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

The EQ has five bands: a 120 Hz shelf, **body** (a 300 Hz peak — cut it and a close, boxy mic
clears up), a 1.2 kHz peak, **presence** (a peak the singer places anywhere from 2 to 5 kHz — the
band that cuts through a track) and an 8 kHz **air** shelf. The Studio preset (the default) is cut
at 300 Hz, +3.5 dB of presence at 3.4 kHz, +3 dB of air and a third of the exciter: a sharp,
finished vocal. Every control of the chain is live on the stage itself — **Tweak**, next to the
preset chips, opens the full panel (presets, gain, tune, EQ, compressor, punch, de-esser, air, rider,
saturation, chorus, delay, reverb) over the stage while you sing; a tweak makes the preset "custom",
and a factory preset chosen by name always means its current values.

The microphone is opened **raw** — no browser echo cancellation, noise suppression or automatic
gain (all three chop and thin a singing voice; AGC pumps, AEC ducks the voice whenever it
correlates with the music) — mono, at the device's own rate. Echo cancellation is on only when the
singer says *I'm on speakers* (the track would otherwise leak into the mic) — and, in a live meet,
while talk-back plays (between songs, during a pause: the other singers' voices out of this device's
speakers would otherwise come back through its mic to everyone, late, and loop between two phones on
speakers): `AudioEngine.setTalkback` asks the live track for it (`applyConstraints` — Firefox
changes the track in place; Chrome and Safari answer and change nothing, so there the mic is
captured again with the setting and swapped in under the chain — the new source connected, then the
old let go, the leveller's analyser moved with it — never on iOS, where a second capture ends the
camera: there it waits for the next opening of the mic) and turns it off again for the song. `AudioEngine.inputInfo`
reports the device, its sample rate and channels; a rate under 32 kHz is a phone-call line (a
Bluetooth headset's HFP mic) and the `MicStatus` component says so and offers another mic. The
**instrument** is a second capture beside the microphone (`openInstrument`: a guitar, keys, a
violin on a USB audio interface — *Instrument* ticked, the input picked, a level in 3 dB steps, on
the mic status and in Settings; opened with the mic by `video/capture.ts`), a line input (no AEC,
no NS, no AGC, the stereo pair folded to mono) summed into the singer's sound where the take
recorder listens — after the vocal chain, before `voice` — so it reaches the take, the other singers,
the stage mix, the film and the broadcast, and never the vocal effects or the leveller; unplugged,
the track's `ended` closes it and the mic status says so; not on iOS (one capture per page). The
**leveller** (`startLeveller`) replaces AGC: the raw peaks are watched 10× a second; quiet
*singing* (a raw peak above −34 dBFS, gained below −18 dBFS, for three readings) lifts the trim 1 dB
at a time up to +12 dB — room noise between phrases never does, which is what used to drive the gain
to the ceiling and the noise floor with it; past −6 dBFS it drops 2 dB at once (floor −6 dB) — slow
up, fast down, no pumping, never clipped. Then: trim → **noise gate** (`sv-gate`: a downward expander —
the room's level is tracked as the quietest the input has lately been, the threshold sits 8 dB above
it, and under it the gain falls 3 dB per dB down to −18 dB, soft-kneed; opens in 3 ms, holds 120 ms,
closes over 180 ms — so the hiss of a phone's microphone, a fan, the street, which the compressor's
makeup, the exciter, the air shelf and the rider used to lift into a steady hiss between phrases, is
turned down while nobody sings and is out of the way the moment somebody does; *Noise gate* in the
panel, on by default) → pitch worklet (the pitch-synchronous shifter and the NSDF auto-tune, below) →
HPF → low shelf 120 Hz / peak 1.2 kHz / **presence peak 3.2 kHz** / high shelf 6.5 kHz
→ compressor → **parallel compression** (a crushed copy, 10:1 from −36 dB with +16 dB of its own
makeup, blended under the dry vocal: soft phrases up, transients kept — punch without
over-compression; the dry side is delayed to meet it) → **de-esser** (Linkwitz-Riley split where
the sibilance starts — 4–9 kHz, 6 kHz by default so the presence region stays whole — the top band
through its own 0.5 ms compressor set to catch only the spikes, never the air; the low band and the
bypass wait for it) →
**exciter** (harmonics made from the voice above 3 kHz, blended in — air, not a treble boost; the
dry side waits for the oversampled shaper) → saturation (same) → chorus/doubler → ping-pong delay →
convolution reverb → **vocal rider** (an RMS meter every 50 ms; below −50 dBFS it holds, otherwise
it steers toward −20 dBFS: up to +12 dB lift, −6 dB cut, a few dB a second at most — every phrase up
front) → **safety** (limiter at −3 dBFS + soft clip: the voice never clips on its way to the mesh or
the recorder, whatever the preset and the singer do) → out. Every dynamics stage is our own
`sv-dynamics` worklet (see the mix bus above for why), every parallel path is delay-matched — the
audio lab checks the chain's impulse response has one arrival and no echo — and the whole chain is
**10 ms** (the limiter's 2 ms lookahead and three oversampled shapers; 32 ms on the native fallback);
the pitch stage alone holds the voice while it works — 3–25 ms, about 14 on average, said to the
page every quarter second. **The pitch stage** (`worklets/pitch-shifter.js`) is a
pitch-synchronous delay-line shifter, the time-domain idea behind PSOLA: one read head on a ring
buffer, reading `ratio` times as fast as the voice is written, its delay drifting; when the delay
leaves its range the head is spliced back into it — a crossfade one pitch period long to a place a
whole number of periods away, the same wave for a sung note, so the splice is inaudible, and a few
milliseconds over a few milliseconds where there is no period (a consonant, a breath). Between
splices a single head reads the voice: no comb filter, no hollow "down a well" colour, no flutter —
the coloration of the two-grain shifter it replaces, whose grains sat 23 ms apart in time and
cancelled and reinforced each other's harmonics all the while (the audio lab now reads the ripple on
a steady shifted tone: under a decibel). The auto-tune keeps the note (the nearest semitone) while
the voice stays within 70 cents of it — a vibrato or a slide around the halfway point never flips the
note back and forth — glides the correction (`autoSpeed`; the vibrato, faster than the glide, comes
through and only the centre of the note moves), stays wet while it is on (never a flicker between the
dry voice and the shifted one at a correction of a cent), and keeps its correction through a 300 ms
unvoiced gap (a consonant, a breath) instead of falling back to the untuned pitch on every "t". The
chain runs live on the captured voice: what is recorded, sent to the publisher and
the other singers' recordings, and heard in the monitor is the processed vocal. Parameters and
presets live in `packages/protocol/src/audio.ts` and round-trip with the plugin's `APVTS` layout;
**Studio** is the default for a new singer (HPF 95 Hz, the body cut 2 dB, presence +3.5 dB at
3.4 kHz, air +2.5 dB, 3:1 compression, parallel 0.25, de-ess 0.45, exciter 0.3, rider 0.6, and a
short, low plate behind the voice — 1.3 s, 10 % mix, 30 ms pre-delay — so the voice sits in front
of the room rather than in it); Natural Tune (the same with a gentle, slow correction: 0.6, speed
0.25), Punch, Up Front, Radio-Ready and Vibrant are the other finished-vocal presets. A singer's preset
choice is kept on their device (`audio_plugin_settings`, localStorage, mirrored to
`SingersVoice/Config/` in Drive) until they change it.

## Data formats

- `track.json` — `singersvoice.track.v2` (imports `singersvoice.trackmaker.v1` and LRC).
- `manifest.json` — `singersvoice.performance.v2` with timeline offsets, FX used, file hashes.
- `audio_plugin_settings.json`, `app_settings.json` — `SingersVoice/Config/`.
