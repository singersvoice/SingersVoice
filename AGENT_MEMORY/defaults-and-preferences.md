# Defaults and preferences

Updated 24 Nov 2026. Read before changing any default. A default is what a new singer gets; a singer's own
setting replaces it and is kept (device localStorage + the Config folder in Drive), except where a dated
migration below says otherwise.

## Audio (see `audio-modes.md` for the why)

| Setting | Default | Where |
|---|---|---|
| Preset | Studio | `AUDIO_SETTINGS_DEFAULTS.activePresetId` |
| Hear myself (monitor) | off (headphones only; speakers feed back) | `audioSettings.monitor` |
| Your voice in your ears (PERFORMER MODE) | 0 dB = about half as loud as the published voice (−15 K-weighted; its own number, untouched on 24 Nov) | `audioSettings.monitorDb` |
| Backing level in your ears | 85 % of the performer track level (−16 LUFS — held there when the published track rose to −14 on 24 Nov: `EARS_TRACK_TRIM_DB`) | `audioSettings.backingGain` (never touches the recording) |
| Track / Vocal volume (PUBLISH MODE) | 0 / 0 dB (reset once for everyone on 23 Nov, `mixV4`) | `appSettings.trackDb / vocalDb` |
| Tempo / key shift | 1.00× / 0 st (a join sings the show as it was sung) | `audioSettings` |
| Echo cancellation ("I'm on speakers") | off | `appSettings.echoCancellation` |
| Count-in | on | `appSettings.countIn` |
| Instrument input | off (not on iOS: one capture per page) | `appSettings.instrumentOn` |

The publish mix targets (`PUBLISH_MIX`, 24 Nov): track −14 LUFS (its own ceiling −4 dBFS), vocal −7.8 K (ceiling −1 dBFS),
duck 3 dB, guard −5 K, mix ceiling −1.5 dBFS. The performer monitor (`PERFORMER_MONITOR`): vocal −15 K, track −16 LUFS.

## Picture and stage

| Setting | Default |
|---|---|
| AUTOZOOM (framing) | **off** (`framing: 'still'`: framed once, still and centred). On = `'voice'`: a close-up on the face while singing, and the frame follows a move. Every save went to off once on 24 Nov (`autozoomV1`); the switch is the singer's from then on. One switch, the same in Settings → Camera, the Studio's Camera & zoom sheet and the meet's My picture drawer. |
| Performer image size | 24 Nov: a fifth bigger in every stage mode (`SHOW_SCALE` 1.44, `SOLO_SCALE` ×1.5 of it, `STAGE_SLOT_FRAC` 0.6 for one singer); the crown 5 % down the saved take's frame, 8 % down the show's — the singer from the crown to the chest |
| Row order | the first singer in the middle, the others to the right and left in turn (`rowOrder`) — offline joins and live meets alike |
| Picture | cut-out (the virtual stage); **NONE — my camera as it is** is a valid background choice (`backgroundId: 'none'`, picture 'camera') |
| Background | the first stage background; the choice is saved (`appSettings.backgroundId`) |
| Camera | on, facing user; device choices saved (`cameraDeviceId`, `audioInputId`) |
| Text size (Display) | 1× (1.3 / 1.6 / 2 offered; every screen must fit a 320 px phone at 2×) |
| Studio saved take stage | 'solo' (the singer 1.5× the show stage's size, both a fifth bigger since 24 Nov); the live strip is the show stage |

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
- Migrations live in `settings.ts` `migrateApp` (`framingV2`, `autozoomV1`, `mixV2`, `mixV3`, `mixV4`): each runs once per device.

## The owner's working preferences (apply always)

- Keep features straightforward; no hidden flows; no multi-level options.
- Automate; when something must be done by hand give simple numbered steps (the owner is not familiar with git/
  GitHub best practice).
- Never claim something works without verifying it (labs, e2es, measured output).
- Reports: concise, bottom line first; list files changed, settings changed, verification results, and what could
  not be verified.
