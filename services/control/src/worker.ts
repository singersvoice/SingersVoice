/**
 * sv-control on Cloudflare Workers + D1 (free tier). Bindings (wrangler.jsonc):
 *   DB                 D1 database (SVT DB)
 *   GOOGLE_CLIENT_ID   var
 *   ALLOWED_ORIGINS    var (comma separated, optional)
 *   PRIVILEGED_EMAILS  var/secret (comma separated, optional)
 *   PUBLISH_KEY_SECRET secret (base64 32 bytes)
 */
import { createApp, sweepMeets, type AppDeps } from './app.ts';
import { createAuthenticator } from './auth.ts';
import { SecretBox } from './crypto.ts';
import { d1Driver, type D1DatabaseLike } from './store/driver.ts';
import { SqlStore } from './store/sql.ts';

interface Env {
  DB: D1DatabaseLike;
  GOOGLE_CLIENT_ID?: string;
  ALLOWED_ORIGINS?: string;
  PRIVILEGED_EMAILS?: string;
  PUBLISH_KEY_SECRET?: string;
  DEV_AUTH?: string;
}

const depsByDb = new WeakMap<object, AppDeps>();

function depsFor(env: Env): AppDeps {
  let d = depsByDb.get(env.DB as object);
  if (!d) {
    d = {
      store: new SqlStore(d1Driver(env.DB)),
      auth: createAuthenticator({ googleClientId: env.GOOGLE_CLIENT_ID, devAuth: env.DEV_AUTH === '1' }),
      secrets: new SecretBox(env.PUBLISH_KEY_SECRET ?? ''),
      runtime: 'cloudflare',
      allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      privilegedEmails: (env.PRIVILEGED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      version: '2.1.0',
    };
    depsByDb.set(env.DB as object, d);
  }
  return d;
}

const app = createApp((env) => depsFor(env as unknown as Env));

export default {
  fetch: (req: Request, env: Env, ctx: unknown) => app.fetch(req, env as unknown as Record<string, unknown>, ctx as never),
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const d = depsFor(env);
    await d.store.migrate();
    await sweepMeets(d.store);
  },
};
