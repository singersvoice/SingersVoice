// Deploy sv-relay (services/relay) to Fly.io in one go, and tell sv-control where it is:
//   1. the Fly app exists (made if not — the name from fly.toml, RELAY_APP to override),
//   2. the relay's secret: the RELAY_SECRET repo secret when set, else the one this run makes
//      (a new one each run: both sides get the same one in the same run, so they always agree),
//   3. `fly deploy` from services/relay (ffmpeg + yt-dlp go into the image), then /health is awaited,
//   4. sv-control learns RELAY_URL and RELAY_SECRET (wrangler secret put — Cloudflare credentials in env),
//      so from the next show on YouTube runs at low latency, Facebook / Instagram / Twitch go live, and the
//      Tracks portal's YouTube song tracks work.
//
// Needs: FLY_API_TOKEN (env). Optional: RELAY_SECRET, RELAY_APP, FLY_REGION, CLOUDFLARE_API_TOKEN +
// CLOUDFLARE_ACCOUNT_ID (for step 4; without them the two values are printed for `wrangler secret put` by hand —
// the secret is printed only then, and only when it was made here, so it never lands in a log by surprise).
//   node tools/fly/deploy-relay.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const svc = path.join(root, 'services', 'relay');
const control = path.join(root, 'services', 'control');
const env = process.env;
if (!env.FLY_API_TOKEN) throw new Error('FLY_API_TOKEN is required (repo → Settings → Secrets → Actions)');

const toml = readFileSync(path.join(svc, 'fly.toml'), 'utf8');
const app = (env.RELAY_APP || toml.match(/^app\s*=\s*"([^"]+)"/m)?.[1] || 'singersvoice-relay').trim();
const region = env.FLY_REGION || toml.match(/^primary_region\s*=\s*"([^"]+)"/m)?.[1] || 'iad'; // fly.toml's primary_region decides; FLY_REGION only labels the log
const url = `https://${app}.fly.dev`;

const fly = (args, opts = {}) => {
  const r = spawnSync('flyctl', args, { cwd: svc, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const flyOk = (args, what) => {
  const r = fly(args);
  if (r.code !== 0) throw new Error(`${what} failed (${r.code}):\n${r.err || r.out}`);
  return r.out;
};

// 1. the app
const list = fly(['apps', 'list', '--json']);
let apps = [];
try {
  apps = JSON.parse(list.out);
} catch {
  apps = [];
}
if (!apps.some((a) => a?.Name === app || a?.name === app)) {
  console.log(`Fly app "${app}" not found — creating it`);
  const made = fly(['apps', 'create', app]);
  if (made.code !== 0 && !/already (been )?taken|already exists/i.test(made.err + made.out)) throw new Error(`fly apps create failed: ${made.err || made.out}\n(a name taken by someone else? set the RELAY_APP repo variable to another name)`);
} else console.log(`Fly app "${app}" exists`);

// 2. the secret: pinned by the repo, or made here (and handed to both sides below)
const pinned = Boolean(env.RELAY_SECRET);
const secret = env.RELAY_SECRET || Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
flyOk(['secrets', 'set', `RELAY_SECRET=${secret}`, '--app', app, '--stage'], 'fly secrets set');
console.log(pinned ? 'RELAY_SECRET: the repo secret, set on the relay.' : 'RELAY_SECRET: made for this run and set on the relay (sv-control gets the same one below).');

// 3. deploy and wait for it
console.log(`Deploying ${app} to ${region} (the image installs ffmpeg and yt-dlp — a couple of minutes the first time)…`);
const dep = fly(['deploy', '--app', app, '--remote-only', '--ha=false', '--yes'], { stdio: ['ignore', 'inherit', 'inherit'] });
if (dep.code !== 0) throw new Error(`fly deploy failed (${dep.code})`);
let health = null;
for (let i = 0; i < 24 && !health; i++) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) health = await r.json();
  } catch {
    /* starting */
  }
  if (!health) await new Promise((res) => setTimeout(res, 5000));
}
if (!health) throw new Error(`${url}/health did not answer after the deploy — \`flyctl logs --app ${app}\` says why`);
console.log(`Relay is up at ${url}: ffmpeg ${health.ffmpeg ?? '?'}, yt-dlp ${health.ytdlp ?? 'not found'}`);
if (!health.ytdlp) console.log('::warning::yt-dlp is not on the relay — YouTube song tracks will be off until the image has it');

// 4. sv-control
if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
  const put = (name, value) => execFileSync('npx', ['--yes', 'wrangler@4', 'secret', 'put', name, '--config', 'wrangler.jsonc'], { cwd: control, env, input: value, stdio: ['pipe', 'inherit', 'inherit'] });
  put('RELAY_URL', url);
  put('RELAY_SECRET', secret);
  console.log(`sv-control now knows the relay (RELAY_URL=${url}, RELAY_SECRET set) — it takes effect at once, no redeploy needed.`);
} else {
  console.log(`\nNo Cloudflare credentials in this run: tell sv-control yourself (in services/control):\n  npx wrangler secret put RELAY_URL      → ${url}\n  npx wrangler secret put RELAY_SECRET   → ${pinned ? 'the RELAY_SECRET repo secret' : secret}`);
}
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `url=${url}\n`);
