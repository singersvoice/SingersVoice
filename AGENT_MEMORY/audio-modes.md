# Audio: the two listening modes, their levels and the vocal-loudness requirement

Updated 23 Nov 2026. Read this before touching `apps/web/src/audio/*`, `packages/protocol/src/audio.ts`,
`apps/web/public/worklets/*`, `apps/web/src/video/showRecorder.ts`, `apps/web/src/broadcast/*`.

## The two modes (the owner's words, 23 Nov 2026)

> **PERFORMER MODE:** live singing in progress on stage.
> **PUBLISH MODE:** final recordings saved in the Google Drive `Performances` folder.
> These modes must have independent audio-processing settings. Do not apply changes intended for one mode to
> the other. … My repeated requests for stronger vocals have been intended for PUBLISH MODE, not PERFORMER
> MODE. Previous changes incorrectly boosted PERFORMER MODE while leaving published recordings too weak.

What each mode is in the code (the agent's reading, 23 Nov; the owner has not contradicted it):

| Mode | What a listener hears | Where in the code |
|---|---|---|
| **PERFORMER** | The singer's own voice in their own ears while singing ("Hear myself", headphones), beside the backing track at their listening level ("Backing level in your ears"). In a live meet during a song every singer hears only themselves (Solo foldback) — the same path. | `AudioEngine.rideMonitor` / `setMonitorLevel` (`audio/engine.ts`), `MONITOR_RIDER` (`audio/mixBus.ts`), `PERFORMER_MONITOR` (`audio/loudness.ts`), `BackingPlayer.gain` (`audio/player.ts`), `components/MixBalance.tsx` `EarsLevel` |
| **PUBLISH** | Everything that leaves the stage: the Studio's saved take, a join's take, the live meet's film (Drive › Performances), the broadcast (YouTube/RTMP), the audience's "Hear the stage" mix, Performances playback and the review's Play mix. | `MixBus` (`audio/mixBus.ts`) with `PUBLISH_MIX` = `MIX_TARGETS` (`audio/loudness.ts`); used by `video/showRecorder.ts`, `audio/takePlayback.ts`, `broadcast/publisherBus.ts`, `portals/publishing/broadcast.ts`, `components/SoundPreview.tsx` ("Preview my voice" is PUBLISH MODE on purpose: the voice through a bus of its own, at the Vocal volume — what the recording gets, into the ears; the engine's monitor is muted meanwhile) |

The two never share a setting: the monitor's rider takes `PERFORMER_MONITOR`, every bus `PUBLISH_MIX`. The
Track / Vocal volume controls belong to PUBLISH MODE; "Your voice in your ears" belongs to PERFORMER MODE.

## The levels (23 Nov 2026)

PUBLISH MODE — `PUBLISH_MIX` in `audio/loudness.ts`:

| | Value | Meaning |
|---|---|---|
| track | **−16 LUFS** | the backing, normalised from whatever its file was mastered at (±18 dB range) |
| vocal | **−9** (K-weighted, LUFS-like) | each voice, held by its rider (`VOCAL_RIDER`, +26 dB lift / −12 cut, K-weighted, floor rule) and its own limiter at −1.5 dBFS |
| duck | **3 dB** | the music steps back under a voice within 40 ms of a phrase, back over 350 ms after it (`sv-ducker`) |
| guard | **−6.5** (K-weighted) | the sum is only ever turned *down* past this line (controls pushed to +30) |
| ceiling | −2 dBFS | the limiter + soft clip at the end of every bus (AAC overshoots ~1 dB) |
| track pocket | HPF 30 Hz, −2 dB shelf < 100 Hz, −1.5 dB @ 3 kHz (Q 0.8), +1 dB makeup | static, on every track |

Result on a bass-heavy mastered song (audio lab §6, the final run of 23 Nov): the voice **5.2–7.0 LU over the
music** on every preset (Octave Down 3.8) plus the 3 dB duck; a sung phrase **−9.9…−11.6 LUFS** (Octave Down −12.5);
limiter 1.5–1.8 LU; peaks ≤ −1.9 dBFS.
In the real Studio recording path (studio e2e, ffmpeg R128, the final run): take −11.6 LUFS integrated, sung
phrases −9.6 LUFS short-term, the breaks −15.2 (5.7 LU under), true peak −1.6 dBFS.

