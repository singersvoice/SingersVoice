# Verification: what proves what

Updated 23 Nov 2026. Run from the repo root. Browser tests need the build first:
`cd apps/web && BASE_PATH=/SingersVoice/ npm run build`. Playwright is at `/opt/npm-tools/node_modules/playwright`
in the sandbox (or a local install); ffmpeg is needed for the audio measurements.

| Check | Command | Must give |
|---|---|---|
| Types | `npm run typecheck` | clean |
| Unit | `cd apps/web && npx vitest run` (166), `cd packages/protocol && npx vitest run` (83), `cd services/control && npx vitest run` (55) | all pass |
| Budget | `node tools/ci/check-budget.mjs apps/web/dist 400` | ≤ 400 KB gz (now ~232) |
| **Audio lab** | `node tools/ci/audio-lab.mjs` | AUDIO LAB OK: chain IR aligned, de-esser, ceilings, **every preset within 5 dB (now 0.6)**, track normalised to the target, riders, guard, **§6 the finished mix on a bass-heavy song for all 16 presets** (voice ≥ 5 LU over the music, sung −12…−7.5 LUFS, limiter ≤ 2.5 LU, peak ≤ −1.3 dBFS, mid-forward ≥ 1 dB except Octave Down), the duck (−3 dB under a phrase, back after), **§7 PERFORMER MODE** (the ears 6 dB under the publish voice) |
| Rider lab | `node tools/ci/rider-lab.mjs` | 9 ok (targets read from the bundle) |
| Mix lab (audience player) | `node tools/ci/mix-lab.mjs` | OK incl. the stall run |
| **Studio e2e** | `BASE_PATH=/SingersVoice/ node tools/ci/studio-e2e.mjs <out>` | 64 ok: voice zoom live and in the file, Camera & zoom during the song, Preview/Save, NONE, the solo stage, iPhone one capture, setup, blocked camera, **PERFORMER vs PUBLISH on the stage** (ears ≈ −15 K; the bus's voice −13…−7 dBFS RMS; ≥ 3.5 dB apart), **the saved take** (−13…−7 LUFS integrated, sung ≥ −11 LUFS and ≥ 5.5 LU over the breaks, true peak ≤ −0.8 dBFS) |
| Fit e2e | `BASE_PATH=/SingersVoice/ node tools/ci/fit-e2e.mjs <out>` | 480 combinations, 0 overflow; Start and 2 lyric lines on screen |
| Live e2e (~25 min, alone) | `SV_REQUEST_LOG=1 BASE_PATH=/SingersVoice/ SV_SERVER_LOGS=<out> node tools/ci/live-duet.mjs <out>` | 181 ok incl. the film not mirrored, the audience mix, **the film's song at −12.5…−6 LUFS, true peak ≤ −0.8** |
| Other e2es | `join` (57), `roles` (100), `signin` (8), `tracks` (83), `yt-track` (17), `tv` (16), `social` (38), `coupons` (30), `screenshots`, `load-e2e.mjs <out> 3` (21) — `tools/ci/*-e2e.mjs` with `BASE_PATH=/SingersVoice/`; `SV_E2E_JSON=apps/web/test/fixtures/sample.track.json SV_E2E_AUDIO=apps/web/test/fixtures/sample.mp3` | all pass |

Measuring a real recording (what the owner sends): `ffmpeg -nostats -i file.mp4 -af ebur128=peak=true -f null -`
gives integrated LUFS, LRA and true peak; band energies per window (lows 60–250 Hz against the voice's
800 Hz–6 kHz) show whether the voice stands over the music. A healthy publish file: integrated ≈ −11 LUFS, sung
phrases ≈ −9.5, breaks ≈ −15, LRA ≥ 4 LU, peak ≤ −1 dBFS.

Rules: labs and e2es run in CI (`.github/workflows/ci.yml`); run the audio lab after any change under
`apps/web/src/audio` or `apps/web/public/worklets`; run the studio and live e2es after any change to the stage,
the mix or the recorders; e2es compete for CPU — run them one at a time.
