/**
 * sv-control on Node 22 (no build step): `node --no-warnings=ExperimentalWarning src/index.ts`
 *
 *   PORT=8787                 SV_DB=./sv-control.sqlite (or :memory:)
 *   GOOGLE_CLIENT_ID=…        tokens must be issued to this OAuth client (recommended)
 *   ALLOWED_ORIGINS=a,b       extra browser origins
 *   PRIVILEGED_EMAILS=a,b     admin accounts: Publishing mode without a plan, and the right to grant plans (the first account ever seen is one too)
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, APP_URL — the plans through Stripe; the prices themselves are set on the Admin page (docs/BILLING.md)
 *   PUBLISH_KEY_SECRET=…      base64 32-byte key for stream keys at rest (generate once: node -e "…randomSecretB64()")
 *   DEV_AUTH=1                accept X-Dev-User headers (local dev / CI only)
 *   ICE_SERVERS=[…]           JSON array of RTCIceServer for performer video (default: Google STUN; add TURN for strict NATs)
 *   YOUTUBE_HLS_BASE=…        YouTube's HLS ingestion endpoint (default https://a.upload.youtube.com/http_upload_hls)
 *   GOOGLE_API_KEY=…          optional: published tracks are then read through the Drive API instead of Drive's public download page
 *   RELAY_URL, RELAY_SECRET   optional: the RTMP relay (services/relay) — low-latency YouTube, Facebook, Instagram, Twitch (docs/RELAY.md)
 *   X_CLIENT_ID, X_CLIENT_SECRET, META_APP_ID, META_APP_SECRET, SERVICE_URL — posting clips to X, Facebook Pages and Instagram (docs/SOCIAL.md)
 *   SV_FAKE_YOUTUBE_DIR=…     dev/CI: serve a stand-in for YouTube at /fake/youtube/http_upload_hls that writes the files here
 */
import { serve } from '@hono/node-server';
import { createApp, parseIceServers, sweepMeets, type AppDeps } from './app.ts';
import { createAuthenticator } from './auth.ts';
import { SecretBox } from './crypto.ts';
import { nodeSqliteDriver } from './store/driver.ts';
import { openNodeSqlite } from './store/node-sqlite.ts';
import { SqlStore } from './store/sql.ts';

const PORT = Number(process.env.PORT ?? 8787);
const db = await openNodeSqlite(process.env.SV_DB ?? './sv-control.sqlite');
const store = new SqlStore(nodeSqliteDriver(db));
store.couponsRequiredDefault = process.env.COUPONS_REQUIRED !== '0'; // the gate (coupons.ts): on unless told otherwise; the Admin page decides from then on
await store.migrate();

/** Browser tests only: Google (Drive, the token check) stands in for itself at this address. */
const fakeGoogle = process.env.SV_FAKE_DRIVE_URL ? fakeDriveFetch(process.env.SV_FAKE_DRIVE_URL) : undefined;

const deps: AppDeps = {
  store,
  auth: createAuthenticator({ googleClientId: process.env.GOOGLE_CLIENT_ID, devAuth: process.env.DEV_AUTH === '1', ...(fakeGoogle ? { fetchImpl: fakeGoogle } : {}) }),
  secrets: new SecretBox(process.env.PUBLISH_KEY_SECRET ?? ''),
  runtime: 'node',
  iceServers: parseIceServers(process.env.ICE_SERVERS),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  privilegedEmails: (process.env.PRIVILEGED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  version: '2.1.0',
  youtubeHlsBase: process.env.YOUTUBE_HLS_BASE || undefined,
  googleApiKey: process.env.GOOGLE_API_KEY || undefined,
  billing: { secretKey: process.env.STRIPE_SECRET_KEY || undefined, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || undefined, appUrl: process.env.APP_URL || 'https://www.singersvoice.com' },
  relay: process.env.RELAY_URL && process.env.RELAY_SECRET ? { url: process.env.RELAY_URL, secret: process.env.RELAY_SECRET } : undefined,
  social: {
    xClientId: process.env.X_CLIENT_ID || undefined,
    xClientSecret: process.env.X_CLIENT_SECRET || undefined,
    metaAppId: process.env.META_APP_ID || undefined,
    metaAppSecret: process.env.META_APP_SECRET || undefined,
    serviceUrl: process.env.SERVICE_URL || undefined,
    // Tests and local runs: the networks' endpoints pointed at a fake (tools/ci/servers.mjs).
    ...(process.env.SV_SOCIAL_FAKE ? { xApi: `${process.env.SV_SOCIAL_FAKE}/x`, xAuthorize: `${process.env.SV_SOCIAL_FAKE}/x/authorize`, metaGraph: `${process.env.SV_SOCIAL_FAKE}/meta`, metaVideo: `${process.env.SV_SOCIAL_FAKE}/meta-video`, metaUpload: `${process.env.SV_SOCIAL_FAKE}/meta-upload`, metaAuthorize: `${process.env.SV_SOCIAL_FAKE}/meta/authorize` } : {}),
  },
  fakeYoutubeDir: process.env.SV_FAKE_YOUTUBE_DIR || undefined,
  fetchImpl: fakeGoogle,
};

/** Every Google address the service may ask (the Drive API, the download pages, the token check) sent to the fake instead, path and query kept. */
function fakeDriveFetch(base: string): typeof fetch {
  const hosts = ['https://www.googleapis.com', 'https://drive.usercontent.google.com', 'https://drive.google.com', 'https://oauth2.googleapis.com'];
  return (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const host = hosts.find((h) => url.startsWith(h));
    return fetch(host ? `${base.replace(/\/$/, '')}${url.slice(host.length)}` : url, init);
  };
}

const app = createApp(() => deps);
serve({ fetch: app.fetch, port: PORT }, () => console.log(`sv-control (node) listening on :${PORT}${process.env.DEV_AUTH === '1' ? ' [DEV_AUTH on]' : ''}`));
setInterval(() => void sweepMeets(store).catch(() => undefined), 30_000).unref();
