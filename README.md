# SingersVoice v2

A lyrics-first singing app for **iOS, Android and the web** — for everyone who lives and breathes music — one TypeScript codebase, installable as a PWA, with every
track and take stored in the singer's **own Google Drive** (`SingersVoice/…`). The app is a static site (Cloudflare Pages at
**www.singersvoice.com**; the GitHub page `singersvoice.github.io/SingersVoice/` while the move is on — docs/HOSTING.md); live
meets (up to 10 performers on stage, unlimited audience with chat) run on the `sv-control` service and the relay.

**Test it now:** https://www.singersvoice.com/ — on a phone, open it in Safari (iOS) or Chrome (Android)
and use *Share → Add to Home Screen* / *Install app* to get the standalone app with the SingersVoice icon.

## Four portals, loosely coupled

| Portal | What it does | Depends on |
| --- | --- | --- |
| **Tracks** (`/tracks`) | **All** — one search across the **SingersVoice track database** (the master database: every song anyone has sung, from YouTube, from a singer's Drive or from the catalog, with its artist, movie, year, language, a shareable Drive URL and when it was last sung — grouped by song name into an expandable tree, the latest sung first; **Sing** on any version brings the song into *your* Drive under Tracks, shares it, registers your copy and opens the stage; a preview plays it here), your Drive, the public catalog and YouTube; **Recommended** — what the singers on stage bookmarked (every stage singer's bookmarks together, saying whose, while you are in a meet) and the songs in the languages you prefer (Settings → *Songs you prefer*: languages and countries; nothing set → a dropdown asks you there), the most sung first; **Bookmarks** — the star on any song (a database record, a catalog entry, a YouTube result, a track of your own Drive) keeps it on your account, singable from here; **My Drive**; the **public catalog (SVT DB)** — the entries in your languages first (*Every language* a tap away); publish a track (Drive folder shared anyone-with-link + catalog entry) so any singer can pull it into their own Drive; **YouTube song tracks** — search YouTube for a backing-track video and bring it into your Drive (`Tracks/YT`, the video shared by link, its sound as the backing track; the video stands in for the lyrics on stage, here and in a meet); imports (SVOld `.trackmaker.json`, `track.json`, `.lrc`), sharing, export. Every Sing (solo or in a meet) and every preview that plays is an access on record — never a search | Drive; the database and the catalog need sv-control; YouTube tracks need the relay (docs/RELAY.md) |
| **Studio** (`/studio`) | Offline: 4-step Track Maker, lyrics-first solo Sing with VoxForge, takes → Temp (7 days) → Keep; **Invite others to join** a take — anyone with the link sings their part over it, their voice and picture beside yours on one stage (the camera is every Studio singer's; a plan gates live meets alone), and the result can be joined in turn — **Joined yours** on Performances shows who did | Drive; sv-control for joining |
| **Live Meets** (`/meets`, `/meet/:id`) | A singing event ([docs/LIVE_MEET_FLOW.md](docs/LIVE_MEET_FLOW.md)): create a meet (up to 3 open per host; end / delete from the list; several in parallel tabs) → you are on stage at once (S1, camera on) with a link + 6-letter code; the room keeps running behind other pages (Return / Leave pill); anyone with it joins **as audience**; they **ask to sing** and the host (admin) lets them on stage (or opens the stage to all); up to 10 stage slots; **the stage is live from the first slot taken**; **one song at a time** — any singer on stage picks it from their Drive library or the public catalog and it is up on every device at once; two picked at the same time → every singer sees the same choice card and one tap settles it; any singer starts, pauses, seeks and stops it; **GMT kickstart**: every device starts the track at the same server instant; host pause/resume/restart/end song; nothing is saved per song — the host's device films the whole meet into their Drive as one file with a chapter mark per song (straight under `Performances`, for everyone who was in the meet); the meet **self-expires after 5 idle minutes** | sv-control |
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
| Instant stage | ✅ the service **pushes** every change to every device in a meet (one event stream per device, SSE) — a slot taken, a song picked, a transport cue, a chat line shows on the other screens in a few hundred milliseconds, the polls now only a safety net; the camera pipeline (cut-out model, framing, packing) runs **in a worker**, so taps and the song start never wait behind it; the singing screen is lyrics-first — the words up from the count-in, the singers in a strip below, one row of controls (Sound settings in a drawer) | `tools/ci/latency-probe.mjs` measures it (docs/TESTING.md) |
| The TV in the room | ✅ the TV's browser opens **www.singersvoice.com/tv** (no sign-in) and shows a four-letter code and a QR; the singer taps **TV** on the stage and types the code (or scans the QR) — the TV shows the stage big, the words on top, the picture below (or either alone: Settings → TV), the clock running; the picture goes straight from the phone to the TV over the room's Wi-Fi, the service carries only the handshake; the sound stays on the phone | `tools/ci/tv-e2e.mjs` |
| Recording | ✅ sample-accurate WAV + camera video, pause/resume on the track timeline; resumable, md5-verified uploads | |
| Public catalog (SVT DB) | ✅ publish / unpublish / search / pull | sv-control |
| Live meets | ✅ rooms, host on stage at creation, **open stage by default** (whoever has the link takes a slot; the host can switch to ask-and-permit), only the host removes anyone from the meet, **talk-back** between songs (the stage hears each other, the audience hears the stage) and Solo foldback during the song, the host's device **films the whole meet into Drive** as it goes — **one file, a chapter mark per song, pause and stretch of stage** (a mark at every start, restart, resume and jump; the film never stops for the song's transport; nothing is saved per song on any device), under Performances with *Watch* and *Chapters* (a button per mark) — an **Instrument** tick beside the mic adds a USB interface's input (a guitar, keys) to a singer's sound, stage live from the lobby (camera cut-out at once, video mesh before the song), one song at a time (library / catalog picker, picked is up, the stage's choice card when two are picked, song over → the one put forward), ready, chat, kickstart sync, transport cued for everyone (pause/resume/restart/seek), late singers mid-song, the audience hears the stage mix (~4 s behind, one continuous sound) and watches the show when a publisher is on air, 5-min expiry, watch page | performers don't hear each other (Solo foldback by design); lyrics only for singers on stage |
| Coupons | ✅ the super admin's gate on who may use SingersVoice: a coupon (code + expiry date) per email address, issued on Admin → **Coupons**; a singer meets the **Coupon screen** before anything else and is in while the code entered is the one issued and the date stands — checked on the service on every request, so a code or date changed or a coupon deleted puts the holder out on their next tap; the requirement is a switch (on by default; `COUPONS_REQUIRED=0` starts it off) | |
| Plans | ✅ **Free** (live meets with the voice; the Studio with the camera is everyone's) · **SVV** $5/month (your picture on stage in live meets, 10 h a month) · **SVVPro** $50/month (100 h) · **Club owner** $250/month (300 h shared with up to 15 members named by email, and Publishing mode) — the prices (USD, and INR for UPI), periods, hours and seats are the super admin's (Admin → Plans & payments); paid through **Stripe** (Checkout at the admin's price, dynamic payment methods — cards, wallets, UPI in INR; the webhook's word opens the plan; renewals, refunds, reconciliation; docs/global-payments-architecture.md, docs/stripe-setup.md) or granted on the Admin page; **video hours metered on the service** while a singer is on stage with the picture on, the picture going when the month's hours are used up; **My club** for the members (docs/BILLING.md) | UPI for a US Stripe account is Stripe's and the account's eligibility (verify in the Dashboard) |
| Publishing | ✅ own portal for **club owners** (the Club owner plan, bought on the Plans page or granted on the Admin page by a super admin; roles *audio only / dual / club owner / super admin* enforced on the service); Publishing and Admin are off every other account's menus: recording and streaming run from *Go live* to *Stop publishing* whatever the singers do to the song, the footage one file with the same chapter marks as the host's film, everything recorded and streamed **unmirrored**, one brand mark (in the picture itself); **Connect YouTube** in one tap, right in the show view: the app makes the HLS key, and *Go live* makes an **unlisted (or public, never private) YouTube broadcast per show** bound to that very stream, writes its link out with **Copy** (it stays after Stop — the video is there), reads YouTube's own word on the stream and ends the broadcast on Stop — nothing pasted; a Publish from the portal opens the show view and goes live by itself; a bar that says only LIVE, YouTube's word and the links; **show view** (performers huge, no lyrics, the whole mix) that **encodes and sends the show itself** (YouTube HLS ingestion + in-house HLS) + **Preview** monitor wall + jobs + history + in-house watch page | the RTMP relay (one container, docs/RELAY.md) takes YouTube from 20–40 s to 4–7 s behind and opens Facebook / Instagram / Twitch; AAC sound needs Chrome/Edge on Windows/Mac (Linux Chrome, Firefox: video only) |
| sv-control | ✅ Hono on Node 22 (node:sqlite) **and** Cloudflare Workers (SQLite Durable Object); Google token auth; tests + boot smoke | [docs/DEPLOY_CONTROL.md](docs/DEPLOY_CONTROL.md) — one workflow run after two secrets |
| sv-relay (RTMP out, YouTube song tracks) | ✅ `services/relay`: Node + ffmpeg + yt-dlp container (Fly.io scale-to-zero or any Docker host) — the browser's segments → RTMP(S), `-c copy`; a YouTube backing-track video → the singer's Drive as a song track | [docs/RELAY.md](docs/RELAY.md): one secret (`FLY_API_TOKEN`) and the *Deploy sv-relay* workflow does the rest |

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
- **sv-relay (RTMP out, YouTube song tracks):** add `FLY_API_TOKEN` (a Fly.io account) and run *Deploy sv-relay* — it
  makes the Fly app, builds the image (ffmpeg, yt-dlp), waits for `/health` and tells sv-control where the relay is
  ([docs/RELAY.md](docs/RELAY.md)). Also runs by itself on pushes that touch `services/relay/`.

## Restore points

`restore/RP1` is the branch frozen before v2 execution (the repo moved from `namballa2025/SingersVoice` to the `singersvoice` org on 2026-11-11; all branches moved with it) (the old scaffold + Terraform PR). See
[docs/RESTORE_POINTS.md](docs/RESTORE_POINTS.md) for how to go back or branch from it.

## Plan

The full v2 implementation plan (architecture, reliability, Drive layout, rules matrix, enterprise gates, costs,
phases) is the Claude Doc shared in the project; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the short version
kept with the code.
