# Live Meets — reliability, capacity and what was verified

The meet of 21 November 2026 (seven singers, about two hours, on the GitHub Pages build of 10 November) broke in
four ways that looked unrelated on screen and were not: **"Exceeded allowed rows written in Durable Objects free
tier"** on every device at the end; **"Cannot reach the SingersVoice service — check your connection"** on the
iPads; **"Failed to create WebGL canvas context when passing video frame"** as a modal on a singer's computer;
and a stage on which the pictures of most singers were missing or frozen ("1/6 video linked", "Srividya's picture
is not moving"), the countdown jumped (8, 7, 6, 5, 3, 2, 4, 3, 2, 1), and voices were missing now and then.

This page is the audit of that, what was changed, how it was tested, and what is still not verified. It is written
for the operator; the mechanics are in the files it names.

## 1 · Root-cause map

| Symptom | Root cause | Fix |
| --- | --- | --- |
| "Exceeded allowed rows written" everywhere, two hours in | Cloudflare's free plan allows a SQLite-backed Durable Object **100,000 rows written a day** (an index entry counts as a row). The service wrote rows for things that are not state: every heartbeat of every device rewrote its participant row and, behind it, the meet row (7 singers × every 3 s); the audience mix inserted a row and deleted one **every second**; a broadcast wrote three rows every two seconds (a segment, its window's trim, the job's counters); the video-seconds clock wrote per tick. Seven singers for two hours is well past 100,000 | A running meet lives **in memory** on the service (`services/control/src/store/live.ts`); a row is written only when the durable projection changed — a slot, a song, the transport, a stop, a join, a leave — and the idle expiry reaches the row once a minute. A minute of seven singers heart-beating, sixty mix batches and thirty signals writes **0 rows** (`services/control/test/budget.test.ts`). A whole three-singer meet of the load test — join, links, an outage, a tab lost, End — writes **about 20 rows** |
| "Cannot reach the SingersVoice service" while the service was up | Once the budget was spent the schema migration promise stayed rejected for good, every request threw, and Cloudflare's error page went out **without CORS headers** — the browser cannot read such an answer and reports it as a network failure | The CORS layer runs before anything that can fail; a spent budget is an honest **503 `storage_limit`** with `Retry-After` (reads still answer); the migration is retried later instead of poisoning every request; `/health` reports the rows read and written and whether writes fail. The app tells the three cases apart — no answer at all, a failure the service answered with, the storage spent — and says which (`apps/web/src/lib/api.ts`, the room's notices) |
| A modal "Failed to create WebGL canvas context…" once per frame | A browser allows a page about sixteen live WebGL contexts and kills the oldest beyond that. The stage held one context **per other singer** (the alpha unpacker) plus the cut-out model's own: a crowded stage lost one, and MediaPipe's runtime answers a lost context with `alert()` | Every unpacker draws through **one shared context** (`apps/web/src/video/alphaPack.ts`), lost and restored as one (the soft fallback meanwhile); the model loads only when a context can be had, its `alert` is taken away before it loads, the silhouette stands in, the model is retried every half minute, and the notices say so (`apps/web/src/video/segmenter.ts`) |
| Pictures missing on the stage ("1/6 video linked") | The sender's pipeline, not the link: a cut-out model that died with its context sends no packed frames; the host's device saw a connected link with nothing on it | The same fix; and the links now **report what actually arrives** (sound, frames), never a connection alone — `peers.ts` `links()`, the room's "Links · 6/6 up · sound from 6 · pictures from 5" line |
| "Srividya's picture is not moving" | Two different things looked the same: frames still arriving with nothing moving (her camera froze on her device) and frames that **stopped arriving on a link that said it was connected** (a stalled decoder or transport) | Told apart: the first is said with a Reconnect button (her device restarts its own camera once by itself); the second is **re-made from here by itself**, once a minute at most (`roomStage.ts`) |
| The countdown 8, 7, 6, 5, 3, 2, 4, 3, 2, 1 | Three sources of a count: the audio clock (which a suspended context makes jump), a main thread that stalled and caught up, and a second device asking for the top of the song **during** the count-in (restart/resume moved the kickstart 3 s ahead for everyone) | One authoritative deadline: the service's kickstart read against **server time** on every device, shown **never larger than the last number** within a cue; a restart or resume asked during a count-in answers with the deadline that stands; a device that merely took its time getting ready never restarts the song (`services/control/src/meets.ts`, `MeetRoom.tsx`) |
| A stage covered in status chips | Every fact was its own chip | One **notice control**: a bell with the count and the one worst line, a popup with every notice, its severity, what to do about it, and a dismiss for the diagnostic ones (`components/NoticeCenter.tsx`, `lib/notices.ts`, `portals/meets/stageNotices.ts`) |
| Voices missing now and then, crackling, worse with more singers | Three causes, in order of evidence: (1) **CPU starvation** — the modal alert per frame and the dead model above pinned the main thread, and a starved audio thread crackles on its way out, so the crackle was baked into the vocal everyone received; (2) a pair of devices that **never link** (a network that allows no direct connection: cellular, a hotel, an office) — those two never hear each other between songs and the film lacks that voice; (3) the **mesh's cost** grows with the number of singers (§6) | (1) fixed above; (2) **TURN** through Cloudflare's relay, minted on the service (§5) and the link's path shown ("by relay"); a link that carries nothing though the other side says its mic is open is **re-made by itself** and said so; sound goes out **first** on every link (`networkPriority: high` on the vocal, `low` on the picture); (3) the publisher's and the host's links take only the picture their show draws (§6), and the ceiling is stated with the measurements below |

