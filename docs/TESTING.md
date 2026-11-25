# Testing SingersVoice on iOS, Android and the web

Live build: **https://www.singersvoice.com/** (and, while the move is on, https://singersvoice.github.io/SingersVoice/)

## Install as an app

- **iOS (Safari):** open the URL → Share → *Add to Home Screen*. Launch from the icon. Keep the app in the foreground
  while singing (iOS pauses the microphone for background web apps). Wired or Bluetooth headphones recommended.
- **Android (Chrome):** open the URL → menu → *Install app* (or the install banner). Launch from the icon.
- **Desktop (Chrome/Edge/Safari):** just open the URL; Chrome offers *Install* in the address bar.

## Portals at a glance

- **Tracks** — All / My Drive / Public catalog / YouTube tabs, in that order. **All**: one box searches the SingersVoice track database (what singers have sung, grouped by song name — a song with several files is an expandable group, several artists cascade one more level; the latest sung first), your Drive and the catalog as you type, YouTube on *Search*; **Sing** on any version brings the song into your Drive under Tracks (shared, registered as your copy) and opens the stage; ▶ previews it here. Sing a track of your own once: it is shared, registered with a 12-character id and listed for every singer; the *in the database* chip shows it. The global "last sung" and your own history move only on a Sing or a preview that plays — never on a search. *More → Publish to public catalog* shares the Drive folder and lists the track for everyone; *Add to my Drive* pulls a catalog track; **YouTube** — type a song (or paste a link): YouTube is always asked for a *karaoke track* ("karaoke" and "track" are added when missing, "karoake" set right — the line under the box says what was asked), *Add to my Drive* on a result fetches it through the relay into `Tracks/YT` (progress in the relay's words), then *Sing*: the karaoke video where the lyrics would be, muted, on the song's clock. Needs the relay (docs/RELAY.md); without it the tab says so. Track Maker has Movie and Year fields for the database's metadata. No track line anywhere (the catalog, All, the Sing screen's list, a meet's song picker) names the singer who shared or registered it, and nothing is tagged *yours* — a track of your own just says *in my library*.
- **Studio** — Track Maker, Sing, Performances (unchanged flows, now under `/studio`).
- **Live Meets** — Create meet (pick a *public* track so others can load it) → share the link/code → whoever has the link takes a slot with *Take a stage slot* (the stage is open; the host can switch to deciding each one) → with headphones on, the singers on stage hear each other and the audience hears the stage (talk-back) → *I'm ready* → host *Start the song (8 s count-in)* → everyone's stage starts at the same instant, nobody on stage hears anyone else → the song ends → nothing is saved per song: the host's device films the whole meet into their Drive as it goes, **one file** with a chapter mark per song, pause and stretch of stage (*Full meet* on the ended page at End meet, its marks on a line; under Performances with *Watch* and *Chapters*) — press Pause, Restart, Stop on the song and the film carries on, a new mark each time. Tick *Instrument* beside the mic to add a USB interface's input to your sound. Only the host can remove someone (*out* on a slot, × on a name). Idle 5 minutes → the meet closes itself.
- **Publishing** (club owners with an active year, or a super admin) — Destinations (stream keys, saved once), Publish a meet, History; **Publish** in the room opens the show view; `/watch/<meetId>` is the public in-house page. With the RTMP relay deployed (docs/RELAY.md) YouTube runs at ultra-low latency and Facebook / Instagram / Twitch go live. Recording and streaming run from *Go live* to *Stop publishing*, whatever the singers do to the song; the footage lands as one file with the same chapter marks as the host's film. **Connect YouTube** in the show view's bar (one tap), then *Go live* makes an unlisted (or public) YouTube broadcast of its own and writes its link out with Copy; a Publish from the portal opens the show view and goes live by itself.
- **Admin** (super admins: the first account ever, `PRIVILEGED_EMAILS`) — Settings › Admin: **Plans & payments** on top (every plan's price in USD and INR, period, video hours, seats, for sale or granted; a note for the Plans page; the expiring-soon and grace margins; every subscriber by standing — expired and expiring first, with the plan, the days left, the hours used this month, the last payment, *Grant again* / *Renew* / *Revoke* in the row; every payment with Stripe's fee and a *Refund* button; the Checkouts without a payment), then every account with its role (*Audio only* → no camera anywhere; *Dual*; *Club owner*; *Super admin*) and its plan chip (the hours used), *Grant* (a plan, for its period or for months) / *Renew* / *Set dates* / *Revoke*; the picture on stage and Publishing open and close at once (an expired period closes by itself, with the date on their gate). The last super admin cannot be demoted.
- **Plans** (everyone who is not a super admin: More › Plans, the Home card, Settings) — the account's plan, the video hours used and left this month, the four plans at the admin's prices, *Pay in USD / INR* when both are priced, **Choose** on each (Stripe's Checkout when payments are set up and the plan is for sale — else *ask the SingersVoice admin*), the return page waiting for Stripe's word, *Manage subscription* (Stripe's portal), the account's payments. **My club** (club owners): members by email, Add / Remove, the seats, the club's hours. In a **live meet**: a free singer is seated with the voice alone (the chip says a picture comes with a plan); with SVV the picture, the chip the hours left; hours used up, the picture goes with the reason. Publishing and Admin are not on a plain singer's menus at all (side menu, More panel, Home, Settings) — the service refuses them to that account anyway.

## 10-minute smoke test

1. **Welcome** → *Continue with Google* (needs the OAuth client, see GOOGLE_OAUTH.md) or *Try it on this device*. On Google's screen tick the Drive box (none is ticked beforehand); left unticked, the app shows **One more tick** — a step, not an error — and the next tap with the box ticked signs you in. With the coupon gate on (Admin › Coupons, on by default), the **Coupon screen** comes first: enter the coupon the admin issued to your email address; super admins are never asked.
2. **Setup** → *Allow both* (the browser's one question for the camera and the microphone; a browser that already allows them shows the step ticked), *Go to my stage*.
3. **Track Maker** → pick an mp3/m4a → paste lyrics (one line each) → choose singers + pattern → *Apply* → Timing:
   play and tap **Mark** on each line → *Review & save* → *Sing it now*.
   - Or **Library → Import** with an SVOld `*.trackmaker.json` + its mp3.
4. **Sing** → *Start singing* (3-2-1) → sing → *Finish* → *Play mix* (seek anywhere, ±10 s, Pause) → **Save** (or *Discard*; *Cancel* at any point before).
5. **Performances** → the take is listed (Temp/Kept); open → play / download.
6. **Settings** → VoxForge presets (try *Hard Tune* with auto-tune) — *Preview my voice* hears each one live, every tweak applied as it is made, *Save my sound* writes the Config files now; text size A++ / Max; backgrounds (**NONE** shows the camera picture as it is). Audio → the Track / Vocal volume in the recording, the mix and the broadcast (0 / 0 to start — the mix itself puts the voice in front; *Default* brings them back). Camera → *Auto zoom* (off to start with: your picture framed once, still and centred; on: the picture pushes in on the face while you sing, back out to the chest when you stop, and follows you when you move).
7. Turn the phone off-line (airplane mode) and reopen the app: the shell loads; device-mode tracks still play.

## Viewport matrix (automated)

`node tools/ci/screenshots.mjs` walks the app at 320×568, 360×640, 390×844, 412×915, 820×1180 and 1280×800, and
on three of them (phone, tablet, desktop) imports a track, sings 9 s with a fake microphone, finishes, keeps the
take, opens Track Maker, runs a meet and the publishing setup — every control a singer has (Track / Vocal
volume, Voice FX) is in those pictures on every size. `SV_SHOT_ONLY=ipad,desktop` walks only the viewports named.
CI uploads the screenshots as an artifact on every PR.

## Known limits of this increment

- Live meets, the catalog and publishing need `sv-control` deployed (`VITE_CONTROL_URL`) — see docs/DEPLOY_CONTROL.md; the portals explain this inline until then.
- Performers do not hear each other (Solo foldback, by design); the audience hears the stage mix the host's device relays, and watches the show (video + mix) once a publisher's show view is on air.
- The "Import a track shared with me" button needs `VITE_GOOGLE_API_KEY` (Google Picker).
- Tempo changes are real-time granular time-stretch on the backing track (key kept); extreme values sound grainy.
- On iOS the Google sign-in popup must be triggered by a tap (it is), and tokens last 1 h → *Reconnect Drive*.

## The audio lab (`tools/ci/audio-lab.mjs`)

`node tools/ci/audio-lab.mjs` renders the real vocal chain and mix bus offline in Chromium
(OfflineAudioContext with the AudioWorklets, esbuild-bundled from `apps/web/src/audio/lab.ts`) and
measures them with synthetic signals — what a listener would hear, in numbers: **the voice gate** (section 0:
the room between phrases at least 10 dB down; a breath in a break — band-limited noise at −28 dBFS, as loud as quiet
singing — at least 15 dB down at the chain's output and a breath right after a phrase at least 8 dB down in its second
half; the sung phrase, its last 100 ms and its first 30 ms untouched, a leading "s" within 4 dB); **the howl
suppressor** (section 0a: a 9.3 kHz tone rising from −60 to −12 dBFS over 1.5 s beside a voice leaves at least
25 dB down once steady and under −40 dBFS at 1 s on its way up, the voice under 4 kHz within 0.3 dB of the render
without the tone, and a voice alone — its harmonics, its vibrato — is never notched); the chain's impulse
response has one arrival (every parallel path delay-matched, no comb filter) and the worklet chain holds
the voice under 3.2 ms (PERFORMER MODE's share of what a singer hears late: the safety limiter's 2 ms and
three `sv-shaper` stages of 15 frames), the de-esser passes a
quiet 8 kHz at unity and ducks a loud one, a voice 10 dB over full scale leaves under the −3 dB
ceiling, the Studio preset adds no hidden gain, every factory preset leaves a −15 dBFS voice within a
decibel of the others (its makeup gives back what its compressor takes), a −30 LUFS track lands at
−14, a −5 dBFS and a −33 dBFS voice both ride to the vocal target within ten seconds (the bus's output
measured after the voice's limiter, which holds up to 3 dB off a voice steered to −7.8 K-weighted) and the
silence after them stays silent, the mix at 0 / 0 sits still, and at +30 / +30 the guard brings it back
under its line with no sample over the ceiling; **the finished mix, every preset** (section 6): on a
bass-heavy mastered song normalised to the track target, a −15 dBFS voice sung in phrases through each
of the sixteen presets — the music lands at −14 LUFS, the voice stands 4–6 LU over it (vocal-only and
track-only renders of the same bus; at least 3.5, Octave Down 2.3), a sung phrase lands at −7…−12.5 LUFS, the
limiter takes under 2.5 LU off it on average and nothing passes −1.2 dBFS, the chain leaves the voice
mid-forward (its 1–5 kHz against its 100–400 Hz, a decibel or more over the raw voice's; Octave Down is
excused), and the duck steps the music back 3 dB under a phrase and has it back within a second (the
track's own path rendered beside the output); **PERFORMER MODE** (section 7): the same voice through the
monitor's rider alone (`MONITOR_RIDER`) lands at the performer level (−15), 7 dB under the publish rider's —
about half as loud in the singer's ears as in the recording; the noise gate turns a −52 dBFS room down by over 10 dB between two sung phrases and
leaves the phrases themselves alone (the first 30 ms of one included); the pitch stage puts a tone a
semitone up or down, and an octave up, to within a few cents, with under 2 dB of ripple on the steady
tone and its level kept, pulls a tone 46 cents sharp onto its note at full strength and 60 % of the
way at 0.6, and reports the hold it puts on the voice. Worklet and native-fallback paths both. Run it
after any change under `apps/web/src/audio` or `apps/web/public/worklets`. The sync measurements
(`audio/sync.ts`: the lag between envelopes, a take laid against its track, the sync check's clicks)
are unit-tested on synthetic signals in `apps/web/test/sync.test.ts`.

## The site's headers in every browser test

`vite preview` (what every e2e runs against, `tools/ci/servers.mjs`) sends the same hardening headers the site
sends from Cloudflare Pages (`apps/web/scripts/headers.mjs`): the Content-Security-Policy above all. A script,
a worker, a frame or a connection the policy would stop on the site stops in the tests first — the console
errors every e2e collects say `Refused to …`, and the feature that needed it fails its check.

## The TV in the room (`tools/ci/tv-e2e.mjs`)

`BASE_PATH=/SingersVoice/ node tools/ci/tv-e2e.mjs <outDir>` (after the build): a TV — a browser context
with no sign-in — opens `/tv` and shows its four-letter code and a QR of the link to it; a singer in the
Studio taps TV, types the code and Connects; the TV links (the picture over a WebRTC link made through
the service's handshake, the words and the clock over its data channel — `lib/tv.ts`,
`services/control/src/tv.ts`): the words on top, the picture below, both on the screen, the line being
sung lit and moving on; she disconnects (the TV shows its code again); the QR's door (`/tv/<code>` on
the phone) claims the TV by itself and lands on Home; a TV page closed is forgotten on the phone.
Screenshots: `tv-code.png`, `tv-linked.png`, `tv-singing.png`.

## Social: a clip posted (`tools/ci/social-e2e.mjs`)

`BASE_PATH=/SingersVoice/ node tools/ci/social-e2e.mjs <outDir>` (after the build): a Studio singer keeps
a take and the clip sheet opens by itself (Settings → Social, on by default); she moves the from/to
sliders (held to at least three seconds, inside the take), makes the clip in the browser
(`lib/clip.ts`: MediaRecorder; MP4 where the browser writes it) and downloads it; in Settings → Social
she connects X and Facebook & Instagram through the networks' sign-in pages — stood in for by
`tools/ci/fake-social.mjs`, which approves at once and takes what the service sends it (sv-control is
pointed at it with `SV_SOCIAL_FAKE`) — picks one of two Pages, and no token reaches the browser; from
Performances she posts a clip of the take to all three and the links come back (the fake got the words
and the clip's bytes, X's token was asked once); the posts are listed in Settings; X disconnected tells X
to drop the token. Screenshots: `clip-sheet.png`, `clip-ready.png`, `settings-social.png`,
`clip-posted.png`.

## Load and chaos (`tools/ci/load-e2e.mjs`)

`node tools/ci/load-e2e.mjs <outDir> [N]` (after a build) puts N singers (default 7; CI runs 3) on one stage —
each a Chromium context with the synthetic camera and voice, the admin granting each one SVV so the picture is on —
and checks what a meet of N actually does, from the links' own statistics (`window.__svMesh.links()`), never from
a connection's state: every link up, sound and a picture arriving on each where the other side says its mic is
open and its camera on, nothing marked silent or blind. Then a 30 s sample of what the mesh costs (each device's
uplink, the browser's CPU seconds from /proc, the service's rows written from /health — written to `load-N.json`
in the out dir), and three kinds of trouble: the service killed for 20 s and started again on its file (every room
says so within seconds, the stage runs on, nobody loses a slot when it is back), a singer's tab closed without a
word (their slot cleared everywhere within 20 s, the other links untouched), and End meet twice (every device
shows it over, the service holds nothing in memory, the second end is no error). A 2-core machine fits three;
seven on it is a demonstration of a starved device (docs/LIVE_MEET_RELIABILITY.md §6).

## Live meet with two performers (`tools/ci/live-duet.mjs`)

Two Chromium contexts with a synthetic-person clip as the fake camera (`tools/ci/fake-person.mjs`,
so the real segmentation model has someone to cut out; every frame carries sensor noise of its own, as a
real camera's do, so the camera-health pixel clock sees a live camera in it) — the host on a desktop viewport, a guest on a phone — import
the sample track and meet in one room. The host takes a slot and must see herself cut out on the
lobby's stage within seconds; the guest arrives as audience and finds the stage open (*Take a stage
slot*); the host switches it off, so he asks to sing, the host sees the request and lets him on;
both lobby stages then show two performers with video linked both ways — before any song. The
publisher's show view, opened in the lobby, receives both. With both mics open the test checks
talk-back (the arriving vocal plays on each stage device, and the host's device starts filming the
meet) and, once the song runs, Solo foldback (muted again). Then both
get ready and the host starts the song: the test asserts the same mesh carries on (no reconnection),
that both devices lay out two performers on the live stage with video linked both ways through the
SVT DB relay (cut-outs drawn on both halves), that the host's cued pause freezes both timelines
at the same position and that resume restarts both together. A third, privileged account (carol,
`PRIVILEGED_EMAILS=carol@dev.local` on the test service) then opens the Publishing **show view** of the
meet on a 1080p viewport: both performers arrive over the receive-only mesh and stand huge on the show
stage (tiles over 90 % of the frame height), there are no lyrics, the chrome hides itself while the
show plays, *Go live* queues a publish job (in-house destination), the pause shows on the show view,
*Stop publishing* ends the job — and the singers' own stage is unaffected. A second tab of the same
account opens Publishing › Preview while the show view stays up: the live meet's monitor tile
receives both performers, draws the exact 16:9 broadcast picture without lyrics, reports the publish
state, and the show view keeps its own links. Between the songs the host seats the wait-listed third singer, whose mic opens by itself (talk-back on, no
tap). The second song is picked twice at once: the guest
picks a song of his own (up at once — *picked is up*), the host picks the shared song a moment
later, and the test asserts the same choice card on every singer's device (both songs, who picked
what, a *Sing this one* for each, on the third singer's phone too), that Start is off while it is
open, that the picker offers neither song again (*Up now* / *Put forward*), and that one tap by the
guest settles it everywhere — the shared song up, his own gone. After the second song the host removes a listener
(his device says so; the link no longer lets him in) and ends the meet: nothing was saved per song
on any device (no save chip after either song; the film ran on through both), and the ended page
lists **one performance — the film of the whole meet**, saved once at End meet and shared with the
meet, with its **chapter marks** exactly the run the stage made (on stage · the song · its restart ·
the jump to 0:02 · the pause · the song resumed · the jump near the end · the stage between · the
second act · the stage again), in order, each named for what it is (*CI Sample Song (from 0:02)*
where a jump or a resume picked it up), each with its place in the file climbing, the one file
spanning the whole meet (never stopped at a Start, Pause, Stop or Restart) — and the guest finds the
same film, one row with the same marks, under Performances, and no take of his own. The first
song's mark must sit at the song's kickstart as the service had it (within a couple of seconds; a
moment ahead by design); the in-app player offers a button per mark. The club owner flow replaces the old plan
grant: a plain account finds Publishing closed (*for club owners*), the Plans page offers the four
plans (to be asked of the admin, no Stripe here), the super admin grants the Club owner plan on the
Admin page, and Publishing opens for that account at once — the singers themselves have the SVV plan
granted at the start, which is what puts their picture on stage
(`tools/ci/roles-e2e.mjs` has the rest). **The cameras' health** on alice's and bob's stages is
logged from the lobby to the end (every change, with the clock that spoke — `frozenBy` — and the
camera line as it stood): a live camera is never called frozen on its picture (the pixel clock, the
measurement clock) on the synthetic person; frames the straining test machine presents late (the
frames-stopped clock, four browsers on two cores) are listed, not failed. Runs in CI after the
viewport screenshots:

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/live-duet.mjs screenshots
```

## Track search and the track database (`tools/ci/tracks-e2e.mjs`)

Four singers in one browser, each with a **Google Drive of their own faked in the test** (the unit
tests' FakeDrive, served over HTTP to the browser — `sv.googleApiBase` on the device points
`drive.ts` at it, a local address only — and to the service: `SV_FAKE_DRIVE_URL` sends sv-control's
token check and public file reads there, with a folder's sharing inherited by its files as Drive
does). The tabs are All · Recommended · Bookmarks · My Drive · Public catalog · YouTube, All first. alice imports a song; a
search registers nothing; her first **Sing** shares her folder (checked on the fake: the anyone
permission is real, and the URL is that folder), registers the song with a 12-character id, her file
ids and her name, records her first access (now, UTC) and writes the id into her track.json; a second
Sing adds no record. bob finds it under All with nothing typed (the latest sung, "by alice"); a
**preview** that plays is an access of his (the global instant moves, he is in his own history);
**Sing** brings the song through the service from alice's shared Drive into *his* Drive under
`Tracks/CI Sample Song`, byte for byte, carrying the id, shared and registered as a copy, and opens
it; sung again, his copy is opened, not made twice. His own "CI Sample Song" by another artist (an
.lrc names it) makes the second version: one song group — "2 versions · 2 artists" — folded until
opened, cascading by artist, every file with Sing; the groups and the versions sort by the latest
access on the page and in the database, and move when a song is sung again; histories are each
singer's own. **Songs you prefer, bookmarks, Recommended**: alice picks English and India in Settings
(on her account; the card says what they reach) and files her song under English; her Recommended
tab lists that song and not the one without a language (nor bob's version without one), no dropdown;
bob, with nothing set, is asked with a dropdown there — his pick shows the songs in English and his
account keeps no preference. The star on alice's song fills and the bookmark is on his account; his
own Drive track's star names the record it is and makes a second; the Bookmarks tab lists both,
Sing from there opens the copy he has, the star tapped again drops one. alice publishes her second
song (no language): her catalog keeps to her languages (nothing shown) until *Every language*; the
star on the entry keeps it as a catalog bookmark with its registry id; bob is asked in the catalog
too, and a country pick keeps it to that country's languages. In a **meet** alice hosts and bob takes
a slot (fake microphones; no camera): the service answers both singers' bookmarks, each saying whose,
and refuses an outsider; bob's Recommended, while the room stays mounted, shows them first, named for
the meet; back in the room the song picker offers them above the list, and alice's catalog bookmark
picked from there is the song up for the meet, with its catalog and registry ids. Then alice **unshares** her folder: carol still gets the song, from bob's shared copy;
with every copy unshared, dave's Sing says the files are no longer shared, nothing is saved, no
access is counted, the record is marked unavailable and the row says so. A run of searches changes
no count. Then (24 Nov) **sound settings files and the Backgrounds folder**, in the fake Drive: alice's
*Save Sound Settings* writes one file to Drive › SingersVoice › Config named by her initials, the date and
the time, holding the whole sound (the preset and its tweaks, the tempo and key, the ears, the Track / Vocal
balance); *Share* puts it in the service's sound catalog where bob's *Import Sound Settings* lists it under
"Shared by other singers" — applied, bob's device has every one of alice's values and the controls show
them; *Delete* bins the file and withdraws the share. alice's picker copies the 36 built-in pictures into
Drive › SingersVoice › Backgrounds (each stamped with its id) and lists them all; an upload from the device
(a 2400×1350 picture) lands in the folder scaled and re-encoded (WebP, well under the original) and becomes
the chosen background, drawn from its own picture; *Select* → the upload and one built-in → *Delete selected*
(the dialog confirmed) bins both, hides the built-in on the account, lists neither, and the background falls
back to a built-in picture; *Restore built-in backgrounds* brings it back and copies it in again. Runs in
CI before the live meet.

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/tracks-e2e.mjs screenshots
```

## Coupons — who may use SingersVoice (`tools/ci/coupons-e2e.mjs`)

A minute's run of the gate: with the requirement off bob is in; alice turns it on from the Coupons
page and bob's next page is the **Coupon screen** (no coupon issued for his address, the reason in
words), the service refusing him every route but his standing (`403 coupon_required`); alice issues
him a coupon on the page (Generate, an expiry a month on, a note) — the list names him as its holder,
out until he enters it; bob enters the wrong code (told so), then the right one in lower case with a
space, and is in — Home, and in after a reload; alice presses **New code** and Save — bob's next tap
is the Coupon screen again (the wrong code now) until he enters the new one; alice moves the expiry
into the past — out, with the date on his screen and in the service's answer; a month on again — in
with the code he has; alice deletes the coupon — out for good; alice turns the requirement off — in
without a coupon. Every change is read back from the service. On the test services the gate starts
off (`COUPONS_REQUIRED=0` in `tools/ci/servers.mjs`), so every other e2e signs its singers in without
one; in production it starts on.

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/coupons-e2e.mjs screenshots
```

## The Studio's stage (`tools/ci/studio-e2e.mjs`)

The singer's own stage, device mode, the synthetic person as the camera and a fake microphone that sings in
**phrases** (six seconds of voice, five of silence, on a loop — a breath is shorter than the zoom's hold, a break
is not). Measured on the live stage strip (the fake person's skin-tone head, found by colour) and in the saved
file (frame by frame, through the Performances player):

- **AUTOZOOM** (`video/framing.ts`): off by default — the seat frames the singer and holds, and the head on the
  strip stays one size (within 8 %) sung or not through the first stretch of the song; switched on in the Camera &
  zoom sheet during the song, the picture pushes in on the face while they are heard (the head ×1.5), eased over
  0.6 s, and after a real break (1.4 s under the threshold) eases back out over 1.1 s. The e2e sees the singer heard
  and not heard with the phrases, the head half as big again while heard once the switch is on, and in the 30 fps
  file both: one head size until the switch, then the glide caught between the two sizes on the way in and out.
- **The Camera & zoom button during the song**: the sheet opens with the *Auto zoom* switch (off); on reaches the feed live.
- **The Sound sheet**: *Preview my voice* opens the microphone through the preset into the ears; three presets tried
  with the preview on — it stays on, nothing restarts, no new capture; *Stop preview*; *Save my sound* writes
  `audio_plugin_settings.json` and `app_settings.json` to the device's Config store (checked in IndexedDB), the
  balance at its defaults (0 / 0 dB).
- **NONE** (Stage background): the stage shows the camera picture as it is at once (the room's wall on the strip, no
  backdrop behind), survives a reload, is shown chosen in the picker; another background brings the cut-out back.
- **The saved performance** (`video/stage.ts` 'solo'): the singer's head half as big again in the file as on the live
  strip's show stage (×1.5, measured), the crown near the top edge (from 1.5 % down, under 40 %) and the whole head in
  the upper part with the chest below it; the Performances player as tall as the window allows, at the file's own
  aspect; *Play mix* in the review plays the take through the mix bus.
- **The review's timeline** (24 Nov): Forward 10 s while playing (the position jumps ahead and plays on), Back 10 s,
  Pause holds the position and offers Play mix, the bar seeks the paused take anywhere, Play mix goes on from there;
  *Discard* beside *Save* while the take is only in Temp, gone once it is saved (the button then says Saved).
- **The track's speed in the file**: two 5-second stretches of the saved file, 22 s apart, are located in the song by
  its sweep (`audio-measure.mjs` `locate`): the distance between them on the song's clock is 22 s within 15 ms
  (measured: 0.1 ms) — no drift, no slowing, no speeding.
- **A frozen camera** (section 5b; `video/stillness.ts`, `localFeed.ts`, `capture.ts`): mid-song the camera is swapped
  for a canvas stream presenting one frame of the fake person over and over (the frames flow, the pixels never
  change — a camera driver frozen on a frame); the feed calls it frozen on its pixels within 7 s (measured 5.1), the
  stage restarts the camera by itself within 12 s (5.5): one video-only capture, the microphone, the recorder, the
  song and the audio context untouched, the picture flowing again, the take's vocal whole.
- **Cancel**: before Start the stage has Cancel (back to the track list) and Home; during a take Cancel stops the song
  and the recorder, throws the take away — no review — and returns to the stage.
- **The two listening modes on the stage**: with *Hear myself* on, the monitor's rider (PERFORMER MODE,
  `__svEngine.monitorOutDb`) is read beside the mix bus's voice meter (PUBLISH MODE, `__svShow.mixLevels()`)
  while the fake microphone sings — the ears within 3 dB of −15 (K-weighted), the bus's voice −13…−7 dBFS RMS
  with the music ducked, the two at least 3.5 dB apart.
- **The saved take's sound** (ffmpeg's EBU R128 on the file): −13…−7 LUFS integrated, the sung phrases at
  least −11 LUFS short-term and 4 LU over the breaks (the music a quarter louder since 24 Nov), true peak under
  −0.5 dBFS (measured −0.9…−1.1: the −1.5 ceiling and the AAC overshoot).
- **The permissions** (`lib/permissions.ts`, `video/capture.ts`): a phone that says it is an iPhone makes ONE
  getUserMedia for camera + microphone at the stage's entry, none at Start (the engine takes the camera's microphone),
  none for the next song (the microphone parked between songs); a computer opens the camera alone at entry and the
  microphone at Start. The setup's *Allow both* is one question for both and the step is ticked; Settings says what
  the browser holds; a browser that blocks the camera is told so on the stage, with the way back, and the song still
  runs with the microphone. ~5 minutes.

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/studio-e2e.mjs screenshots
```

## Every screen fits a phone (`tools/ci/fit-e2e.mjs`)

Every portal and settings page, the pickers and the Studio's stage with a song open, on four phone widths (320,
360, 390, 412) and a tablet, at every text size the Display setting offers (1×, 1.3×, 1.6×, 2×): nothing wider than
the window (the root's `clientWidth` — in a phone emulation, as on a phone, a layout wider than the screen widens
`window.innerWidth` instead of scrolling, so that counts too), and the stage keeps its Start button on screen without
scrolling with the lyrics readable (two lines' room at a 24 px+ font). One line per screen and size; the widest
elements named and pictured when a screen fails. 480 combinations, ~12 minutes.

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/fit-e2e.mjs screenshots
```

## Joining a performance (`tools/ci/join-e2e.mjs`)

Three singers, Google Drive faked per singer (as the track e2e), fake cameras with the synthetic
person (`fake-person.mjs`: the real segmentation model cuts them out) and a fake microphone. alice
imports a 24-second song and sings it in the Studio with her camera on: the take lands in her Drive
as the show **and her cut-out video beside it** (alpha-packed, found again from the show's own
properties, Save moving both). **Invite others to join**: both files shared anyone-with-the-link,
the song in the track database, the invite on record with one layer — alice, her cut-out, where its
frame 0 falls on the show — and the link is the app's own page. bob, a **free account** (voice
alone in a live meet, `/me` says so), opens the link: the show and alice's cut-out come through the
service, the song from the track database; his stage says *joining alice · you are singer 2* with
two performers, alice's picture on it before a note is sung, the song's second part his by default,
tempo and key fixed; he sings with his camera on (the Studio's camera is every singer's: a plan
gates live meets alone), keeps: the review says *with alice*, the manifest remembers what it joined
and both singers in slot order, alice's layer moved onto his clock by the arithmetic join.ts states,
his saved show has **two cut-outs** on it (the fake person's badge, once per singer, clustered by
where it is in a frame) and sound. bob opens his: alice's invite counts one join; her Performances
page lists *Joined yours* (Watch, Join too) and marks her take *open to join · 1 joined*. carol joins
bob's: three performers, the row from the middle out — carol, alice, bob left to right (the first singer in the
centre) on her stage and in her saved show. alice closes hers: the
link no longer opens it. ~6 minutes.

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/join-e2e.mjs screenshots
```

## The first sign-in (`tools/ci/signin-e2e.mjs`)

Google faked in the browser (its sign-in library and the profile and Drive endpoints answered by the
test; the script builds its own copy of the app with a client id, a few seconds). Google's screen
lists each permission with a box to tick, none ticked beforehand, and the first answer comes back
without the Drive one — what a first-timer who just taps Continue gets: the sign-in screen shows the
**One more tick** step (what to tick and why), no error toast, nothing kept from the attempt. The
second answer has the box ticked: signed in, the set-up screen makes the Drive folders — with the
first two Drive calls refused (403, the way the moments after a consent can see) and asked again
without a word. No error toast on the way in, no page errors.

```bash
node tools/ci/signin-e2e.mjs screenshots
```

## Roles, the Admin page and the instrument (`tools/ci/roles-e2e.mjs`)

A run of three minutes of what every role and plan comes to, read back from the service after every
change, never from the page that made it: the first account (alice) is the super admin and a new one
(bob) is dual and on the Free plan; the service refuses the account list, a role change and every
Publishing route to anyone else (`403 publishing_closed`); the Admin page lists every account with a
count per role and turns a singer away. **The menus**: bob's More panel has no Publishing, no Admin
and no club — the Plans page instead — and his Home the Plans card; the Publishing gate points him at
the plans; alice's side menu has Publishing and no Plans page of her own. **The picture on stage comes
with a plan**: on alice's open stage bob is seated with the voice alone, the chip saying a picture
comes with a plan, the room carrying `audio` for him; alice grants him **SVV** through the service —
his seat gets the picture on the next heartbeat and the chip the hours left (*10 h 0 m*); the service
counts his seconds on stage; alice sets his month's hours to the limit and the picture goes on the
next heartbeat with the reason (*used up*), the room carrying `audio` again; hours back, it returns;
the plan revoked, the voice alone and the Free plan. **The plans**: the four are on the Admin page
with the prices, hours and seats asked for; alice prices the club year ($250, ₹21 000, a year) and
writes a note; the service keeps them (and refuses them to bob); bob's Plans page shows the four at
her prices with the note, offers *Pay in INR*, and, with no Stripe on the test service, says to ask
the admin (no Choose button). alice makes bob **audio only**: Settings on his device locks *Camera on
stage* with the reason, on the stage he is seated with the *audio only · no camera* chip, and the room
carries `media: audio` for him. She grants him the **Club owner plan** on the Admin page: the service
opens Publishing at once (a year from today, start and end kept), the overview has him *active · 365
days left*, *0/15 members*, the grant as his last payment and on the payments record, his device
opens the portal, his Plans page shows the plan, its end, the club's hours, Publishing open and the
seats, and Publishing and **My club** are now on his Home and in his More panel. **His club**: he
names dave by email — listed *not signed in yet*, the seats counting; dave signs in and has the club's
picture and hours, bob's club, no Publishing (and no club of his own to add to); removed, dave is on
the Free plan again. She **sets the dates** to a period that has run out: the subscription stands
*expired*, the overview flags it (*expired · 35 days ago*, first in the list), Publishing is closed on
the service with the date in words and on his gate; **Grant again** from the overview gives the plan's
year from today and opens it again, **Renew** there adds a year to the end of it; **Revoke** closes it
at once with the reason, on the overview too. The last super admin cannot be demoted (the toast says
to make another one first); a second super admin made on the page has the Admin page and Publishing
on the service at once and opens the page. Then the **instrument**: *Instrument* ticked in Settings
lists the audio inputs to pick from and keeps the input and its level on the device; in the room the
input opens with the microphone and is named on the mic status with its level; unticking closes it.

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/roles-e2e.mjs screenshots
```

### Sound checks — what a listener actually gets

**The mix lab (`tools/ci/mix-lab.mjs`, `npm run mix-lab`)** measures the audience's player on its
own, exactly: the real `MixPlayer` and the real `sv-mix-out` worklet run in Chromium on a song
encoded the way the host's device encodes the stage mix (Opus batches, one a second), on an
AudioContext at 48 kHz and again at 44.1 kHz (a laptop: every packet resampled), and six seconds of
the output are recorded on the audio thread (the `sv-tap` worklet) and measured
(`tools/ci/audio-measure.mjs`): the output is the song (normalised cross-correlation above 0.9 —
the capture is matched against the whole song by FFT in the band of a sweep the test song carries,
so the answer is a correlation coefficient and the exact track position), located within 0.3 s of
where the player says it is (the lyrics follow the sound), **not one click** (the song puts nothing
in the top of the spectrum, so a burst there is a seam — none), not one gap, the position advancing
at real time, 3–5 s behind the newest batch. The player's Worker (`audio/mixPlay.worker.ts`) runs in
the lab as in the app (the lab serves it next to its page); the batches are handed to the player as
the service's stream would hand them. A third run is **a stall**: the batches stop for four seconds
and then come on — the cushion runs out, the sound pauses in silence (faded out, never cut: no
click at either edge), and comes back faded in once the cushion is full, from exactly where it
stopped, nothing skipped — twelve seconds measured, the pause and both sides of it.

**The rider lab (`tools/ci/rider-lab.mjs`, `npm run rider-lab`)** measures the mix's automatic
vocal level: the real `sv-leveler` worklet with the real `VOCAL_RIDER` settings on an
OfflineAudioContext, fed a synthetic microphone (`apps/web/src/audio/riderLab.ts`: a steady hiss at
one level and, over it, the e2e's voice sung in two-second phrases) — a microphone that only hisses
at −40 dBFS comes out at −40 (never riden up; the old rider made it −22), a voice 12 dB over the
hiss comes up as far as its hiss allows (the hiss between its phrases kept 12 dB under the target —
the riders measure K-weighted now, and a white hiss reads about 3 dB louder that way, as the ear
hears it), a quiet singer on a quiet microphone gets the full lift to the vocal target, a loud
singer is brought down to it (the hiss with them), a voice only 5 dB over the hiss leaves the rider
shut, and the guard (`MIX_GUARD`, no floor rule) holds a hot mix at its line. The targets are read
from the bundle (`window.svRiderConfig`), never written into the lab.

**The live e2e** then measures the real pipeline, with the synthetic singing voice as every
microphone (a smooth harmonic voice, in phrases) and the test song (`tools/ci/e2e-song.mjs`: the
sample on a loop with a slow 4.5 → 7.5 kHz sweep under it, so any six seconds can be told exactly
where in the song they were):

- **the audience**: six seconds of exactly what an audience device plays (`window.__svMix`),
  recorded at the same moment as six seconds of the host's own mix (`window.__svStage`) — sound
  (RMS), **no gap** (10 ms or more of digital silence), **no click** (an isolated step of 0.25 or
  more, unmistakable whatever a codec adds), the **song itself** (correlation above 0.3 in the
  audience's output and in the host's mix), **where the mix player says it is** (within 0.75 s of
  the position the player reported as the capture began), and 3–8 s behind the stage — when the
  host's Opus encoder is starved on the test machine (its queue past 25 blocks, or blocks left out
  during the capture), the gap, click, song and position checks stand down and say so: the audience
  then hears the skips the bounded backlog makes, which is the broadcaster working as designed, and
  the player itself is measured exactly in the mix lab (with the encoder and the player each in a
  Worker of their own, that stand-down is rare: the checks run for real);
- **the broadcast**: six seconds of the publisher bus (`window.__svBroadcast.bus.output`, exactly
  what the encoder gets) against the host's mix at the same moment — sound, no gap, no click, the
  backing track in it (correlation above 0.3), and the track **where the singers are** (the stage's
  position less the quarter-second vocal lag, within a second).

The measurements print beside the checks (`audience sound: …`, `the host's mix: …`, `publisher bus
sound: …`). The unit side of the same thing is `apps/web/test/mixOut.test.ts`: the stateful
resampler keeps one curve across 20 ms blocks at 44.1 → 48 and 48 → 44.1 kHz, and the `sv-mix-out`
worklet (loaded with stand-ins for the AudioWorklet globals) waits for its cushion, plays packets
back to back without a seam at either rate, fades in over its first ten milliseconds and out over
the last ten before it would run dry (no step at either edge), goes silent (not noisy) when dry,
takes its sound from a second port (the page's Worker) as from its own, and resumes once the cushion
is back from exactly where it stopped.

**The HLS lab (`tools/ci/hls-lab.mjs`, `npm run hls-lab`)** measures what the watch page plays: the
browser's own muxer (`apps/web/src/broadcast/tsMuxer.ts`) runs in Node on real H.264 + AAC that
ffmpeg made, packetised and cut into one-second segments exactly as the show view's encoder does
(video stamped on a 30 fps clock, four ADTS frames per audio PES, a cut at every keyframe), the
segments are served as a live playlist that grows one a second, and Chromium plays it through
hls.js with the watch page's own settings — with sound and without (the live e2e can only ever run
video-only, since the headless browser has no AAC encoder). The first segment must probe as H.264 +
AAC with the sound starting beside the picture; the player must start within a few seconds, keep
advancing (≥ 5 s played in 12), and raise no fatal error.

**The camera watchdog and the cut-out model** are unit-tested in Node with a fake DOM
(`apps/web/test/segmenter.test.ts`, `feedHealth.test.ts`): a model that stops answering hands the
picture to the silhouette within three seconds and gets it back the moment it answers, a new camera
is never blocked by a frame the old one still owes, a track's mute / ended events are reported at
once, a camera whose frames were flowing and stop for five seconds is called frozen (and a camera
whose frames never flowed, a hidden page or a muted track is never judged by frames).

**The meet session's clock** (`meetSession.test.ts`): an answer older than the room the stream pushed
(the service's `serverEpochMs`) leaves the room as it stands and gives up only its own lines (the
video hours, the chat); an older pushed room is ignored; one of the same instant or newer is applied;
one without a clock (an older service) as it comes.

**A still picture** (`feedHealth.test.ts`, `stageStill.test.ts`): a camera whose pixels stand
exactly still (the same frame over and over, three at least) is called frozen within
`PIXELS_STILL_AFTER` seconds and ok once they move, a dark picture never; one presenting the same
picture (the model measuring the singer exactly the same, cut-out after cut-out) is called frozen
after `STILL_AFTER` seconds and ok once it moves; a pixel of sway, the silhouette, or nobody in the
picture never is. On the stage, a remote performer whose frames arrive with the same 16×21 sample
for `STILL_AFTER_MS` is marked still (`onStill`), a changed picture unmarks them, frames that stop
give the placeholder and no mark, and a performer gone from the stage is forgotten.

**The stage frame and the seat** (`apps/web/test/framing.test.ts`, `seat.test.ts`): the head is
found crown to jaw and ear to ear on synthetic figures near and far, a blob the model lit elsewhere
(a plant) never moves the crown, a collar widening right under the jaw never swallows the head, a
fragment or the figure itself measured as a head is not plausible (a close-up is); the seat draws
the whole camera frame while settling, glides once to the stage frame of the median head and holds
it exactly, holds under wobble in place and size for half a minute, ignores a second of a different
head and follows a singer who moved and stayed in one glide, never follows measurements that
disagree (a model losing and finding the figure), and holds when nobody is found.

**The track database** (`packages/protocol/test/registry.test.ts`, `services/control/test/app.test.ts`,
`apps/web/test/registry.test.ts`): the ids (8 random characters from an alphabet without 0/O/1/I, the
month minted, the same way everywhere), the song keys that group one song's files, the reading of a
karaoke title; the service — one record per source with the blanks filled and never blanked, the
catalog mirrored, an access moving the global and the singer's own instants in UTC while searches and
copies move nothing, the groups sorted by the latest access, pages, the owner's (or a super admin's)
metadata patch; the files handed over from the owner's Drive, then from any singer's shared copy, the
record marked unavailable when none is left and available again on a new copy. The singer's side: a
track of their own shared and registered on its first Sing with the id written into the track.json,
once; somebody else's record sung — the files through the service, the copy under Tracks carrying the
id, shared and registered, found and not copied twice the next time; the service's refusal passed on
with nothing saved; a preview's audio.

**YouTube song tracks** (`services/relay/test/yt.test.mjs`, `apps/web/test/ytTracks.test.ts`,
`drive.test.ts`, `services/control/test/app.test.ts`): the relay runs a search and a whole fetch job
against a stub yt-dlp (a search answered as yt-dlp prints it, a 20 MB "download", YouTube's refusals in
its words), a stub ffprobe and ffmpeg, and a stand-in for Google's API — the two files reach the folder
in ordered pieces with the properties the app looks for, the video alone is shared anyone-with-the-link,
the token is never in an answer, a private video ends the job with the reason. The browser's import
runs against the fake Drive and a fake service: the folder under `Tracks/YT` first, the relay's words on
the bar, the track.json written beside the relay's files, a video track listed and loaded, nothing left
of a failed job; the stage's way to the video (the owner's token, else the service by the catalog entry
a copy came from), fetched once. sv-control: nothing without the relay, the search and the job through
it with the singer's own token, the catalog entry carrying the video, the video proxied like the audio.

**What the saved files hold** — the live e2e decodes two of them with ffmpeg at the end of the
run (fetched from the in-app player 8 MB at a time — a whole meet is one file) and measures six
seconds of each: the host's **film of the whole meet** (at the moment of the first song it measured
live, found where the song's mark puts it) and the publisher's **footage of the broadcast** (where
the marks put the moment it measured on the bus) must both carry the song (the backing track
located by correlation) and the voice; the film's picture must run the whole meet (frames to its
last minute, not one picture with a song behind it). **Orientation**: the fake person wears a
magenta badge on the camera's left of the head and a yellow one on the right; a frame of the film
must keep magenta left of yellow — the picture as the camera saw it, not a mirror (the
screen alone mirrors the singer's own camera, as a mirror does). The voice is told
from the song by its harmonics: the fake microphone sings a vibrato on 180 Hz (a phase modulation,
each harmonic a line ±1.2 % wide), and `voice` in `tools/ci/audio-measure.mjs` reads the power at
those harmonics against the bands between them, against the same figure for the song alone at the
same position — a mix with the voice stands many dB above; a mix without it reads like the song.
The same figure is checked live on the host's mix, the audience's sound and the publisher bus.
**PUBLISH MODE in the film**: ffmpeg's EBU R128 over 40 s of the film from the first song's mark
must read −12.5…−5 LUFS integrated (a record's loudness, the voices over the track) with a true peak
under −0.5 dBFS — the same level set the Studio's saved take is held to.

### Instant changes and the footage

In the same run a singer on his phone switches the **stage background from the live stage**; a
MutationObserver in every other page notes, on that page's own clock, the moment the new
background is in its DOM, so the test machine's polling of four busy browsers never counts: the
word must have gone out over the mesh to both peers (the other singer and the show view), every
page must have the new background within two polls (the show view under 4 s, the audience under
5 s, the host's stage under 5 s not counting the time its main thread was blocked — the host's is
the busiest page on one machine running four browsers, and the watchdog's stalls that overlap
the switch are the machine's, not the app's; the timings print beside the check, and on a real
device the word arrives within a few hundred milliseconds), and the broadcast picture
(`__svBroadcast.picture.backgroundId`) must draw it. The playlist the fake YouTube received must
say each segment is about a second (0.9–2 s: a keyframe is asked for at the first grab a second
after the last, so a late grab makes a longer segment, never a shorter one), and the segment
itself must probe as a second of frames unless the encoder left frames out (`stats.dropped`). On
this one machine the pages' main threads stall for seconds at a time, so a few checks read the
state rather than a moment: the lobby waits for the link itself (`data-linked`), the Preview tile
counts as receiving both performers when both links are up and both are drawn (frames advancing
inside one 1.5 s window is printed beside it), the two singers' "saved" chips are watched at once
(a chip stays 20 s), and a tap on the show view's self-hiding chrome wakes it first and counts as
landed when the button is gone afterwards. While the
broadcast is on air the bar must say the **footage** is being recorded into the publisher's storage
(`[data-footage="recording"]`), *Stop publishing* must complete it (`saved`), and at the end the
publisher's Performances page must list *Broadcast* with its video. The show view's own **stream
check** (`[data-stream-check="ok"]`: the playlist played back on a hidden player half a minute in)
must say the stream plays, the bar must carry the **Mic off** chip, and the public watch page must
offer no way into the meet.

## Where a tap's time goes (`tools/ci/latency-probe.mjs`)

Not a pass/fail test: a table. Two performers (the host on a desktop, a second singer on a phone
viewport) and an audience device on the local service; every row is a tap on one device and, on
the device's own clock (a MutationObserver inside the page), the moment its own screen showed the
result and the moment the other devices' screens did — a slot taken, *I'm ready*, a chat line,
*Start the song*, *Pause*, *Resume* — with a CPU profile of the host around the song start (the
hottest functions by self time), the main-thread stalls and long tasks on both singers since the
tap, the lyrics panel's size on the phone, and the heartbeat and action round trips as the
browser timed them.

```bash
BASE_PATH=/SingersVoice/ npm run build && node tools/ci/latency-probe.mjs probe-out
```

On this two-core machine with three browsers and a software GPU the absolute figures are the
machine's (a 300 ms stall is the stage canvas drawn by SwiftShader), but the shape is the app's: an
action's round trip is 15–60 ms, the singing screen is in the DOM 70 ms after the tap on an idle
device, and with the push stream the other devices follow in 40–300 ms (3.5 s when they waited for
their next poll). The page-side profile is where to look when a tap feels slow again: with the camera
pipeline in its worker the profile around a song start shows no segmentation, no `createImageBitmap`
and no `getImageData` on the page at all. `localStorage['sv.feedWorker'] = '0'` runs the pipeline
on the page for comparison (100–120 ms long tasks every 200 ms here).
