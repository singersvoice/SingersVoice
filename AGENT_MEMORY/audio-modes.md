# Audio: the two listening modes, their levels and the vocal-loudness requirement

Updated 24 Nov 2026. Read this before touching `apps/web/src/audio/*`, `packages/protocol/src/audio.ts`,
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

The two never share a setting: the monitor's rider and the player's ears gain take `PERFORMER_MONITOR`, every bus
`PUBLISH_MIX`. The Track / Vocal volume controls belong to PUBLISH MODE; "Your voice in your ears" and "Backing level
in your ears" belong to PERFORMER MODE. **A change to one mode is never a change to the other** (the owner, 24 Nov:
"PERFORMER MODE vocals are already perfect — do not change them").

## The levels (24 Nov 2026)

PUBLISH MODE — `PUBLISH_MIX` in `audio/loudness.ts`:

| | Value | Meaning |
|---|---|---|
| track | **−14 LUFS** | the backing, normalised from whatever its file was mastered at (±18 dB range); 24 Nov: a quarter louder than the −16 of 23 Nov (the owner's "+25 %") |
| track ceiling | −4 dBFS | `TRACK_CEILING_DB`: the music's own limiter (2 ms lookahead) after the pocket, so a mastered track brought to −14 does not drive the sum's limiter by itself |
| vocal | **−7.8** (K-weighted, LUFS-like) | each voice's rider target (`VOCAL_RIDER`, +26 dB lift / −12 cut, K-weighted, floor rule); 24 Nov: +1.2 dB (the owner's "+15 %") — **but the ceiling binds** (below) |
| vocal ceiling | −1 dBFS | each voice's own limiter (`VOCAL_CEILING_DB`, release 50 ms) |
| duck | **3 dB** | the music steps back under a voice within 40 ms of a phrase, back over 350 ms after it (`sv-ducker`) |
| guard | **−5** (K-weighted) | the sum is only ever turned *down* past this line (controls pushed to +30) |
| ceiling | −1.5 dBFS | `MIX_CEILING_DB`: the limiter + soft clip at the end of every bus (AAC overshoots ~0.5 dB; the e2e measures the file's true peak) |
| track pocket | HPF 30 Hz, −2 dB shelf < 100 Hz, −1.5 dB @ 3 kHz (Q 0.8), +1 dB makeup | static, on every track |

Result on a bass-heavy mastered song (audio lab §6, 24 Nov): the music at −14.3 LUFS; the voice **3.9–6.0 LU over
the music** on every preset (Octave Down 2.8) plus the 3 dB duck; the voice alone −8.3…−10.4 LUFS (Studio −9.5); a sung
phrase **−9.4…−11.9 LUFS** (Octave Down −11.9); the breaks −15.4; limiter 1.7–2.1 LU; peaks ≤ −1.44 dBFS.
Against 23 Nov: the music +1.7–1.9 dB (the quarter asked for), the voice **+0.3–0.6 dB** — the ceiling, not the
target, decides the voice's loudness (next paragraph); the sung phrase +0.4–0.6.

**The physical limit, measured (24 Nov):** a voice whose peaks are held under −1 dBFS cannot be louder than about
−9.5 K-weighted short-term through this chain (its crest factor after the presets' compression is 8–9 dB); the rider
pushes to −7.8, the limiter takes 1.7–2 LU back, and pushing further turns into limiting (density, then pumping), not
loudness. A density compressor between the rider and the limiter was tried and removed (a peak-detecting compressor
with any release holds the gain down between a voice's peaks and *loses* loudness). What is left to make the voice
stronger in the file: the balance (the track under it, the duck), the tone (mid-forward), and the ceilings (raised to
−1 / −1.5 on 24 Nov). The owner's "+15 % vocal" is therefore delivered only in part (+0.3…+0.6 dB, ≈ +5 %), and said
so in the 24 Nov report.

PERFORMER MODE — `PERFORMER_MONITOR` in `audio/loudness.ts`, **its own numbers, independent of PUBLISH_MIX**:
`vocalDb = −15` (K-weighted): the singer's own voice in their ears, about half as loud as the published voice (the
monitor's rider `MONITOR_RIDER`); `trackLufs = −16`: the track under the Backing level — the player's ears gain
carries `EARS_TRACK_TRIM_DB = −16 − (−14) = −2 dB` on top of the Backing level, so the ears' track stayed exactly
where it was when the published track rose on 24 Nov. Adjustable per singer: "Your voice in your ears"
(`audioSettings.monitorDb`, ±24 dB, 1.5 dB steps, default 0). Audio lab §7: the ears at −15.1 against the published
rider's −8.0. Measured on the stage (studio e2e): the monitor's rider output −15 dB while the mix bus held the same
voice near −9 dBFS RMS with the music ducked 3.0 dB.

## PERFORMER MODE's latency (24 Nov 2026)

The owner hears their own voice "a fraction of a second" late with Hear myself. What the app holds the voice for
(the chain's lookaheads) was 10 ms with worklets — the browser's WaveShaperNode '2x' oversampling holds the signal
128 frames (2.7 ms) at each of the chain's three shapers (exciter, saturation, the safety's soft clip) plus the
safety limiter's 2 ms. 24 Nov: the three shapers run in our own `sv-shaper` worklet (2× oversampled through two
31-tap half-band filters: 15 frames each, flat to 19 kHz, −54 dB stopband) — **the chain now holds the voice
2.96 ms** (audio lab §1: measured = reported; the parallel paths still aligned, −43 dB). The capture asks for the
shortest buffer (`latency: { ideal: 128/48000 }` in `micConstraints`; Chrome/Safari honour it where the device can).
The rest of what the singer hears is the device: microphone in + speakers out, 20–60 ms on a wired computer, 100–200
more on Bluetooth — not the app's to fix; the Sound sheet says the figures (`EarsDelayNote`: the app's part, the
device's part, measured by the sync check where it has been) and that wired headphones are quickest. The pitch
stage (tune / robot / octave-down / doubler presets) still holds the voice 10–25 ms while it works.

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
- 23 Nov (commit cf04b4c): the two modes separated. PERFORMER = half the published voice (−15 K); PUBLISH vocal
  raised to −9 K with the limiter at −1.5 dBFS and the duck at 3 dB; every stored balance reset once.
- 24 Nov: the owner — "the latest fixes are better" — asked for the default TRACK +25 %, the PUBLISH vocal +15 %,
  PERFORMER vocals unchanged ("already perfect"), and the monitoring delay gone. Done: track −14 (+25 %), the vocal
  target −7.8 with the ceilings at −1 / −1.5 (measured +0.3…+0.6 dB: the limit above), the guard −5, the track's own
  ceiling −4; the ears untouched (their track held at −16 by `EARS_TRACK_TRIM_DB`); the chain's hold 10 → 3 ms.

Physical limit to remember: a voice cannot be pushed past about −9.5 K-weighted under a −1 dBFS ceiling — the
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
