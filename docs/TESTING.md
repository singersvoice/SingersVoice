# Testing SingersVoice on iOS, Android and the web

Live build: **https://singersvoice.github.io/SingersVoice/**

## Install as an app

- **iOS (Safari):** open the URL → Share → *Add to Home Screen*. Launch from the icon. Keep the app in the foreground
  while singing (iOS pauses the microphone for background web apps). Wired or Bluetooth headphones recommended.
- **Android (Chrome):** open the URL → menu → *Install app* (or the install banner). Launch from the icon.
- **Desktop (Chrome/Edge/Safari):** just open the URL; Chrome offers *Install* in the address bar.

## Portals at a glance

- **Tracks** — My Drive / Public catalog tabs; *More → Publish to public catalog* shares the Drive folder and lists the track for everyone; *Add to my Drive* pulls a catalog track.
- **Studio** — Track Maker, Sing, Performances (unchanged flows, now under `/studio`).
- **Live Meets** — Create meet (pick a *public* track so others can load it) → share the link/code → whoever has the link takes a slot with *Take a stage slot* (the stage is open; the host can switch to deciding each one) → with headphones on, the singers on stage hear each other and the audience hears the stage (talk-back) → *I'm ready* → host *Start the song (8 s count-in)* → everyone's stage starts at the same instant, nobody on stage hears anyone else → the song ends → the take lands as one file in `Performances` and is listed on the meet's ended page; the host's device films the whole meet into their Drive as it goes (*Full meet*, on the ended page too). Only the host can remove someone (*out* on a slot, × on a name). Idle 5 minutes → the meet closes itself.
- **Publishing** (Publisher plan or admin) — Destinations (stream keys, saved once), Publish a meet, History; **Publish** in the room opens the show view; `/watch/<meetId>` is the public in-house page. With the RTMP relay deployed (docs/RELAY.md) YouTube runs at ultra-low latency and Facebook / Instagram / Twitch go live.

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
two songs' shows and the film of the whole meet (long enough to span both songs), and the guest
finds all three under Performances. Runs in CI after the viewport screenshots:

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/live-duet.mjs screenshots
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
