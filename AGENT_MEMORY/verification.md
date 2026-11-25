# Verification: what proves what

Updated 24 Nov 2026 (evening). Run from the repo root. Browser tests need the build first:
`cd apps/web && BASE_PATH=/SingersVoice/ npm run build`. Playwright is at `/opt/npm-tools/node_modules/playwright`
in the sandbox (or a local install); ffmpeg is needed for the audio measurements.

| Check | Command | Must give |
|---|---|---|
| Types | `npm run typecheck` | clean |
| Unit | `cd apps/web && npx vitest run` (172; 25 Nov: `meetSession.test.ts` — the session keeps the newest state by the service's clock), `cd packages/protocol && npx vitest run` (85), `cd services/control && npx vitest run` (56) | all pass |
| Budget | `node tools/ci/check-budget.mjs apps/web/dist 400` | ≤ 400 KB gz (now ~240) |
| **Audio lab** | `node tools/ci/audio-lab.mjs` | AUDIO LAB OK (140): **§0 the voice gate** (the room ≥ 10 dB down; a breath in a break ≥ 15 dB down and one right after a phrase ≥ 8 dB down at the chain's output; the sung phrase, its last 100 ms within 0.5 dB, its first 30 ms within 3 dB, a leading "s" within 4 dB), **§0a the howl suppressor** (a 9.3 kHz squeal ≥ 25 dB down by 2.2 s and ≤ −40 dBFS at 1 s on its way up; the voice under 4 kHz within 0.3 dB; a voice alone never notched), chain IR aligned **and the worklet chain under 3.2 ms** (24 Nov: 2.96), de-esser, ceilings, **every preset within 5 dB (now 0.6)**, track normalised to the target (−14), riders (the bus's output after the voice's limiter: within −3.2…+1 dB of the reachable target), guard, **§6 the finished mix on a bass-heavy song for all 16 presets** (voice ≥ 3.5 LU over the music — Octave Down 2.3; sung −12.5…−7 LUFS; limiter ≤ 2.5 LU; peak ≤ −1.2 dBFS; mid-forward ≥ 1 dB except Octave Down), the duck (−3 dB under a phrase, back after), **§7 PERFORMER MODE** (the ears at −15, their own level; 7 dB under the publish rider's) |
| Rider lab | `node tools/ci/rider-lab.mjs` | 9 ok (targets read from the bundle) |
| Mix lab (audience player) | `node tools/ci/mix-lab.mjs` | OK incl. the stall run |
| **Studio e2e** | `BASE_PATH=/SingersVoice/ node tools/ci/studio-e2e.mjs <out>` | 86 ok: **AUTOZOOM off by default = 'follow'** (the head one size on the strip sung or not, and one size in the file until the switch), the Camera & zoom sheet's Auto zoom switch during the song, **on: the push-in ×1.5 live and in the file, the glides caught**, Preview/Save, NONE, the solo stage (×1.5 the strip's; **the crown near the top edge, the chest in**), **the review's timeline** (forward / back 10 s, Pause holds, the bar seeks, Play mix goes on; Discard beside Save, gone once saved), **the track's speed in the file** (22 s of file = 22 s of song within 15 ms; the stretches matched r > 0.3), **§5b the frozen camera** (found within 7 s on its pixels, restarted by itself within 12 s with one video-only capture; the microphone, the recorder, the song and the audio context untouched; the picture flowing again; the vocal whole), **Cancel** (before Start: Cancel + Home; during a take: everything stopped, no review), iPhone one capture, setup, blocked camera, **PERFORMER vs PUBLISH on the stage** (ears ≈ −15 K; the bus's voice −13…−7 dBFS RMS; ≥ 3.5 dB apart), **the saved take** (−13…−7 LUFS integrated, sung ≥ −11 LUFS and ≥ 4 LU over the breaks, true peak ≤ −0.5 dBFS) |
| Fit e2e | `BASE_PATH=/SingersVoice/ node tools/ci/fit-e2e.mjs <out>` | 480 combinations, 0 overflow; Start and 2 lyric lines on screen |
| Live e2e (~25 min, alone) | `SV_REQUEST_LOG=1 BASE_PATH=/SingersVoice/ SV_SERVER_LOGS=<out> node tools/ci/live-duet.mjs <out>` | 186 ok (25 Nov 01:40, on the final build with the session's clock guard and the stamp-at-read service) incl. **the cameras' health logged lobby to end: a live camera never called frozen on its picture (`frozenBy`; "ok throughout" on both devices)**, the film not mirrored, the audience mix, **the My picture drawer on the live stage: the same Auto zoom switch (off) and the same seat ('follow') as the Studio's**, **the film's song at −12.5…−5 LUFS, true peak ≤ −0.5** |
| Other e2es | `join` (58: the Auto zoom switch off in the sheet; **the row carol · alice · bob — the first singer in the middle**; Save), `roles` (100), `signin` (8), `tracks` (99: **§7 sound settings files in Drive › Config — the whole sound, shared through the service and imported by another singer (every control follows), deleted and withdrawn; the Backgrounds folder — the 36 built-in pictures copied in, an upload scaled to WebP and chosen, Select → Delete to the Drive bin, Restore**), `yt-track` (17), `tv` (16), `social` (38), `coupons` (30), `screenshots`, `load-e2e.mjs <out> 3` (21) — `tools/ci/*-e2e.mjs` with `BASE_PATH=/SingersVoice/`; `SV_E2E_JSON=apps/web/test/fixtures/sample.track.json SV_E2E_AUDIO=apps/web/test/fixtures/sample.mp3` | all pass |

Measuring a real recording (what the owner sends): `ffmpeg -nostats -i file.mp4 -af ebur128=peak=true -f null -`
gives integrated LUFS, LRA and true peak; band energies per window (lows 60–250 Hz against the voice's
800 Hz–6 kHz) show whether the voice stands over the music. A healthy publish file (24 Nov levels): integrated
≈ −10 LUFS, sung phrases ≈ −9, breaks ≈ −13.5, LRA ≥ 3 LU, true peak ≈ −1.1 dBFS (the ceiling −1.5 plus the AAC
encoder's overshoot).

Rules: labs and e2es run in CI (`.github/workflows/ci.yml`); run the audio lab after any change under
`apps/web/src/audio` or `apps/web/public/worklets`; run the studio and live e2es after any change to the stage,
the mix or the recorders; e2es compete for CPU — run them one at a time.
