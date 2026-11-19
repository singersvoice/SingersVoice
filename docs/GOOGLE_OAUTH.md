# Google sign-in + Drive (one-time setup)

SingersVoice signs people in with Google and keeps their files in **their** Drive using the non-sensitive
`drive.file` scope (the app only sees files it created or that the singer picked). It is a browser-only flow
(Google Identity Services token client) — no client secret, nothing to host.

## 1. Create the OAuth client

1. https://console.cloud.google.com → create/select a project (e.g. **SingersVoice**).
2. **APIs & Services → Library** → enable **Google Drive API** (and **Google Picker API** if you want "Import a
   track shared with me").
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**, app name **SingersVoice**, your support email, app logo optional.
   - Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `https://www.googleapis.com/auth/drive.file`.
   - **Publish** the app (status *In production*). While it is *Testing*, only listed test users can sign in —
     everyone else sees Google's *Access blocked: … has not completed the Google verification process*
     (error 403 access_denied) — and tokens expire after 7 days. `drive.file`, openid, email and profile are
     all non-sensitive scopes, so publishing needs **no verification review**: the moment the status is
     *In production*, any Google account signs in. (Console → **Google Auth Platform → Audience →
     Publish app → Confirm**; if the console lists the project under *APIs & Services → OAuth consent
     screen*, the button is on that page.) The app itself says this when a sign-in is refused.
4. **Credentials → Create credentials → OAuth client ID** → *Web application*:
   - Name: `SingersVoice Web`
   - **Authorized JavaScript origins**:
     - `https://singersvoice.github.io`
     - `http://localhost:5173` and `http://localhost:4173` (local dev/preview)
     - your Cloudflare domain later (e.g. `https://app.singersvoice.com`)
   - No redirect URIs are needed for the token flow.
5. Copy the client ID (`…apps.googleusercontent.com`).

## 2. Give it to the app

- **GitHub Pages build:** repo → *Settings → Secrets and variables → Actions → Variables* →
  `VITE_GOOGLE_CLIENT_ID = <client id>` → re-run *Deploy web*.
- **Local:** `apps/web/.env.local` → `VITE_GOOGLE_CLIENT_ID=<client id>` (git-ignored).
- Optional Picker: create an **API key** restricted to the Picker API + your origins and set `VITE_GOOGLE_API_KEY`.
  Pulling a published track from another singer's Drive needs no key: the service fetches it (optionally with
  its own `GOOGLE_API_KEY`, Drive API enabled, no referrer restriction).

Without a client ID the app still runs fully in **device mode** (IndexedDB), so testing never blocks on Google.

## 3. What happens on first sign-in

1. "Continue with Google" opens the Google consent (one popup; on iOS Safari it is a sheet). Google's
   screen lists each permission with a **box to tick, none ticked beforehand** (Google's granular
   consent; an app cannot pre-tick them). The sign-in screen says so under the button — *tick the
   Google Drive box* — and when a sign-in comes back without the Drive one ticked, the app shows it as
   a step, **One more tick**, with the button reading *Continue with Google — tick the Drive box*: one
   more tap with the box ticked, and it is done. It is never reported as an error, and nothing is kept
   from the attempt without it (`DriveScopeMissingError`, `lib/google.ts`).
2. The app receives a 1-hour access token (kept in session/local storage, with the moment it was
   minted). It goes to Google and, as the sign-in, to sv-control; for a **YouTube song track**
   sv-control hands it on to the relay for that one job, which uploads the video and its sound into the
   singer's Drive with it (docs/RELAY.md) — nowhere else. In the token's first minute and a half a
   refusal from Google (a 403 while the permission just given reaches the Drive API, or the profile
   lookup) is asked again a few times before it counts.
