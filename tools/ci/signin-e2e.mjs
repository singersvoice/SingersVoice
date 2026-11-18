// Sign-in e2e: the first sign-in with Google faked. Google's screen lists each permission with a box to tick, none
// ticked beforehand; the first answer here comes back without the Drive one (what a first-timer who just taps Continue
// gets): the sign-in screen shows the "One more tick" step — no error toast, nothing kept — and the second answer, with
// the box ticked, signs the singer in and the set-up screen makes the Drive folders. Also: a Drive refusal in the token's
// first minute (the permission just given still reaching the Drive API) is absorbed, the folders come, no error shows.
//   node tools/ci/signin-e2e.mjs [outDir]   — builds its own copy of the app with a Google client id (a few seconds)
// Exits 1 when any check fails. Needs playwright (local install or /opt/npm-tools).
import { createRequire } from 'node:module';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
const out = process.argv[2] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const base = '/SingersVoice/';
const root = path.resolve(new URL('../..', import.meta.url).pathname);
const dist = path.join(tmpdir(), 'sv-signin-dist');
console.log('building the app with a Google client id →', dist);
execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], { cwd: path.join(root, 'apps/web'), stdio: 'inherit', env: { ...process.env, BASE_PATH: base, VITE_GOOGLE_CLIENT_ID: 'e2e-client' } });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(base)) { res.writeHead(302, { Location: base }); return res.end(); }
  let f = path.join(dist, p.slice(base.length));
  if (!existsSync(f) || statSync(f).isDirectory()) f = path.join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}${base}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// Google's sign-in library, faked: the first request answers without the Drive scope, the second with it; the profile too.
let answers = 0;
await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({ contentType: 'text/javascript', body: `
  window.google = { accounts: { oauth2: {
    initTokenClient(cfg) { return { requestAccessToken() { setTimeout(() => cfg.callback(window.__svAnswer()), 300); } }; },
    revoke(t, done) { done && done(); },
  } } };` }));
await page.route('https://www.googleapis.com/oauth2/v3/userinfo', (route) => route.fulfill({ json: { sub: '1234567890', name: 'Hari Singer', email: 'hari@example.com', picture: '' } }));
let refuse = 0; // Drive refusals still to hand out (the permission just given "not there yet")
let refused = 0;
await page.route(/https:\/\/www\.googleapis\.com\/drive\/v3\/files(\?.*)?$/, async (route) => {
  const req = route.request();
  if (refuse > 0) { refuse--; refused++; return route.fulfill({ status: 403, json: { error: { code: 403, message: 'The caller does not have permission' } } }); }
  if (req.method() === 'GET') return route.fulfill({ json: { files: [] } });
  const body = JSON.parse(req.postData() || '{}');
  return route.fulfill({ json: { id: 'f' + Math.random().toString(36).slice(2, 14).padEnd(12, '0'), name: body.name, mimeType: body.mimeType, parents: body.parents ?? [], appProperties: body.appProperties ?? {}, createdTime: new Date().toISOString() } });
});
await page.route(/https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[^?]+/, (route) => route.fulfill({ json: { id: 'x', trashed: false } }));
await page.addInitScript(() => {
  window.__svAnswer = () => {
    const n = (window.__n = (window.__n || 0) + 1);
    return n === 1 ? { access_token: 'ya29.first', expires_in: 3599, scope: 'openid email profile' } : { access_token: 'ya29.second', expires_in: 3599, scope: 'openid email profile https://www.googleapis.com/auth/drive.file' };
  };
});
await page.goto(url, { waitUntil: 'networkidle' });
let failed = false;
const ok = (c, what) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${what}`); if (!c) failed = true; };
ok(await page.locator('[data-drive-hint]').isVisible(), 'the sign-in screen says to tick the Google Drive box before the first tap');
await page.screenshot({ path: `${out}/signin-1-before.png` });
await page.getByRole('button', { name: 'Continue with Google' }).click();
await page.locator('[data-tick-drive]').waitFor({ timeout: 10000 });
ok(true, 'a sign-in without the Drive box ticked shows the "One more tick" step');
ok((await page.locator('.toast.error, .toast.warn').count()) === 0, 'and no error toast');
ok(await page.evaluate(() => !localStorage.getItem('sv.profile') && !localStorage.getItem('sv.google.token')), 'nothing is kept from the attempt without it');
await page.screenshot({ path: `${out}/signin-2-one-more-tick.png` });
refuse = 2; // the first two Drive calls after the sign-in are refused, as the moments after a consent can see
await page.getByRole('button', { name: /Continue with Google/ }).click();
await page.waitForURL(/\/setup/, { timeout: 15000 });
await page.locator('[data-drive-folders="ok"]').waitFor({ timeout: 15000 });
ok(true, 'with the box ticked the second time: signed in, the set-up screen has the Drive folders');
ok(refused === 2 && refuse === 0, `the two refusals of the fresh token were absorbed on the way (${refused} refused, asked again)`);
ok((await page.locator('.toast.error, .toast.warn').count()) === 0, 'no error toast on the way in');
await page.screenshot({ path: `${out}/signin-3-setup.png` });
ok(errors.length === 0, `no page errors (${errors.join(' | ').slice(0, 200)})`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
