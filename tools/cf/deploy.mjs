// Deploy sv-control to Cloudflare Workers + D1 (free tier) in one go:
//   1. create the D1 database "svt-db" if it does not exist,
//   2. write .generated/wrangler.jsonc with its id + vars,
//   3. wrangler deploy, 4. push secrets, 5. print the worker URL (also to $GITHUB_OUTPUT as `url`).
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

// 1. D1
const dbName = env.SV_D1_NAME || 'svt-db';
let dbId = '';
try {
  const list = JSON.parse(wrangler(['d1', 'list', '--json']));
  dbId = list.find((d) => d.name === dbName)?.uuid ?? '';
} catch {
  /* fall through: create */
}
if (!dbId) {
  const out = wrangler(['d1', 'create', dbName]);
  dbId = (out.match(/database_id\s*=?\s*"?([0-9a-f-]{36})/i) ?? out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i))?.[1] ?? '';
  if (!dbId) throw new Error(`Could not read the D1 id from:\n${out}`);
  console.log(`created D1 ${dbName} (${dbId})`);
} else console.log(`using D1 ${dbName} (${dbId})`);

// 2. config
const base = JSON.parse(readFileSync(path.join(svc, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const cfg = {
  ...base,
  main: '../src/worker.ts',
  vars: {
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? '',
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS ?? base.vars?.ALLOWED_ORIGINS ?? '',
    PRIVILEGED_EMAILS: env.PRIVILEGED_EMAILS ?? '',
  },
  d1_databases: [{ binding: 'DB', database_name: dbName, database_id: dbId }],
};
delete cfg.$schema;
const cfgPath = path.join(gen, 'wrangler.jsonc');
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

// 3. deploy
const out = wrangler(['deploy', '--config', cfgPath]);
process.stdout.write(out);
const url = out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? '';

// 4. secrets
let keySecret = env.PUBLISH_KEY_SECRET ?? '';
if (!keySecret) {
  keySecret = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  console.log('\nNo PUBLISH_KEY_SECRET given — generated one. Save it as a repo secret so stream keys survive redeploys:\n  PUBLISH_KEY_SECRET=' + keySecret + '\n');
}
execFileSync('npx', ['--yes', 'wrangler@4', 'secret', 'put', 'PUBLISH_KEY_SECRET', '--config', cfgPath], { cwd: svc, env, input: keySecret, stdio: ['pipe', 'inherit', 'inherit'] });

// 5. output
console.log(`\nsv-control URL: ${url || '(see wrangler output above)'}`);
if (env.GITHUB_OUTPUT && url) appendFileSync(env.GITHUB_OUTPUT, `url=${url}\n`);
