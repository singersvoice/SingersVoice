// The TV e2e: a TV (a browser with no sign-in) shows its code and QR at /tv; a singer in the Studio taps TV, types the
// code, and the TV shows her stage — the picture over a WebRTC link made through the service's handshake, the words
// and the clock over its data channel — then she disconnects and the TV shows a code again; the QR's door (/tv/<code>
// on the phone) claims a TV by itself. In the browser, the built app against the real sv-control (lib/tv.ts,
// services/control/src/tv.ts).
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/tv-e2e.mjs [outDir]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const work = path.join(tmpdir(), `sv-tv-e2e-${process.pid}`);
mkdirSync(work, { recursive: true });

const servers = await startServers({ base: process.env.BASE_PATH ?? '/SingersVoice/' });
const base = servers.appUrl;
const control = `control=${servers.controlUrl}`;
const SONG_S = 30;
const song = makeSong(path.join(work, 'song.mp3'), SONG_S);
const trackJson = path.join(work, 'song.track.json');
{
  const t = JSON.parse(readFileSync('apps/web/test/fixtures/sample.track.json', 'utf8'));
  t.durationMs = SONG_S * 1000;
  t.title = 'CI TV Song';
  writeFileSync(trackJson, JSON.stringify(t));
}
const clip = path.join(work, 'fake-person.y4m');
execFileSync('node', [new URL('./fake-person.mjs', import.meta.url).pathname, clip], { stdio: 'inherit' });
const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errors = { tv: [], alice: [] };
const watch = (page, name) => {
  page.on('pageerror', (e) => errors[name].push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/favicon|404/.test(m.text()) && errors[name].push(m.text()));
};

