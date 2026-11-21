# Security — how SingersVoice is kept safe, and the review of 20 Nov 2026

What there is to protect: singers' Google accounts and Drive files, their meets (who gets on a stage, who
hears a room), their payments, the stream keys and social tokens the service holds for them, and the
service itself (its database, its secrets, its availability). This page says how each is handled, what
the review of the whole site found, and what was changed for it. Read it with docs/ARCHITECTURE.md
(where things live) and docs/HOSTING.md (where the site runs).

## The shape of it

- **No passwords, no sessions of our own.** The app signs in with Google; the service checks the Google
  access token with Google on every request (`services/control/src/auth.ts`, cached until the token
  expires) and **only a token issued to this app's OAuth client** counts (the audience check). The
  Drive files are the singer's own: the service never holds a Google token except in flight for a
  YouTube fetch job (`/yt/fetch` → the relay; never logged, never answered back).
- **Secrets stay on the service.** Stream keys (Publishing), the networks' tokens (Social) and the
  Pages a Meta sign-in found are sealed with AES-GCM under `PUBLISH_KEY_SECRET` (`crypto.ts`) and
  opened only to use them; what goes to the browser is a hint (`…1234`) or a handle. Stripe, X, Meta
  and relay credentials are Worker secrets / `.env.local`, never in the repo; CI scans every push for
  credential shapes (Google keys and client secrets, private keys, Stripe keys, GitHub, Fly and Meta
  tokens).
- **Every route is signed in** but these, each with a credential of its own: `/health`, `/time`, the
  public watch portal (`/watch/*`: a meet's public face — the host shares that link on purpose), the
  Stripe webhook (its HMAC signature, five-minute tolerance, event ids deduplicated), a meet's event
  stream (its resume token in the query — the browser's EventSource sends no header; a 192-bit random
  token, never the Google token), a TV screen's routes (the TV's own token), and the social sign-in
  callbacks (the state the service made, taken once within a quarter hour, only at its own provider's
  door). `/fake/*` exists on Node only when a test asks for it.
- **Who may do what** is decided on the service from the account's row on every request: the role
  (audio only / dual / club owner / super admin), the plan in force (`entitlementOf`), blocked for
  good, the coupon gate; a meet's host alone ends it, removes anyone, blocks anyone, registers its film;
  the Admin routes are the super admin's alone (the last super admin cannot be demoted); Publishing
  needs the plan (or a super admin); a performance's owner alone opens or closes it for joining.
- **What a client sends is bounded** before it is kept: titles, names, notes, captions and chat lines
  sliced to their sizes; Drive ids, registry ids, YouTube ids, meet codes, promo codes and performance
  ids matched against their shapes; links kept for others (a performance's, a recording's, an invite's
  show, a catalog folder's) must be `https://` — a `javascript:` link is dropped or refused; signals
  (64 KB), mix batches (200 KB a second), live segments and social clips (95 MB) have their sizes;
  JSON that does not parse is a 400, never a crash.
- **Floods are held**: a host runs three open meets at most; chat is twenty lines in ten seconds per
  device; a TV address registers twenty screens a minute; a participant keeps four event streams and
  a TV side three (the oldest closes); an account starts twelve social posts an hour; a Checkout is
  idempotent on its order; meets expire after five idle minutes and their signals, mix and live segments
  are rolling windows.
- **The site's own headers** (Cloudflare Pages `_headers`, written by `apps/web/scripts/postbuild.mjs`
  from `scripts/headers.mjs`; `vite preview` sends the same, so every browser test runs under them):
  a Content-Security-Policy (scripts from the site, Google's sign-in and Picker and the MediaPipe CDN
  only — no inline script; frames from Google only; never framed; no plugins; forms to nowhere else),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY`, a `Permissions-Policy` (camera, microphone and display capture for the site
  itself; no geolocation, no payment API), `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
  GitHub Pages can send none of these — one more reason to finish the move (docs/HOSTING.md).
- **CORS**: the service answers only the site's origins (`DEFAULT_ORIGINS` + `ALLOWED_ORIGINS` + the
  Cloudflare preview pattern); the public watch routes answer anyone (read-only, cacheable). The
  app's address for Stripe's and the networks' way back is taken only when it is one of those origins
  and the request really came from it.
- **The relay** (`services/relay`) takes calls from sv-control alone (`RELAY_SECRET`, compared in
  constant time), spawns ffmpeg and yt-dlp with argument arrays (no shell), takes an eleven-character
  video id only (`--` before the URL), limits the video's length, and logs hosts, never tokens.
- **The browser**: no `dangerouslySetInnerHTML` but the QR code the app itself makes (its own markup
  for a known string); links from the service are rendered as `href`s and are `https://` by the rule
  above; `rel="noopener"` on every `target="_blank"`.

