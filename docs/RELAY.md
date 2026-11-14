# sv-relay — the RTMP leg of a broadcast (low-latency YouTube, Facebook, Instagram, Twitch)

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

## What it costs

A relay machine on Fly.io's smallest size (shared CPU, 512 MB) is about **$2–3 a month if it ran
all the time**; with `auto_stop_machines` it stops when no show has run for a while and starts on
the first segment, so an idle relay costs nothing and a show costs roughly **10¢ per stream-hour**
of machine time plus outbound bandwidth (about 1 GB an hour per RTMP target, $0.02/GB on Fly).
One machine carries about 20 shows at once (`RELAY_MAX_STREAMS`); a second region is a second
`fly scale` command.

## Setting it up (once, about 15 minutes)

You need the Fly CLI (`flyctl`) and a Fly.io account (a card is required, the free allowance covers
this). In the repository:

1. Create the app (the name must be unique on Fly; change it in `services/relay/fly.toml` if taken):

   ```
   cd services/relay
   fly launch --copy-config --no-deploy
   ```

2. Pick a long random secret and give it to the relay:

   ```
   fly secrets set RELAY_SECRET=<a long random string>
   ```

3. Deploy (the first build takes a couple of minutes — it installs ffmpeg):

   ```
   fly deploy
   ```

   `fly status` shows the machine; `https://<app>.fly.dev/health` answers `{"ok":true,"ffmpeg":…}`.

4. Tell sv-control where the relay is and the same secret (in `services/control`):

   ```
   npx wrangler secret put RELAY_URL        # https://<app>.fly.dev
   npx wrangler secret put RELAY_SECRET
   ```

That is all. From the next show on, a job whose destinations include YouTube, Facebook, Instagram
or Twitch starts a stream on the relay, and the publishing portal's Destinations page lets you
enable all four (without a relay only YouTube — through HLS ingestion — and the watch page can be
enabled).

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
- `GET /health` — no secret needed.

Everything but `/health` needs `Authorization: Bearer <RELAY_SECRET>`. A stream that receives
nothing for a minute is closed. `npm test` in `services/relay` runs the service against a stub
ffmpeg and checks the bytes go through in order.

## Running it anywhere else

It is a plain container (`services/relay/Dockerfile`, port 8080, env `RELAY_SECRET`,
`RELAY_MAX_STREAMS`): Cloudflare Containers, Render, Railway, a $5 VPS with Docker — anything
that can run an image and reach the internet works the same; only `RELAY_URL` changes.
