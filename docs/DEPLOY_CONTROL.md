# Deploying sv-control (the SVT DB service)

`services/control` is the only server SingersVoice needs for the Tracks catalog, Live Meets and
Publishing. It is a small Hono app that runs on **Cloudflare Workers (free tier)** — the SVT DB is a
SQLite-backed Durable Object inside the worker, so there is nothing else to provision — or on any
Node 22 host. The web app finds it through `VITE_CONTROL_URL` (or discovers it, see below).

## Option A — Cloudflare, fully automated (recommended)

1. Create a Cloudflare account (free) and copy the **Account ID** from the dashboard (right side of
   *Workers & Pages*).
2. *My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template*. Nothing to add —
   create it and copy the token.
3. In GitHub: https://github.com/singersvoice/SingersVoice/settings/secrets/actions → **New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = the token
   - `CLOUDFLARE_ACCOUNT_ID` = the account id
4. *Settings → Secrets and variables → Actions → Variables*:
   - `PRIVILEGED_EMAILS` = your Google address (comma-separate several). These are admin accounts: Publishing mode without a plan, and the right to grant the Publisher plan to others (docs/BILLING.md).
   - `VITE_GOOGLE_CLIENT_ID` (from docs/GOOGLE_OAUTH.md) — the service also uses it to validate tokens.
5. https://github.com/singersvoice/SingersVoice/actions/workflows/deploy-control.yml → **Run workflow**
   (it also runs by itself on every push that touches the service).

The workflow registers a workers.dev subdomain if the account has none, deploys the worker
(`https://sv-control.<your-subdomain>.workers.dev`), generates `PUBLISH_KEY_SECRET` on a brand-new
worker (it stays on the worker across deploys and is never printed; add a `PUBLISH_KEY_SECRET` repo
secret only if you want to pin your own) and re-runs *Deploy web* with that URL. *Deploy web* can also find the URL by itself from
the Cloudflare account, so no repo variable has to be set by hand; set `VITE_CONTROL_URL` only to
point the app somewhere else. From then on every push redeploys both.

Free-tier budget: 100k requests/day. A 10-performer meet in the lobby polls every 2 s per device
(~18k requests/hour at full stage); live/settled rooms poll every 5 s. The Durable Object keeps the
SVT DB in one SQLite database (free tier: 5 GB storage, 5 M rows read/day, 100k rows written/day).

## Option B — any Node host (Fly.io, DigitalOcean, your own box)

```bash
docker compose up --build            # local
# or
PORT=8787 SV_DB=/data/sv-control.sqlite GOOGLE_CLIENT_ID=… PRIVILEGED_EMAILS=you@gmail.com \
PUBLISH_KEY_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
node --no-warnings=ExperimentalWarning services/control/src/index.ts
```

Then set the repo variable `VITE_CONTROL_URL` to `https://<your host>` and run *Deploy web*.

## Environment

| Variable | Where | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | var | Access tokens must be issued to this OAuth client |
| `ALLOWED_ORIGINS` | var | Extra browser origins (GitHub Pages + localhost are always allowed) |
| `PRIVILEGED_EMAILS` | var/secret | Admin accounts: Publishing mode without a plan, and the right to grant plans (the first account ever seen is one too) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PUBLISHER`, `APP_URL` | secret | The Publisher plan through Stripe — docs/BILLING.md |
| `PUBLISH_KEY_SECRET` | secret | AES-GCM key (base64, 32 bytes) for stream keys at rest — generated on the worker if not given |
| `DEV_AUTH` | var | `1` accepts `X-Dev-User` headers — local dev and CI only, never in production |
| `ICE_SERVERS` | var/secret | JSON array of RTCIceServer for performer-to-performer video, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`. Default: Google STUN only (works for most home/mobile networks; add TURN for corporate NATs) |
| `SV_DB` | env (Node only) | SQLite file path, default `./sv-control.sqlite` |

## Testing against a different service

In the app: *Settings → Live services → Service URL*, or open the app with `?control=https://…`.
