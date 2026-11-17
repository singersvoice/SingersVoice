# sv-relay — the RTMP leg of a broadcast, and the fetcher of YouTube song tracks

## Why it exists

A browser cannot speak RTMP. Until now the publisher's browser pushed the show to YouTube through
**HLS ingestion** (one-second segments uploaded one by one), and YouTube plays an HLS-ingested
stream with its *normal* or *low* latency setting: the audience saw the stage **15–30 s** late.
YouTube's **ultra-low-latency** setting — a few seconds — only exists for RTMP, and Facebook,
Instagram and Twitch take nothing else.

`services/relay` is one small container that closes that gap: sv-control forwards every segment
the browser sends to the relay, and the relay pipes the bytes — unchanged, no transcoding — into
one `ffmpeg -c copy` per show that writes them to every RTMP target at once. Stream keys travel
only between the two services (sv-control opens them from its sealed store), never through a
browser. With the relay in place a YouTube viewer is typically **3–5 s** behind the stage
(1 s segment + upload + YouTube's ultra-low-latency buffer); the in-house watch page is about 4 s behind.

```
publisher's browser ──TS segments──▶ sv-control (Worker) ──▶ relay (ffmpeg -c copy) ──RTMP──▶ YouTube / Facebook / Instagram / Twitch
                                        │
                                        └──▶ the watch page (HLS, as before)
```

A browser cannot download from YouTube either. The same container is where **YouTube song
tracks** happen (the Tracks portal's YouTube section): a singer types a few words, picks a karaoke
video, and the relay — `yt-dlp` and `ffmpeg` — downloads it (H.264 + AAC, 720p at most), takes the
sound out into its own file, and uploads both into the singer's own Drive
(`SingersVoice/Tracks/YT/<title>/`) with the singer's own Google sign-in, the video shared
anyone-with-the-link. The app then has a track like any other: the sound is the backing track the
singers sing to, the video (the words are in the picture) stands where the lyrics would be — in the
Studio and on every singer's stage in a meet. The singer's Google token goes from the browser to
sv-control (as on every request) and from there to the relay for that job alone; it is never
logged or answered back.

```
Tracks portal ─ search ─▶ sv-control ─▶ relay: yt-dlp (search) ─▶ the first dozen results
Tracks portal ─ fetch ──▶ sv-control ─▶ relay: yt-dlp (download) → ffmpeg (sound out, mp4 fast-start) → Drive (resumable upload, share) ─▶ job done
Tracks portal ─ writes track.json beside the two files ─▶ a song track; the stage shows the video, muted, on the song's clock
```

Caveat, in plain words: YouTube does not like downloads from servers. `yt-dlp` is updated by the
relay itself when it starts and once a day (YouTube changes under it every few weeks), but a cloud
address can still be told to "sign in to confirm you're not a bot" for a while. The app then says so
("YouTube asked the server to sign in — try again later, or another video"); nothing half-made is
left in the Drive.

## What it costs

A relay machine on Fly.io's smallest size (shared CPU, 1 GB) is about **$5 a month if it ran all the
time**; with `auto_stop_machines` it stops when no show or download has run for a while and starts
on the first request, so an idle relay costs nothing and a show costs roughly **10¢ per stream-hour**
of machine time plus outbound bandwidth (about 1 GB an hour per RTMP target, $0.02/GB on Fly). A
YouTube song track costs a minute or two of machine time. One machine carries about 20 shows at once
(`RELAY_MAX_STREAMS`) and two downloads at a time (`RELAY_YT_JOBS`, eight more waiting); a second
region is a second `fly scale` command.

## Setting it up (once — one secret)

You need a Fly.io account (a card is required; the usage above is within what a hobby account
allows). Then, in the repository on GitHub (**Settings → Secrets and variables → Actions**):

1. Make a Fly token — on your computer with the Fly CLI, `flyctl tokens create deploy -x 999999h`,
   or in the Fly dashboard under *Tokens* — and add it as the secret **`FLY_API_TOKEN`**.
2. Run the workflow **Deploy sv-relay (Fly.io)** from the Actions tab (it also runs by itself on
   every push that touches `services/relay/`). It makes the Fly app, sets the relay's secret, builds
   the image (ffmpeg and yt-dlp go in), waits for `/health`, and — with the Cloudflare credentials
   that are already there for sv-control — tells sv-control where the relay is (`RELAY_URL`,
   `RELAY_SECRET`). Nothing else to do: from the next show on YouTube runs at low latency,
   Facebook / Instagram / Twitch can be enabled on the Destinations page, and the Tracks portal's
   YouTube section works.

Optional: a **`RELAY_SECRET`** repo secret pins the shared secret (otherwise each run makes a fresh
one and sets it on both sides in the same run); the **`RELAY_APP`** repo variable names the Fly app
when `singersvoice-relay` is taken.

### By hand instead

In `services/relay`: `fly launch --copy-config --no-deploy`, `fly secrets set RELAY_SECRET=<a long
random string>`, `fly deploy`; then in `services/control`: `npx wrangler secret put RELAY_URL`
(`https://<app>.fly.dev`) and `npx wrangler secret put RELAY_SECRET` (the same string).
`https://<app>.fly.dev/health` answers `{"ok":true,"ffmpeg":…,"ytdlp":…}`.

## YouTube: set the stream to ultra-low latency

The relay removes our part of the delay; YouTube's own buffer is a setting on the stream:
YouTube Studio → Go live → Stream → **Stream settings → Stream latency → Ultra-low latency**.
Keep the default stream key there (it does not change between broadcasts, so it is saved once on
the Destinations page). Without the relay (HLS ingestion), choose **Low latency** — ultra-low is
not offered for HLS — and expect 10–20 s.

## What the relay accepts

- `POST /streams/:id/start` — `{ targets: [{ kind, url, key }] }`; `url` must be `rtmp://` or `rtmps://`.
- `POST /streams/:id/segments` — the MPEG-TS bytes of one segment (up to 8 MB), in order.
- `POST /streams/:id/stop`.
- `GET /streams/:id` — running, bytes, segments, ffmpeg's last lines.
- `GET /yt` — whether yt-dlp is here, and its version.
- `GET /yt/search?q=…` — the first dozen YouTube results for the words (a pasted link or id is that one video).
- `POST /yt/fetch` — `{ videoId, trackId, folderId, name, token }`: a job; answers `202 { job }`.
- `GET /yt/jobs/:id` — the job: `queued · downloading · converting · uploading · done · error`, a fraction, one line on where it is, the result (the two Drive file ids, duration, size, title, channel) or the reason it failed, in words.
- `GET /health` — no secret needed: ffmpeg's version, the stream count, yt-dlp's version, the job count.

Everything but `/health` needs `Authorization: Bearer <RELAY_SECRET>`. A stream that receives
nothing for a minute is closed; finished jobs are forgotten after an hour. `npm test` in
`services/relay` runs the service against a stub ffmpeg (the bytes go through in order) and against
a stub yt-dlp, a stub ffprobe and a stand-in for Google's API (a search answered, a job run end to
end — the pieces of the upload in order, the properties the app looks for, the video shared, the
token never in an answer — and a refusal in words).

Environment: `RELAY_SECRET`, `PORT`, `RELAY_MAX_STREAMS` (20), `RELAY_IDLE_MS` (60 000),
`RELAY_FFMPEG` / `RELAY_FFPROBE` / `RELAY_YTDLP` (the programs), `RELAY_YT_JOBS` (2 at a time),
`RELAY_YT_QUEUE` (8 waiting), `RELAY_YTDLP_UPDATE=0` (no self-update), `RELAY_YTDLP_ARGS` (extra
yt-dlp arguments for every call — a proxy, an extractor argument), `RELAY_YTDLP_COOKIES` (a browser's
YouTube cookies in Netscape format, the text itself, for a machine YouTube keeps asking to sign in:
`fly secrets set RELAY_YTDLP_COOKIES="$(cat cookies.txt)"`; yt-dlp's wiki says how to export them),
`RELAY_GOOGLE_API` (tests).

## Running it anywhere else

It is a plain container (`services/relay/Dockerfile`, port 8080, env `RELAY_SECRET`,
`RELAY_MAX_STREAMS`): Cloudflare Containers, Render, Railway, a $5 VPS with Docker — anything
that can run an image and reach the internet works the same; only `RELAY_URL` changes.
