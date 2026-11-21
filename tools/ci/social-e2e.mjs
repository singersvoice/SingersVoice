// The social e2e: a singer keeps a take and the clip sheet opens by itself; she picks a section and the
// clip is made in the browser (MediaRecorder) and downloaded; in Settings → Social she connects X and
// Facebook & Instagram through the networks' sign-in pages (stood in for by tools/ci/fake-social.mjs,
// which approves at once), picks the Page; then she posts a clip of the take to all three from the
// Performances page and the links come back; the fake received the bytes and the words. In the browser,
// the built app against the real sv-control (components/ClipSheet.tsx, components/SocialSettings.tsx,
// services/control/src/social.ts).
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/social-e2e.mjs [outDir]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeSong } from './e2e-song.mjs';
import { startServers } from './servers.mjs';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/npm-tools/node_modules/playwright');
}
const out = process.argv[2] ?? 'screenshots';
mkdirSync(out, { recursive: true });
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const formatSeconds = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const work = path.join(tmpdir(), `sv-social-e2e-${process.pid}`);
mkdirSync(work, { recursive: true });

const servers = await startServers({ base: process.env.BASE_PATH ?? '/SingersVoice/', fakeSocial: true });
const base = servers.appUrl;
const control = `control=${servers.controlUrl}`;
const SONG_S = 16;
const song = makeSong(path.join(work, 'song.mp3'), SONG_S);
const trackJson = path.join(work, 'song.track.json');
{
  const t = JSON.parse(readFileSync('apps/web/test/fixtures/sample.track.json', 'utf8'));
  t.durationMs = SONG_S * 1000;
  t.title = 'CI Clip Song';
  writeFileSync(trackJson, JSON.stringify(t));
}
const clip = path.join(work, 'fake-person.y4m');
execFileSync('node', [new URL('./fake-person.mjs', import.meta.url).pathname, clip], { stdio: 'inherit' });
const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone', 'camera'], deviceScaleFactor: 1, acceptDownloads: true });
  ctx.setDefaultTimeout(60000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/favicon|404/.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${base}?${control}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('sv.profile', JSON.stringify({ sub: 'alice', name: 'alice', email: '', picture: '', mode: 'local' }));
    localStorage.setItem('sv.mode', 'local');
    localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true, countIn: false, cameraOn: true }));
  });
  await page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.locator('input[type=file][accept*=".json"]').setInputFiles(trackJson);
  await page.locator('input[type=file][accept*="audio"]').setInputFiles(song);
  await page.getByRole('button', { name: /^Import$/ }).last().click();
  await page.getByText(/^Imported/).waitFor({ timeout: 30000 });
  const trackId = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('singersvoice'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('tracks'); const q = tx.objectStore('tracks').getAllKeys(); q.onsuccess = () => res(q.result[0]); }; }));

  // ---- The Home search: a few letters find any feature; Enter goes there (the section scrolled into view) ----
  await page.goto(`${base}home?${control}`, { waitUntil: 'networkidle' });
  await page.locator('[data-feature-query]').fill('tv');
  await page.locator('[data-feature-hit]').first().waitFor();
  const hitsTv = await page.locator('[data-feature-hit]').evaluateAll((els) => els.map((e) => e.dataset.featureHit));
  check(hitsTv[0] === '/settings#tv', `"tv" lists the TV in the room first (${hitsTv.slice(0, 3).join(', ')})`);
  await page.locator('[data-feature-query]').press('Enter');
  await page.waitForURL(/\/settings#tv/, { timeout: 15000 });
  await wait(600);
  const tvTop = await page.evaluate(() => Math.round(document.getElementById('tv')?.getBoundingClientRect().top ?? 9999));
  check(tvTop >= -40 && tvTop < 200, `Enter opens Settings scrolled to the TV section (top at ${tvTop}px)`);
  await page.goto(`${base}home?${control}`, { waitUntil: 'networkidle' });
  await page.locator('[data-feature-query]').fill('you tube');
  await page.locator('[data-feature-hit]').first().waitFor();
  check((await page.locator('[data-feature-hit]').first().getAttribute('data-feature-hit')) === '/tracks#youtube', '"you tube" finds the YouTube song tracks');
  await page.locator('[data-feature-hit]').first().click();
  await page.waitForURL(/\/tracks#youtube/, { timeout: 15000 });
  await page.locator('[data-yt-query], [data-yt-unavailable]').first().waitFor({ timeout: 15000 });
  check(true, 'a tap opens the Tracks portal on its YouTube tab');
  await page.goto(`${base}home?${control}`, { waitUntil: 'networkidle' });
  await page.locator('[data-feature-query]').fill('block someone');
  await page.locator('[data-feature-hit]').first().waitFor();
  check((await page.locator('[data-feature-hit]').first().getAttribute('data-feature-hit')) === '/settings#account', '"block someone" finds the account section with the block list');
  await page.locator('[data-feature-query]').fill('zzzz');
  await page.locator('[data-feature-none]').waitFor();
  check((await page.locator('[data-feature-hit]').count()) === 0, 'nonsense finds nothing, and says so');
  check((await page.locator('[data-feature-hit][data-feature-hit="/admin"]').count()) === 0, 'the Admin page is not in a singer\'s list');
  await page.locator('[data-feature-query]').fill('');

  // ---- A take kept: the clip sheet opens by itself (Settings → Social, on by default) ----
  await page.goto(`${base}studio/sing/${encodeURIComponent(trackId)}?${control}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Start singing' }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Start singing' }).click();
  await page.locator('button', { hasText: 'Finish' }).waitFor({ timeout: 30000 });
  await wait(9000);
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.locator('[data-review]').waitFor({ timeout: 60000 });
  await page.locator('[data-review][data-saved-state="temp"]').waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Keep', exact: true }).click();
  await page.locator('[data-review][data-saved-state="kept"]').waitFor({ timeout: 60000 });
  await page.locator('[data-clip-sheet]').waitFor({ timeout: 20000 });
  check(true, 'the take kept: the clip sheet opens by itself (Settings → Social offers it)');
  const sheet = page.locator('[data-clip-sheet]');
  check(/Download it and post it on facebook\.com/.test(await sheet.locator('[data-clip-own-apps]').innerText()) && (await sheet.locator('[data-clip-connect]').count()) === 1, "with no network connected the sheet says how to post from the singer's own accounts (a computer: Download, then the sites), and offers Connect for posting from inside the app");
  check((await sheet.locator('[data-clip-whole]').count()) === 1, 'a short performance can go out whole');
  const total = Number(await sheet.locator('[data-clip-end]').getAttribute('max'));
  check(total >= 6500 && total <= 20000, `the sliders span the take (${total} ms)`);
  const end = String(Math.min(6000, total - 500));
  await sheet.locator('[data-clip-start]').fill('1000');
  await sheet.locator('[data-clip-end]').fill(end);
  check((await sheet.locator('[data-clip-length]').innerText()).trim() === formatSeconds(Number(end) - 1000) && (await sheet.locator('[data-clip-from-label]').innerText()).trim() === '0:01', `the section is 0:01–${formatSeconds(Number(end))} (${(await sheet.locator('[data-clip-from-label]').innerText()).trim()} → ${(await sheet.locator('[data-clip-to-label]').innerText()).trim()}, ${(await sheet.locator('[data-clip-length]').innerText()).trim()})`);
  await sheet.locator('[data-clip-end]').fill('0');
  check((await sheet.getAttribute('data-clip-from')) === '0' && Number(await sheet.getAttribute('data-clip-to')) >= 3000, 'an end dragged before the start keeps a section of at least three seconds');
  await sheet.locator('[data-clip-start]').fill('1000');
  await sheet.locator('[data-clip-end]').fill(end);
  await page.screenshot({ path: `${out}/clip-sheet.png` });
  await sheet.locator('[data-clip-make]').click();
  await sheet.locator('[data-clip-ready]').waitFor({ timeout: 60000 });
  const mime = await sheet.locator('[data-clip-ready]').getAttribute('data-clip-mime');
  check(/^video\/(mp4|webm)/.test(mime ?? ''), `the clip is made in the browser as ${mime}`);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), sheet.locator('[data-clip-download]').click()]);
  const file = path.join(work, download.suggestedFilename());
  await download.saveAs(file);
  const size = statSync(file).size;
  check(size > 20_000 && /CI Clip Song clip\.(mp4|webm)$/.test(download.suggestedFilename()), `Download keeps the clip as a file: ${download.suggestedFilename()} (${(size / 1024).toFixed(0)} KB)`);
  await page.screenshot({ path: `${out}/clip-ready.png` });
  await sheet.getByRole('button', { name: 'Close' }).click();

  // ---- Settings → Social before the admin switched posting on: the rows say so, no Connect ----
  await page.goto(`${base}settings?${control}#social`, { waitUntil: 'networkidle' });
  await page.locator('[data-social-networks]').waitFor();
  check((await page.locator('[data-social-row]').count()) === 3 && (await page.locator('[data-social-row="snapchat"]').count()) === 0 && /personal account cannot be posted to by any app/.test(await page.locator('[data-social-row="instagram"]').innerText()), 'the Social section lists X, Facebook Page and Instagram — nothing that cannot be posted to (no Snapchat)');
  check((await page.locator('[data-social-unconfigured="x"]').count()) === 1 && (await page.locator('[data-social-connect="x"]').count()) === 0 && /Post from your apps/.test(await page.locator('[data-social-unconfigured="x"]').innerText()) && /Social posting/.test(await page.locator('[data-social-unconfigured="x"]').innerText()), 'before the site owner registers SingersVoice with X, the row says so — and that the singer posts from the X app meanwhile');

  // ---- Admin → Social posting: the operator pastes what X and Meta gave (the fakes' ids); the callbacks are shown to copy ----
  await page.goto(`${base}admin?${control}#social-apps`, { waitUntil: 'networkidle' });
  await page.locator('[data-social-app="x"]').waitFor({ timeout: 30000 });
  check((await page.locator('[data-social-app-state="off"]').count()) === 2, 'the Admin page shows both networks off');
  check((await page.locator('[data-social-app-callback="x"]').innerText()).trim() === `${servers.controlUrl}/social/x/callback` && (await page.locator('[data-social-app-callback="meta"]').innerText()).trim() === `${servers.controlUrl}/social/meta/callback`, "the way back for each network is the service's own callback, shown to copy");
  await page.locator('[data-social-app-id="x"]').fill('fake-x-id');
  check(await page.locator('[data-social-app-save="x"]').isDisabled(), 'Save waits for the secret too');
  await page.locator('[data-social-app-secret="x"]').fill('fake-x-secret');
  await page.locator('[data-social-app-save="x"]').click();
  await page.locator('[data-social-app="x"] [data-social-app-state="on"]').waitFor({ timeout: 15000 });
  await page.locator('[data-social-app-id="meta"]').fill('fake-meta-id');
  await page.locator('[data-social-app-secret="meta"]').fill('fake-meta-secret');
  await page.locator('[data-social-app-save="meta"]').click();
  await page.locator('[data-social-app="meta"] [data-social-app-state="on"]').waitFor({ timeout: 15000 });
  check((await page.locator('[data-social-app-secret="x"]').inputValue()) === '' && !/fake-x-secret|fake-meta-secret/.test(await page.content()), 'saved: both on; the secrets are gone from the page and never come back');
  check(!/fake-x-secret/.test(JSON.stringify(await page.evaluate(async (url) => (await fetch(`${url}/admin/social`, { headers: { 'X-Dev-User': 'alice', 'X-Dev-Name': 'alice' } })).json(), servers.controlUrl))), 'the service answers whether a secret is set, never the secret');
  await page.screenshot({ path: `${out}/admin-social.png`, fullPage: true });

  // ---- Settings → Social: Connect is there now; X and Facebook & Instagram connected through the networks' pages ----
  await page.goto(`${base}settings?${control}#social`, { waitUntil: 'networkidle' });
  await page.locator('[data-social-connect="x"]').waitFor({ timeout: 20000 });
  check(true, 'the moment the admin saved, singers find Connect X and Connect Facebook & Instagram');
  await page.locator('[data-social-connect="x"]').click();
  await page.waitForURL(/\/settings/, { timeout: 30000 });
  await page.locator('[data-social-handle="x"]').waitFor({ timeout: 30000 });
  check((await page.locator('[data-social-handle="x"]').innerText()).trim() === '@fake_singer', `X connected through its sign-in page; the handle shows (${(await page.locator('[data-social-handle="x"]').innerText()).trim()})`);
  check(!/social=/.test(page.url()), 'the way back is cleaned off the address');
  await page.locator('[data-social-connect="meta"]').click();
  await page.locator('[data-social-pages]').waitFor({ timeout: 30000 });
  check((await page.locator('[data-social-page]').count()) === 2, 'the Meta sign-in found two Pages: the singer picks one');
  await page.locator('[data-social-page="page2"]').click();
  await page.locator('[data-social-handle="facebook"]').waitFor();
  check((await page.locator('[data-social-handle="facebook"]').innerText()).trim() === 'Fake Singer Music' && (await page.locator('[data-social-handle="instagram"]').innerText()).trim() === '@fake.singer', 'the Page and the Instagram account linked to it are connected together');
  const status = await page.evaluate(async (url) => (await fetch(`${url}/social`, { headers: { 'X-Dev-User': 'alice', 'X-Dev-Name': 'alice' } })).json(), servers.controlUrl);
  check(!JSON.stringify(status).includes('xat') && !JSON.stringify(status).includes('ptok'), 'no token of any network reaches the browser');
  await page.screenshot({ path: `${out}/settings-social.png`, fullPage: true });

  // ---- Performances: a clip of the kept take posted to all three ----
  await page.goto(`${base}studio/performances?${control}`, { waitUntil: 'networkidle' });
  await page.locator('[data-take]').first().waitFor({ timeout: 30000 });
  await page.locator('[data-take] .thumb').first().click();
  await page.locator('[data-post-clip]').waitFor({ timeout: 60000 });
  await page.locator('[data-post-clip]').click();
  const sheet2 = page.locator('[data-clip-sheet]');
  await sheet2.waitFor();
  await sheet2.locator('[data-clip-network="x"]').waitFor({ timeout: 20000 });
  check((await sheet2.locator('[data-clip-network]').count()) === 3 && (await sheet2.locator('[data-clip-network]:checked').count()) === 3, 'the three connected networks are ticked to post to');
  check(/at most 140 s/.test(await sheet2.locator('[data-clip-range]').innerText()), 'the section is held to the strictest network ticked (X: 140 s)');
  await sheet2.locator('[data-clip-start]').fill('0');
  await sheet2.locator('[data-clip-end]').fill('4000');
  await sheet2.locator('[data-clip-caption]').fill('CI Clip Song — a clip from the e2e');
  await sheet2.locator('[data-clip-make]').click();
  await sheet2.locator('[data-clip-ready]').waitFor({ timeout: 60000 });
  await sheet2.locator('[data-clip-post]').click();
  await sheet2.locator('[data-clip-result-network="instagram"][data-clip-result-status="posted"]').waitFor({ timeout: 60000 });
  await sheet2.locator('[data-clip-result-network="x"]').waitFor({ timeout: 60000 }); // X is last: its upload is finalized and waited for
  const results = await sheet2.locator('[data-clip-result-network]').evaluateAll((els) => els.map((e) => [e.dataset.clipResultNetwork, e.dataset.clipResultStatus, e.querySelector('a')?.href ?? '']));
  check(results.length === 3 && results.every((r) => r[1] === 'posted') && results.some((r) => r[2] === 'https://x.com/fake_singer/status/9001') && results.some((r) => r[2] === 'https://www.facebook.com/watch/?v=fbvideo1') && results.some((r) => r[2] === 'https://www.instagram.com/reel/fake1/'), `posted to X, the Page and Instagram, with the links (${JSON.stringify(results)})`);
  await page.screenshot({ path: `${out}/clip-posted.png` });
  const log = await servers.social.log();
  const tweet = log.find((l) => l.path === '/x/2/tweets');
  const append = log.find((l) => l.path === '/x/2/media/upload/media1/append');
  const fbUpload = log.find((l) => l.path === '/meta-video/page2/videos');
  const igUpload = log.find((l) => l.path === '/meta-upload/container1');
  check(Boolean(tweet) && /CI Clip Song — a clip from the e2e/.test(tweet?.body ?? '') && JSON.parse(tweet.body).media.media_ids[0] === 'media1', `X got the words and the media (${tweet?.body})`);
  check(append?.bytes > 10_000 && fbUpload?.bytes > 10_000 && igUpload?.bytes > 10_000 && igUpload?.auth === 'OAuth ptok2', `each network got the clip's bytes (X ${append?.bytes}, Facebook ${fbUpload?.bytes}, Instagram ${igUpload?.bytes} with the Page's token)`);
  check(log.filter((l) => l.path === '/x/2/oauth2/token').length === 1, "X's token was asked once (good for two hours; renewed by the refresh token later)");

  // ---- Settings again: the posts listed; X let go ----
  await page.goto(`${base}settings?${control}#social`, { waitUntil: 'networkidle' });
  await page.locator('[data-social-posts]').waitFor();
  check((await page.locator('[data-social-post][data-social-post-status="posted"]').count()) === 3, 'the Social section lists the three posts');
  await page.locator('[data-social-disconnect="x"]').click();
  await page.locator('[data-social-connect="x"]').waitFor();
  check((await page.locator('[data-social-handle="x"]').count()) === 0 && log.length > 0, 'X disconnected: Connect is back');
  check((await servers.social.log()).some((l) => l.path === '/x/2/oauth2/revoke'), 'and X was told to drop the token');

  check(errors.length === 0, `no page errors (${JSON.stringify(errors)})`);
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  await servers.stop();
}
console.log(failed ? 'SOCIAL E2E FAILED' : 'SOCIAL E2E OK');
process.exit(failed ? 1 : 0);