try {
  // ---- The TV: /tv, no sign-in — a code and a QR ----
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  tvCtx.setDefaultTimeout(60000);
  const tv = await tvCtx.newPage();
  watch(tv, 'tv');
  await tv.goto(`${base}tv?${control}`, { waitUntil: 'networkidle' });
  await tv.locator('[data-tv-code]').waitFor({ timeout: 30000 });
  const code = (await tv.locator('[data-tv-code]').innerText()).replace(/\s+/g, '');
  check(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code), `the TV shows a code of four letters: ${code}`);
  await tv.locator('.tv-qr svg').waitFor({ timeout: 15000 });
  check((await tv.locator('.tv-qr').getAttribute('aria-label')).endsWith(`/tv/${code}`), `and a QR of the link to it (…/tv/${code})`);
  check((await tv.locator('.tv').getAttribute('data-tv-state')) === 'waiting', 'waiting for a singer');
  await tv.screenshot({ path: `${out}/tv-code.png` });

  // ---- alice in the Studio (local mode: her own device's tracks) ----
  const aCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone', 'camera'], deviceScaleFactor: 1 });
  aCtx.setDefaultTimeout(60000);
  const alice = await aCtx.newPage();
  watch(alice, 'alice');
  await alice.goto(`${base}?${control}`, { waitUntil: 'networkidle' });
  await alice.evaluate(() => {
    localStorage.setItem('sv.profile', JSON.stringify({ sub: 'alice', name: 'alice', email: '', picture: '', mode: 'local' }));
    localStorage.setItem('sv.mode', 'local');
    localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true, countIn: false, cameraOn: true }));
  });
  await alice.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await alice.getByRole('button', { name: 'Import' }).first().click();
  await alice.locator('input[type=file][accept*=".json"]').setInputFiles(trackJson);
  await alice.locator('input[type=file][accept*="audio"]').setInputFiles(song);
  await alice.getByRole('button', { name: /^Import$/ }).last().click();
  await alice.getByText(/^Imported/).waitFor({ timeout: 30000 });
  const trackId = await alice.evaluate(() => new Promise((res) => { const r = indexedDB.open('singersvoice'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('tracks'); const q = tx.objectStore('tracks').getAllKeys(); q.onsuccess = () => res(q.result[0]); }; }));
  await alice.goto(`${base}studio/sing/${encodeURIComponent(trackId)}?${control}`, { waitUntil: 'networkidle' });
  await alice.getByRole('button', { name: 'Start singing' }).waitFor({ timeout: 60000 });

  // The TV button → the code typed → Connect: the chip says the TV shows her stage; the TV links.
  await alice.locator('[data-tv-button]').click();
  await alice.locator('.sheet [data-tv-code]').waitFor();
  await alice.locator('.sheet [data-tv-code]').fill(code.toLowerCase());
  await alice.locator('.sheet [data-tv-connect]').click();
  await alice.locator('.sheet [data-tv-chip]').waitFor({ timeout: 20000 });
  let chip = '';
  for (let i = 0; i < 60; i++) {
    chip = await alice.locator('.sheet [data-tv-chip]').innerText();
    if (/showing your stage/.test(chip)) break;
    await wait(500);
  }
  check(/showing your stage/.test(chip), `alice's panel: "${chip}"`);
  await alice.screenshot({ path: `${out}/tv-alice-panel.png` });
  await tv.locator('[data-tv-linked]').waitFor({ timeout: 20000 });
  check((await tv.locator('.tv').getAttribute('data-tv-look')) === 'both', 'the TV shows the words and the stage (the default)');
  // The picture: the video gets frames from alice's show canvas.
  let video = null;
  for (let i = 0; i < 60; i++) {
    video = await tv.evaluate(() => { const v = document.querySelector('[data-tv-video]'); return v ? { w: v.videoWidth, h: v.videoHeight, ready: v.readyState, t: v.currentTime } : null; });
    if (video && video.w > 0 && video.ready >= 2) break;
    await wait(500);
  }
  check(video && video.w > 0 && video.ready >= 2, `the TV plays alice's stage picture (${JSON.stringify(video)})`);
  const layout = await tv.evaluate(() => { const v = document.querySelector('[data-tv-video]').getBoundingClientRect(); const l = document.querySelector('.tv-lyrics').getBoundingClientRect(); return { video: [Math.round(v.y), Math.round(v.height)], lyrics: [Math.round(l.y), Math.round(l.height)], screen: innerHeight }; });
  check(layout.lyrics[0] === 0 && layout.lyrics[1] > 400 && layout.video[0] >= layout.lyrics[1] - 1 && layout.video[0] + layout.video[1] <= layout.screen + 1 && layout.video[1] > 300, `the words on top, the picture below, both on the screen (${JSON.stringify(layout)})`);
  check((await tv.locator('.tv-lyrics .lyric').count()) > 0, 'the song\'s words are on the TV before a note is sung');
  check(/alice/.test(await tv.locator('.tv-tag').innerText()), `the TV's corner names the singer (${(await tv.locator('.tv-tag').innerText()).trim()})`);
  await tv.screenshot({ path: `${out}/tv-linked.png` });

  // She sings: the TV's clock runs — an active line, then another.
  await alice.locator('.sheet').getByRole('button', { name: 'Close' }).click();
  await alice.getByRole('button', { name: 'Start singing' }).click();
  await alice.locator('button', { hasText: 'Finish' }).waitFor({ timeout: 30000 });
  let active = '';
  for (let i = 0; i < 40; i++) {
    const n = await tv.locator('.tv-lyrics .lyric.active').count();
    if (n) {
      active = await tv.locator('.tv-lyrics .lyric.active').first().innerText();
      break;
    }
    await wait(500);
  }
  check(active.length > 0, `the TV lights the line being sung: "${active}"`);
  let moved = false;
  for (let i = 0; i < 40 && !moved; i++) {
    await wait(500);
    const n = await tv.locator('.tv-lyrics .lyric.active').count();
    if (n && (await tv.locator('.tv-lyrics .lyric.active').first().innerText()) !== active) moved = true;
  }
  check(moved, 'and moves on with the song (its clock runs on between the phone\'s ticks)');
  await tv.screenshot({ path: `${out}/tv-singing.png` });
  await alice.getByRole('button', { name: 'Finish' }).click();
  await alice.locator('[data-review]').waitFor({ timeout: 60000 });

  // Disconnect: the TV shows a code again (the same screen, a new claim possible).
  await alice.locator('[data-tv-button]').click().catch(() => undefined); // (the review page has no TV button: the panel is in Settings then)
  const back = await alice.locator('.sheet [data-tv-disconnect]').count();
  if (back) await alice.locator('.sheet [data-tv-disconnect]').click();
  else {
    await alice.goto(`${base}settings?${control}`, { waitUntil: 'networkidle' });
    await alice.getByRole('button', { name: 'Forget this TV' }).click();
  }
  await tv.locator('[data-tv-code]').waitFor({ timeout: 20000 });
  const code2 = (await tv.locator('[data-tv-code]').innerText()).replace(/\s+/g, '');
  check(code2 === code, `disconnected: the TV shows its code again (${code2})`);

  // The QR's door: /tv/<code> on the phone claims the TV by itself; the TV says whose stage is coming.
  await alice.goto(`${base}tv/${code}?${control}`, { waitUntil: 'networkidle' });
  await tv.locator('[data-tv-claimed]').waitFor({ timeout: 20000 });
  check(/alice/.test(await tv.locator('[data-tv-claimed]').innerText()), `the QR link claims the TV: "${(await tv.locator('[data-tv-claimed]').innerText()).trim()}"`);
  await alice.waitForURL(/\/home/, { timeout: 15000 });
  check(/\/home/.test(alice.url()), 'and the phone lands on Home');
  // The TV page closes: the service forgets the screen; the phone's link is told.
  await tv.close();
  await wait(1500);
  const state = await alice.evaluate(() => localStorage.getItem('sv.tv.code'));
  check(state === null || state === '', `the phone forgets a TV whose page closed (sv.tv.code: ${JSON.stringify(state)})`);

  check(errors.tv.length === 0 && errors.alice.length === 0, `no page errors (${JSON.stringify(errors)})`);
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  await servers.stop();
}
console.log(failed ? 'TV E2E FAILED' : 'TV E2E OK');
process.exit(failed ? 1 : 0);
