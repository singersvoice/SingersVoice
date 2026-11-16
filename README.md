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
| **Live Meets** (`/meets`, `/meet/:id`) | A karaoke event ([docs/LIVE_MEET_FLOW.md](docs/LIVE_MEET_FLOW.md)): create a meet (up to 3 open per host; end / delete from the list; several in parallel tabs) → you are on stage at once (S1, camera on) with a link + 6-letter code; the room keeps running behind other pages (Return / Leave pill); anyone with it joins **as audience**; they **ask to sing** and the host (admin) lets them on stage (or opens the stage to all); up to 10 stage slots; **the stage is live from the first slot taken**; **one song at a time** — any singer on stage picks it from their Drive library or the public catalog and it is up on every device at once; two picked at the same time → every singer sees the same choice card and one tap settles it; any singer starts, pauses, seeks and stops it; **GMT kickstart**: every device starts the track at the same server instant; host pause/resume/restart/end song; each performer's take is a personal session kept in their own Drive (one file, straight under `Performances`); the meet **self-expires after 5 idle minutes** | sv-control |
| **Publishing** (`/publishing`, `/publishing/show/:id`, `/watch/:id`) | Privileged users only, its own portal: destinations (YouTube, Facebook, Instagram, Twitch, in-house portal) with encrypted stream keys and each platform's **live link** (the page viewers open — one button per platform while on air hands it over), set up right on the Publish tab; **Publish** opens the **show view** — the performers cut out of their cameras and huge on one stage, no lyrics, the track and every singer's vocal blended, a self-hiding broadcast bar (Go live / Stop, monitor switches, full screen); **Go live** makes the browser the encoder (WebCodecs H.264 + AAC → one-second MPEG-TS segments → the service → **YouTube's HLS ingestion** (forwarded after the answer, never in its way; the key must be one YouTube made for HLS) and the **in-house watch page**, which plays the show via HLS); **Preview** monitors every open meet with the exact picture; jobs per meet, history; public watch page: the show (or the stage mix) + chat, never lyrics, and no way into the meet from it; the show view never opens a microphone (a **Mic off** chip says so) and checks its own stream half a minute in | sv-control; the **RTMP relay** (`services/relay`, docs/RELAY.md) for YouTube at ultra-low latency and Facebook / Instagram / Twitch |

**One set of names everywhere.** The portals are the same entries on the Home cards, in the side
menu of a wide screen and in a phone's tab bar: **Home · Tracks** (with **Track Maker** listed under
it) **· Studio · Live Meets · Publishing · Performances · Settings** — a phone's bar holds the first
four and **More**, which opens the rest. The brand mark is in motion in the top-left corner (its
small loop; the still mark for anyone who turns motion off) and, mid size and faint, in the
bottom-right corner of every screen as a watermark (the corner of the picture on a full-screen
stage, under the header in the show view).

**Sign-in is Google-only and mandatory** (Drive is the system of record). A build without `VITE_GOOGLE_CLIENT_ID` offers a *developer preview* on-device mode so CI and local testing never block on Google.

## Status

