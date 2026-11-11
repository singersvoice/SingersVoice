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

## Components

| Component | Where | Runs on |
| --- | --- | --- |
| PWA client | `apps/web` | iOS Safari (installable), Android Chrome (installable), desktop browsers |
| Shared protocol | `packages/protocol` | client + services |
| sv-control | `services/control` | Node 22 container (Hono + WebSocket): meets, slots, kickstart, chat; Postgres + Google ID-token auth next |
| sv-session (V3) | `services/session` (planned) | one pod per meet: mediasoup ingest → VoxForge C++ mixer-composer → FFmpeg encoder → RTMPS / LL-HLS |

## Audio chain (VoxForge, web twin of the JUCE plugin)

trim → pitch worklet (granular shifter + NSDF auto-tune) → HPF → low shelf 120 Hz / peak 1.2 kHz / high shelf
6.5 kHz → compressor → saturation → chorus/doubler → ping-pong delay → convolution reverb → out. Parameters and
presets live in `packages/protocol/src/audio.ts` and round-trip with the plugin's `APVTS` layout.

## Data formats

- `track.json` — `singersvoice.track.v2` (imports `singersvoice.trackmaker.v1` and LRC).
- `manifest.json` — `singersvoice.performance.v2` with timeline offsets, FX used, file hashes.
- `audio_plugin_settings.json`, `app_settings.json` — `SingersVoice/Config/`.
