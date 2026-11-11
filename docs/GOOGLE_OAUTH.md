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
   - **Publish** the app (status *In production*). While it is *Testing*, only listed test users can sign in and
     tokens expire after 7 days. `drive.file` is non-sensitive, so no verification review is needed.
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

Without a client ID the app still runs fully in **device mode** (IndexedDB), so testing never blocks on Google.

## 3. What happens on first sign-in

1. "Continue with Google" opens the Google consent (one popup; on iOS Safari it is a sheet).
2. The app receives a 1-hour access token (kept in session/local storage, never sent anywhere but Google).
3. It creates, once per account: `SingersVoice/Tracks`, `Performances/Live`, `Performances/Offline`, `Temp`,
   `Config`, `Backgrounds`, `Exports` — every file carries `appProperties` (`svType`, `svId`, …).
4. When the token expires a **Reconnect Drive** button appears in the top bar (a tap, no re-consent).

## 4. Native iOS / Android apps (later)

The PWA already runs installed on both platforms. If/when native shells (Capacitor) are added they get their own
iOS/Android OAuth client IDs; the Drive layout and protocol stay the same.
