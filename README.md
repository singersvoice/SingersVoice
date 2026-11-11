# SingersVoice v2

Lyrics-first karaoke for **iOS, Android and the web** — one TypeScript codebase, installable as a PWA, with every
track and take stored in the singer's **own Google Drive** (`SingersVoice/…`). Solo rehearsal works today from a
static host (GitHub Pages); live meets (up to 10 performers on stage, unlimited audience with chat) run on the
`sv-control` service and per-meet session containers described in the v2 implementation plan.

**Test it now:** https://singersvoice.github.io/SingersVoice/ — on a phone, open it in Safari (iOS) or Chrome (Android)
and use *Share → Add to Home Screen* / *Install app* to get the standalone app with the SingersVoice icon.

## What's in the box

| Area | Status | Notes |
| --- | --- | --- |
| Sign-in + Google Drive link | ✅ browser-only OAuth (`drive.file`), folder tree created at onboarding | needs `VITE_GOOGLE_CLIENT_ID` (see [docs/GOOGLE_OAUTH.md](docs/GOOGLE_OAUTH.md)); without it the app runs in **device mode** (IndexedDB) |
| Track Maker | ✅ 4 steps: Source → Lyrics → Timing (tap-to-mark, waveform, nudge, auto-space) → Save | imports SVOld `*.trackmaker.json`, v2 `track.json`, `.lrc` |
| Sing (lyrics-first stage) | ✅ 16 / 60 / 24 % layout, 1 done + 1 active + 3 upcoming lines, singer-slot badges, cue deck, 3-2-1 count-in | backing track + lyrics + recorder share one audio clock |
| VoxForge voice | ✅ Web Audio chain (trim → pitch/auto-tune worklet → HPF → 3-band EQ → comp → sat → chorus → stereo delay → reverb → out), 8 presets, tempo 0.5–1.5× with key kept, key shift ±6 st | presets autosave to `Config/audio_plugin_settings.json` |
| Recording | ✅ sample-accurate WAV vocal (AudioWorklet) + camera video (MediaRecorder); auto-saved to **Temp** (7 days), **Keep** moves it to `Performances/Offline` | uploads are resumable and md5-verified |
| Camera | ✅ Wide / Mid / Close presets, AutoZoom intro, face auto-frame (where `FaceDetector` exists), front/back flip, optional person cut-out (MediaPipe, lazy-loaded) | |
| Library / Performances / Settings | ✅ search, share (anyone-with-link or a Google account), export, delete; playback with alignment nudge; device pickers, text scale 1.0–2.0, backgrounds | |
| Meets | 🟡 stage preview + chat layout + protocol; `services/control` skeleton (rooms, slots, GMT kickstart, chat) | goes live once sv-control is deployed and `VITE_CONTROL_URL` is set |
| Session container (mixer/encoder) | ⏳ V3 | mediasoup ingest · VoxForge C++ mixer · FFmpeg → RTMPS/LL-HLS |

## Repository layout

```
apps/web/              Preact + Vite + TypeScript PWA (the iOS / Android / web client)
  public/brand/        logo kit (from SVOld/assets/Logo), PWA icons, welcome loop
  public/backgrounds/  stage & publishing backgrounds (from SVOld/assets/Backgrounds, WebP)
  public/worklets/     AudioWorklets: pitch-shifter + auto-tune, sample-accurate recorder
  src/audio            engine, VoxForge chain, backing player, recorder
  src/lib/storage      StorageProvider: Google Drive (drive.file) and this-device (IndexedDB)
  src/screens          Welcome/Setup, Home, Library, TrackMaker, Sing, Performances, Meets, Settings
packages/protocol/     shared types + pure helpers (track v2, lyrics window, LRC, performance manifest,
                       VoxForge params/presets, Drive layout, meet messages) — 100 % unit-tested
services/control/      sv-control (Hono + WebSocket on Node 22): meets, stage slots, kickstart clock, chat
tools/brand/           make_brand.py (icons from the logo render), export_logo_blender.py (render SV.blend)
tools/backgrounds/     convert.sh (jpg/mp4 → web sizes + index.json)
tools/ci/              check-budget.mjs (400 KB gz first load), screenshots.mjs (viewport matrix + stage e2e)
docs/                  GOOGLE_OAUTH.md, RESTORE_POINTS.md, ARCHITECTURE.md, TESTING.md
```

## Develop

```bash
npm i -g npm@12          # npm 10 hits a workspace peer-dependency bug
npm ci
npm run dev              # http://localhost:5173  (device mode unless VITE_GOOGLE_CLIENT_ID is set)
npm test                 # vitest across workspaces
npm run typecheck
npm run build            # apps/web/dist (+404.html, .nojekyll, version.json)
npm run budget           # first-load gzip budget
npm run screenshots      # Playwright walk at 320/360/390/412/820/1280 px (needs playwright)
npm run control          # sv-control on :8787
```

Local Google sign-in: create `apps/web/.env.local` with `VITE_GOOGLE_CLIENT_ID=…` (never committed; CI scans for
credentials).

## Deploy

- **Web / iOS / Android (PWA):** push to `main` → `.github/workflows/deploy-web.yml` builds with
  `BASE_PATH=/SingersVoice/` and publishes to GitHub Pages. Set repo *Variables* `VITE_GOOGLE_CLIENT_ID`
  (and optionally `VITE_GOOGLE_API_KEY`, `VITE_CONTROL_URL`). GitHub Pages is for testing; before commercial use move
  the same `dist/` to Cloudflare (static assets + Worker, see the Terraform in PR #1 / branch
  `infra/terraform-cloudflare`).
- **sv-control:** `docker compose up --build` locally; the image in `services/control/Dockerfile` runs on any
  container host (Fly Machines, DOKS, GKE Autopilot — costed in the plan).

## Restore points

`restore/RP1` is the branch frozen before v2 execution (the repo moved from `namballa2025/SingersVoice` to the `singersvoice` org on 2026-11-11; all branches moved with it) (the old scaffold + Terraform PR). See
[docs/RESTORE_POINTS.md](docs/RESTORE_POINTS.md) for how to go back or branch from it.

## Plan

The full v2 implementation plan (architecture, reliability, Drive layout, rules matrix, enterprise gates, costs,
phases) is the Claude Doc shared in the project; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the short version
kept with the code.
