# Social — posting performances to X, Facebook and Instagram

Singers connect their own handles in **Settings → Social** and post a clip of any performance saved to
their Drive straight from SingersVoice — to their **X** timeline, to a **Facebook Page** they manage,
and to the **Instagram professional account** linked to that Page — with the post's link back in the
app. For that to be offered, SingersVoice itself has to be registered once with X and once with Meta
(a "developer app" each), by you, the operator. This page is that setup, click by click; the secrets
go into GitHub and the deploy puts them on the service by itself. Nothing is pasted into chat, nothing
goes into the repository.

## What singers get

- **Post a clip** on every saved performance (Performances → the performance → *Post a clip*), and the
  same sheet opens by itself after a take is **kept** (Settings → Social → *Offer to post a clip after I
  keep a take*, on by default; the starting length 30 s / 60 s / 90 s / 2 min; *Whole performance*
  when it fits the networks ticked).
- The sheet: the video, two sliders (**from**, **to**), *Play section*, the **caption** (the song, who
  sang, the performance's link — editable), the connected networks ticked, **Make the clip** (written by
  the browser itself: MP4 H.264/AAC on Chrome for Windows, Mac and Android and on Safari — what X and
  Instagram take; a minute of clip takes a minute to write), then **Post to …** — the clip goes browser →
  service → network, and the links come back (also listed under Settings → Social → *Posted from here*).
- With no network connected yet, the sheet leads to Settings → Social. Beside posting: **Share…** (a
  phone's share sheet with the file, any app installed) and **Download**.

## What the networks allow — and what is therefore not offered

| Network | Posts from SingersVoice | Where it lands | The network's rule |
| --- | --- | --- | --- |
| **X** | yes | a post with the video on the singer's own timeline | an X developer app; videos ≤ 140 s |
| **Facebook Page** | yes | a video post on a Page the singer manages | a Meta app with Page permissions (App Review); **a personal profile cannot be posted to by any app** (since 2018) |
| **Instagram professional** (business or creator) account linked to that Page | yes | a Reel on the account's profile | the same Meta app with Instagram permissions; videos ≤ 3 min |
| Instagram personal account | no | — | no API; the account can be switched to professional, free, in Instagram → Settings → Account type |
| Snapchat | no — not in the app | — | no API a web app may post through |

## Setting it up (once, by the operator)

Everything ends on the app's **Admin page → Social posting**: two boxes per network (the id and the
secret the network gives you), **Save**, and every singer finds **Connect** in Settings → Social at
once — no deploy, nothing in the repo (the secret is sealed on the service and never shown again). The
Admin page also shows, with a **Copy** button, the exact address each network asks for as "the way
back" (the callback), so nothing has to be typed. (The GitHub way still works too: repository secrets
`X_CLIENT_ID`, `X_CLIENT_SECRET`, `META_APP_ID`, `META_APP_SECRET`, which the *Deploy sv-control*
workflow puts on the service; what is pasted on the Admin page wins over them.)

### X (10 minutes)

1. Go to **developer.x.com** (it is called the X Developer Portal) and sign in with the X account that
   will own the integration. Choose the **Free** plan (it allows posting; the limits are per month —
   check them against how many singers will post) and create a **Project**, then an **App** in it.
2. In the app's **Settings** tab, find **User authentication settings** → **Set up**:
   - App permissions: **Read and write**.
   - Type of App: **Web App, Automated App or Bot**.
   - Callback URI: the address under **The way back** on Admin → Social posting → X (Copy, paste).
   - Website URL: `https://www.singersvoice.com`.
   - Save.
3. In the app's **Keys and tokens** tab, under **OAuth 2.0 Client ID and Client Secret**, copy the two
   values (regenerate the secret if it is not shown).
4. Admin → Social posting → X: paste them into the two boxes → **Save**. The chip says *on*.
5. Settings → Social: **Connect X** is there. Tap it, approve on X's page, and your handle shows.

### Meta — Facebook Pages and Instagram (30 minutes, then Meta's review)

1. Go to **developers.facebook.com** and sign in with the Facebook account that will own the
   integration → **My Apps** → **Create App**. Use case: **Other** → type **Business** → a name (say
   "SingersVoice") → create.
2. In the app's dashboard, **Add product** → **Facebook Login for Business** → Set up. Under its
   **Settings**: *Valid OAuth Redirect URIs*: the address under **The way back** on Admin → Social
   posting → Facebook & Instagram (Copy, paste). Save.
3. **App settings → Basic**: copy the **App ID** and the **App Secret** (Show). Add the **Privacy Policy
   URL** `https://www.singersvoice.com/privacy.html` and the **Terms of Service URL**
   `https://www.singersvoice.com/terms.html` (Meta needs both before the app can go live).
4. Admin → Social posting → Facebook & Instagram: paste the two values → **Save**.
5. **Try it at once**: while the app is in *Development* mode, it works for the app's own admins,
   developers and testers — add yourself and any tester under **App roles**. Settings → Social →
   **Connect Facebook & Instagram** → approve → pick the Page if you manage several. A Page you manage
   and (for Reels) an Instagram **professional** account linked to that Page are the singer's side of it
   (Instagram → Settings → Account type → Switch to professional; then link it to the Page from the
   Page's settings → Linked accounts).
6. **For everyone else**: **App Review** → *Permissions and features* → request **Advanced Access** for
   `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`,
   `instagram_content_publish`. Meta asks for a screen recording of the flow (connect in Settings →
   Social, post a clip) and a short explanation ("singers post a clip of their own performance to a
   Page/Instagram account they manage"), and for **Business verification** of the account (a business
   document). Allow one to three weeks. Then switch the app to **Live** (the toggle at the top of the
   dashboard). Until then singers outside the app's roles see Connect, and Meta's page refuses them.

### Checking

- Settings → Social shows **Connect X** / **Connect Facebook & Instagram** the moment the Admin page has
  the pair; without it the row says the admin has not switched posting on yet.
- The whole flow runs in CI against stand-ins for both networks (`tools/ci/social-e2e.mjs`,
  `tools/ci/fake-social.mjs`); the service side with fakes of the networks' answers
  (`services/control/test/app.test.ts`, "social").

## What the service keeps, and where tokens go

- `social_accounts`: per account and network, the target (the X user, the Page, the Instagram account),
  its handle, and the network's tokens **sealed** with the service's secret (`PUBLISH_KEY_SECRET`, like
  stream keys). They are opened only to make a post and never go to the browser (`GET /social` returns
  handles, never tokens). X's tokens last two hours and are renewed with the refresh token before a post;
  a Page's token does not expire.
- `social_states`: a sign-in under way — the random state the network sends back and, for X, the PKCE
  verifier; taken once, gone in a quarter hour, and only at its own provider's door.
- `social_pending`: the Pages a Meta sign-in found when there were several to pick from (sealed; an hour).
- `social_posts`: every post made from here and what became of it (posted with its link, processing,
  failed with the note). Twelve posts an hour per account; a clip of 95 MB at most (the Worker's
  request limit — six minutes of 720p).
- Disconnecting drops the row (and tells X to revoke the token); Facebook and Instagram go together (one
  token).