| Area | Status | Notes |
| --- | --- | --- |
| Sign-in + Google Drive link | ✅ browser-only OAuth (`drive.file`), folder tree created at onboarding | needs `VITE_GOOGLE_CLIENT_ID` ([docs/GOOGLE_OAUTH.md](docs/GOOGLE_OAUTH.md)) |
| Track Maker / Sing / Performances | ✅ | see Studio |
| VoxForge voice | ✅ Web Audio chain + pitch/auto-tune worklet, 8 presets, tempo with key kept, key shift | presets autosave to `Config/audio_plugin_settings.json` |
| Virtual stage | ✅ singers cut out of their cameras (on-device segmentation) and placed in one straight row on the stage background — **every singer the same size** (each device frames its singer's head the same size at the same place, however near or far they sit — a frame set once and held like a stage camera's, never steered after a sway), evenly spaced, every head at the same height, behind a lit riser, 1–10 performers, no boxed tiles | soft-focus oval when the model can't load |
| Recording | ✅ sample-accurate WAV + camera video, pause/resume on the track timeline; resumable, md5-verified uploads | |
| Public catalog (SVT DB) | ✅ publish / unpublish / search / pull | sv-control |
| Live meets | ✅ rooms, host on stage at creation, **open stage by default** (whoever has the link takes a slot; the host can switch to ask-and-permit), only the host removes anyone from the meet, **talk-back** between songs (the stage hears each other, the audience hears the stage) and Solo foldback during the song, the host's device **films the whole meet into Drive** as it goes (one video, "Full meet"), stage live from the lobby (camera cut-out at once, video mesh before the song), one song at a time (library / catalog picker, picked is up, the stage's choice card when two are picked, song over → the one put forward), ready, chat, kickstart sync, transport cued for everyone (pause/resume/restart/seek), late singers mid-song, personal takes saved by themselves, the audience hears the stage mix (~4 s behind, one continuous sound) and watches the show when a publisher is on air, 5-min expiry, watch page | performers don't hear each other (Solo foldback by design); lyrics only for singers on stage |
| Publishing | ✅ own portal for the **Publisher plan** (paid through Stripe, docs/BILLING.md; admins free): destinations + **show view** (performers huge, no lyrics, the whole mix) that **encodes and sends the show itself** (YouTube HLS ingestion + in-house HLS) + **Preview** monitor wall + jobs + history + in-house watch page | the RTMP relay (one container, docs/RELAY.md) takes YouTube from 20–40 s to 4–7 s behind and opens Facebook / Instagram / Twitch; AAC sound needs Chrome/Edge on Windows/Mac (Linux Chrome, Firefox: video only) |
| sv-control | ✅ Hono on Node 22 (node:sqlite) **and** Cloudflare Workers (SQLite Durable Object); Google token auth; tests + boot smoke | [docs/DEPLOY_CONTROL.md](docs/DEPLOY_CONTROL.md) — one workflow run after two secrets |
| sv-relay (RTMP out) | ✅ `services/relay`: Node + ffmpeg container (Fly.io scale-to-zero or any Docker host) — the browser's segments → RTMP(S), `-c copy` | [docs/RELAY.md](docs/RELAY.md): `fly launch`, two secrets, `fly deploy` |

## Repository layout

```
apps/web/              Preact + Vite + TypeScript PWA (the iOS / Android / web client)
  src/portals/         tracks · studio · meets · publishing — independent portals, shared only via lib/ and the protocol
  public/brand/        logo kit (from SVOld/assets/Logo), PWA icons, welcome loop
  public/backgrounds/  stage & publishing backgrounds (from SVOld/assets/Backgrounds, WebP)
  public/worklets/     AudioWorklets: pitch-shifter + auto-tune, sample-accurate recorder, the mix tap and mix-out (the audience's sound), a diagnostic tap
  src/audio            engine, VoxForge chain, backing player, recorder
  src/lib/storage      StorageProvider: Google Drive (drive.file) and this-device (IndexedDB)
  src/screens          Welcome/Setup, Home, Library, TrackMaker, Sing, Performances, Meets, Settings
packages/protocol/     shared types + pure helpers (track v2, lyrics window, LRC, performance manifest,
                       VoxForge params/presets, Drive layout, meet messages) — 100 % unit-tested
services/control/      sv-control = the SVT DB API (Hono): catalog, meets, chat, kickstart clock, publishing — Node 22 or Cloudflare Workers (Durable Object)
tools/brand/           make_brand.py (icons from the logo render), export_logo_blender.py (render SV.blend)
tools/backgrounds/     convert.sh (jpg/mp4 → web sizes + index.json)
tools/ci/              check-budget.mjs, screenshots.mjs (viewport matrix + solo and live-meet e2e), live-duet.mjs, audio-measure.mjs (clicks, gaps, the song located in a capture), mix-lab.mjs (the audience's player, measured), hls-lab.mjs (the watch page's player on the browser's own muxer, with sound), e2e-song.mjs, audio-lab.mjs (the vocal chain and mix bus, measured), control-smoke.mjs
tools/cf/              deploy.mjs — sv-control to Cloudflare Workers in one run; control-url.mjs — finds the service URL for Deploy web
docs/                  GOOGLE_OAUTH.md, RESTORE_POINTS.md, ARCHITECTURE.md, TESTING.md, BILLING.md
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
npm run audio-lab        # the vocal chain and mix bus rendered offline in Chromium and measured
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
