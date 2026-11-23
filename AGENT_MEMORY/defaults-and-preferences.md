# Defaults and preferences

Updated 23 Nov 2026. Read before changing any default. A default is what a new singer gets; a singer's own
setting replaces it and is kept (device localStorage + the Config folder in Drive), except where a dated
migration below says otherwise.

## Audio (see `audio-modes.md` for the why)

| Setting | Default | Where |
|---|---|---|
| Preset | Studio | `AUDIO_SETTINGS_DEFAULTS.activePresetId` |
| Hear myself (monitor) | off (headphones only; speakers feed back) | `audioSettings.monitor` |
| Your voice in your ears (PERFORMER MODE) | 0 dB = half as loud as the published voice (−15 K-weighted) | `audioSettings.monitorDb` |
| Backing level in your ears | 85 % | `audioSettings.backingGain` (never touches the recording) |
| Track / Vocal volume (PUBLISH MODE) | 0 / 0 dB (reset once for everyone on 23 Nov, `mixV4`) | `appSettings.trackDb / vocalDb` |
| Tempo / key shift | 1.00× / 0 st (a join sings the show as it was sung) | `audioSettings` |
| Echo cancellation ("I'm on speakers") | off | `appSettings.echoCancellation` |
| Count-in | on | `appSettings.countIn` |
| Instrument input | off (not on iOS: one capture per page) | `appSettings.instrumentOn` |

The publish mix targets (`PUBLISH_MIX`): track −16 LUFS, vocal −9 K, duck 3 dB, guard −6.5 K, ceiling −2 dBFS.
The performer monitor (`PERFORMER_MONITOR`): vocal −15 K.

## Picture and stage

| Setting | Default |
|---|---|
| Framing ("Zoom") | **Zoom with my voice** (`'voice'`; options Still, Follow me). A save from before 22 Nov was moved onto it once (`framingV2`). |
| Picture | cut-out (the virtual stage); **NONE — my camera as it is** is a valid background choice (`backgroundId: 'none'`, picture 'camera') |
| Background | the first stage background; the choice is saved (`appSettings.backgroundId`) |
| Camera | on, facing user; device choices saved (`cameraDeviceId`, `audioInputId`) |
| Text size (Display) | 1× (1.3 / 1.6 / 2 offered; every screen must fit a 320 px phone at 2×) |
| Studio saved take stage | 'solo' (the singer 1.5× the show stage's size); the live strip unchanged |

## Permissions

The camera and the microphone are asked for once, together, at setup ("Allow both"); the browser's own permission
state is read at launch, at setup and in Settings; on iPhone/iPad one capture per Studio visit (camera opened with
the mic, the engine adopts the mic at Start, the mic parked between songs). A saved device choice never assumes the
browser still allows the device; a blocked device is said so on the stage with the browser's own way back.

## Persistence

- localStorage first (`sv.settings.app`, `sv.settings.audio`, `sv.loudness`, …), the Config folder 2.5 s after each
  change (`SingersVoice/Config/app_settings.json`, `audio_plugin_settings.json`), "Save my sound" writes now.
- At start: localStorage at once; signed in to Drive the Config copy is pulled and the **newer copy wins, file by
  file** (`updatedAt` on both files; `restoreSettingsAtStart`, `pullSettings`); a newer local copy is pushed up.
- Migrations live in `settings.ts` `migrateApp` (`framingV2`, `mixV2`, `mixV3`, `mixV4`): each runs once per device.

## The owner's working preferences (apply always)

- Keep features straightforward; no hidden flows; no multi-level options.
- Automate; when something must be done by hand give simple numbered steps (the owner is not familiar with git/
  GitHub best practice).
- Never claim something works without verifying it (labs, e2es, measured output).
- Reports: concise, bottom line first; list files changed, settings changed, verification results, and what could
  not be verified.
