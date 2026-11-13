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
| Track | Optional. Pick one of your tracks or a public one now, or leave **Pick later** and build the set list in the room. A private track shows a *Publish it* button so every singer can load it. |
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
code, **Share link**, the idle countdown and, for privileged accounts, **Show view** (Publishing).

### The stage (always on)

The strip at the top is the virtual stage: every performer cut out of their camera, side by side by
slot, over the stage background. It is live from the first slot taken — there is no "start" for the
stage itself. Chips on it: *N on stage · x/y video linked*, *blending you into the stage…* while the
model loads, a camera on/off button for you.

**How big you stand.** The stage frames every singer itself: it finds you in your cut-out and fills
your slot with you — head near the top, the camera's cut edge on the picture's bottom edge (a
webcam bust shot fills the whole height), feet on the floor if your camera sees them. One singer
fills the picture; ten make one even row across it, each as big as a tenth of the stage allows, heads
level (someone whose camera sees them whole stands on the floor at the others' head height rather
than towering over them). A stretched arm reaches past your slot instead of shrinking you. The
*Framing* setting (wide / mid / close, auto zoom) only chooses how tight your camera's crop is.

### Who is who

- Everyone who enters is **audience** (chat, lyrics and the backing track once the song runs).
- The **host** is the admin: seated on S1 at the start, takes any slot freely, decides who sings,
  orders the set list, starts/pauses/resumes/restarts/ends songs, ends the meet.
- A **singer** is anyone on a slot (up to 10). Audience become singers by **Ask to sing** → the
  host's lobby shows the **wait list** (*"<name> wants to sing"*) with **Let them sing** / **Not
  now**. On yes, the server seats them in the first free slot; their camera opens by itself.
  Declined singers may ask again; a pending ask can be withdrawn. **Open stage** (host switch) lets
  anyone take a free slot without asking. The host can clear any slot (×). Singers can move to
  another free slot and **Leave stage**.
- **A running song belongs to the singers on stage.** From the count-in to the end of the song
  nobody new steps on: a newcomer sees *Ask to sing next* and joins the wait list (the host sees
  *wait list · N* on the live stage, nothing else), *Let them sing* waits until the song is over,
  and an open stage's *Take a stage slot* comes back between songs. Share the link with a hundred
  people: they all arrive as audience at the bottom, and the stage changes only between songs.

### The set list (karaoke queue)

| Option | Who | What it does |
| --- | --- | --- |
| **Pick your selection of song** | host, singers | Opens the picker: **one list** — your own songs first (tagged *Your library*), then the songs other singers share (tagged *Shared by …*), never the same song twice — under one search box built for thousands: every word you type must match, in any order, in the title, artist, genre, language or the singer who shared it; your library is filtered on the spot, the shared ones are searched in the catalog a page at a time; the counts say *3 of your 120 · 14 of 9,800 shared*; Enter picks the top match. One answer when nothing fits: *No song matches "…" — in your library or among the shared songs* (a song of yours that matches is never "no match"). Picking is all you do: the song loads on every device in the meet, so all the singers sing the same lines at the same time. A song of yours that other devices cannot reach yet is shared on the way (its Drive folder gets an anyone-with-the-link permission — needs a Google sign-in; otherwise only your own devices can play it, and the others say so) — and every singer on stage gets a copy of it in their own Drive library, in the background. The first song picked becomes the current one; later picks queue up. |
| **Now** (in the picker / on a queued song) | host | Makes that song the current one (the previous current goes back to the top of the queue). Only between songs. |
| ▲ / × on a queued song | host (× also the one who added it) | Move up / remove. |
| **Skip** | host | Drops the current song; the next one comes up. |
| *Track ready on this device* / warning | everyone | Each device loads the current song itself: from its own library, else from the public catalog. A private track of the host only works on the host's devices — the warning says so and the host can publish it from Tracks. |

### Getting ready and starting

| Option | Who | What it does |
| --- | --- | --- |
| **I'm ready (mic & camera check)** | singers | Opens the mic (and the camera on iOS), decodes the current song, marks you *ready*. Shown once there is a song; ready resets whenever the set list moves on. Under it the **Mic** line says what the microphone really gives: its name, its sample rate, the automatic level — and warns in red when it is a *phone-call quality* line (a Bluetooth headset's mic: 8–16 kHz, thin and muffled), with a menu to sing into another microphone; **I'm on speakers** turns echo cancellation on (only needed when the track plays out of speakers; with headphones it stays off for the cleanest voice — a hint appears when the sound is going out through speakers). |
| **Start the song (8 s count-in)** | host | Needs a song and at least one singer. Every device starts the backing track at the same server instant (the GMT kickstart); a singer who is not ready yet can still **Join the song on stage** afterwards and starts mid-song. |
| **End meet** | host | Ends the event for everyone (after a confirmation). |

## 3 · The room — live stage (singers) — Performer mode

