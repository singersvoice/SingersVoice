# Live Meets — how a karaoke event runs

Every screen, every option, and which independent process owns it. The four portals (Tracks,
Studio, Live Meets, Publishing) never call into each other: they share only the protocol types,
`lib/catalog.ts` (the public catalog) and `lib/storage` (your Drive). The show (Publishing) is a
separate process watching the same meet; the song is one activity on a stage that is live from the
first moment.

## 1 · Meets home (`/meets`)

| Option | What it does |
| --- | --- |
| **Create a meet** — Title | The event's name (defaults to "<your name>'s meet"). |
| Track | Optional. Pick one of your tracks or a public one now, or leave **Pick later** and pick the songs in the room, one at a time. A private track shows a *Publish it* button so every singer can load it. |
| Background | The stage background (from your settings' picker). |
| *open meets N/3* | You may host **at most 3 open meets** (lobby / countdown / live) at a time; at the limit, Create is off until you end one below. |
| **Join by code** | 6-letter code → the room. A shared link does the same. |
| My meets | Meets you host or joined, with their state. Per meet: **Open** (this tab), **New tab** (run several meets side by side), and for meets you host **End** (open ones) and **Delete** (any — the room, chat and take list go for good; takes stay in each singer's Drive). |

The moment you create a meet you are **on stage (S1)** with your camera on. The meet closes itself
after 5 idle minutes.

**The room follows you.** Leaving the room page for another page in the same tab (Publishing,
Tracks, …) does not leave the meet: the room keeps running behind the page — heartbeat, camera,
cut-out, video links — and a floating pill (*On stage · S1 · <meet>*) offers **Return** and
**Leave**. So the host can open Publishing › Preview and see themselves. A finished meet does not
follow you around.

## 2 · The room (`/meet/:id`) — lobby

The room is one page with two tabs, **Stage** and **Chat**. The header shows the host, the join
code, **Share link**, the idle countdown and, for Publisher-plan (or admin) accounts, **Publish**
(the show view in a new tab, with the destinations saved on the account — see §6).

### The stage (always on)

The strip at the top is the virtual stage: every performer cut out of their camera and seated in
**one row of chairs** — the same size, evenly spaced by slot along a shallow arc, behind a lit riser
that hides everything below the chest — over the stage background. It is live from the first slot
taken — there is no "start" for the stage itself. Chips on it: *N on stage · x/y video linked*,
*blending you into the stage…* while the model loads, a camera on/off button for you, and the
stage's word on your distance to the camera (*Sit back a little* / *Come a little closer*).

**Everyone the same size — strictly.** Your own device frames you before anything leaves it (the
*stage frame*): it finds your head in your cut-out and sends a frame with the head the same size at
the same place — the top of the head 8 % down, the head 22 % of the frame tall, centred — however
near or far you sit. Sitting back, you are brought up (never more than 3.3×, a blur helps nobody);
sitting close, you are brought back — the frame then has room around what the camera could see,
and the chip asks you to sit back, because the stage can only show what the camera sees (the
camera's bottom edge fades out rather than cutting across you). Every stage draws that frame
whole, in slots of one size: so the host on a laptop a foot from the webcam and a friend across the
room from a phone come out as two performers of one size, heads level, on one line. There is no
framing setting any more — nobody is bigger than anybody. Ten singers make one even row across the
stage, two stand big in the middle; the names sit on the riser under each singer.

### Who is who

- Everyone who enters is **audience** (chat, lyrics and the backing track once the song runs).
- The **host** is the admin: seated on S1 at the start, takes any slot freely, decides who sings
  (when the stage is not open), ends the meet — and is the only one who can **remove anyone from
  the meet** (the **out** button on a slot, × on a name in the
  audience list): the person is off the stage and out of the room, their device says *"<host>
  removed you from this meet"*, and the link no longer lets that account back in.
- **The song belongs to the stage — one song at a time.** Every singer on stage — the host
  included, nobody more than anyone else — picks the song, **starts** it (count-in), pauses,
  resumes, restarts, seeks, and **stops it for everyone**; the same buttons on every device.
  **Picked is up**: the first pick is the song of the stage, loading on every device at once — no
  second tap, no queue. When a second singer picks another song while one is up, neither replaces
  the other and nothing queues: every singer on stage sees the **same choice card** (the song up and
  every song put forward, who picked what), nothing can start, and **one tap by any singer settles
  it** — the chosen song is up on every device and the others are gone. A song picked twice is
  listed once: the picker says *Up now* / *Put forward* instead of offering it again, and the
  service never lists a song that is already up or put forward. **Whoever starts, every singer on
  stage sings**: the moment the song runs, every singer's device — the host's included, mic opened
  or not yet — goes to the singing screen and joins the song by itself (the mic opens on the way),
  from the count-in; every vocal is in the mix in its part. Only a browser that insists on a tap for
  the mic (iOS, where the mic and camera are one capture) leaves one tap, **Join the song**, on the
  singing screen itself.
- A **singer** is anyone on a slot (up to 10). **A new meet has an open stage**: whoever has the
  link takes a free slot with **Take a stage slot** — no permission needed (the three friends you
  sent the link to are meant to sing). The host can switch **Open stage** off; then audience ask
  with **Ask to sing** → the host's lobby shows the **wait list** (*"<name> wants to sing"*) with
  **Let them sing** / **Not now**, and on yes the server seats them in the first free slot.
  Declined singers may ask again; a pending ask can be withdrawn. Taking a slot opens your mic and
  camera with that tap. The host can clear any slot (× — back to the audience). Singers can move
  to another free slot and **Leave stage** (the mic closes with it).
- **Talk-back.** While no song runs, the singers on stage hear each other (each one's voice goes
  over the stage's own links), and the audience hears the stage through the host's device — so a
  stage can talk, count in, agree on the next song. From the countdown to the end of the song
  **nobody on stage hears anyone else** (Solo foldback: latency never pulls a duet apart), while the
  audience, the recording and any broadcast get the whole blend. Headphones are recommended on stage
  (the chip says so): with speakers, talk-back feeds the room back into every mic.
- **A running song belongs to the singers on stage.** From the count-in to the end of the song
  nobody new steps on: a newcomer sees *Ask to sing next* and joins the wait list (the host sees
  *wait list · N* on the live stage, nothing else), *Let them sing* waits until the song is over,
  and an open stage's *Take a stage slot* comes back between songs. Share the link with a hundred
  people: they all arrive as audience at the bottom, and the stage changes only between songs.

### The song of the stage (one at a time)

| Option | Who | What it does |
| --- | --- | --- |
| **Pick your selection of song** | host, singers | Opens the picker: **one list** — your own songs first (tagged *Your library*), then the songs other singers share (tagged *Shared by …*), never the same song twice — under one search box built for thousands: every word you type must match, in any order, in the title, artist, genre, language or the singer who shared it; your library is filtered on the spot, the shared ones are searched in the catalog a page at a time; the counts say *3 of your 120 · 14 of 9,800 shared*; Enter picks the top match. One answer when nothing fits: *No song matches "…" — in your library or among the shared songs* (a song of yours that matches is never "no match"). Picking is all you do: **picked is up** — the song loads on every device in the meet (*"… is up — loading on every device"*), so all the singers sing the same lines at the same time, and any singer on stage starts it. A song of yours that other devices cannot reach yet is shared on the way (its Drive folder gets an anyone-with-the-link permission — needs a Google sign-in; otherwise only your own devices can play it, and the others say so) — and every singer on stage gets a copy of it in their own Drive library, in the background. |
| **The choice card** — *N songs picked — one song at a time on this stage* | everyone sees it; host and singers settle it | When a song is picked while another is up (two singers picking at the same time, or one changing their mind), the pick is **put forward** (*"… is put forward — the stage chooses"*): the card lists the song up (*picked first*) and every song put forward (*picked by …*), the same on every device in the meet; **Start** is off until it is settled. **Sing this one** on any of them, by any singer on stage, settles it with one tap: that song is up on every device, every other song on the card is dropped (removed from the meet — not queued, not remembered). × withdraws a song put forward (the singer who put it forward, or anyone on stage); a withdrawal that leaves a single song put forward with nothing up makes that song the one up. The audience sees the card without the buttons. |
| *After this song* (while a song runs) | host, singers (× also the one who put it forward) | A song picked during a song does not interrupt it: it is put forward for after the song. One alone comes up by itself when the song ends; several stay on the card with **Sing this one** — the singers may settle it during the song, or the choice card is waiting in the lobby when the song ends, nothing up until it is settled. |
| *Up now* / *Put forward* (in the picker) | everyone | The song is there already: it is not offered again (a tap that lands twice adds nothing either — the service lists a song once, told by its ids or by title and length). |
| *Track ready on this device* / warning | everyone | Each device loads the current song itself: from its own library, else from the public catalog. A private track of the host only works on the host's devices — the warning says so and the host can publish it from Tracks. |

### Getting ready and starting

| Option | Who | What it does |
| --- | --- | --- |
| **Turn my mic on** | singers | The mic opens by itself the moment you are seated (talk-back, your vocal in the song); this button only appears when the browser wanted a tap first (a permission not given yet, or iOS with the camera on) — one tap opens it. |
| **Film the whole meet into my Drive** | host | On by default. From the moment the host's mic is open on stage until **End meet** (or the host steps off), the host's device records the whole meet as **one video** — the show picture (everyone on stage over the background, no lyrics) with the stage mix (the songs, the talk between them) — and writes it into their Drive *as it goes* (ten seconds at a time, a resumable upload): a two-hour meet never has to fit in memory, and a tab that dies loses seconds, not the meet (the next start of the app completes the file with what Drive already holds). The switch shows what it is doing (*Filming · 12:34 · 210 MB in Drive*). The finished film is a performance of the meet, **Full meet**, listed on the ended screen and under Performances, shared with everyone who was in the meet like a song's show. |
| **I'm ready (mic & camera check)** | singers | Opens the mic (and the camera on iOS) if it is not open yet, decodes the current song, marks you *ready*. Shown once there is a song (and no choice open); ready resets whenever another song comes up. Under it the **Mic** line says what the microphone really gives: its name, its sample rate, the automatic level — and warns in red when it is a *phone-call quality* line (a Bluetooth headset's mic: 8–16 kHz, thin and muffled), with a menu to sing into another microphone; **I'm on speakers** turns echo cancellation on (only needed when the track plays out of speakers; with headphones it stays off for the cleanest voice — a hint appears when the sound is going out through speakers). |
| **Start the song (8 s count-in)** | host, singers | Needs a song on the stage and no choice open (*Several songs are picked — choose one on the song card first*). Whoever taps it is made ready on the way (mic, track) if not yet; every device starts the backing track at the same server instant (the GMT kickstart), and every other singer on stage goes to the singing screen and joins from the count-in without a tap — mic open or not yet (it opens on the way). A singer whose browser insisted on a tap for the mic sees **Join the song** on the singing screen and starts mid-song with that tap. |
| **End the song** (lobby, while a song runs) | host, singers | Ends the song for everyone; a song put forward during it comes up (several: the choice card). |
| **End meet** | host | Ends the event for everyone (after a confirmation). |

## 3 · The room — live stage (singers) — Performer mode

**Performer mode is for singing**: the lyrics are the picture (big, your line highlighted; the cue
deck shows who sings what in a duet) and the singers are small — each one's frame as their own
camera framed it, in the lower part under the lyrics, no zoom of any kind. That frame is the
picture of you everywhere: the show and the audience get exactly what you see of yourself here, only
bigger. Controls: camera on/off,
hear myself, **Songs** (a drawer over the stage: what is playing, what is next, pick a song — the song picker is at
hand while singing too), FX presets with **Tweak** beside them (every control of the vocal chain in a
drawer, live on your voice), and the **timeline — drag it (or use the arrow keys on it) to
move back or forth in the song**. Transport belongs to the stage: every singer on stage may
**Pause** (cued 3 s ahead, everyone freezes at the same position), **Resume**, and **seek** — a
jump is cued too (*jumping to 1:23…*), so the song keeps playing and every device jumps at the
same instant; while paused the paused position simply moves for everyone. **Restart** (from the
top) and **Stop song** — which stops the song for everyone, a song put forward during it up — are
every singer's as well. The **Songs** drawer shows what is playing and what was put forward for
after it, and holds the picker. A singer who is not the host also has **Leave**: their own take ends, the
song goes on for the others, and they can **Join the song** again. The backing track ending on any
device ends the song for everyone too. Whoever plays, pauses or seeks, the devices stay in sync:
every cue is a shared GMT instant, never "when the message arrives". A take follows every pause and
jump on the track timeline (a part sung again replaces the old one); the saved show records what
happened, jumps included.

**What gets saved — by itself.** Every take is a personal session: your vocal, sample-accurate on
the track timeline across any number of pauses — and its video is **the show**: exactly the
broadcast picture Publisher mode shows (every singer on stage over the stage background, huge, no
lyrics), with the whole mix as its sound (the backing track, your vocal after FX, and every other
singer's vocal, which travels over the links for the recording only — nobody ever hears it).
When the song is over (or you stop your take) **nothing asks you anything**: you are straight
back on the stage — the lobby with the next song up, or, after your own Stop mid-song, the live
stage with *Join the song* — your mic stays open (talk-back is back on: the stage hears each
other again), and the take saves itself in the background, kept at once in your
Drive `Performances` (never Temp). A chip in the room says *Saving "song"… · 40 %* → *Saved
"song"* (→ Performances), or *Could not save — Retry*; the saver keeps going when you change page,
leave the room or the meet ends, retries by itself, and the app never reloads under it. **The
host's take of a song is the meet's saved performance**: registered with the meet and shared with
everyone who was in it — anyone with its link can watch it. Pick the next song, sing, and on, until
the singers drop off.

**The voice.** Under the lyrics, one row of chips applies a finished-vocal treatment to the
captured voice the instant it is tapped (the chain runs in 128-frame blocks — under 3 ms — so
nothing is delayed): **Studio** (the default for a new singer: clean low end, presence, de-essed, a
touch of air, held at one level), **Natural Tune** (the same plus gentle, slow pitch correction
that keeps the vibrato), **Punch** (punch without over-compression: a light main compressor with a
crushed copy blended under), **Up Front** (placement: on top of the track, every phrase at one
level, a short pre-delayed room), **Radio-Ready** (bright, dense, loud, a hint of grit), **Vibrant**
(maximum air and presence, the rider all the way — even a whisper fills the stage), then Pop Star,
Warm, Bright, Warm Ballad, Stadium, Telephone, Doubler, Robot, Octave Down. The choice is the
singer's own, kept on their device (and in their Drive config) until they change it; what the
recording, the publisher and the other singers' recordings get is the treated voice.

**Restart, Track volume, Vocal volume.** Every singer on stage has **Restart** (the song starts over
for everyone, cued — a fluffed first line is nobody's problem) beside Pause and Stop; the host alone
ends the song. Under the transport, **Track volume** and **Vocal volume** move in 3 dB steps
(−30…+30) on top of a mix that is already balanced — the track normalised to one loudness whatever
file it came from, a rider on every voice — and a guard turns the sum back down when both are
pushed, so even +30 / +30 never lives in the limiter; **Backing level in your ears** (Settings) is
only what you hear, never what is recorded: the balance *this
device mixes at* — what it records, what the host's device relays to
the audience, and (in the show view) what goes out to YouTube and the portal. They are kept on the
device until changed. *Hear myself* is a different thing — the singer's own monitor — and comes back
through the browser some 40–100 ms late (more while pitch correction runs), so a singer hears
themselves twice; the Mic line says so and points to the microphone's or interface's own headphone
jack, which is instant. A song that runs out on its own now finishes like one that is stopped: the
takes save, the meet moves on (a stale callback used to leave it hanging unless someone had paused).

## 4 · The room — audience

Audience see the stage (performers' placeholders — video is private to the stage and the
publisher), the song of the stage (and the choice card, without its buttons), who is on stage, **Ask to sing**, chat, and **the show** when a publisher
is on air — the publisher's broadcast, every singer on the stage background with the track and
their voices blended (section 6), played a few seconds behind behind a *Watch the show* tap — and
otherwise the stage background with who is on it, plus **Hear the stage — the singers and the
track, blended**: the very mix the host's device builds for the saved show (the backing track with
every singer's vocal, after their FX, in sync) is sent out by the host's device a second at a time
(WebCodecs/Opus, 64 kbps, through the relay — no media server; listeners read it from the public
`/watch/:id/mix` route, which the edge caches, so a hundred listeners cost the relay one answer
per second) and played a couple of seconds behind the stage. The status line says *Hearing the stage · 2.1 s behind*. When
nothing arrives (the host's browser has no WebCodecs — Chrome, Edge, Safari 16.4+ and Firefox 130+
do — or the host is not singing yet) the device plays the backing track alone, in sync. While the
show plays with its own sound the mix stays off. **No lyrics for the audience, ever** — lyrics are
Performer mode's, for the singers on stage. The singers on stage never hear any of this (or each
other): Solo foldback, so latency never pulls them apart.

A big audience costs nobody anything: an audience device polls the room every 5 s and the mix every
second (through the edge cache), draws a still stage twice a second, runs no camera, no cut-out and
no mesh; the room names the first dozen of the audience and counts the rest (*Audience (120): Ann,
Ben … and 108 more*), so what every poll carries stays small; the singers' and the publisher's work
never grows with the audience (docs/ARCHITECTURE.md, "A hundred in a meet").

## 5 · Between songs and the end

When a song is over the meet is back in the **lobby**: stage, slots and cameras untouched, ready
flags cleared, a song put forward during the song up (several: the choice card, nothing up until the
singers settle it; none: nothing until somebody picks one). Any number of songs follow. **End meet** → the *Meet ended* screen: **the performances of this meet** (one saved show
per song — Watch, Share), every singer's registered take (links to their Drive), *Create another
meet*, *All performances*, and for the host with Publishing, *Publish this meet*. A meet that
nobody touched for 5 minutes expires the same way.

## 5a · Performances (`/studio/performances`, also from Home and the Meets page)

Everything you ever sang, by date and name:

| Section | What is in it |
| --- | --- |
| **Meet performances** | One saved show per song of every meet you hosted or were in: *meet · song*, date and time, length, who sang, who hosted. **Play** (your own: in the app) / **Watch** (the host's Drive link — anyone with it can watch), **Share** (copies the link, or the phone's share sheet). The host's own rows have a **Delete** button right there, and the section a **Delete all (N)** for every performance you hosted — permanently (one confirmation): the files leave your Drive for good (not the trash) and the meet's list. A performance in another host's Drive is theirs to delete. |
| **Your takes** | Your own takes: every take of a meet song (kept by itself) and Studio takes (Temp for 7 days unless kept). Tap a row to play it, keep it, download it, **Share link** (shares the file anyone-with-the-link and copies it). Every row has a **Delete** button, and the section a **Delete all (N)** for every take shown (the filter — All / Kept / Temp — decides which) — permanently, out of your Drive, after one confirmation; a progress line counts them down. |
| **Saving now** | Whatever the background saver is still on (with Retry when something is stuck). |

In Drive: **one level, one file per performance** — `SingersVoice/Performances/<song · meet [meet
id] · date time>.mp4`, e.g. `Performances/Ammo · Friday Meet [mwe8q644-onrv6m] · 2026-11-12
2047.mp4` (local time; the meet's title and id so every take of a meet is found together; the show
is **MP4** with H.264 and AAC on Windows, Mac and iOS, H.264 and Opus on Linux Chrome, WebM only on
Firefox; the sound at 192 kbps; Drive's own player opens it for anyone with the link). A take
without video is its vocal WAV, named the same way. The details (who sang, offsets, settings) ride
on the file itself — its Drive properties and description — so nothing else is stored beside it;
Studio takes land in the same folder, `Temp/…` until kept. **Delete is delete**: the file is
removed from Drive, not trashed. Performances saved by older builds (a folder each, under
`Performances/Live` or `/Offline`) are flattened once on the first start after the update: the show
moved up and stamped, shared again where the folder was, the folder and the `Live` / `Offline`
folders deleted. There is exactly one of each app folder: the folder tree is built once per device,
every caller waiting for the same build, and the first start after an update walks the tree once
more and folds any
doubled folders (made by older builds racing, or by two devices at once) into the oldest — files
moved over, the emptied duplicates trashed. **Share** on a performance puts the bare link on the
clipboard on a computer (nothing appended); on a phone it opens the share sheet with the link alone. The Studio's own lists (*Sing a
track*, *Latest takes*) carry a delete button on every row; Tracks has one in each track's manage
panel; Performances deletes an opened take. A meet's
performance is also shared, from the host's Drive, with each singer's Google account (it shows up in
their Drive's *Shared with me*).

## 6 · Publishing (the Publisher plan, or an admin) — its own process

`/publishing`: **Publish a meet** (pick a meet you host or joined, or any by link/code; switch on
the destinations — a platform that has no stream key yet opens its setup right there: ingest URL
filled in, paste the key, **Save & enable**, and the switch comes on; *Change key* later; the
in-house portal needs nothing; **Publish** → the show view), **Preview** (every open eligible meet
as a 16:9 monitor tile with the exact broadcast picture), **Destinations** (the same keys, managed
in one place: YouTube, Facebook, Instagram, Twitch ingest + stream key, Enable / Disable; keys are
stored encrypted on the service and only their last 4 characters ever shown again), **History**.

The **show view** (`/publishing/show/:id`) joins the meet as a *publisher* — never on stage, never
counted as audience, one participant per view — pulls every performer's video (receive-only) and
draws them huge on one stage (each singer exactly as their own camera frames them — the picture
they see of themselves on the live stage, only bigger — ten in one even row), no lyrics, with a
self-hiding bar (destinations, Go live / Stop,
singers' vocals, backing track in sync, full screen). It shows the singers from the lobby on (*Up
next: …*), the countdown as an opener, *Paused by the host*, and carries on across every song of
the event: the show is independent of the song.

**The broadcast sound.** Publishing collects the whole song: every singer's vocal (after their
own FX — the presets a singer picks are theirs, kept on their device until they change them)
travels to the publisher's links at 96 kbps Opus (music quality, not the phone-call default), and
to the other singers' links for their recordings only; singers never hear each other, so latency
never pulls them apart while they sing the same lines — and the show view plays those vocals with
the backing track, which it runs a quarter second behind the shared clock to meet them. The same
blend reaches the audience in the room through *Hear the stage* (section 4).
Preview tiles monitor silently; one can be heard on request.

**What the publisher hears.** The show view's two buttons (vocals, music) are its *monitor* — the
publisher's own ears — and never touch the broadcast, which always carries every voice and the
track. A publisher who is also singing on stage (the same account) does not hear their own voice
in the show view: it would come back a few hundred milliseconds late through the mesh, the
"repeated voice" that feels like the show view listening to the mic — it does not; the show view
never opens a microphone or camera. While the broadcast runs the show view displays the encoder's
own canvas, so what the publisher watches is exactly what goes out.

**Go live — the show view is the encoder.** Nothing sits between the publisher and the platforms:
the show view's own browser encodes the picture (its 1280×720 show canvas through WebCodecs,
H.264, a keyframe every second, no B-frames) and the sound (the bus above through WebCodecs,
AAC-LC 48 kHz stereo 128 kbps), cuts them at the keyframes into one-second MPEG-TS segments and
PUTs each one to the service (`PUT /publishing/jobs/:id/live/<name>.ts`). The service keeps the
last eight for the **in-house portal** (an HLS playlist, `GET /watch/:id/live.m3u8`, that the
watch page and the room's audience play through hls.js — Safari natively — a few seconds behind)
and forwards each segment, then a fresh playlist, to **YouTube's HLS ingestion** with the saved
stream key (`https://a.upload.youtube.com/http_upload_hls?cid=<key>&copy=0&file=…`): the key
never leaves the service. The broadcast bar says *LIVE · 1:23 · 3100 kbps · 41 segments ·
YouTube: YouTube is receiving the show*; a wrong key reads *YouTube rejected the stream key
(401)*. Stop, or leaving the show view, ends the job; a job whose segments stop for 20 s is off
air. What a browser needs: WebCodecs (Chrome, Edge, Safari 17+, Firefox 130+) and an AAC encoder
for sound — Windows, macOS, iOS and Android have one; Chrome on Linux and Firefox do not and go
out **video only** (the bar says so; the audience then hears the stage mix for sound).

**Low latency — the RTMP relay (`services/relay`, docs/RELAY.md).** YouTube's HLS ingestion is
the slow road: YouTube plays an HLS-ingested stream 15–30 s behind the stage (its *ultra-low
latency* setting, a few seconds, exists for RTMP only), and Facebook, Instagram and Twitch take
RTMP(S) and nothing else — which a browser cannot speak. The relay is one small container
(Node + ffmpeg, scale-to-zero on Fly.io or any Docker host) that closes the gap: when `RELAY_URL`
and `RELAY_SECRET` are set on the service, every segment the show view sends is handed on to the
relay, where one `ffmpeg -c copy` per show (no transcoding, a sliver of a CPU) writes the same
bytes to every RTMP target of the job at once — YouTube included, which then runs at *ultra-low
latency* (set that in YouTube Studio → Stream settings): the viewer is 3–5 s behind the stage.
Stream keys travel service → relay only (`Authorization: Bearer`), never through a browser. The
Destinations page says whether the relay is on; the broadcast bar reads *relay: streaming to
youtube, facebook*; a stream the relay lost (it restarted, or was idle a minute) is started again
by the next segment, a relay that is down is retried every few seconds and reported, and the watch
page keeps playing throughout. Without a relay, YouTube keeps working through HLS ingestion (choose
*Low latency* in YouTube Studio: 10–20 s), and jobs for the other three stay *requested*.

## 7 · What is independent of what

| Process | Owns | Depends on |
| --- | --- | --- |
| Stage (room) | cameras, cut-outs, performer video mesh | the meet's slot list only |
| Songs | which song is up / put forward (the choice card) | `lib/catalog.ts` + your Drive to resolve a song |
| Song transport | kickstart, pause/resume/restart, takes | the current song being loadable on each device |
| Audience | the show (when on air) or the stage, hearing the stage, chat, asking to sing | the meet snapshot; the publisher's segments; the host's mix batches (falls back to the backing track alone) |
| Publishing show / Preview | the broadcast picture, jobs | the meet's slot list + the performers' video |
| The film of the meet | one video of the whole meet in the host's Drive | the host's device being on stage with its mic open (the stage's video and sound reach it only there) |
| RTMP relay | the RTMP streams of a job | the service forwarding segments; the saved keys |

Each of these can fail or change without the others noticing: a song that one device cannot load
leaves that singer in the audience's position for that song; a publisher leaving changes nothing on
stage; the host ending a song never touches who is on stage.