PERFORMER MODE — `PERFORMER_MONITOR.vocalDb = PUBLISH_MIX.vocalDb − 6 = −15` (K-weighted): the singer's own
voice in their ears is **half as loud as the published voice**. Adjustable per singer: "Your voice in your ears"
(`audioSettings.monitorDb`, ±24 dB, 1.5 dB steps, default 0). Audio lab §7: the ears at −15.2 against the published
−9.2 (6.0 dB under). Measured on the stage (studio e2e): the monitor's rider output −15.0 dB while the mix bus held
the same voice at −9.8 dBFS RMS with the music ducked 3.0 dB.

The Track / Vocal volume controls (PUBLISH MODE) start at **0 / 0** (`MIX_TRACK_DEFAULT_DB`, `MIX_VOCAL_DEFAULT_DB`,
`audio/gain.ts`), ±30 dB in 1.5 dB steps; a Default button appears when moved. Every stored balance was reset to
0 / 0 once with the 23 Nov modes (`settings.ts` `mixV4`), because balances set on earlier builds to make up for
the old mix work against the new one.

The vocal chain's own rider (`voxforge.ts` `RIDER_TARGET_DB`) leaves the voice at −16 dBFS RMS; the engine's input
leveller keeps raw mic peaks between −18 and −6 dBFS (trim −6…+12 dB). All 16 presets are level-matched: a −15 dBFS
voice leaves each within 0.6 dB of the others (−16.2…−16.8 dBFS), so a preset tap changes colour, never level.

## How the requirement evolved (why it is as it is)

- Up to 22 Nov: track −19 LUFS, vocal −17 dBFS *plain* RMS, guard −15 dBFS *plain* RMS. The owner reported
  weak vocals repeatedly. The 22 Nov recording (PPD22Nov.mp4) measured: the whole pinned at −15.5 dBFS RMS
  (LRA 2.2 LU) whatever was sung, the lows 10–15 dB over the voice's band, a sung phrase adding 8 dB to the mids
  and nothing to the whole. Cause: the guard measured plain RMS, which a bass-heavy track fills on its own; it
  gave every vocal entry back by turning the whole mix down.
- 22 Nov (commit 0485780): a first, superficial fix — the controls' defaults set to +1.6 / +4.6 dB. Reverted on
  23 Nov (the mix itself must be right; defaults are 0 / 0).
- 23 Nov (commit 7dfcb2a): the real fix — K-weighted riders and guard, track −16, vocal −11, duck 2.5, pocket EQ,
  per-vocal limiter, presets mid-forward and level-matched, the monitor through the mix's rider. **Mistake:** the
  monitor (PERFORMER MODE) was given the publish level (−11): the owner heard their own voice "boosted" on
  stage while the recordings (made with earlier balances still stored) stayed weak (PPD23Nov.mp4: −8.8 LUFS,
  flat, the track dominating — a stored Track offset pushing the sum into the guard).
- 23 Nov (this change): the two modes separated. PERFORMER = half the published voice (−15 K); PUBLISH vocal
  raised to −9 K with the limiter at −1.5 dBFS and the duck at 3 dB; every stored balance reset once.

Physical limit to remember: a voice cannot be pushed past about −9 K-weighted under a −1.5 dBFS ceiling — the
rider pushes, the limiter holds, and the energy goes into limiting (density, then pumping), not loudness. Vocal
"strength" beyond that comes from the balance (the track under it, the duck) and the tone (mid-forward EQ).

## Presets (`packages/protocol/src/audio.ts`)

All sixteen (Natural, Studio, Natural Tune, Punch, Up Front, Radio-Ready, Vibrant, Pop Star, Warm, Bright, Warm
Ballad, Stadium, Telephone, Doubler, Robot, Octave Down) are mid-forward: body under 300 Hz eased (−1.5…−2.5),
1.2 kHz mid +1.5…+2.5, presence +2…+4.5, HPF 100 Hz, compressor −22 dB 4:1 (characters keep their colour on top).
Makeups (`cMk`) are tuned by the audio lab (§3c): change an EQ or compressor value → re-run the lab and retune the
makeup so the preset stays within the ±2.5 dB band. `applyPreset` keeps the singer's input/output trims.

## Preview / Save (Settings → Voice, the Sound sheets)

"Preview my voice" opens the mic through the real chain and a mix bus's rider (PUBLISH MODE: the voice as the
recording gets it) into the ears (the engine's PERFORMER-MODE monitor is muted meanwhile — `muteMonitor`); every preset tap and tweak applies in place, nothing restarts. "Save my sound"
writes `audio_plugin_settings.json` and `app_settings.json` to the Config folder now (`saveSettingsNow`).
