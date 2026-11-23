# Product and architecture

Updated 23 Nov 2026.

## What SingersVoice is

A Smule-style singing app, built as a lightweight PWA (Preact + signals + Vite) for Android, iOS and the web:
sing a song over a backing track, alone (the Studio) or with up to 10 singers live (Live Meets), with the
performance saved to the singer's own Google Drive and, for publishers, streamed to YouTube/Facebook/Instagram/
Twitch and an in-house portal. The owner (HN) treats it as a commercial product (plans, Stripe, clubs).

Splash tagline: "One Virtual Stage. Endless Musical Possibilities." Splash text (20 Nov): "SingersVoice / For
everyone who lives and breathes music. / Find your songs. Feel every lyric. Sing together and save to your Drive".
**The word "Karaoke" must not appear anywhere in the app** (YouTube searches carry "karaoke track" as a query
only).

## Parts (monorepo)

| Part | Path | Notes |
|---|---|---|
| Web app (PWA) | `apps/web` | Preact + signals, Vite 7, module workers (`new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`), AudioWorklets in `apps/web/public/worklets`. Budget: ≤ 400 KB gz first load (`tools/ci/check-budget.mjs`), now ~232 KB. **No new npm dependencies.** |
| Protocol | `packages/protocol` | Shared types, presets (`audio.ts`), manifests. |
| Control service | `services/control` | Hono; runs on Node or a Cloudflare Durable Object (the "Control Worker", deployed on push). Meets, catalog (SVT DB), roles, plans, coupons, social posting, admin. |
| Relay | `services/relay` | Fly.io; ffmpeg `-c copy` RTMP leg to YouTube etc., YouTube track fetch jobs. |
| Infra | Terraform in the repo, Cloudflare (Pages, Worker), Fly.io; `terraform apply` in one go. |

Hosting today: GitHub Pages at `singersvoice.github.io/SingersVoice/` (repo `singersvoice/SingersVoice`, public,
inside the owner's GitHub Enterprise org). The owner wants `www.singersvoice.com` to carry everything once
commercial. The app is a PWA: **after a deploy every device must close and reopen the app** to get the new build.

## The two user-facing modes (the owner's vocabulary)

- **Performer mode** — the singer's stage view: the lyrics (only ever shown to singers on stage), their own picture
  framed to chest level by default (the seat; "Zoom with my voice" pushes in on the face while they sing), the
  controls. Audio in Performer mode = what the singer hears (see `audio-modes.md`: PERFORMER MODE).
- **Publisher / Publish mode** — the show for others and the record of it: the performers huge on an elegant stage,
  **no lyrics**, the backing track blended with every singer's vocal (each with their own voice settings); the
  saved take / film, the broadcast, the audience's stage. Audio = PUBLISH MODE.

The live stream must match what the singer sees of themselves in Performer mode (framing choices strictly kept,
no extra zoom); the stage is one straight row of equal singers (up to 10); publisher mode is for Club owners and
Super admins only.

## Sign-in, storage

Google sign-in only; the singer's Google Drive is linked at onboarding and holds everything ("everything on Google
Drive"): `SingersVoice/Tracks`, `SingersVoice/Performances` (one level of song files, no per-take folders; the only
option is a permanent Delete), `SingersVoice/Config` (`app_settings.json`, `audio_plugin_settings.json`). A
"device" mode (no Google) exists for tests and local use only. Tracks are shared through the SVT DB catalog
(a central track database: song, artists, movie, year, language, a 12-char id, shareable Drive URL, last-accessed
in UTC; tabs All · My Drive · Public Catalog · YouTube; Sing copies a track into the singer's own Tracks folder).

## How code ships (the owner is not a git user)

Work happens in a sandbox clone (`/home/claude/SingersVoice`, no remote). Every change is committed there (never
amend a shipped commit), bundled (`git bundle create /mnt/user-data/outputs/sv-<hash>.bundle <prevPCHead>..main`),
written to the owner's PC (`C:\Work\MyProjects2026\SingersVoice\_bootstrap\`) through the device bridge and merged
with `git fetch <bundle> main:refs/bundles/main && git merge --ff-only refs/bundles/main` (lock files removed first;
`_bootstrap` removed after). The owner pushes from the PC: `cd C:\Work\MyProjects2026\SingersVoice` then
`git push origin main`. CI (GitHub Actions) runs the labs and e2es and deploys Pages + the Control Worker.
A stop-hook notice "N unpushed commits" refers to the sandbox clone — answer with the PC push instruction.

## Working preferences of the owner

- Maximum automation; simple, generic step-by-step instructions for anything that must be done by hand.
- "Don't make things complicated — keep features straightforward" (a plain button for an action, not a hidden flow;
  no multi-level options).
- Reviews plans before implementation for big features; executes the v2 plan only.
- Hard requirement: no live session or offline session may fail or crash.
- Wants restore points before big steps.
