# Deploying sv-control (the SVT DB service)

`services/control` is the only server SingersVoice needs for the Tracks catalog, Live Meets and
Publishing. It is a small Hono app that runs on **Cloudflare Workers + D1 (free tier)** or on any
Node 22 host. The web app finds it through `VITE_CONTROL_URL`.

## Option A — Cloudflare, fully automated (recommended)

1. Create a Cloudflare account (free) and copy the **Account ID** from the dashboard (right side of
   *Workers & Pages*).
2. *My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template*. Add the
   permission **Account → D1 → Edit**. Create and copy the token.
3. In GitHub: https://github.com/singersvoice/SingersVoice/settings/secrets/actions → **New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = the token
   - `CLOUDFLARE_ACCOUNT_ID` = the account id
4. *Settings → Secrets and variables → Actions → Variables*:
   - `PRIVILEGED_EMAILS` = your Google address (comma-separate several). These accounts get Publishing mode.
   - `VITE_GOOGLE_CLIENT_ID` (from docs/GOOGLE_OAUTH.md) — the service also uses it to validate tokens.
5. https://github.com/singersvoice/SingersVoice/actions/workflows/deploy-control.yml → **Run workflow**.

The workflow creates the D1 database, deploys the worker, generates `PUBLISH_KEY_SECRET` the first
time (copy it from the run log into a secret so stream keys survive redeploys), stores the worker URL
in `VITE_CONTROL_URL` and re-runs *Deploy web*. From then on every push redeploys both.

Free-tier budget: 100k requests/day. A 10-performer meet in the lobby polls every 2 s per device
(~18k requests/hour at full stage); live/settled rooms poll every 5 s.

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
| `PRIVILEGED_EMAILS` | var/secret | Accounts allowed to use Publishing mode (the first account ever seen is privileged too) |
| `PUBLISH_KEY_SECRET` | secret | AES-GCM key (base64, 32 bytes) for stream keys at rest |
| `DEV_AUTH` | var | `1` accepts `X-Dev-User` headers — local dev and CI only, never in production |
| `SV_DB` | env (Node only) | SQLite file path, default `./sv-control.sqlite` |

## Testing against a different service

In the app: *Settings → Live services → Service URL*, or open the app with `?control=https://…`.
