# Social — posting clips of saved performances

Any performance saved to a singer's Drive can go out as a **clip**: the singer picks the section
(from–to), the app makes the clip on the device, and the clip goes where the singer wants. This page
says what each network allows, what works with nothing set up, and what you (the operator) set up so
singers can post **from inside SingersVoice**.

## What singers get

- **Post a clip** on every saved performance (Performances → the performance → *Post a clip*), and the
  same sheet opens by itself after a take is **kept** (Settings → Social → *Offer to post a clip after I
  keep a take*; on by default; the starting length 30 s / 60 s / 90 s / 2 min).
- The sheet: the video, two sliders (**from**, **to**), *Play section*, *First N s* / *Last N s*, the
  **caption** (the song, who sang, the performance's link — editable), the connected networks to tick,
  **Make the clip**. The clip is written by the browser itself (MediaRecorder) — the section plays once,
  silently, at its own speed, so a one-minute clip takes a minute — as MP4 (H.264 + AAC) on Chrome for
  Windows, Mac and Android and on Safari, which is what X and Instagram take; on Linux Chrome writes
  VP9, which the share sheet and Facebook still take.
- Then:
  - **Share…** (phones and tablets): the system share sheet with the file — Instagram, Snapchat,
    Facebook, X, WhatsApp, Messages… whatever is installed. This is the **only** way into **Snapchat**
    and into a **personal Instagram account**: neither lets a web app post for you.
  - **Download**: the file, to post from any app or site by hand. On a computer the sheet also opens
    **X's** and **Facebook's** composers with the caption and the link; the clip is attached there by
    hand (Instagram and Snapchat post from their phone apps only).
  - **Post to …**: the networks connected in **Settings → Social** get the clip straight from
    SingersVoice — the file goes browser → service → network, the post's link comes back and is listed
    under *Posted from here*.

## What each network allows (as of late 2026 — verify against the networks' developer docs)

| Network | From inside SingersVoice | How | Needs |
| --- | --- | --- | --- |
| **X** | yes — a post with the video | OAuth 2.0 (PKCE) sign-in on x.com; chunked media upload (`/2/media/upload`), then `POST /2/tweets` | an X developer app (free tier posts; check the tier's monthly write limit); video ≤ 140 s, ≤ 512 MB, MP4 H.264/AAC |
| **Facebook Page** | yes — a video post on a Page the singer manages | Facebook Login; `POST /{page-id}/videos` with the Page's token | a Meta app with `pages_show_list`, `pages_manage_posts`, `pages_read_engagement` (App Review); a **personal profile cannot be posted to** by any app — Facebook's rule since 2018 |
| **Instagram** (professional account linked to a Page) | yes — a Reel | the same Facebook Login; a media container (`/{ig-user-id}/media`, resumable upload), Instagram processes it, `media_publish` | the same Meta app with `instagram_basic`, `instagram_content_publish` (App Review); a business or creator account linked to the Page; video ≤ 3 min, ≤ 300 MB, MP4 H.264/AAC |
| **Instagram** (personal account) | no | the phone's share sheet | — |
| **Snapchat** | no | the phone's share sheet | — |

## Setting it up (the operator)

Secrets go on the service only — Worker secrets (`npx wrangler secret put NAME` from
`services/control`, with the Cloudflare token in the environment) or `.env.local` for a Node run —
**never in the repo** (the CI secret scan is there for a reason). The service also needs its **own
public address** for the networks' redirect: `SERVICE_URL` (e.g. `https://sv-control.<you>.workers.dev`
or your custom domain for the Worker); without it the service uses the origin of the request that started
the sign-in, which is right on Cloudflare and wrong behind a local proxy.

### X

1. developer.x.com → a project and an app (the Free tier allows posting; the limits are per month and
   per app — check them against how many singers will post).
2. User authentication settings: **OAuth 2.0**, type **Web App**; callback URL
   `https://<SERVICE_URL>/social/x/callback`; website URL `https://www.singersvoice.com`.
3. Copy the **OAuth 2.0 Client ID** and **Client Secret** into `X_CLIENT_ID` and `X_CLIENT_SECRET`.
4. The scopes the service asks for: `tweet.read tweet.write users.read media.write offline.access`
   (the last keeps the sign-in alive: X's tokens last two hours and the service renews them with the
   refresh token).

### Meta (Facebook Pages and Instagram)

1. developers.facebook.com → an app of type **Business**; add the **Facebook Login for Business**
   product; Valid OAuth Redirect URIs: `https://<SERVICE_URL>/social/meta/callback`.
2. App Review for `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`,
   `instagram_content_publish` (Instagram publishing needs the app on **Advanced Access** for these, which
   needs business verification — allow a few weeks; until then only the app's own admins/testers can
   connect).
3. Copy the **App ID** and **App Secret** into `META_APP_ID` and `META_APP_SECRET`.
4. Singers need a **Facebook Page** they manage and, for Instagram, a **professional** (business or
   creator) Instagram account **linked to that Page** (Instagram → Settings → Account → Sharing to other
   apps → Facebook). One sign-in connects both; when the singer manages several Pages, Settings → Social
   asks which one.

### Checking

- Settings → Social shows **Connect X** / **Connect Facebook & Instagram** once the ids are in (without
  them it says posting from here is not set up and points at Share… and Download).
- `tools/ci/social-e2e.mjs` runs the whole flow against a stand-in for both networks
  (`tools/ci/fake-social.mjs`); `services/control/test/app.test.ts` ("social") covers the service with
  fakes of the networks' answers.

## What the service keeps, and where tokens go

- `social_accounts`: per account and network, the target (the X user, the Page, the Instagram account),
  its handle, and the network's tokens **sealed** with the service's secret (`PUBLISH_KEY_SECRET`, like
  stream keys). They are opened only to make a post and never go to the browser (`GET /social` returns
  handles, never tokens).
- `social_states`: a sign-in under way — the random state the network sends back and, for X, the PKCE
  verifier; taken once, gone in a quarter hour. The callback route needs no sign-in of ours: the state
  is the credential, and a state presented at the wrong provider's door is ignored.
- `social_pending`: the Pages a Meta sign-in found when there were several to pick from (sealed; an hour).
- `social_posts`: every post made from here and what became of it (posted with its link, processing,
  failed with the note). Twelve posts an hour per account; a clip of 95 MB at most (the Worker's request
  limit).
- Disconnecting drops the row (and tells X to revoke the token); Facebook and Instagram go together (one
  token).