## 2 · The architecture, as it is

- **The app** (`apps/web`, a PWA on GitHub Pages or Cloudflare Pages): everything a singer sees, the audio chain,
  the camera cut-out, the stage, the recorder.
- **The service** (`services/control`, one Cloudflare Durable Object with SQLite, or the same code on Node): sign-in,
  the meets and who is in them, the WebRTC signalling relay, the audience mix fan-out, a broadcast's HLS window, the
  catalog, plans, billing, social posting. One object serves every meet; every device holds one event stream (SSE)
  to it and heart-beats every 30 s with the stream open (every 2–5 s without it).
- **The mesh** (`apps/web/src/video/peers.ts`): every singer on stage links to every other singer **directly**
  (WebRTC, a full mesh of up to ten) and to each publisher view. A link carries the singer's vocal (Opus 96 kbps,
  always) and their alpha-packed picture (scaled to what the other side draws). The service only relays the
  signalling; no media passes through it.
- **The relay** (`services/relay`, Fly.io): RTMP to YouTube/Facebook/Instagram/Twitch from a broadcast's segments,
  and YouTube song fetches. Idle streams end themselves after 60 s.

## 3 · The life of a meet — states, supervision, cleanup

A meet is `lobby → countdown → live → (lobby…) → ended | expired`; a participant is `joined → (on a slot) → left |
timed out`; a broadcast is `requested → starting → live → stopped | failed`. What watches each:

- **Presence**: a device is "heard from" by its heartbeat or its open stream; one silent for 60 s is taken off the
  stage by `reconcile` (every heartbeat of anyone runs it; the sweep runs it for an empty room).
- **A device going** (the tab closed, the page reloaded): the room sends `POST /meets/:id/away?rt=…` on `pagehide`
  with `navigator.sendBeacon` — no headers, finished by the browser after the page is gone. The service gives it
  **10 s** to be heard from again (a reload is back on its slot within that); otherwise the slot is cleared then
  and every room told — not a minute later. Measured: **11 s** from the close to every other device (load test).
- **Idle expiry**: 5 minutes without activity closes the meet (the row says so for good; the live layer forgets
  it; the streams get the last word and close; its broadcasts end; its signals go).
- **A broadcast never outlives its meet**: ending the meet (End, expiry) ends its jobs as the publisher's Stop
  would — the state, the note, the segment window, the relay's streams — from one function, idempotent
  (`endJob`). The sweep (every 30 s on Node, every 5 minutes on Cloudflare by cron) ends a broadcast whose show
  view sent nothing for two minutes, or never began within ten (`sweepJobs`), so nothing stays "live" for ever
  and the memory window of a vanished show is freed.
