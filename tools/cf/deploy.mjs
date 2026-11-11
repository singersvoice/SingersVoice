// Deploy sv-control to Cloudflare Workers (free tier) in one go:
//   0. make sure the account has a workers.dev subdomain (a fresh account has none; wrangler can't ask in CI),
//   1. write .generated/wrangler.jsonc with the vars filled in (the SVT DB is a SQLite Durable Object,
//      so there is nothing to provision — a plain "Edit Cloudflare Workers" token is enough),
//   2. wrangler deploy, 3. push secrets, 4. print the worker URL (also to $GITHUB_OUTPUT as `url`).
//
// Needs: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (env). Optional: GOOGLE_CLIENT_ID, ALLOWED_ORIGINS,
// PRIVILEGED_EMAILS, PUBLISH_KEY_SECRET (generated and printed once if missing — save it as a secret!).
//   node tools/cf/deploy.mjs
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const svc = path.join(root, 'services', 'control');
const gen = path.join(svc, '.generated');
mkdirSync(gen, { recursive: true });

const env = process.env;
for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) if (!env[k]) throw new Error(`${k} is required`);
const wrangler = (args, opts = {}) =>
  execFileSync('npx', ['--yes', 'wrangler@4', ...args], { cwd: svc, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
const api = async (route, init = {}) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body?.success !== false, status: res.status, result: body?.result, errors: body?.errors ?? [] };
};

const base = JSON.parse(readFileSync(path.join(svc, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

// 0. workers.dev subdomain
let subdomain = (await api('/workers/subdomain')).result?.subdomain ?? '';
if (!subdomain) {
  const rnd = Math.random().toString(36).slice(2, 6);
  for (const name of ['singersvoice', `singersvoice-${rnd}`, `sv-${rnd}${Date.now().toString(36).slice(-3)}`]) {
    const r = await api('/workers/subdomain', { method: 'PUT', body: JSON.stringify({ subdomain: name }) });
    if (r.ok) {
      subdomain = r.result?.subdomain ?? name;
      console.log(`Registered the workers.dev subdomain "${subdomain}" for this account.`);
      break;
    }
    console.log(`workers.dev subdomain "${name}" not available (${r.errors.map((e) => `${e.code} ${e.message}`).join('; ') || r.status}) — trying another`);
  }
  if (!subdomain) throw new Error('Could not register a workers.dev subdomain — pick one in the Cloudflare dashboard (Workers & Pages) and re-run.');
}
const expectedUrl = `https://${base.name}.${subdomain}.workers.dev`;

// 1. config (the SVT DB is a SQLite Durable Object — nothing to provision)
const cfg = {
  ...base,
  main: '../src/worker.ts',
  vars: {
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? '',
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS ?? base.vars?.ALLOWED_ORIGINS ?? '',
    PRIVILEGED_EMAILS: env.PRIVILEGED_EMAILS ?? '',
  },
};
delete cfg.$schema;
const cfgPath = path.join(gen, 'wrangler.jsonc');
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

// 2. deploy
const out = wrangler(['deploy', '--config', cfgPath]);
process.stdout.write(out);
const url = out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? expectedUrl;

// 3. secrets — PUBLISH_KEY_SECRET encrypts stream keys at rest. A repo secret pins it; otherwise the
//    worker keeps the one it already has (secrets survive deploys), and only a brand-new worker gets a
//    generated one. It is never printed: Actions logs of a public repo are public.
let keySecret = env.PUBLISH_KEY_SECRET ?? '';
let have = false;
if (!keySecret) {
  try {
    const list = JSON.parse(wrangler(['secret', 'list', '--config', cfgPath, '--format', 'json']));
    have = Array.isArray(list) && list.some((s) => s?.name === 'PUBLISH_KEY_SECRET');
  } catch {
    have = false;
  }
  if (!have) {
    keySecret = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    console.log('\nPUBLISH_KEY_SECRET generated and stored on the worker (kept across deploys). To pin your own, add a PUBLISH_KEY_SECRET repo secret.');
  } else {
    console.log('\nPUBLISH_KEY_SECRET: keeping the one already on the worker.');
  }
}
if (keySecret) {
  execFileSync('npx', ['--yes', 'wrangler@4', 'secret', 'put', 'PUBLISH_KEY_SECRET', '--config', cfgPath], { cwd: svc, env, input: keySecret, stdio: ['pipe', 'inherit', 'inherit'] });
}

// 4. output
console.log(`\nsv-control URL: ${url}`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `url=${url}\n`);