## The review (20 Nov 2026) — findings and what changed

| # | Finding | Severity | Change |
| --- | --- | --- | --- |
| 1 | The Google audience check ran only when `GOOGLE_CLIENT_ID` was set and the token info carried `aud`; a service without the id (or a token without `aud`) accepted a token issued to **any** app for the same Google user — any site a singer ever signed into with Google could have called the service as them. | high | `auth.ts`: no client id → every Google token is refused (an error logged once); `aud` must equal the client id. The e2e fakes answer with the id. Tests: `services/control/test/auth.test.ts`. |
| 2 | `DEV_AUTH=1` (the `X-Dev-User` header stands for a sign-in) was honoured on the Cloudflare Worker too if the var was ever set. | high (latent) | `worker.ts`: dev auth is never on on the Worker — Node only (tests, local runs). |
| 3 | Resume tokens (a device's credential for a meet) were `newId()`s: the clock plus six letters (~31 bits), the clock part known from `joinedAt`. | medium | `ids.ts newToken()`: 192 random bits, URL-safe base64; `rt-<token>`. Tests: `ids.test.ts`, the hardening test. |
| 4 | Links a client registered for everyone to open — a meet performance's `link`/`videoLink`, a recording's folder link, an invite's show link, a catalog folder link — were kept as any string and rendered as `href`s: a `javascript:` link from a host would have run in every member's browser (stored XSS). | high | `ids.ts httpsLink()`: `https://` or nothing; the routes drop or refuse anything else. Tests: `ids.test.ts`, the hardening test. |
| 5 | A catalog entry's Drive ids and track id were not checked (the fetch route checked them later, so no SSRF, but junk rows could be made). | low | Checked on publish. |
| 6 | Chat had no rate limit (a stuck key or a script could fill a room; the host's only answer was to kick). | low | Twenty lines in ten seconds per device, then 429. |
| 7 | One participant (or one TV side) could open any number of event streams. | low | Four per participant, three per TV side; the oldest closes. Tests: `streams.test.ts`. |
| 8 | The site sent no Content-Security-Policy. | medium | The policy above, on Cloudflare Pages and in `vite preview` (every browser test runs under it). `'unsafe-eval'` had to stay in `script-src`: MediaPipe's Emscripten runtime evaluates strings and runs nowhere without it — no inline script runs, and no script from anywhere but the listed origins; the alternative (MediaPipe Tasks, which needs no eval) is noted below. |
| 9 | `npm audit`: `glob` / `minimatch` (moderate: a cancellation bypass and a globparts amplification) under `vite-plugin-pwa → workbox-build`, build time only. | low | Left as is: build-time, no input of a stranger reaches them; pinning newer majors broke the build's own dependencies. Watched by `npm audit` in CI. |
| 10 | The CI secret scan knew Google, Stripe and private keys only. | low | GitHub, Fly, Meta and X token shapes added. |

Looked at and found in order: the Stripe webhook (signature, tolerance, idempotency, the order and the
subscription change on Stripe's word only); refunds (super admin, Stripe payments only, idempotent);
the admin routes (all seventeen behind `superAdminOnly`); the publishing gate (`/publishing/*`
middleware); stream keys (sealed, hinted, opened for the relay only); the social flows (state once,
PKCE for X, tokens sealed, no token in any answer, redirect only to the app's own origin); the TV
handshake (tokens, sizes, claims); the relay (no shell, ids checked, lengths limited); the watch portal
(read-only); the Drive fetches (ids checked, three fixed hosts, redirects followed to Google only);
SSE streams (a 20-minute cap, pings, closed with the meet); the coupon gate and the block-for-good
(enforced on every request); error messages (no stack, no secret, no other account's data).

## Not done, and why

- **MediaPipe without `'unsafe-eval'`**: the newer MediaPipe Tasks (`@mediapipe/tasks-vision`) loads
  its runtime as proper WebAssembly without string evaluation; moving the segmenter to it would let
  `script-src` drop `'unsafe-eval'`. Worth doing with the next piece of camera work.
- **TURN**: performer video goes peer to peer over STUN; a deployment behind strict NATs would set
  `ICE_SERVERS` to a TURN service with credentials of its own (not a security gap, a connectivity one).
- **Rate limits by address on signed-in routes**: every signed-in route is limited by what an account
  may do (meets, posts, chat), not by address; a flood of accounts is Google's sign-up to stop, and
  Cloudflare's rate limiting rules sit in front of the Worker if ever needed.
- **The public repository**: the code is open (docs/HOSTING.md says why that may change); nothing in
  it is secret, which the scan keeps so.

## Reporting

Something found? Open a **private security advisory** on the repository (GitHub → Security → Report a
vulnerability), or write to the contact named on the site's Privacy page. Please do not post a working
exploit in a public issue.