- **A service restart mid-meet** (a redeploy, a crash, an eviction between songs): the meet is read back from its
  rows and found open (the stored expiry gets the flush's grace); everyone in it has the usual minute to be heard
  from; the mesh never notices, because no media goes through the service. Measured: with the service killed for
  **20 s** every room says so within **5 s** and keeps running on its links (sound still arriving); the moment it
  is back every device reconnects within a second, nobody loses a slot, the links were never touched.
- **Idempotent ends**: End meet twice, Stop a broadcast twice, a sweep over an ended job — each changes nothing
  (`services/control/test/lifecycle.test.ts`).
- **In the browser**: the mesh, the camera, the audio engine, the recorder, the timers and the stream are owned by
  the room and closed when it unmounts (Leave, another meet, sign-out) or when the meet is over; the stage's notices
  are cleared with it.
- **Watched from outside the room**: every device sends what its links carry with its heartbeat (numbers only, kept
  in memory — never a row); the host's slot cards say when a singer's device is short of links or of sound, and
  **Admin → Live now** (`GET /admin/live`, the super admin's) lists every open meet, everyone in it, each device's
  report, the broadcasts on the air and the storage counters, refreshed every ten seconds — the operator's view of a
  meet in trouble without being in the room.

## 4 · The write budget (Durable Objects)

What the free plan allows: 100,000 rows written and 5 million rows read a day per account (an index entry is a
row). What the service writes now, per event: a join or a leave 1–2 rows, a slot change 1, a song or a transport
change 1, the idle expiry once a minute per open meet, video seconds once a minute per singer; heartbeats, clock
reports, WebRTC signals, mix batches and broadcast segments **0**. `/health` shows `storage.rowsWritten`,
`rowsRead`, `writes: ok|failing` and the live layer's sizes. A day's budget spent is a 503 the app explains
("The service cannot save anything more today; it starts over at 00:00 UTC"), and nothing already saved is lost.

Is the Durable Object the right place? Yes, at this size: one object serves every meet with the whole running state
in memory, which is exactly what a few meets of ten need; the rows are the recovery, not the hot path. The paid
Workers plan ($5/month) raises the limit to 50 million rows written a month and is the right setting for a public
service — but it was not the fix: with the old write pattern a few more meets would have spent that too.

## 5 · Connectivity and errors

- `lib/api.ts` tells failures apart and names them: **offline** (no answer at all — a deadline of 20 s on every
  request, 120 s on an upload), **failing** (a 5xx the service answered with, in its words), **storage_limit**
  (the budget spent, until when). The heartbeat backs off with jitter (2 s doubling to 30 s), the event stream is
  watched for silence (70 s) and re-opened, a join is retried while the trouble is the link's.
- The Worker always answers with CORS headers, including every error; the free-plan error is never a bare page.
- **TURN** (`docs/DEPLOY_CONTROL.md`): with `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` on the service it mints
  Cloudflare TURN credentials (six hours, renewed two hours before the end, the API token never leaves the service)
  and hands them to every performer with `/ice`; a mint that fails leaves STUN alone and refuses nothing. The
  mesh re-fetches the servers before a new link when the last set is 45 minutes old. **Not yet on the deployed
  service: the keys are the operator's to create (five minutes).**

## 6 · Capacity — what the mesh costs, measured

Every singer's device encodes its picture **once per link** and sends its vocal once per link: with N singers on
stage that is N−1 encoders and N−1 uplinks per device, plus one more of each per publisher view (the show, a
Preview tile). The decoding side is N−1 decoders and unpackers. The cut-out model runs once per device whatever N.

What each link now carries: a singer's link, the picture at 320 px wide (213 on a stage of more than six), 15 fps,
300–400 kbps; the vocal 96 kbps. A publisher's link used to carry the whole frame (720×960, 24 fps, 4.5 Mbps)
whatever the stage drew; it now carries **the width the show draws a slot at** (`stage.ts wantedSingerWidth`): on a
1080p show a stage of seven draws each singer 258 px wide, so the link carries 336 px at 1.5 Mbps (the floor,
so the encoder never trades resolution for bitrate) instead of 720 px at 4.5 Mbps; a stage of four gets 576 px at
2.9 Mbps; one or two singers the whole frame as before. The host's device filming the meet asks for the same. A
singer's uplink on a stage of seven with a show view and the host filming: 5 × 0.4 + 0.4 + 1.5 ≈ **3.9 Mbps** (it
was ≈ 7 Mbps), seven small encoders instead of six small and one large. The vocal is marked high priority on the
way out, the picture low.

Measured in the load test (`tools/ci/load-e2e.mjs`, headless Chromium with a synthetic camera and voice, the real
cut-out model, on a **2-core** test machine — the numbers are that machine's, phones differ):

| Singers | Links up | Sound and a picture on every link | Per-device uplink | Browser CPU | Rows written |
| --- | --- | --- | --- | --- | --- |
| 3 | all 6 in 4–5 s | yes, on every link | 55–67 kbps (small synthetic pictures) | 0.69 CPU-s per device-second — both cores saturated already by three pages | 2–3 in 30 s; ~20 for the whole meet |
| 7 | the seventh singer seated after 74 s; not all 42 links up after 143 s | no: four of seven devices sent nothing yet, two links marked silent/blind, one link `limited: bandwidth` | 0–39 kbps | the two cores saturated the whole time | 18 in 30 s, 141 since the start — seats timing out and re-taken under the starvation |

The 2-core machine cannot run seven cut-out models and 42 encoders, and the seven-singer run is what a short
device does under a mesh of seven: links take minutes to come up, media stalls, the signal queue fills (600
signals in flight — it holds 3,000 now and ages them at two minutes), presence times out and seats churn. A
phone is in the same position with seven on stage: this is the ceiling of a full mesh, and no setting raises
it. The notices now say when a device is straining ("This device is straining — your picture goes out smaller
for now") and what to do (Settings → Camera → "My camera as it is", which skips the cut-out model).

**The right architecture for seven to ten singers with video is an SFU** (each device sends once, a server
forwards): Cloudflare Realtime SFU (the account is on Cloudflare already; 1 TB a month free egress; an app id and
secret kept on the service, the sessions and tracks brokered by `sv-control`). That is a multi-day change to the
media layer (`peers.ts`, `align.ts`'s round trips over the service instead of the data channel, the unpacker per
track) and it cannot be verified in CI without the hosted SFU, so it was **not** started in this pass: it is the
next project, and the measurements above are its justification. Until then: audio for ten is fine (ten Opus
encoders cost nothing); video for up to four or five phones is fine; a stage of seven on phones should expect
small pictures and should keep the cut-out off on the weakest devices.

## 7 · Audio — the path and what is verified

Microphone → the VoxForge chain (an AudioWorklet, 48 kHz, `latencyHint: interactive`) → the vocal stream → one
Opus sender per link (96 kbps, DTX off, high priority) → the other device's jitter buffer (held back by the timing
plan during a song, lifted between songs) → the ShowRecorder bus (the mix for the film, the audience and the
broadcast; played to the speakers only between songs and while paused — Solo foldback during a song, talk-back
otherwise). The host's device alone encodes the audience mix (WebCodecs/Opus, a second at a time) and only while
somebody listens.

Verified by machine: in the live e2e (`tools/ci/live-duet.mjs`) a listener's speakers, the publisher's bus and the
broadcast are recorded and measured — the voice and the song are both there, in time; in the load test every link
of every device reports sound arriving from the links' own RTP counters, not from the connection state.

What the links watch now, every two seconds, per link: bytes of sound and frames of picture that actually
arrived; the path (direct or by relay); the round trip; the loss among audio packets; our own encoder's
limitation (cpu, bandwidth). A link from a singer whose mic is open with no sound for 12 s is **re-made by itself**
(once a minute at most) and the room says "No sound arrives from X — re-linking"; the same for a camera that is on
with no frames. "No link to X" after 20 s names the pair that cannot connect, with Retry.

**Not verified here**: crackling and distortion on real phones. The sandbox has no phones; the causes addressed
are the ones with evidence (CPU starvation from the WebGL fault, the encoder load of the mesh, unlinked pairs). Two
candidates remain if crackle persists after this build: a 44.1 kHz USB microphone on an iPad under a 48 kHz
AudioContext (the "Synido voice 100 · 44 kHz" line in the screenshot — WebKit resamples, and resampling under load
can glitch), and `latencyHint: interactive` on a loaded phone (bigger buffers crackle less, hear-myself arrives
later). Both are a one-line change each, best tried with the device in hand.

## 8 · Video, WebGL and the stage picture

- One WebGL context for every picture on the page (the unpackers share it; lost and restored as one; the soft
  fallback meanwhile).
- The cut-out model never shows an alert: no context → the silhouette, a notice, a retry every half minute.
- A singer's own camera: frozen, muted or ended is detected on their device and restarted once by itself, then by
  a tap; "sit back / come closer" from the stage frame.
- Another singer's picture: frames arriving but still (their camera) is said with Reconnect; frames stopped on a
  connected link is re-made from here by itself; no frames at all though their camera is on (the link's own
  counters) is re-made by itself and said so.
- A publisher's link under strain gives up resolution and frame rate by turns (`degradationPreference:
  balanced`) rather than freezing; a singer's link keeps its frame rate.

## 9 · The countdown

One deadline — the service's `kickstartEpochMs` — read on every device against server time (the clock is synced
against the service on join and again whenever the last sync is a minute old). The number shown is `ceil((kickstart − serverNow) / 1000)`, clamped so it
**never grows** within a cue (a stalled main thread catches up, never counts twice); the audio clock schedules
the sound and no longer drives the display. A restart or resume asked while the count-in runs **changes
nothing** (the song has not started; the one deadline stands) — the 8, 7, 6, 5, 3, 2, 4, 3, 2, 1 was a second
device's "restart" moving the kickstart three seconds ahead. A device that took its time getting ready at the
start never restarts the song for everyone; only a singer's own tap, well into a song, does.
(`services/control/test/rules.test.ts` covers the rule; `__svPos.countdown` exposes the number to the e2e.)

## 10 · The notices

One control on the stage: a bell with the count (red for critical, amber for warnings), the one worst line beside
it, and a popup listing every notice with its severity, a longer word on it and what to do (Restart camera,
Reconnect, Retry, Open the camera). Notices are raised and taken down by whoever knows (the stage, the session,
the links), grouped by id (one per singer and kind), the diagnostic ones dismissible, the critical ones not.
Nothing covers the stage.

## 11 · Tests run for this work

- Unit: protocol 83, web 158, control 55 (`lifecycle.test.ts`, `ice.test.ts`, `budget.test.ts` among them), relay 5 —
  all green.
- E2E on the built app against the real service, all green: join (57), roles (100), tracks (83), tv (16), social
  (38), coupons (30), yt-track (17), signin (8); the 25-minute live duet (179 — two performers, a publisher, an
  audience, a TV, the sound measured on the way to the audience and the broadcast); **the new load and chaos e2e**
  (`node tools/ci/load-e2e.mjs <out> [N]`, 21 with three singers): N singers on one stage, every link's media verified
  from its counters, the service's rows counted, the service killed for 20 s and restarted on its file, a tab closed
  without a word, End meet twice. The seven-singer run on the 2-core machine is reported in §6 as what it is.
- Build budget: 230 KB gzipped first load of 400.

## 12 · What is not verified, and what the operator has to do

1. **Push** (`cd C:\Work\MyProjects2026\SingersVoice`, `git push origin main`): the site everyone sang on is the
   10 November build; none of this is deployed until the push. Devices must close and reopen the app once.
2. **TURN keys** (docs/DEPLOY_CONTROL.md, five minutes): until then a pair of singers behind strict networks
   still never link, and the room now says so ("No link to X").
3. **The Workers paid plan** ($5/month) for a public service: not the fix, but the right setting.
4. **The YouTube stream** (`https://www.youtube.com/live/QxogR6wjfqE`): not inspected — this workspace cannot fetch
   the video, and claiming otherwise would be worse than saying so. To measure it: attach a downloaded recording
   (a minute is enough) and the relay's log for that hour (`fly logs -a <relay app>`), and the next pass compares
   the broadcast's own bus capture (the live e2e already measures that path) with what arrived.
5. **Phones**: the crackle candidates in §7, the mesh ceiling in §6 — the next meet's notices (the Links line, the
   strain line, "by relay") are the measurements; a screenshot of the popup after a song says what each device saw.
