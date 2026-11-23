# Security and privacy constraints (keep verbatim; never relax)

Updated 23 Nov 2026.

- Never commit secrets. `.env.local` is git-ignored. The CI secret scan catches `(sk|rk)_(live|test)_…`,
  `whsec_…`, Google keys/client secrets, private keys, `ghp_`, `github_pat_`, `fo1_/fm2_`, `EAA…`, X bearer shapes.
- Stream keys are never returned in full or sent to the browser; `PUBLISH_KEY_SECRET` is never printed.
- The owner's email is private. Never stage or report the old prototype's (`C:\Work\SVOld`) local secrets.
- Never run `npx prettier --write`; keep the single-quote, wide-line style by hand.
- The relay logs hosts only. The singer's Google token travels browser → sv-control → relay only for a YouTube
  fetch job and is never logged or answered back. The YouTube token is kept apart from the Drive token.
- A Fly token, a Cloudflare API token, Cloudflare TURN keys (`CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`) are pasted only
  into the GitHub secret field, never into chat; the API token never leaves the service.
- Stripe keys only as Worker secrets / env, never in the repo. X/Meta developer-app ids and secrets go only into
  GitHub repository secrets or the Admin → Social posting page, never into chat or the repo; social network tokens
  are sealed on the service.
- The deployed app ignores `?control=` on links. A resume token may travel in a query string (never the Google
  token) — the `/meets/:id/away?rt=` beacon relies on this.
- SingersVoice never sees or stores any password. The TV's token is its credential.
- Browser permissions are the browser's: the app asks once, reads the state where offered, and points to the
  browser's own switch when blocked; nothing saved ever stands in for the browser's record.
