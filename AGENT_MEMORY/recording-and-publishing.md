# Recording and publishing workflows

Updated 24 Nov 2026 (evening). Both listening modes (`audio-modes.md`) apply to every workflow here: what the singer
hears is PERFORMER MODE; every saved or sent output is PUBLISH MODE through the one mix bus.

## Offline takes (the Studio, `apps/web/src/portals/studio/Sing.tsx`)

- A song from the singer's Tracks (Drive or device). Start → count-in (optional) → the song plays through
  `BackingPlayer` (normalised to the publish track target; the singer's ears get it at their Backing level); the
  mic goes through the VoxForge chain (`audio/voxforge.ts`); the take recorder keeps the vocal (`vocal.wav`,
  48 kHz); the `ShowRecorder` ('solo' stage) films the stage and mixes the track + the voice through the
  **mix bus** (PUBLISH MODE) into the saved video. The monitor (PERFORMER MODE) is a separate path.
- Review (24 Nov evening): Play mix / Pause plays the take through the same bus (`audio/takePlayback.ts`: a timeline of its
  own — `positionMs`, `seek`, `pause`, `resume`) — the review is the file; the seek bar moves anywhere, Back / Forward
  10 s, the show video kept on the take's timeline (`syncVideo`). **Save** (was Keep) files it in Drive › SingersVoice ›
  Performances (one level of files; a manifest `performance.json`, the vocal, the video); **Discard** removes the Temp
  copy only and goes back to the stage — it is gone once the take is saved (a saved performance is deleted from the
  Performances page, with its own confirmation, never from the review). The Performances page says Saved (was Kept)
  and plays saved takes through the bus too; a meet's film plays as a video.
- Cancel (24 Nov evening): before Start the stage has Cancel (back to the track list / the performances for a join) and a
  Home button; during a take Cancel (the Home icon, with a confirmation) stops the song, the recorder and the show,
  throws the take away — nothing saved, no review — and returns to the stage as before Start (the camera stays on).
- The camera's health on the stage: a frozen camera (its pixels still for 3 s, `video/stillness.ts`) is restarted by
  itself within seconds — the camera alone; the microphone, the recorder and the song go on (studio e2e §5b measures it:
  found in ~5 s, restarted ~6 s after the freeze, one video-only capture, the vocal whole).
- Sync: the recording holds the track back by the device's measured round trip (`audio/sync.ts`); after each take
  the vocal is laid against the track and corrected when a clear lag is found.
- **Joins:** a solo performance can be shared; another singer opens it from the portal and adds their own video
  and vocal to the same song (video allowed for everyone offline); the share link is view-only.
- The rotating SV logo sits top-right on every stored recording.
- Sound settings files and the singer's backgrounds: `defaults-and-preferences.md` (Save Sound Settings / Import Sound
  Settings / Share; the Backgrounds folder as the record, upload / select / delete / restore).

## Live meets (`apps/web/src/portals/meets/*`, `services/control`)

- The host is on stage the moment they start a meet; anyone entering the stage appears on it instantly; the
  audience asks to sing and gets on stage only if the admin permits; only the host removes anyone; open stage by
  default; one song at a time; meets expire after 5 idle minutes.
- Listening: while a song plays, singers on stage hear **only themselves** (Solo foldback — PERFORMER MODE); while
  paused or between songs they hear each other (talk-back); the audience hears every voice blended with the
  track, in time (PUBLISH MODE, the host's device's mix bus, sent out a second at a time — `MixBroadcaster`).
- The show (publish mode) begins when the meet starts and runs as its own process; the host's device keeps one mix
  bus up for the whole time it is on stage; the film of the meet (ShowRecorder 'show' stage) is saved to
  Performances in chapters: every song, restart, pause or stage stretch is its own timestamped chunk, never merged;
  recording and streaming start at Publish and never stop for play/pause/stop/restart.
- Video in live meets is plan-gated (SVV / SVVPro / Club); audio meets are free. The Studio camera is for everyone.
- Recordings and streams must never be mirror-imaged (the live e2e checks the film's badges).
- A TV in the room can show the stage; the TV's token is its credential.

## Broadcast (Publishing portal)

- Publisher mode for Club owners and Super admins: YouTube/Facebook/Instagram/Twitch settings, a Preview tab
  that shows exactly what the platforms get, the relay on Fly.io (RTMP `-c copy`). Stream keys never return in
  full or reach the browser. The broadcast audio is the same PUBLISH MODE bus (`broadcast/publisherBus.ts`,
  Worker-based encoders). YouTube normalises playback to −14 LUFS: the balance, not the absolute level, is what
  the viewer gets.

## Roles and plans

Audio only / Dual / Club owners / Super admin. Free (audio meets), SVV ($5/month, video, 10 h), SVVPro ($50/month,
100 h), Club Owner ($250, 15 users, 300 h; the owner adds the emails). Super Admin portal sets pricing and durations;
Stripe primary (UPI/PhonePe per the owner's master prompt). Social posting (X, Facebook, Instagram) with the user's
own handles; Snapchat removed.
