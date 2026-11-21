# Hosting: www.singersvoice.com on Cloudflare Pages

The app is a static site (HTML, JS, CSS, the model files). It is published to **two hosts on every push to
`main`** by `.github/workflows/deploy-web.yml`:

| Host | Address | Served from | When |
| --- | --- | --- | --- |
| **Cloudflare Pages** | https://www.singersvoice.com (and `<project>.pages.dev`) | `/` | the repo variable `CF_PAGES_PROJECT` is set |
| GitHub Pages | https://singersvoice.github.io/SingersVoice/ | `/SingersVoice/` | until the repo variable `GH_PAGES` is `off` |

The `sv-control` service (Cloudflare Worker) and the relay (Fly.io) are unchanged by the move: the service already
answers the site's origins (`www.singersvoice.com`, `singersvoice.com`, the `pages.dev` address, the GitHub page,
localhost — `DEFAULT_ORIGINS` in `services/control/src/app.ts`), and Stripe sends a singer back to whichever of
those the app was opened at (the app says where it lives on each checkout; the service accepts only its own origins).

## Why not stay on github.io

- **GitHub Pages is for non-commercial sites.** Its terms forbid "commercial transactions" and running a SaaS from it.
  The moment plans are sold through Stripe, the site is a commercial service — a complaint or a review can take it down.
- **The repository must be public** for GitHub Pages on a free organization account — and the repo
  `singersvoice/SingersVoice` **is public today: anyone can read every file of the code.** (No secret is in it — the
  secret scan in CI guards that — but the code, the docs and the plans are open to the world.) Private repos get
  Pages only on paid GitHub plans.
- No control over HTTP headers (no security headers, no caching policy), a 1 GB site / 100 GB-a-month soft limit,
  10 builds an hour, and the address `singersvoice.github.io/SingersVoice/` is nobody's brand.
- Cloudflare Pages: free for this size (unlimited requests and bandwidth for a static site, 20,000 files), your own domain
  with its certificate, a global CDN, headers from a `_headers` file (the build writes one), preview deployments,
  the same account as `sv-control` — and the repo can go private.
- Disadvantage of moving: two addresses while the move is on (people with the old link / the old installed app),
  and a few one-time clicks in three places (Cloudflare, Google, GitHub) listed below.

## The move, step by step

Everything is done once. The code is already in the repo.

### 1. Cloudflare: the token

The deploy uses the same `CLOUDFLARE_API_TOKEN` as `sv-control`, which needs one more permission.

1. https://dash.cloudflare.com/profile/api-tokens → the token used for SingersVoice → **Edit**
   (or **Create Token → Edit Cloudflare Workers** template and replace the GitHub secret).
2. Permissions — add **Account → Cloudflare Pages → Edit** (keep *Workers Scripts → Edit* and the rest).
3. **Continue to summary → Save**. If you made a new token: GitHub → repo → **Settings → Secrets and variables →
   Actions → Secrets → `CLOUDFLARE_API_TOKEN` → Update** and paste it. (The token is pasted only there, never in chat.)

### 2. GitHub: turn the Cloudflare deploy on

Repo → **Settings → Secrets and variables → Actions → Variables → New repository variable**:

