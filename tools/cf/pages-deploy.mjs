// Deploy the built web app (apps/web/dist) to Cloudflare Pages — the site at www.singersvoice.com.
//   0. make sure the Pages project exists (created on the first run, production branch `main`),
//   1. wrangler pages deploy, 2. print the deployment URL (also to $GITHUB_OUTPUT as `url`).
// Needs: CLOUDFLARE_API_TOKEN (a token with "Cloudflare Pages: Edit"), CLOUDFLARE_ACCOUNT_ID, CF_PAGES_PROJECT
// (the project's name, e.g. `singersvoice` → singersvoice.pages.dev). The custom domain is attached once, by hand,
// in the Cloudflare dashboard (docs/HOSTING.md) — the project remembers it.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = path.join(root, 'apps', 'web', 'dist');
const env = { ...process.env };
const project = (env.CF_PAGES_PROJECT ?? '').trim();
const branch = (env.CF_PAGES_BRANCH ?? 'main').trim() || 'main';
const die = (m) => {
  console.error(m);
  process.exit(1);
};
if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) die('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are needed (repo secrets)');
if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(project)) die(`CF_PAGES_PROJECT must be a Pages project name (lower-case letters, digits, dashes), got "${project}"`);
if (!existsSync(path.join(dist, 'index.html'))) die(`no build at ${dist} — run the build first`);

const wrangler = (args, opts = {}) => execFileSync('npx', ['--yes', 'wrangler@4', ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });

// 0. the project (idempotent)
let projects = [];
try {
  projects = JSON.parse(wrangler(['pages', 'project', 'list', '--json']) || '[]');
} catch (e) {
  die(`Cannot list the Pages projects (${e instanceof Error ? e.message.split('\n')[0] : e}).\nThe CLOUDFLARE_API_TOKEN secret needs the permission "Account → Cloudflare Pages → Edit" besides "Workers Scripts → Edit": edit the token at https://dash.cloudflare.com/profile/api-tokens and run this workflow again.`);
}
if (!Array.isArray(projects)) projects = [];
if (!projects.some((p) => p && (p.name === project || p.Name === project))) {
  console.log(`Pages project "${project}" not found — creating it (production branch ${branch})`);
  wrangler(['pages', 'project', 'create', project, '--production-branch', branch], { stdio: 'inherit' });
}

// 1. deploy
const out = wrangler(['pages', 'deploy', dist, '--project-name', project, '--branch', branch, '--commit-dirty=true']);
process.stdout.write(out);
const url = (out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev\b/i) ?? [''])[0];
console.log(`\nDeployed: ${url || '(see the log above)'} — production: https://${project}.pages.dev`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `url=${url || `https://${project}.pages.dev`}\n`);
