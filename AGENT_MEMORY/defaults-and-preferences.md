# Defaults and preferences

Updated 24 Nov 2026 (evening). Read before changing any default. A default is what a new singer gets; a singer's own
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
| Voice gate | on, amount 0.75 (= 27 dB of range before the compressors; 24 Nov evening: a voice-evidence gate — the room AND the breaths turned down whenever no voice is heard; `audio-modes.md`) | `params.gtOn / gtAmt` |
| Howl suppressor | always on (no control: a feedback squeal is never wanted); the lab can switch it off (`chain.setHowl`) | `voxforge.ts` 'sv-howl' |
| Echo cancellation ("I'm on speakers") | off | `appSettings.echoCancellation` |
| Count-in | on | `appSettings.countIn` |
| Instrument input | off (not on iOS: one capture per page) | `appSettings.instrumentOn` |

The publish mix targets (`PUBLISH_MIX`, 24 Nov): track −14 LUFS (its own ceiling −4 dBFS), vocal −7.8 K (ceiling −1 dBFS),
duck 3 dB, guard −5 K, mix ceiling −1.5 dBFS. The performer monitor (`PERFORMER_MONITOR`): vocal −15 K, track −16 LUFS.

## Picture and stage

| Setting | Default |
|---|---|
| AUTOZOOM (framing) | **off** = `framing: 'follow'` (24 Nov evening: "head to chest, kept so when the camera moves" — the frame holds the singer head to chest, centred, and re-frames with one glide when they or the camera have moved beyond the seat's margins; never a push-in). On = `'voice'`: the same, plus a close-up on the face while singing. Every save went to off once on 24 Nov morning (`autozoomV1`, then `'still'`), and every `'still'` save went to `'follow'` once in the evening (`autozoomV2`); a switch turned on stays on. `'still'` (framed once, left alone, the wide `STILL` margins) remains a valid value an older save may hold; nothing sets it any more. One switch, the same in Settings → Camera, the Studio's Camera & zoom sheet and the meet's My picture drawer. |
| Camera health | a camera whose pixels stand exactly still for 3 s (`PIXELS_STILL_AFTER`, the same frame three times over at least), whose frames stop for 5 s (`FROZEN_AFTER`; not fewer: a device straining presents frames late and in bursts) or whose model measurement is identical for 15 s (`STILL_AFTER`) is frozen; restarted by itself at most once in 15 s (`AUTO_RESTART_EVERY_MS`), the camera alone — the microphone, the recorder and the song untouched (capture.ts `closeCamera` / `openCameraKeepingMic` / `restartCamera`; the camera button goes the same way: on iOS the video tracks alone are stopped and the camera alone is asked for again, the pair re-captured only if the microphone did not survive it) |
| Performer image size | 24 Nov: a fifth bigger in every stage mode (`SHOW_SCALE` 1.44, `SOLO_SCALE` ×1.5 of it, `STAGE_SLOT_FRAC` 0.6 for one singer); the crown 5 % down the saved take's frame, 8 % down the show's — the singer from the crown to the chest |
| Row order | the first singer in the middle, the others to the right and left in turn (`rowOrder`) — offline joins and live meets alike |
| Picture | cut-out (the virtual stage); **NONE — my camera as it is** is a valid background choice (`backgroundId: 'none'`, picture 'camera') |
| Background | the first built-in picture (`mytestbg1`); the choice is saved (`appSettings.backgroundId`: a built-in's id, `none`, or an upload's `mybg:<store id>`). 24 Nov evening: the Backgrounds folder (Drive › SingersVoice › Backgrounds, or this device) is the record — the 37 built-in pictures copied in once per account (`svStock`), uploads from the device (scaled to ≤ 1920 px, WebP/JPEG), Select → Delete (an upload to the Drive bin; a built-in hidden on the account: `hiddenBackgrounds`, synced with the app settings, and its copy binned) and Restore built-in backgrounds. A live meet's shared stage names built-in pictures only (every device has them). |
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
- Migrations live in `settings.ts` `migrateApp` (`framingV2`, `autozoomV1`, `autozoomV2`, `mixV2`, `mixV3`, `mixV4`): each runs once per device.
- Sound settings files (24 Nov evening, `lib/sounds.ts`, protocol `sounds.ts`): "Save Sound Settings" writes the complete sound
  (the preset and every tweak, monitor + its level, tempo, key, Backing level, the Track / Vocal balance) to the Config folder as
  `<initials>_<YYYYMMDD>_<HHMMSS>.svsound.json` (the two settings files refreshed too); "Import Sound Settings" lists the files
  saved here and the ones shared by other singers (the service's sound catalog, `/catalog/sounds`) and applies one — every
  control follows; Share / Withdraw share / Delete for the singer's own. A file is validated and clamped on the way in
  (`parseSoundSettings`); an unknown preset id becomes 'custom' (the params carry the sound).

## The owner's working preferences (apply always)

- Keep features straightforward; no hidden flows; no multi-level options.
- Automate; when something must be done by hand give simple numbered steps (the owner is not familiar with git/
  GitHub best practice).
- Never claim something works without verifying it (labs, e2es, measured output).
- Reports: concise, bottom line first; list files changed, settings changed, verification results, and what could
  not be verified.