- `CF_PAGES_PROJECT` = `singersvoice` (the Pages project's name; its own address becomes `singersvoice.pages.dev`).

Then push (or **Actions → Deploy web → Run workflow**). The workflow builds the app for `/`, creates the Pages
project if it does not exist and deploys. The job's summary shows the `pages.dev` address — open it: the app must
work there (Google sign-in will not yet — step 4).

### 3. Cloudflare: the domain

Your domain `singersvoice.com` should be on Cloudflare (if the registrar is elsewhere: Cloudflare dashboard →
**Add a domain** → follow the nameserver change at the registrar; it is free).

1. Dashboard → **Workers & Pages → singersvoice (Pages) → Custom domains → Set up a custom domain**.
2. Enter `www.singersvoice.com` → **Continue** → **Activate domain**. Cloudflare adds the DNS record (a CNAME to
   `singersvoice.pages.dev`) and the certificate itself when the domain is on Cloudflare; otherwise it shows the
   CNAME to add at your DNS provider.
3. Repeat for `singersvoice.com` (the bare domain) so both work. Then make the bare domain go to `www`:
   **Websites → singersvoice.com → Rules → Redirect Rules → Create rule** → *Redirect from Root to WWW* template
   (301). (Or leave both serving the app — the service allows both origins.)
4. Open https://www.singersvoice.com — the app, with the padlock.

### 4. Google: let the new address sign people in

Google only hands out sign-ins to the addresses it knows.

1. https://console.cloud.google.com → the SingersVoice project → **APIs & Services → Credentials → the
   `SingersVoice Web` OAuth client**.
2. **Authorized JavaScript origins → Add URI**: `https://www.singersvoice.com`; add `https://singersvoice.com` if it
   serves the app too. Keep `https://singersvoice.github.io` while the GitHub page is published. **Save**
   (takes effect within minutes).
3. **Google Auth Platform → Branding** (the consent screen): *Application home page* `https://www.singersvoice.com`,
   *Authorized domains* add `singersvoice.com`; privacy policy `https://www.singersvoice.com/privacy.html`, terms
   `https://www.singersvoice.com/terms.html`.
4. Sign in on https://www.singersvoice.com — your Drive tracks and takes are there (they live in your Drive, not
   on the site).

### 5. Stripe: the return address

The app tells the service where it lives on every checkout, so nothing breaks — but set the default and the
wallet domain:

1. On your PC, in `services/control`: `npx wrangler secret put APP_URL` → `https://www.singersvoice.com`.
2. Stripe dashboard → **Settings → Business → Public details → Website**: `https://www.singersvoice.com`;
   **Settings → Payments → Payment method domains → Add** `www.singersvoice.com` (Apple Pay / Google Pay).

### 6. Send the old address to the new one, then make the repo private

Once sign-in works on the domain (a week or two for people to see the new address is kind):

1. Repo variable `VITE_CANONICAL_ORIGIN` = `https://www.singersvoice.com`. From the next deploy the GitHub page
   sends every visitor to the same page on the domain (`?stay` on the old address keeps you there, for support).
2. Later, when nobody opens the old address any more: repo variable `GH_PAGES` = `off`, and repo → **Settings →
   Pages → Unpublish site**. Remove `https://singersvoice.github.io` from the Google client's origins.
3. Repo → **Settings → General → Danger Zone → Change repository visibility → Private**. Cloudflare Pages
   deploys from the workflow, not from GitHub Pages, so a private repo changes nothing for the site.
   Actions minutes on a private repo: 2,000 a month free for an organization; a deploy takes about 3.

### Checks after the move

- https://www.singersvoice.com/version.json shows `"host": "cloudflare"` and the commit just pushed.
- Sign in, open Tracks (your Drive), start a meet from a phone and join from another device: the service's CORS
  allows the domain (a refused origin shows as a failed `/me` call in the browser's console).
- Pay for a plan in Stripe **test mode**: Checkout comes back to `https://www.singersvoice.com/billing/return`.
- A phone with the **old** installed app: the next open shows "A new version of SingersVoice is ready" (the GitHub
  page's build), then — with `VITE_CANONICAL_ORIGIN` set — lands on the domain. The app can be installed again
  from there (the old icon can be removed).

## How the build differs per host

`apps/web/scripts/postbuild.mjs`: on GitHub Pages a `404.html` copy of the app (its only way to a single-page app)
and `.nojekyll`; on Cloudflare Pages no `404.html` (Pages serves `index.html` for every route by itself) and a
`_headers` file: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: DENY`, a `Permissions-Policy` that
keeps the camera, the microphone and screen capture to the site itself, a year's immutable cache for the hashed
`/assets/*`, a week for the model files, none for the service worker. `version.json` names the host.
