/**
 * sv-control on Cloudflare Workers (free tier) — the SVT DB lives in ONE SQLite-backed Durable
 * Object ("main"), so deploying needs only the standard Workers permissions (no D1 setup).
 *
 * Bindings (wrangler.jsonc): SVT_DB (Durable Object namespace, class SvtDb)
 * Vars/secrets: GOOGLE_CLIENT_ID, ALLOWED_ORIGINS, PRIVILEGED_EMAILS, PUBLISH_KEY_SECRET, DEV_AUTH, ICE_SERVERS, YOUTUBE_HLS_BASE, GOOGLE_API_KEY (optional)
 */
import { createApp, parseIceServers, sweepMeets, type AppDeps } from './app.ts';
import { createAuthenticator } from './auth.ts';
import { SecretBox } from './crypto.ts';
import { durableSqlDriver, type SqlStorageLike } from './store/driver.ts';
import { SqlStore } from './store/sql.ts';

interface Env {
  SVT_DB: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
  GOOGLE_CLIENT_ID?: string;
  ALLOWED_ORIGINS?: string;
  PRIVILEGED_EMAILS?: string;
  PUBLISH_KEY_SECRET?: string;
  DEV_AUTH?: string;
  ICE_SERVERS?: string;
  YOUTUBE_HLS_BASE?: string;
  GOOGLE_API_KEY?: string;
}

interface DurableState {
  storage: { sql: SqlStorageLike };
}

const SWEEP_PATH = '/__sweep';
const SWEEP_HEADER = 'x-sv-internal';

/** The single SVT DB instance: SQLite in Durable Object storage + the whole Hono app. */
export class SvtDb {
  private deps: AppDeps;
  private app: ReturnType<typeof createApp>;

  constructor(state: DurableState, env: Env) {
    this.deps = {
      store: new SqlStore(durableSqlDriver(state.storage.sql)),
      auth: createAuthenticator({ googleClientId: env.GOOGLE_CLIENT_ID, devAuth: env.DEV_AUTH === '1' }),
      secrets: new SecretBox(env.PUBLISH_KEY_SECRET ?? ''),
      runtime: 'cloudflare',
      iceServers: parseIceServers(env.ICE_SERVERS),
      allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      privilegedEmails: (env.PRIVILEGED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      version: '2.1.0',
      youtubeHlsBase: env.YOUTUBE_HLS_BASE || undefined,
      googleApiKey: env.GOOGLE_API_KEY || undefined,
    };
    this.app = createApp(() => this.deps);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === SWEEP_PATH) {
      if (req.headers.get(SWEEP_HEADER) !== '1') return new Response('not found', { status: 404 });
      await this.deps.store.migrate();
      const n = await sweepMeets(this.deps.store);
      return Response.json({ swept: n });
    }
    return this.app.fetch(req);
  }
}

function main(env: Env) {
  return env.SVT_DB.get(env.SVT_DB.idFromName('main'));
}

/**
 * What every viewer of a meet asks for, again and again — the show's HLS playlist and segments,
 * the live status, the audience mix batches, the public meet page — is answered from the edge
 * cache, so a hundred viewers cost the one Durable Object a handful of requests per second
 * instead of a hundred (a segment is immutable; the rest is fresh enough for a second or two).
 * These paths carry no sign-in and answer every origin alike.
 */
export const EDGE_CACHE: { test: RegExp; ttlS: number; browser?: boolean }[] = [
  { test: /^\/watch\/[^/]+\/live\/[A-Za-z0-9_-]{1,80}\.ts$/, ttlS: 120, browser: true },
  { test: /^\/watch\/[^/]+\/live\.m3u8$/, ttlS: 1 },
  { test: /^\/watch\/[^/]+\/live$/, ttlS: 2 },
  { test: /^\/watch\/[^/]+\/mix$/, ttlS: 1 },
  { test: /^\/watch\/[^/]+$/, ttlS: 2 },
];

/** The cache TTL (seconds) for a request, or 0 when it is not one to cache. */
export function edgeCacheTtl(method: string, pathname: string): number {
  if (method !== 'GET') return 0;
  return EDGE_CACHE.find((r) => r.test.test(pathname))?.ttlS ?? 0;
}

/**
 * The Cache-Control the edge and the browser get: the edge keeps the answer for its TTL
 * (`s-maxage`); the browser keeps only what never changes (a segment) — a poll must reach the edge.
 */
export function edgeCacheControl(pathname: string, ttlS: number): string {
  const browser = EDGE_CACHE.find((r) => r.test.test(pathname))?.browser ?? false;
  return `public, max-age=${browser ? ttlS : 0}, s-maxage=${ttlS}`;
}

interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
}

async function cachedFetch(req: Request, env: Env, ctx: ExecutionContextLike, ttlS: number): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(req.url, { method: 'GET' });
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return hit;
  const res = await main(env).fetch(req);
  if (!res.ok || !res.body) return res;
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', edgeCacheControl(new URL(req.url).pathname, ttlS));
  headers.delete('vary'); // one answer for every origin (the route allows them all)
  const out = new Response(res.body, { status: res.status, headers });
  ctx.waitUntil(cache.put(key, out.clone()).catch(() => undefined));
  return out;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === SWEEP_PATH) return Promise.resolve(new Response('not found', { status: 404 }));
    const ttl = edgeCacheTtl(req.method, url.pathname);
    if (ttl > 0) return cachedFetch(req, env, ctx, ttl);
    return main(env).fetch(req);
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await main(env).fetch(new Request(`https://svt-db.internal${SWEEP_PATH}`, { headers: { [SWEEP_HEADER]: '1' } }));
  },
};
