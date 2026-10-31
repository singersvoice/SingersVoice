# SingersVoice

A social karaoke & duet singing app (Smule-style): sing along to backing tracks with synced lyrics, record solo or join someone else's duet, and share performances.

## Stack
- **web/** – React frontend (served by nginx)
- **api/** – Node.js / Express API
- **db/** – PostgreSQL 16 (init scripts in `db/init`)

Designed to run inside the shared `BusinessPlatform` Docker Compose workspace alongside the other projects.

## Planned features
- Song catalog with backing tracks and time-synced lyrics
- In-browser recording (Web Audio / MediaRecorder) with pitch guide
- Solo, duet ("join") and group performances
- Audio effects (reverb, echo, auto-tune lite) and mixing
- Profiles, follows, likes, comments, feed
- Performance sharing and playback

## Getting started
```bash
docker compose up --build
```
- Web: http://localhost:8080
- API: http://localhost:8080/api/health

## Cloud infrastructure
Production runs on Cloudflare (Workers + Durable Objects, D1, R2, Realtime SFU, Stream) with recordings
stored in each user's Google Drive. `infra/` holds the Terraform that creates all of it in one
`terraform apply`; see [infra/README.md](infra/README.md). The implementation plan (both modes,
onboarding, costs) lives in the SingersVoice Implementation Plan doc.
