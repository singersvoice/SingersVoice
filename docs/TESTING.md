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
- **Live Meets** — Create meet (pick a *public* track so others can load it) → share the link/code → performers *Take a stage slot* → *I'm ready* → host *Start the song (8 s count-in)* → everyone's stage starts at the same instant → *Finish* → Keep → the take lands in `Performances/Live` and is listed on the meet's ended page. Idle 5 minutes → the meet closes itself.
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
on two of them imports a track, sings 9 s with a fake microphone, finishes, keeps the take and opens Track Maker.
CI uploads the screenshots as an artifact on every PR.

## Known limits of this increment

- Live meets, the catalog and publishing need `sv-control` deployed (`VITE_CONTROL_URL`) — see docs/DEPLOY_CONTROL.md; the portals explain this inline until then.
- Performers do not hear each other (Solo foldback, by design); the audience hears the composed stream only once the session container exists.
- The "Import a track shared with me" button needs `VITE_GOOGLE_API_KEY` (Google Picker).
- Tempo changes are real-time granular time-stretch on the backing track (key kept); extreme values sound grainy.
- On iOS the Google sign-in popup must be triggered by a tap (it is), and tokens last 1 h → *Reconnect Drive*.
