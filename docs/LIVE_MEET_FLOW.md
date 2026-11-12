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
| **Pick your selection of song** | host, singers | Opens the picker: *My songs* (your Drive library) and *Songs from other singers*, with search. Picking is all you do: the song loads on every device in the meet, so all the singers sing the same lines at the same time. A song of yours that other devices cannot reach yet is shared on the way (its Drive folder gets an anyone-with-the-link permission — needs a Google sign-in; otherwise only your own devices can play it, and the others say so). The first song picked becomes the current one; later picks queue up. |
| **Now** (in the picker / on a queued song) | host | Makes that song the current one (the previous current goes back to the top of the queue). Only between songs. |
| ▲ / × on a queued song | host (× also the one who added it) | Move up / remove. |
| **Skip** | host | Drops the current song; the next one comes up. |
| *Track ready on this device* / warning | everyone | Each device loads the current song itself: from its own library, else from the public catalog. A private track of the host only works on the host's devices — the warning says so and the host can publish it from Tracks. |

### Getting ready and starting

| Option | Who | What it does |
| --- | --- | --- |
| **I'm ready (mic & camera check)** | singers | Opens the mic (and the camera on iOS), decodes the current song, marks you *ready*. Shown once there is a song; ready resets whenever the set list moves on. |
| **Start the song (8 s count-in)** | host | Needs a song and at least one singer. Every device starts the backing track at the same server instant (the GMT kickstart); a singer who is not ready yet can still **Join the song on stage** afterwards and starts mid-song. |
| **End meet** | host | Ends the event for everyone (after a confirmation). |

## 3 · The room — live stage (singers)

The same stage, with the lyrics laid over it (your line is highlighted; the cue deck shows who sings
what in a duet). Controls: camera on/off, hear myself, **Set list** (a drawer over the stage: what is
playing, what is next, add a song — the song picker is at hand while singing too), FX presets,
timeline. Host-only transport: **Pause** (cued 3 s ahead, everyone freezes at the same position),
**Resume**, **Restart** (from the top), and **Stop song** — which stops the song for everyone. A
singer's **Stop** stops only their own take; the song goes on for the others. The backing track
ending on the host's device ends the song for everyone too.

Every take is a personal session: vocal + camera video, sample-accurate on the track timeline
across any number of pauses, reviewed on **Your take** (play the mix, align, Keep → your Drive,
`Performances/Live`, or Discard). **Back to the stage** returns to the lobby — you are still on
stage, the camera stays on, and the next song may already be up.

## 4 · The room — audience

Audience see the stage (performers' placeholders — video is private to the stage and the
publisher), the set list, who is on stage, **Ask to sing**, chat, and while a song runs: the lyrics
in sync and *Play the backing track here, in sync* (voices arrive with the published stream).

## 5 · Between songs and the end

When a song is over the meet is back in the **lobby**: stage, slots and cameras untouched, ready
flags cleared, the next queued song up (or nothing until somebody adds one). Any number of songs
follow. **End meet** → the *Meet ended* screen: every singer's registered take (links to their
Drive), *Create another meet*, *My performances*, and for the host with Publishing, *Publish this
meet*. A meet that nobody touched for 5 minutes expires the same way.

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

**The broadcast sound.** Only Publishing collects the whole song: every singer's vocal (after
their own FX) travels to the publisher's links — and only there; singers never hear each other,
so latency never pulls them apart while they sing the same lines — and the show view plays those
vocals with the backing track, which it runs a quarter second behind the shared clock to meet them.
Preview tiles monitor silently; one can be heard on request. (The session container that encodes
this mix to RTMPS/LL-HLS is the next increment; until then the show view's own sound is the mix.)

## 7 · What is independent of what

| Process | Owns | Depends on |
| --- | --- | --- |
| Stage (room) | cameras, cut-outs, performer video mesh | the meet's slot list only |
| Set list | which song is current / queued | `lib/catalog.ts` + your Drive to resolve a song |
| Song transport | kickstart, pause/resume/restart, takes | the current song being loadable on each device |
| Audience | lyrics, listen, chat, asking to sing | the meet snapshot |
| Publishing show / Preview | the broadcast picture, jobs | the meet's slot list + the performers' video |

Each of these can fail or change without the others noticing: a song that one device cannot load
leaves that singer in the audience's position for that song; a publisher leaving changes nothing on
stage; the host ending a song never touches who is on stage.
