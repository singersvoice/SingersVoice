# SingersVoice v2

Lyrics-first karaoke for **iOS, Android and the web** — one TypeScript codebase, installable as a PWA, with every
track and take stored in the singer's **own Google Drive** (`SingersVoice/…`). Solo rehearsal works today from a
static host (GitHub Pages); live meets (up to 10 performers on stage, unlimited audience with chat) run on the
`sv-control` service and per-meet session containers described in the v2 implementation plan.

**Test it now:** https://singersvoice.github.io/SingersVoice/ — on a phone, open it in Safari (iOS) or Chrome (Android)
and use *Share → Add to Home Screen* / *Install app* to get the standalone app with the SingersVoice icon.

## Four portals, loosely coupled

| Portal | What it does | Depends on |
| --- | --- | --- |
| **Tracks** (`/tracks`) | Your tracks in Drive; the **public catalog (SVT DB)** — publish a track (Drive folder shared anyone-with-link + catalog entry) so any singer can pull it into their own Drive; imports (SVOld `.trackmaker.json`, `track.json`, `.lrc`), sharing, export | Drive; catalog needs sv-control |
| **Studio** (`/studio`) | Offline: 4-step Track Maker, lyrics-first solo Sing with VoxForge, takes → Temp (7 days) → Keep | Drive only |
| **Live Meets** (`/meets`, `/meet/:id`) | Create a meet → link + 6-letter code; anyone with it joins; up to 10 stage slots, unlimited audience with chat; **GMT kickstart**: every device starts the track at the same server instant; each performer's take is a personal session kept in their own Drive (`Performances/Live`); the meet **self-expires after 5 idle minutes** | sv-control |
| **Publishing** (`/publishing`, `/publishing/show/:id`, `/watch/:id`) | Privileged users only, its own portal: destinations (YouTube, Facebook, Instagram, Twitch, in-house portal) with encrypted stream keys; **Publish** opens the **show view** — the performers cut out of their cameras and huge on one stage, no lyrics, a self-hiding broadcast bar (Go live / Stop, backing track in sync, full screen); jobs per meet, history; public watch page with lyrics + chat | sv-control (+ session container for the actual encoder, next increment) |

**Sign-in is Google-only and mandatory** (Drive is the system of record). A build without `VITE_GOOGLE_CLIENT_ID` offers a *developer preview* on-device mode so CI and local testing never block on Google.

## Status

| Area | Status | Notes |
| --- | --- | --- |
| Sign-in + Google Drive link | ✅ browser-only OAuth (`drive.file`), folder tree created at onboarding | needs `VITE_GOOGLE_CLIENT_ID` ([docs/GOOGLE_OAUTH.md](docs/GOOGLE_OAUTH.md)) |
| Track Maker / Sing / Performances | ✅ | see Studio |
| VoxForge voice | ✅ Web Audio chain + pitch/auto-tune worklet, 8 presets, tempo with key kept, key shift | presets autosave to `Config/audio_plugin_settings.json` |
| Virtual stage | ✅ singers cut out of their cameras (on-device segmentation) and placed side by side on the stage background, 1–10 performers, no boxed tiles | soft-focus oval when the model can't load |
| Recording | ✅ sample-accurate WAV + camera video, pause/resume on the track timeline; resumable, md5-verified uploads | |
| Public catalog (SVT DB) | ✅ publish / unpublish / search / pull | sv-control |
| Live meets | ✅ rooms, slots, ready, chat, kickstart sync, host pause/resume/restart cued for everyone, performer video mesh on one virtual stage, personal takes, 5-min expiry, watch page | performers don't hear each other (Solo foldback by design); the audience stream needs the session container |
| Publishing | ✅ own portal for privileged accounts: destinations + **show view** (performers huge, no lyrics, receive-only video, backing track in sync) + jobs + history + in-house watch page | the encoder (RTMPS push, LL-HLS) is the session container, next increment; until then, capture the show view (e.g. OBS window capture) to stream it |
| sv-control | ✅ Hono on Node 22 (node:sqlite) **and** Cloudflare Workers (SQLite Durable Object); Google token auth; tests + boot smoke | [docs/DEPLOY_CONTROL.md](docs/DEPLOY_CONTROL.md) — one workflow run after two secrets |
| Session container (mixer/encoder) | ⏳ next | mediasoup ingest · VoxForge C++ mixer · FFmpeg → RTMPS/LL-HLS |

## Repository layout

```
apps/web/              Preact + Vite + TypeScript PWA (the iOS / Android / web client)
  src/portals/         tracks · studio · meets · publishing — independent portals, shared only via lib/ and the protocol
  public/brand/        logo kit (from SVOld/assets/Logo), PWA icons, welcome loop
  public/backgrounds/  stage & publishing backgrounds (from SVOld/assets/Backgrounds, WebP)
  public/worklets/     AudioWorklets: pitch-shifter + auto-tune, sample-accurate recorder
  src/audio            engine, VoxForge chain, backing player, recorder
  src/lib/storage      StorageProvider: Google Drive (drive.file) and this-device (IndexedDB)
  src/screens          Welcome/Setup, Home, Library, TrackMaker, Sing, Performances, Meets, Settings
packages/protocol/     shared types + pure helpers (track v2, lyrics window, LRC, performance manifest,
                       VoxForge params/presets, Drive layout, meet messages) — 100 % unit-tested
services/control/      sv-control = the SVT DB API (Hono): catalog, meets, chat, kickstart clock, publishing — Node 22 or Cloudflare Workers (Durable Object)
tools/brand/           make_brand.py (icons from the logo render), export_logo_blender.py (render SV.blend)
tools/backgrounds/     convert.sh (jpg/mp4 → web sizes + index.json)
tools/ci/              check-budget.mjs, screenshots.mjs (viewport matrix + solo and live-meet e2e), control-smoke.mjs
tools/cf/              deploy.mjs — sv-control to Cloudflare Workers in one run; control-url.mjs — finds the service URL for Deploy web
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
- **sv-control (SVT DB):** add `CLOUDFLARE_API_TOKEN` (plain "Edit Cloudflare Workers" token) + `CLOUDFLARE_ACCOUNT_ID`
  secrets and run *Deploy sv-control* — it deploys the worker (SQLite Durable Object inside, nothing else to create) and
  redeploys the web app with the worker URL; *Deploy web* also discovers that URL by itself ([docs/DEPLOY_CONTROL.md](docs/DEPLOY_CONTROL.md)).
  Or `docker compose up --build` / any Node 22 host.

## Restore points

`restore/RP1` is the branch frozen before v2 execution (the repo moved from `namballa2025/SingersVoice` to the `singersvoice` org on 2026-11-11; all branches moved with it) (the old scaffold + Terraform PR). See
[docs/RESTORE_POINTS.md](docs/RESTORE_POINTS.md) for how to go back or branch from it.

## Plan

The full v2 implementation plan (architecture, reliability, Drive layout, rules matrix, enterprise gates, costs,
phases) is the Claude Doc shared in the project; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the short version
kept with the code.
