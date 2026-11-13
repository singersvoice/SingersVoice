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
- **Live Meets** — Create meet (pick a *public* track so others can load it) → share the link/code → performers *Take a stage slot* → *I'm ready* → host *Start the song (8 s count-in)* → everyone's stage starts at the same instant → *Finish* → the take lands as one file in `Performances` and is listed on the meet's ended page. Idle 5 minutes → the meet closes itself.
- **Publishing** (privileged accounts) — Destinations (stream keys), Publish a meet, History; `/watch/<meetId>` is the public in-house page.

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
take, opens Track Maker, runs a meet and the publishing setup — every control a singer has (framing, Track / Vocal
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
lobby's stage within seconds; the guest arrives as audience, cannot take a slot, asks to sing, the
host sees the request and lets him on; both lobby stages then show two performers with video linked
both ways — before any song. The publisher's show view, opened in the lobby, receives both. Then both
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
state, and the show view keeps its own links. Runs in CI after the viewport screenshots:

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/live-duet.mjs screenshots
```
