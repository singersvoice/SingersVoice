# Testing SingersVoice on iOS, Android and the web

Live build: **https://singersvoice.github.io/SingersVoice/**

## Install as an app

- **iOS (Safari):** open the URL → Share → *Add to Home Screen*. Launch from the icon. Keep the app in the foreground
  while singing (iOS pauses the microphone for background web apps). Wired or Bluetooth headphones recommended.
- **Android (Chrome):** open the URL → menu → *Install app* (or the install banner). Launch from the icon.
- **Desktop (Chrome/Edge/Safari):** just open the URL; Chrome offers *Install* in the address bar.

## Portals at a glance

- **Tracks** — All / My Drive / Public catalog / YouTube tabs, in that order. **All**: one box searches the SingersVoice track database (what singers have sung, grouped by song name — a song with several files is an expandable group, several artists cascade one more level; the latest sung first), your Drive and the catalog as you type, YouTube on *Search*; **Sing** on any version brings the song into your Drive under Tracks (shared, registered as your copy) and opens the stage; ▶ previews it here. Sing a track of your own once: it is shared, registered with a 12-character id and listed for every singer; the *in the database* chip shows it. The global "last sung" and your own history move only on a Sing or a preview that plays — never on a search. *More → Publish to public catalog* shares the Drive folder and lists the track for everyone; *Add to my Drive* pulls a catalog track; **YouTube** — type a song (or paste a link), *Add to my Drive* on a result fetches it through the relay into `Tracks/YT` (progress in the relay's words), then *Sing*: the karaoke video where the lyrics would be, muted, on the song's clock. Needs the relay (docs/RELAY.md); without it the tab says so. Track Maker has Movie and Year fields for the database's metadata.
- **Studio** — Track Maker, Sing, Performances (unchanged flows, now under `/studio`).
- **Live Meets** — Create meet (pick a *public* track so others can load it) → share the link/code → whoever has the link takes a slot with *Take a stage slot* (the stage is open; the host can switch to deciding each one) → with headphones on, the singers on stage hear each other and the audience hears the stage (talk-back) → *I'm ready* → host *Start the song (8 s count-in)* → everyone's stage starts at the same instant, nobody on stage hears anyone else → the song ends → the take lands as one file in `Performances` and is listed on the meet's ended page; the host's device films the whole meet into their Drive as it goes, a chapter per song, pause and stretch of stage (*Full meet 01, 02, …* on the ended page too; under Performances one filming with its chapters and *Play all*) — press Pause, Restart, Stop on the song and the film carries on, each a new chapter. Tick *Instrument* beside the mic to add a USB interface's input to your sound. Only the host can remove someone (*out* on a slot, × on a name). Idle 5 minutes → the meet closes itself.
- **Publishing** (club owners with an active year, or a super admin) — Destinations (stream keys, saved once), Publish a meet, History; **Publish** in the room opens the show view; `/watch/<meetId>` is the public in-house page. With the RTMP relay deployed (docs/RELAY.md) YouTube runs at ultra-low latency and Facebook / Instagram / Twitch go live. Recording and streaming run from *Go live* to *Stop publishing*, whatever the singers do to the song; the footage lands in chapters like the host's film.
- **Admin** (super admins: the first account ever, `PRIVILEGED_EMAILS`) — Settings › Admin: every account with its role (*Audio only* → no camera on stage, on their device and on everyone's stage; *Dual*; *Club owner*; *Super admin*), *Grant a year* / *Renew* / *Set dates* / *Revoke* on a club owner's subscription; Publishing opens and closes for them at once (an expired year closes it by itself, with the date on their gate). The last super admin cannot be demoted.

## 10-minute smoke test

1. **Welcome** → *Continue with Google* (needs the OAuth client, see GOOGLE_OAUTH.md) or *Try it on this device*.
2. **Setup** → Test microphone, Test camera, *Go to my stage*.
3. **Track Maker** → pick an mp3/m4a → paste lyrics (one line each) → choose singers + pattern → *Apply* → Timing:
   play and tap **Mark** on each line → *Review & save* → *Sing it now*.
   - Or **Library → Import** with an SVOld `*.trackmaker.json` + its mp3.
4. **Sing** → *Start singing* (3-2-1) → sing → *Finish take* → *Play mix* → **Keep**.
5. **Performances** → the take is listed (Temp/Kept); open → play / download.
6. **Settings** → VoxForge presets (try *Hard Tune* with auto-tune), text size A++ / Max, backgrounds.
7. Turn the phone off-line (airplane mode) and reopen the app: the shell loads; device-mode tracks still play.

## Viewport matrix (automated)

`node tools/ci/screenshots.mjs` walks the app at 320×568, 360×640, 390×844, 412×915, 820×1180 and 1280×800, and
on three of them (phone, tablet, desktop) imports a track, sings 9 s with a fake microphone, finishes, keeps the
take, opens Track Maker, runs a meet and the publishing setup — every control a singer has (Track / Vocal
volume, Voice FX) is in those pictures on every size. `SV_SHOT_ONLY=ipad,desktop` walks only the viewports named.
CI uploads the screenshots as an artifact on every PR.

## Known limits of this increment

- Live meets, the catalog and publishing need `sv-control` deployed (`VITE_CONTROL_URL`) — see docs/DEPLOY_CONTROL.md; the portals explain this inline until then.
- Performers do not hear each other (Solo foldback, by design); the audience hears the stage mix the host's device relays, and watches the show (video + mix) once a publisher's show view is on air.
- The "Import a track shared with me" button needs `VITE_GOOGLE_API_KEY` (Google Picker).
- Tempo changes are real-time granular time-stretch on the backing track (key kept); extreme values sound grainy.
- On iOS the Google sign-in popup must be triggered by a tap (it is), and tokens last 1 h → *Reconnect Drive*.

## The audio lab (`tools/ci/audio-lab.mjs`)

`node tools/ci/audio-lab.mjs` renders the real vocal chain and mix bus offline in Chromium
(OfflineAudioContext with the AudioWorklets, esbuild-bundled from `apps/web/src/audio/lab.ts`) and
measures them with synthetic signals — what a listener would hear, in numbers: the chain's impulse
response has one arrival (every parallel path delay-matched, no comb filter), the de-esser passes a
quiet 8 kHz at unity and ducks a loud one, a voice 10 dB over full scale leaves under the −3 dB
ceiling, the Studio preset adds no hidden gain, a −30 LUFS track lands at −19, a −5 dBFS and a
−33 dBFS voice both ride to −17 within ten seconds and the silence after them stays silent, the mix
at 0 / 0 sits still, and at +30 / +30 the guard brings it back under the target with no sample over
the ceiling. Worklet and native-fallback paths both. Run it after any change under `apps/web/src/audio`
or `apps/web/public/worklets`.

## Live meet with two performers (`tools/ci/live-duet.mjs`)

Two Chromium contexts with a synthetic-person clip as the fake camera (`tools/ci/fake-person.mjs`,
so the real segmentation model has someone to cut out) — the host on a desktop viewport, a guest on a phone — import
the sample track and meet in one room. The host takes a slot and must see herself cut out on the
lobby's stage within seconds; the guest arrives as audience and finds the stage open (*Take a stage
slot*); the host switches it off, so he asks to sing, the host sees the request and lets him on;
both lobby stages then show two performers with video linked both ways — before any song. The
publisher's show view, opened in the lobby, receives both. With both mics open the test checks
talk-back (the arriving vocal plays on each stage device, and the host's device starts filming the
meet) and, once the song runs, Solo foldback (muted again). Then both
get ready and the host starts the song: the test asserts the same mesh carries on (no reconnection),
that both devices lay out two performers on the live stage with video linked both ways through the
SVT DB relay (cut-outs drawn on both halves), that the host's cued pause freezes both timelines
at the same position and that resume restarts both together. A third, privileged account (carol,
`PRIVILEGED_EMAILS=carol@dev.local` on the test service) then opens the Publishing **show view** of the
meet on a 1080p viewport: both performers arrive over the receive-only mesh and stand huge on the show
stage (tiles over 90 % of the frame height), there are no lyrics, the chrome hides itself while the
show plays, *Go live* queues a publish job (in-house destination), the pause shows on the show view,
*Stop publishing* ends the job — and the singers' own stage is unaffected. A second tab of the same
account opens Publishing › Preview while the show view stays up: the live meet's monitor tile
receives both performers, draws the exact 16:9 broadcast picture without lyrics, reports the publish
state, and the show view keeps its own links. Between the songs the host seats the wait-listed third singer, whose mic opens by itself (talk-back on, no
tap). The second song is picked twice at once: the guest
picks a song of his own (up at once — *picked is up*), the host picks the shared song a moment
later, and the test asserts the same choice card on every singer's device (both songs, who picked
what, a *Sing this one* for each, on the third singer's phone too), that Start is off while it is
open, that the picker offers neither song again (*Up now* / *Put forward*), and that one tap by the
guest settles it everywhere — the shared song up, his own gone. After the second song the host removes a listener
(his device says so; the link no longer lets him in) and ends the meet: the ended page lists the
two songs' shows and the **film of the whole meet as its chapters** — exactly the run the stage
made (on stage · the song · its restart · the jump to 0:02 · the pause · the song resumed · the
jump near the end · the stage between · the second act · the stage again), numbered in order with
nothing missing or merged, each named for what it is, each with its timestamp climbing, together
spanning the whole meet (the film never stopped at a Start, Pause, Stop or Restart), no song
chapter a sliver — and the guest finds the two shows and the same run of chapters under
Performances. The first song's chapter must be cut at the song's kickstart as the service had it
(within a couple of seconds; a moment ahead by design). The club owner flow replaces the old plan
grant: a plain account finds Publishing closed (*for club owners*), the Plans page offers the
year, the super admin grants it on the Admin page, and Publishing opens for that account at once
(`tools/ci/roles-e2e.mjs` has the rest). Runs in CI after the viewport screenshots:

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/live-duet.mjs screenshots
```

## Track search and the track database (`tools/ci/tracks-e2e.mjs`)

Four singers in one browser, each with a **Google Drive of their own faked in the test** (the unit
tests' FakeDrive, served over HTTP to the browser — `sv.googleApiBase` on the device points
`drive.ts` at it, a local address only — and to the service: `SV_FAKE_DRIVE_URL` sends sv-control's
token check and public file reads there, with a folder's sharing inherited by its files as Drive
does). The tabs are All · My Drive · Public catalog · YouTube, All first. alice imports a song; a
search registers nothing; her first **Sing** shares her folder (checked on the fake: the anyone
permission is real, and the URL is that folder), registers the song with a 12-character id, her file
ids and her name, records her first access (now, UTC) and writes the id into her track.json; a second
Sing adds no record. bob finds it under All with nothing typed (the latest sung, "by alice"); a
**preview** that plays is an access of his (the global instant moves, he is in his own history);
**Sing** brings the song through the service from alice's shared Drive into *his* Drive under
`Tracks/CI Sample Song`, byte for byte, carrying the id, shared and registered as a copy, and opens
it; sung again, his copy is opened, not made twice. His own "CI Sample Song" by another artist (an
.lrc names it) makes the second version: one song group — "2 versions · 2 artists" — folded until
opened, cascading by artist, every file with Sing; the groups and the versions sort by the latest
access on the page and in the database, and move when a song is sung again; histories are each
singer's own. alice **unshares** her folder: carol still gets the song, from bob's shared copy;
with every copy unshared, dave's Sing says the files are no longer shared, nothing is saved, no
access is counted, the record is marked unavailable and the row says so. A run of searches changes
no count. Runs in CI before the live meet.

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/tracks-e2e.mjs screenshots
```

## Roles, the Admin page and the instrument (`tools/ci/roles-e2e.mjs`)

A quick run (two minutes) of what every role comes to, read back from the service after every
change, never from the page that made it: the first account (alice) is the super admin and a new
one (bob) is dual; the service refuses the account list, a role change and every Publishing route
to anyone else (`403 publishing_closed`); the Admin page lists every account with a count per role
and turns a singer away. alice makes bob **audio only**: Settings on his device locks *Camera on
stage* with the reason, on alice's open stage he is seated with the *audio only · no camera* chip,
and the room carries `media: audio` for him to every device. She grants him a **club owner year**
on the Admin page: the service opens Publishing at once (a year from today, start and end kept),
his device opens the portal, his Plans page shows the year's end. She **sets the dates** to a year
that has run out: the subscription stands *expired*, Publishing is closed on the service with the
date in words and on his gate; **Renew** gives a year from today and opens it again; **Revoke**
closes it at once with the reason. The last super admin cannot be demoted (the toast says to make
another one first); a second super admin made on the page has the Admin page and Publishing on the
service at once and opens the page. Then the **instrument**: *Instrument* ticked in Settings lists
the audio inputs to pick from and keeps the input and its level on the device; in the room the
input opens with the microphone and is named on the mic status with its level; unticking closes it.

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/roles-e2e.mjs screenshots
```

### Sound checks — what a listener actually gets

**The mix lab (`tools/ci/mix-lab.mjs`, `npm run mix-lab`)** measures the audience's player on its
own, exactly: the real `MixPlayer` and the real `sv-mix-out` worklet run in Chromium on a song
encoded the way the host's device encodes the stage mix (Opus batches, one a second), on an
AudioContext at 48 kHz and again at 44.1 kHz (a laptop: every packet resampled), and six seconds of
the output are recorded on the audio thread (the `sv-tap` worklet) and measured
(`tools/ci/audio-measure.mjs`): the output is the song (normalised cross-correlation above 0.9 —
the capture is matched against the whole song by FFT in the band of a sweep the test song carries,
so the answer is a correlation coefficient and the exact track position), located within 0.3 s of
where the player says it is (the lyrics follow the sound), **not one click** (the song puts nothing
in the top of the spectrum, so a burst there is a seam — none), not one gap, the position advancing
at real time, 3–5 s behind the newest batch.

**The rider lab (`tools/ci/rider-lab.mjs`, `npm run rider-lab`)** measures the mix's automatic
vocal level: the real `sv-leveler` worklet with the real `VOCAL_RIDER` settings on an
OfflineAudioContext, fed a synthetic microphone (`apps/web/src/audio/riderLab.ts`: a steady hiss at
one level and, over it, the e2e's voice sung in two-second phrases) — a microphone that only hisses
at −40 dBFS comes out at −40 (never riden up; the old rider made it −22), a voice 12 dB over the
hiss comes out at the vocal target with the hiss between its phrases 12 dB under the target, a
quiet singer on a quiet microphone gets the full lift, a loud singer is brought down (the hiss with
them), a voice only 5 dB over the hiss leaves the rider shut, and the guard (`MIX_GUARD`, no floor
rule) holds a hot mix at the mix target.

**The live e2e** then measures the real pipeline, with the synthetic singing voice as every
microphone (a smooth harmonic voice, in phrases) and the test song (`tools/ci/e2e-song.mjs`: the
sample on a loop with a slow 4.5 → 7.5 kHz sweep under it, so any six seconds can be told exactly
where in the song they were):

- **the audience**: six seconds of exactly what an audience device plays (`window.__svMix`),
  recorded at the same moment as six seconds of the host's own mix (`window.__svStage`) — sound
  (RMS), **no gap** (10 ms or more of digital silence), **no click** (an isolated step of 0.25 or
  more, unmistakable whatever a codec adds), the **song itself** (correlation above 0.3 in the
  audience's output and in the host's mix), **where the mix player says it is** (within 0.75 s of
  the position the player reported as the capture began), and 3–8 s behind the stage — when the
  host's Opus encoder is starved on the test machine (its queue past 25 blocks, or blocks left out
  during the capture), the gap, click, song and position checks stand down and say so: the audience
  then hears the skips the bounded backlog makes, which is the broadcaster working as designed, and
  the player itself is measured exactly in the mix lab;
- **the broadcast**: six seconds of the publisher bus (`window.__svBroadcast.bus.output`, exactly
  what the encoder gets) against the host's mix at the same moment — sound, no gap, no click, the
  backing track in it (correlation above 0.3), and the track **where the singers are** (the stage's
  position less the quarter-second vocal lag, within a second).

The measurements print beside the checks (`audience sound: …`, `the host's mix: …`, `publisher bus
sound: …`). The unit side of the same thing is `apps/web/test/mixOut.test.ts`: the stateful
resampler keeps one curve across 20 ms blocks at 44.1 → 48 and 48 → 44.1 kHz, and the `sv-mix-out`
worklet (loaded with stand-ins for the AudioWorklet globals) waits for its cushion, plays packets
back to back without a seam at either rate, goes silent (not noisy) when dry and resumes once the
cushion is back.

**The HLS lab (`tools/ci/hls-lab.mjs`, `npm run hls-lab`)** measures what the watch page plays: the
browser's own muxer (`apps/web/src/broadcast/tsMuxer.ts`) runs in Node on real H.264 + AAC that
ffmpeg made, packetised and cut into one-second segments exactly as the show view's encoder does
(video stamped on a 30 fps clock, four ADTS frames per audio PES, a cut at every keyframe), the
segments are served as a live playlist that grows one a second, and Chromium plays it through
hls.js with the watch page's own settings — with sound and without (the live e2e can only ever run
video-only, since the headless browser has no AAC encoder). The first segment must probe as H.264 +
AAC with the sound starting beside the picture; the player must start within a few seconds, keep
advancing (≥ 5 s played in 12), and raise no fatal error.

**The camera watchdog and the cut-out model** are unit-tested in Node with a fake DOM
(`apps/web/test/segmenter.test.ts`, `feedHealth.test.ts`): a model that stops answering hands the
picture to the silhouette within three seconds and gets it back the moment it answers, a new camera
is never blocked by a frame the old one still owes, a track's mute / ended events are reported at
once, a camera whose frames were flowing and stop for five seconds is called frozen (and a camera
whose frames never flowed, a hidden page or a muted track is never judged by frames).

**A still picture** (`feedHealth.test.ts`, `stageStill.test.ts`): a camera presenting the same
picture (the model measuring the singer exactly the same, cut-out after cut-out) is called frozen
after `STILL_AFTER` seconds and ok once it moves; a pixel of sway, the silhouette, or nobody in the
picture never is. On the stage, a remote performer whose frames arrive with the same 16×21 sample
for `STILL_AFTER_MS` is marked still (`onStill`), a changed picture unmarks them, frames that stop
give the placeholder and no mark, and a performer gone from the stage is forgotten.

**The stage frame and the seat** (`apps/web/test/framing.test.ts`, `seat.test.ts`): the head is
found crown to jaw and ear to ear on synthetic figures near and far, a blob the model lit elsewhere
(a plant) never moves the crown, a collar widening right under the jaw never swallows the head, a
fragment or the figure itself measured as a head is not plausible (a close-up is); the seat draws
the whole camera frame while settling, glides once to the stage frame of the median head and holds
it exactly, holds under wobble in place and size for half a minute, ignores a second of a different
head and follows a singer who moved and stayed in one glide, never follows measurements that
disagree (a model losing and finding the figure), and holds when nobody is found.

**The track database** (`packages/protocol/test/registry.test.ts`, `services/control/test/app.test.ts`,
`apps/web/test/registry.test.ts`): the ids (8 random characters from an alphabet without 0/O/1/I, the
month minted, the same way everywhere), the song keys that group one song's files, the reading of a
karaoke title; the service — one record per source with the blanks filled and never blanked, the
catalog mirrored, an access moving the global and the singer's own instants in UTC while searches and
copies move nothing, the groups sorted by the latest access, pages, the owner's (or a super admin's)
metadata patch; the files handed over from the owner's Drive, then from any singer's shared copy, the
record marked unavailable when none is left and available again on a new copy. The singer's side: a
track of their own shared and registered on its first Sing with the id written into the track.json,
once; somebody else's record sung — the files through the service, the copy under Tracks carrying the
id, shared and registered, found and not copied twice the next time; the service's refusal passed on
with nothing saved; a preview's audio.

**YouTube song tracks** (`services/relay/test/yt.test.mjs`, `apps/web/test/ytTracks.test.ts`,
`drive.test.ts`, `services/control/test/app.test.ts`): the relay runs a search and a whole fetch job
against a stub yt-dlp (a search answered as yt-dlp prints it, a 20 MB "download", YouTube's refusals in
its words), a stub ffprobe and ffmpeg, and a stand-in for Google's API — the two files reach the folder
in ordered pieces with the properties the app looks for, the video alone is shared anyone-with-the-link,
the token is never in an answer, a private video ends the job with the reason. The browser's import
runs against the fake Drive and a fake service: the folder under `Tracks/YT` first, the relay's words on
the bar, the track.json written beside the relay's files, a video track listed and loaded, nothing left
of a failed job; the stage's way to the video (the owner's token, else the service by the catalog entry
a copy came from), fetched once. sv-control: nothing without the relay, the search and the job through
it with the singer's own token, the catalog entry carrying the video, the video proxied like the audio.

**What the saved files hold** — the live e2e decodes three of them with ffmpeg at the end of the
run and measures six seconds of each: the song's saved show (a singer's take), the host's **film of
the whole meet** (the first song's chapter, at the moment of the first song it measured live, found
where the chapter's own timestamp puts it) and the publisher's **footage of the broadcast** (the
chapter that holds the moment it measured on the bus) must all carry the song (the backing track
located by correlation) and the voice. **Orientation**: the fake person wears a magenta badge on the
camera's left of the head and a yellow one on the right; a frame of the saved show and a frame of
the film must keep magenta left of yellow — the picture as the camera saw it, not a mirror (the
screen alone mirrors the singer's own camera, as a mirror does). The voice is told
from the song by its harmonics: the fake microphone sings a vibrato on 180 Hz (a phase modulation,
each harmonic a line ±1.2 % wide), and `voice` in `tools/ci/audio-measure.mjs` reads the power at
those harmonics against the bands between them, against the same figure for the song alone at the
same position — a mix with the voice stands many dB above; a mix without it reads like the song.
The same figure is checked live on the host's mix, the audience's sound and the publisher bus.

### Instant changes and the footage

In the same run a singer on his phone switches the **stage background from the live stage**; a
MutationObserver in every other page notes, on that page's own clock, the moment the new
background is in its DOM, so the test machine's polling of four busy browsers never counts: the
word must have gone out over the mesh to both peers (the other singer and the show view), every
page must have the new background within two polls (the show view under 4 s, the audience under
5 s, the host's stage under 5 s not counting the time its main thread was blocked — the host's is
the busiest page on one machine running four browsers, and the watchdog's stalls that overlap
the switch are the machine's, not the app's; the timings print beside the check, and on a real
device the word arrives within a few hundred milliseconds), and the broadcast picture
(`__svBroadcast.picture.backgroundId`) must draw it. The playlist the fake YouTube received must
say each segment is about a second (0.9–2 s: a keyframe is asked for at the first grab a second
after the last, so a late grab makes a longer segment, never a shorter one), and the segment
itself must probe as a second of frames unless the encoder left frames out (`stats.dropped`). On
this one machine the pages' main threads stall for seconds at a time, so a few checks read the
state rather than a moment: the lobby waits for the link itself (`data-linked`), the Preview tile
counts as receiving both performers when both links are up and both are drawn (frames advancing
inside one 1.5 s window is printed beside it), the two singers' "saved" chips are watched at once
(a chip stays 20 s), and a tap on the show view's self-hiding chrome wakes it first and counts as
landed when the button is gone afterwards. While the
broadcast is on air the bar must say the **footage** is being recorded into the publisher's storage
(`[data-footage="recording"]`), *Stop publishing* must complete it (`saved`), and at the end the
publisher's Performances page must list *Broadcast* with its video. The show view's own **stream
check** (`[data-stream-check="ok"]`: the playlist played back on a hidden player half a minute in)
must say the stream plays, the bar must carry the **Mic off** chip, and the public watch page must
offer no way into the meet.
