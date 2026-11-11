// Work out where sv-control lives, so "Deploy web" never depends on a repo variable being set by hand:
//   1. the `control_url` workflow input (passed by deploy-control.yml right after a deploy),
//   2. the VITE_CONTROL_URL repo variable (if someone set it),
//   3. discovery: the Cloudflare account's workers.dev subdomain → https://sv-control.<sub>.workers.dev,
//      accepted only when GET /health answers.
// Prints the result and writes `url=<url>` to $GITHUB_OUTPUT (empty = the app runs without live services).
//   INPUT_URL=… VAR_URL=… CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node tools/cf/control-url.mjs
import { appendFileSync } from 'node:fs';

const env = process.env;
const WORKER_NAME = env.CONTROL_WORKER_NAME || 'sv-control';
const clean = (s) => (s ?? '').trim().replace(/\/+$/, '');

async function healthy(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function discover() {
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) return { url: '', why: 'no Cloudflare credentials in this run' };
  let res;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return { url: '', why: `Cloudflare API unreachable: ${e?.message ?? e}` };
  }
  const body = await res.json().catch(() => ({}));
  const sub = body?.result?.subdomain;
  if (!res.ok || !sub) return { url: '', why: `Cloudflare subdomain lookup failed (${res.status}): ${JSON.stringify(body?.errors ?? body)}` };
  const url = `https://${WORKER_NAME}.${sub}.workers.dev`;
  if (!(await healthy(url))) return { url: '', why: `${url}/health did not answer — is sv-control deployed yet?` };
  return { url, why: 'discovered from the Cloudflare account' };
}

let url = clean(env.INPUT_URL);
let why = 'from the workflow input';
if (!url) {
  url = clean(env.VAR_URL);
  why = 'from the VITE_CONTROL_URL variable';
}
if (url) {
  if (!(await healthy(url))) console.log(`::warning::${url}/health did not answer; the app will show the SVT DB as offline until it does.`);
} else {
  ({ url, why } = await discover());
}

console.log(url ? `sv-control URL: ${url} (${why})` : `sv-control URL: none (${why}) — the web app is built without live services`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `url=${url}\n`);
