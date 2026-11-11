# Architecture (v2, short form)

The authoritative plan is the Claude Doc *SingersVoice Implementation Plan → v2 plan*. This page keeps the pieces
that the code depends on.

## Principles

1. **Lyrics first.** The stage is 16 % stage strip · 60 % lyrics · 24 % controls (portrait); 5 visible lines
   (1 done grey, 1 active green with progress fill, 3 upcoming orange); singer-slot badges; personal cue deck.
2. **Local-first, clock-anchored.** Every device plays the backing track from a scheduled `AudioContext` time
   (locally) or a shared wall-clock instant (meets — the *GMT kickstart*). The vocal is captured by an
   AudioWorklet that reports the exact clock time of its first frame, so vocal, video and lyrics align without
   round-trips. No performer waits on the network to sing.
3. **Drive is the system of record.** `SingersVoice/{Tracks, Performances/{Live,Offline}, Temp, Config,
   Backgrounds, Exports}`, one sub-folder per task, `appProperties` on every file, resumable + md5-verified uploads,
   Temp auto-deletes after 7 days unless kept.
4. **No session can fail silently.** Takes are secured in Temp as soon as they end; uploads resume; token expiry
   surfaces as a one-tap *Reconnect*; the stage keeps the screen awake and warns before leaving mid-take.
5. **Lightweight.** First load ≈ 58 KB gzipped (Preact + signals + the app). Backgrounds, the cut-out model and
   Google scripts load on demand. The same `dist/` runs on GitHub Pages, Cloudflare or any static host.

## Portals (loosely coupled)

| Portal | Route | State it owns | Talks to |
| --- | --- | --- | --- |
| Tracks | `/tracks` | track files in Drive, catalog entries | Drive API, `sv-control /catalog/*` |
| Studio | `/studio/*` | tracks, takes, audio settings | Drive API only (works offline) |
| Live Meets | `/meets`, `/meet/:id` | meet session (poll), personal take | `sv-control /meets/*`, Drive for the take |
| Publishing | `/publishing`, `/watch/:id` | destinations, jobs | `sv-control /publishing/*`, `/watch/*` |

No portal imports another's screens; they share only `packages/protocol`, `lib/` (storage, api, audio) and
`state/` (session, settings). The SVT DB (sv-control) is the only shared backend and holds no media.

## Live meet timing

1. Each client measures its clock offset to the server (5 samples of `GET /time`, median of the fastest).
2. The host presses Start → the server stores `kickstartEpochMs = now + 8 s`.
3. Every performer's device converts that instant to its own AudioContext time and schedules the backing
   track (and the sample-accurate recorder) there. Nobody waits for anybody; network jitter only affects
   when a device *learns* the instant, not when it plays.
4. Performers hear only themselves + the track (Solo foldback). The composed mix for the audience comes from
   the session container (next increment); until then the watch page shows lyrics in sync and chat.
5. Inactivity (no join/heartbeat/chat/slot/start for 5 minutes) expires the meet; a live take is capped at 15 minutes.

## Components

| Component | Where | Runs on |
| --- | --- | --- |
| PWA client | `apps/web` | iOS Safari (installable), Android Chrome (installable), desktop browsers |
| Shared protocol | `packages/protocol` | client + services |
| sv-control (SVT DB) | `services/control` | Hono on Node 22 (node:sqlite) or Cloudflare Workers + D1: users (privileged flag), catalog, meets, chat, recordings, publishing destinations/jobs; Google access-token auth |
| sv-session (V3) | `services/session` (planned) | one pod per meet: mediasoup ingest → VoxForge C++ mixer-composer → FFmpeg encoder → RTMPS / LL-HLS |

## Audio chain (VoxForge, web twin of the JUCE plugin)

trim → pitch worklet (granular shifter + NSDF auto-tune) → HPF → low shelf 120 Hz / peak 1.2 kHz / high shelf
6.5 kHz → compressor → saturation → chorus/doubler → ping-pong delay → convolution reverb → out. Parameters and
presets live in `packages/protocol/src/audio.ts` and round-trip with the plugin's `APVTS` layout.

## Data formats

- `track.json` — `singersvoice.track.v2` (imports `singersvoice.trackmaker.v1` and LRC).
- `manifest.json` — `singersvoice.performance.v2` with timeline offsets, FX used, file hashes.
- `audio_plugin_settings.json`, `app_settings.json` — `SingersVoice/Config/`.