**Performer mode is for singing**: the lyrics are the picture (big, your line highlighted; the cue
deck shows who sings what in a duet) and the singers are small — each one's frame as their own
camera framed it, in the lower part under the lyrics, no zoom of any kind. (The zoom that fills the
picture with the singers is Publisher mode's, below.) Controls: camera on/off, hear myself, **Set
list** (a drawer over the stage: what is playing, what is next, add a song — the song picker is at
hand while singing too), FX presets, and the **timeline — drag it (or use the arrow keys on it) to
move back or forth in the song**. Transport belongs to the stage: every singer on stage may
**Pause** (cued 3 s ahead, everyone freezes at the same position), **Resume**, and **seek** — a
jump is cued too (*jumping to 1:23…*), so the song keeps playing and every device jumps at the
same instant; while paused the paused position simply moves for everyone. **Restart** (from the
top) and **Stop song** — which stops the song for everyone — are the host's. A singer's **Stop**
stops only their own take; the song goes on for the others. The backing track ending on the host's
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
stage with *Join the song* — and the take saves itself in the background, kept at once in your
Drive `Performances/Live` (never Temp). A chip in the room says *Saving "song"… · 40 %* → *Saved
"song"* (→ Performances), or *Could not save — Retry*; the saver keeps going when you change page,
leave the room or the meet ends, retries by itself, and the app never reloads under it. **The
host's take of a song is the meet's saved performance**: registered with the meet and shared with
everyone who was in it — anyone with its link can watch it. Pick the next song, sing, and on, until
the singers drop off.

## 4 · The room — audience

Audience see the stage (performers' placeholders — video is private to the stage and the
publisher), the set list, who is on stage, **Ask to sing**, chat, and **Hear the stage — the singers
and the track, blended**: the very mix the host's device builds for the saved show (the backing
track with every singer's vocal, after their FX, in sync) is sent out by the host's device a second
at a time (WebCodecs/Opus, 64 kbps, through `/meets/:id/mix` on the relay — no media server) and
played here a couple of seconds behind the stage; the lyrics follow what is being heard, not the
clock. The status line says *Hearing the stage · 2.1 s behind*. When nothing arrives (the host's
browser has no WebCodecs — Chrome, Edge, Safari 16.4+ and Firefox 130+ do — or the host is not
singing yet) the device plays the backing track alone, in sync, as before. The singers on stage
never hear this (or each other): Solo foldback, so latency never pulls them apart.

## 5 · Between songs and the end

When a song is over the meet is back in the **lobby**: stage, slots and cameras untouched, ready
flags cleared, the next queued song up (or nothing until somebody adds one). Any number of songs
follow. **End meet** → the *Meet ended* screen: **the performances of this meet** (one saved show
per song — Watch, Share), every singer's registered take (links to their Drive), *Create another
meet*, *All performances*, and for the host with Publishing, *Publish this meet*. A meet that
nobody touched for 5 minutes expires the same way.

## 5a · Performances (`/studio/performances`, also from Home and the Meets page)

Everything you ever sang, by date and name:

| Section | What is in it |
| --- | --- |
| **Meet performances** | One saved show per song of every meet you hosted or were in: *meet · song*, date and time, length, who sang, who hosted. **Play** (your own: in the app) / **Watch** (the host's Drive link — anyone with it can watch), **Share** (copies the link, or the phone's share sheet). The host can remove one from the meet. |
| **Your takes** | Your own takes: every take of a meet song (kept by itself) and Studio takes (Temp for 7 days unless kept). Open one to play it, keep it, download it (vocal WAV, show video, manifest), **Share link** (shares the Drive folder anyone-with-the-link and copies the video's link), or delete it. |
| **Saving now** | Whatever the background saver is still on (with Retry when something is stuck). |

In Drive: `SingersVoice/Performances/Live/<date time song (id)>/manifest.json + vocal.wav +
<song · meet · date>.mp4` (the show — **MP4** with H.264 and AAC on Windows, Mac and iOS, H.264 and
Opus on Linux Chrome, WebM only on Firefox; the sound at 192 kbps; named so the people a link
reaches see the song and the meet, and Drive's own player opens it for anyone with the link),
`Performances/Offline/…` for Studio takes, `Temp/…` until kept. The Studio's own lists (*Sing a
track*, *Latest takes*) carry a delete button on every row; Tracks has one in each track's manage
panel; Performances deletes an opened take. A meet's
performance is also shared, from the host's Drive, with each singer's Google account (it shows up in
their Drive's *Shared with me*).

## 6 · Publishing (privileged accounts) — its own process

`/publishing`: **Publish a meet** (pick a meet you host or joined, or any by link/code; choose
destinations; **Publish** → the show view), **Preview** (every open eligible meet as a 16:9 monitor
tile with the exact broadcast picture), **Destinations** (YouTube, Facebook, Instagram, Twitch
ingest + stream key; the in-house portal), **History**.

The **show view** (`/publishing/show/:id`) joins the meet as a *publisher* — never on stage, never
counted as audience, one participant per view — pulls every performer's video (receive-only) and
draws them huge on one stage (the same framing as the room's stage: each singer fills their slot
top to bottom, ten in one even row), no lyrics, with a self-hiding bar (destinations, Go live / Stop,
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
Preview tiles monitor silently; one can be heard on request. (The session container that encodes
this mix to RTMPS/LL-HLS is the next increment; until then the show view's own sound is the mix.)

## 7 · What is independent of what

| Process | Owns | Depends on |
| --- | --- | --- |
| Stage (room) | cameras, cut-outs, performer video mesh | the meet's slot list only |
| Set list | which song is current / queued | `lib/catalog.ts` + your Drive to resolve a song |
| Song transport | kickstart, pause/resume/restart, takes | the current song being loadable on each device |
| Audience | lyrics, hearing the stage, chat, asking to sing | the meet snapshot; the host's mix batches (falls back to the backing track alone) |
| Publishing show / Preview | the broadcast picture, jobs | the meet's slot list + the performers' video |

Each of these can fail or change without the others noticing: a song that one device cannot load
leaves that singer in the audience's position for that song; a publisher leaving changes nothing on
stage; the host ending a song never touches who is on stage.
