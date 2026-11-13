/**
 * sv-control on Node 22 (no build step): `node --no-warnings=ExperimentalWarning src/index.ts`
 *
 *   PORT=8787                 SV_DB=./sv-control.sqlite (or :memory:)
 *   GOOGLE_CLIENT_ID=…        tokens must be issued to this OAuth client (recommended)
 *   ALLOWED_ORIGINS=a,b       extra browser origins
 *   PRIVILEGED_EMAILS=a,b     accounts allowed to use Publishing mode (the first account ever seen is privileged too)
 *   PUBLISH_KEY_SECRET=…      base64 32-byte key for stream keys at rest (generate once: node -e "…randomSecretB64()")
 *   DEV_AUTH=1                accept X-Dev-User headers (local dev / CI only)
 *   ICE_SERVERS=[…]           JSON array of RTCIceServer for performer video (default: Google STUN; add TURN for strict NATs)
 *   YOUTUBE_HLS_BASE=…        YouTube's HLS ingestion endpoint (default https://a.upload.youtube.com/http_upload_hls)
 *   GOOGLE_API_KEY=…          optional: published tracks are then read through the Drive API instead of Drive's public download page
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
await store.migrate();

const deps: AppDeps = {
  store,
  auth: createAuthenticator({ googleClientId: process.env.GOOGLE_CLIENT_ID, devAuth: process.env.DEV_AUTH === '1' }),
  secrets: new SecretBox(process.env.PUBLISH_KEY_SECRET ?? ''),
  runtime: 'node',
  iceServers: parseIceServers(process.env.ICE_SERVERS),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  privilegedEmails: (process.env.PRIVILEGED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  version: '2.1.0',
  youtubeHlsBase: process.env.YOUTUBE_HLS_BASE || undefined,
  googleApiKey: process.env.GOOGLE_API_KEY || undefined,
  fakeYoutubeDir: process.env.SV_FAKE_YOUTUBE_DIR || undefined,
};

const app = createApp(() => deps);
serve({ fetch: app.fetch, port: PORT }, () => console.log(`sv-control (node) listening on :${PORT}${process.env.DEV_AUTH === '1' ? ' [DEV_AUTH on]' : ''}`));
setInterval(() => void sweepMeets(store).catch(() => undefined), 30_000).unref();
