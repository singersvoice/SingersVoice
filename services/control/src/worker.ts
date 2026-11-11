/**
 * sv-control on Cloudflare Workers (free tier) — the SVT DB lives in ONE SQLite-backed Durable
 * Object ("main"), so deploying needs only the standard Workers permissions (no D1 setup).
 *
 * Bindings (wrangler.jsonc): SVT_DB (Durable Object namespace, class SvtDb)
 * Vars/secrets: GOOGLE_CLIENT_ID, ALLOWED_ORIGINS, PRIVILEGED_EMAILS, PUBLISH_KEY_SECRET, DEV_AUTH
 */
import { createApp, sweepMeets, type AppDeps } from './app.ts';
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
      allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      privilegedEmails: (env.PRIVILEGED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      version: '2.1.0',
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

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === SWEEP_PATH) return Promise.resolve(new Response('not found', { status: 404 }));
    return main(env).fetch(req);
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await main(env).fetch(new Request(`https://svt-db.internal${SWEEP_PATH}`, { headers: { [SWEEP_HEADER]: '1' } }));
  },
};