3. It creates, once per account: `SingersVoice/Tracks` (and `Tracks/YT` for the YouTube song tracks),
   `Performances` (one file per performance), `Temp`, `Config`, `Backgrounds`, `Exports` — every file
   carries `appProperties` (`svType`, `svId`, …). The folders are a step of their own on the set-up
   screen (tried three times over a few seconds); should they still not come, that step says so with a
   **Retry** — the sign-in itself is never reported as failed once it has succeeded.
4. When the token expires a **Reconnect Drive** button appears in the top bar (a tap, no re-consent).

## 3a. YouTube run by the app (Connect YouTube — in the show view's bar, or Publishing → Destinations)

A publisher who connects YouTube lets the app run their channel for them through the YouTube Data API v3:
the HLS stream key is made once, every show gets a YouTube broadcast of its own with its link
(`youtube.com/watch?v=…`) the moment they tap **Go live**, the show view reads YouTube's own word on the
stream while it runs, and the broadcast is ended on **Stop publishing**. Nothing is pasted or looked up in
YouTube Studio. Two switches in the same Google Cloud project make it possible (once, by whoever owns the
project):

1. **APIs & Services → Library → "YouTube Data API v3" → Enable.** Until it is on, Connect YouTube says
   *The YouTube Data API is not enabled for this app yet*.
2. **OAuth consent screen → Data access (Scopes) → Add or remove scopes → tick
   `https://www.googleapis.com/auth/youtube`** ("Manage your YouTube account") → Update → Save. The
   app asks for this scope only when the publisher taps Connect YouTube, **in an authorization of its
   own** — Google refuses `drive.file` and `youtube` in one request (*"This request contains scopes
   that cannot be requested together"*), so the YouTube permission is asked for alone, kept as its own
   token, and no request lets Google merge the scopes granted before into it (`include_granted_scopes`
   off); the Drive sign-in never asks for it. It is a *sensitive* scope: with the app published and not yet
   verified by Google, the consent screen shows *"Google hasn't verified this app"* — the publisher
   clicks **Advanced → Go to SingersVoice (unsafe)** once; up to 100 users may do so. (Google's
   verification review removes that screen; it is optional for a channel's own publisher.)

The publisher's channel itself must have live streaming enabled (YouTube Studio → Create → Go live;
YouTube asks for a phone verification and takes up to 24 hours the first time) — otherwise YouTube
answers *liveStreamingNotEnabled* and the show view says so in those words.

The YouTube token is kept apart from the sign-in's (`sv.youtube.token`; it lasts an hour and is re-issued
silently at the next tap — Go live, Stop, Make it unlisted; the show view's 15-second status poll never
opens a window for it); signing out drops it, and **Disconnect YouTube** under Destinations forgets it.
Broadcasts are made **unlisted** by default (anyone with the link) — the select beside the destination
chips in the show view, or the setting under Destinations, switches them to public; never private.

## 4. Native iOS / Android apps (later)

The PWA already runs installed on both platforms. If/when native shells (Capacitor) are added they get their own
iOS/Android OAuth client IDs; the Drive layout and protocol stay the same.


## "Failed to open popup window", or a blank Google page

Two different things, both seen on phones:

- **The first tap fails, the second works.** A browser lets a page open a window only during the
  tap itself, and the first tap used to spend that moment downloading Google's sign-in library.
  The app now loads the library as soon as the sign-in screen appears, and if it is somehow not
  there yet it says "tap Continue with Google once more" instead of opening a window the browser
  will block.
- **The link was opened inside another app** (a message in WhatsApp, a mail in Gmail, a post on
  Facebook or Instagram): those apps show pages in their own built-in browser, where the sign-in
  window is blocked and Google refuses to show its sign-in page at all (a blank
  accounts.google.com). The app recognises this and shows "You are inside …'s built-in browser"
  with **Open in Safari / Open in Chrome** (and a copy-the-link button, and the menu way: ⋯ →
  Open in browser). Once SingersVoice is open in the real browser, sign-in works and the installed
  app (Add to Home Screen) never has the problem again.
