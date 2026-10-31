# SingersVoice infrastructure (Terraform → Cloudflare)

One `terraform apply` creates every piece of cloud infrastructure SingersVoice needs and deploys
the Worker. Recordings live in each user's Google Drive, so the cloud footprint is deliberately
small: Cloudflare's free tiers cover development and a small launch; the Workers Paid plan
($5/month) is the only fixed cost once real users arrive.

| Resource | Why | Terraform resource |
| --- | --- | --- |
| D1 database | users, sessions, performances, Drive file pointers | `cloudflare_d1_database.main` |
| KV namespace | OAuth state/nonces, rate limits, hot lookups | `cloudflare_workers_kv_namespace.cache` |
| R2 bucket (30-day expiry) | cache of Drive-hosted media for playback; no egress fees | `cloudflare_r2_bucket.media_cache` + lifecycle |
| Queue | after-session jobs (share Drive files, build mix pointers) | `cloudflare_queue.jobs` |
| Realtime SFU app | WebRTC for User Mode rooms (up to 5 singers) | `cloudflare_calls_sfu_app.realtime` |
| TURN app | NAT traversal for singers on strict networks | `cloudflare_calls_turn_app.turn` |
| Account API token (Stream only) | the Worker creates live inputs/outputs for Publishing Mode | `cloudflare_account_token.worker_runtime` |
| Zero Trust Access app + policy | gates `/publish` and `/api/publish` to admin emails (custom domain only) | `access.tf` |
| Worker + static assets + secrets | API, Durable Object `SessionRoom`, SPA | `deploy.tf` via wrangler |

## Prerequisites (one time, ~15 minutes)

1. **Terraform ≥ 1.9** and **Node ≥ 20** (wrangler runs through `npx`). Run from macOS, Linux, WSL or Git Bash — the deploy step is a bash script.
2. **Cloudflare account ID**: Dashboard → Workers & Pages → *Account details* (right sidebar).
3. **Cloudflare API token** for Terraform (Dashboard → My Profile → API Tokens → Create Token → *Custom token*):
   - Account: `Workers Scripts: Edit`, `Workers KV Storage: Edit`, `D1: Edit`, `Workers R2 Storage: Edit`,
     `Queues: Edit`, `Cloudflare Realtime: Edit`, `Stream: Edit`, `Account API Tokens: Edit`,
     `Access: Apps and Policies: Edit`, `Account Settings: Read`, `Workers Tail: Read` (optional, for `wrangler tail`)
   - Zone (only if using a custom domain): `Workers Routes: Edit`, `DNS: Edit`, `Zone: Read`
   - Account Resources: *Include → your account*. (`Stream: Edit` is needed because Terraform mints a
     Stream-only runtime token for the Worker, and a token cannot grant more than it holds.)
4. **Google OAuth client** (console.cloud.google.com → APIs & Services):
   - Enable **Google Drive API**.
   - OAuth consent screen: External, add scopes `openid`, `email`, `profile`, `https://www.googleapis.com/auth/drive.file`.
     Set publishing status to **In production** (in *Testing*, refresh tokens expire after 7 days).
   - Credentials → Create → **OAuth client ID → Web application**. Authorized redirect URI: the
     `google_oauth_redirect_uri` output (you can add it after the first apply).
5. **(Custom domain only)** the zone must already be on Cloudflare, and Zero Trust must have been opened
   once in the dashboard to pick a team name (`access_team_name`).

## Deploy

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # fill in account ID, Google client, admin emails
export CLOUDFLARE_API_TOKEN=...                # the token from step 3

terraform init
terraform apply
```

The apply ends by running `wrangler deploy` with the generated config in `.generated/wrangler.jsonc`,
applying D1 migrations (when `worker/migrations/*.sql` exists) and pushing secrets. Until the real
app is built, a placeholder Worker is deployed so the whole path is exercised; `/api/health` reports
whether D1, KV and R2 bindings work.

Day-to-day releases do not need Terraform:

```bash
npx wrangler deploy --config infra/.generated/wrangler.jsonc   # after building worker/ and web/
npx wrangler dev    --config infra/.generated/wrangler.jsonc   # local dev with Miniflare
```

## What the Worker receives

Vars: `ENVIRONMENT`, `GOOGLE_CLIENT_ID`, `CF_ACCOUNT_ID`, `ADMIN_EMAILS`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`.
Secrets: `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` (32 bytes, base64, AES-256-GCM for
refresh tokens at rest), `REALTIME_SFU_APP_ID`, `REALTIME_SFU_APP_SECRET`, `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`,
`CLOUDFLARE_STREAM_TOKEN`.
Bindings: `DB` (D1), `KV`, `MEDIA_CACHE` (R2), `JOBS` (Queue producer + consumer), `SESSION_ROOM` (Durable Object), `ASSETS`.

## Cost (October 2026 list prices, USD)

| Service | Free allowance | Beyond |
| --- | --- | --- |
| Workers (incl. Durable Objects, KV) | 100k requests/day on Free | $5/month Paid plan: 10M requests, then $0.30/M |
| D1 | 5 GB storage, 5M rows read/day, 100k rows written/day | $0.75/GB-month, $0.001/M rows read |
| R2 | 10 GB-month, zero egress | $0.015/GB-month |
| Queues | Paid plan only | first 1M operations/month included |
| Realtime SFU / TURN | 1 TB egress/month | $0.05/GB |
| Stream (Publishing Mode) | — | $1 per 1,000 minutes delivered, $5 per 1,000 minutes stored |
| Zero Trust Access | 50 users | $7/user/month |

A small launch (a few hundred users, ~200 half-hour group sessions a month) stays at the $5/month plan
plus pennies of usage; see the implementation plan for the worked estimate.

## Tear down

```bash
terraform destroy
```

R2 buckets must be empty before they can be deleted; the lifecycle rule empties the cache within
`media_cache_ttl_days`, or empty it manually in the dashboard first.

## Files

```
infra/
├── versions.tf          providers, optional R2 state backend
├── variables.tf         inputs (account, domain, Google client, admins)
├── main.tf              D1, KV, R2, Queue, Realtime SFU/TURN, runtime token, generated secrets
├── access.tf            Zero Trust Access for the publishing console (custom domain only)
├── deploy.tf            generates .generated/wrangler.jsonc and runs wrangler deploy
├── outputs.tf
├── templates/wrangler.jsonc.tftpl
├── placeholder/         minimal Worker + page deployed until the app exists
└── terraform.tfvars.example
```
