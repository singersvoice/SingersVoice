// Fit e2e: every screen of the built app fits a phone — no sideways scroll, nothing wider than the window — at
// every text size the Display setting offers (1×, 1.3×, 1.6×, 2×), on four phone widths (320, 360, 390, 412) and a
// tablet; and the stage (a song open in the Studio) keeps its Start button on screen without scrolling. Device
// mode (no Google), the fake camera and microphone, as screenshots.mjs.
//
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/fit-e2e.mjs [outDir]
// Prints one line per screen and size that overflows (with the widest elements), screenshots the worst, exits 1 on any.
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
/** `p`, or `fallback` when it has not answered in `ms` (a page evaluate has no timeout of its own; a hung page would hold the whole audit). */
const timed = (p, ms, fallback) => Promise.race([p, wait(ms).then(() => fallback)]);
const work = path.join(tmpdir(), `sv-fit-e2e-${process.pid}`);
mkdirSync(work, { recursive: true });

const servers = await startServers({ base: process.env.BASE_PATH ?? '/SingersVoice/' });
const base = servers.appUrl;
const control = `control=${servers.controlUrl}`;
const url = (p) => `${base}${p.replace(/^\//, '')}${p.includes('?') ? '&' : '?'}${control}`;

// A song in the library, so the Studio's stage (the lyrics, the strip, the controls) can be measured too.
const SONG_S = 24;
const song = makeSong(path.join(work, 'song.mp3'), SONG_S);
const trackJson = path.join(work, 'song.track.json');
{
  const t = JSON.parse(readFileSync('apps/web/test/fixtures/sample.track.json', 'utf8'));
  t.durationMs = SONG_S * 1000;
  t.title = 'CI Fit Song';
  writeFileSync(trackJson, JSON.stringify(t));
}

const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

/** The screens walked: every portal and settings page, the pickers, the Studio's stage with a song open. */
const SCREENS = ['/home', '/tracks', '/tracks/recommended', '/tracks/bookmarks', '/tracks/drive', '/tracks/catalog', '/tracks/youtube', '/studio', '/studio/sing', '/studio/performances', '/studio/trackmaker', '/meets', '/publishing', '/publishing/destinations', '/publishing/preview', '/plans', '/club', '/settings', '/settings#audio', '/settings#voice', '/settings#camera', '/settings#backgrounds', '/admin'];
const SIZES = [
  { name: 'iphone-se-320', width: 320, height: 568 },
  { name: 'android-360', width: 360, height: 640 },
  { name: 'iphone-390', width: 390, height: 844 },
  { name: 'pixel-412', width: 412, height: 915 },
  { name: 'ipad-820', width: 820, height: 1180 },
];
const SCALES = ['1', '1.3', '1.6', '2'];

/**
 * How far the page runs past the window (px), and the elements that do (their tag/class and right edge). The
 * window's width is the root's clientWidth: in a phone emulation (as on a phone) a layout wider than the screen
 * widens the layout viewport instead — window.innerWidth grows with it and the page is shown zoomed out — so
 * innerWidth above clientWidth is an overflow too. Toasts and the watermark sit fixed over the page and are not
 * counted (they never scroll the page).
 */
const overflowOf = (page) =>
  page.evaluate(() => {
    const doc = document.documentElement;
    const W = doc.clientWidth;
    const scrollW = Math.max(doc.scrollWidth, document.body.scrollWidth, window.innerWidth);
    const over = scrollW - W;
    const wide = [];
    if (over > 1) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > W + 1 && !el.closest('.toasts, .watermark') && getComputedStyle(el).position !== 'fixed') {
          const id = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
          wide.push(`${id}@${Math.round(r.right)}`);
        }
      }
    }
    return { over, wide: wide.slice(0, 6), scrollW, W };
  });

const results = [];
for (const size of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.width < 800, hasTouch: size.width < 800, deviceScaleFactor: 1, permissions: ['microphone', 'camera'] });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  await page.goto(url('/'), { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('sv.mode', 'device');
    localStorage.setItem('sv.profile', JSON.stringify({ sub: 'dev-fit', name: 'Fit', email: 'fit@dev.local', picture: '', mode: 'device' }));
    localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true, countIn: false, cameraOn: true, socialOffer: false }));
  });
  // The song, imported into this context's library (device mode: the IndexedDB of this context — each gets its own).
  await page.goto(url('/tracks'), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Import' }).first().click();
  const sheet = page.locator('.sheet');
  await sheet.waitFor();
  await sheet.locator('input[type=file][accept*=".json"]').setInputFiles(trackJson);
  await sheet.locator('input[type=file][accept*="audio"]').setInputFiles(song);
  await sheet.getByRole('button', { name: 'Import' }).click();
  await page.getByText(/^Imported/).waitFor({ timeout: 60000 });
  await page.locator('.sheet').waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
  // The import gives the song an id of its own: the Studio's song list has it.
  await page.goto(url('/studio'), { waitUntil: 'networkidle' });
  await page.locator('.item[data-track]').first().waitFor({ timeout: 15000 }).catch(() => undefined);
  const trackId = (await page.locator('.item[data-track]').first().getAttribute('data-track').catch(() => null)) ?? '';
  console.log(`info ${size.name}: the song imported as ${trackId || '(no row found)'}`);

  for (const scale of SCALES) {
    await page.evaluate((s) => {
      const app = JSON.parse(localStorage.getItem('sv.settings.app') || '{}');
      app.textScale = Number(s);
      localStorage.setItem('sv.settings.app', JSON.stringify(app));
    }, scale);
    for (const screen of SCREENS) {
      await page.goto(url(screen), { waitUntil: 'networkidle', timeout: 20000 }).catch(() => undefined);
      await wait(350);
      const o = await timed(overflowOf(page), 15000, { over: 0, wide: ['(the page did not answer in 15 s)'], scrollW: 0, W: 0 });
      const label = `${size.name} ×${scale} ${screen}`;
      console.log(`info ${label}: ${o.scrollW} of ${o.W}`);
      results.push({ size: size.name, scale, screen, ...o });
      if (o.over > 1) {
        console.log(`FAIL ${label}: ${o.over} px wider than the window (${o.scrollW} > ${o.W}) — ${o.wide.join(', ')}`);
        await page.screenshot({ path: path.join(out, `fit-${size.name}-x${scale}-${screen.replace(/[^a-z0-9]+/gi, '_')}.png`) }).catch(() => undefined);
        failed = true;
      }
    }
    // The Studio's stage with the song open: fits, and the Start button is on screen without scrolling.
    {
      await page.goto(url(`/studio/sing/${encodeURIComponent(trackId)}`), { waitUntil: 'networkidle', timeout: 20000 }).catch(() => undefined);
      await page.getByRole('button', { name: 'Start singing' }).waitFor({ timeout: 30000 }).catch(() => undefined);
      await wait(800);
      const o = await timed(overflowOf(page), 15000, { over: 0, wide: ['(the page did not answer in 15 s)'], scrollW: 0, W: 0 });
      const start = await timed(page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /Start singing/.test(x.textContent || ''));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const lyrics = document.querySelector('.lyrics');
        const line = document.querySelector('.lyric');
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          H: document.documentElement.clientHeight,
          W: document.documentElement.clientWidth,
          right: Math.round(r.right),
          // the lyrics: their box's height and their font size (the first line's) — room for the line being sung and the next
          lyricsH: lyrics ? Math.round(lyrics.getBoundingClientRect().height) : 0,
          lyricPx: line ? parseFloat(getComputedStyle(line).fontSize) : 0,
        };
      }), 15000, null);
      const label = `${size.name} ×${scale} /studio/sing (stage)`;
      console.log(`info ${label}: ${o.scrollW} of ${o.W}, Start ${start ? `${start.top}–${start.bottom} of ${start.H}` : 'not found'}, lyrics ${start ? `${start.lyricsH} px at ${start.lyricPx} px` : '-'}`);
      results.push({ size: size.name, scale, screen: '/studio/sing/:id', ...o, start });
      if (o.over > 1) {
        console.log(`FAIL ${label}: ${o.over} px wider than the window — ${o.wide.join(', ')}`);
        failed = true;
      }
      const onScreen = start && start.top >= 0 && start.bottom <= start.H + 1 && start.right <= start.W + 1;
      check(Boolean(onScreen), `${label}: the Start button is on screen without scrolling (${start ? `${start.top}–${start.bottom} of ${start.H}` : 'not found'})`);
      // Readable lyrics: at least two lines' worth of height at a 24 px+ font, whatever the text size and the phone.
      const readable = start && start.lyricPx >= 24 && start.lyricsH >= start.lyricPx * 2.4;
      check(Boolean(readable), `${label}: the lyrics are readable (${start ? `${start.lyricsH} px tall at ${start.lyricPx} px` : 'not found'})`);
      if (!onScreen || !readable || o.over > 1) await page.screenshot({ path: path.join(out, `fit-${size.name}-x${scale}-stage.png`) }).catch(() => undefined);
    }
  }
  await ctx.close();
}
const overflowing = results.filter((r) => r.over > 1);
check(overflowing.length === 0, `${results.length} screen × size × text-size combinations measured; ${overflowing.length} run wider than the window`);
await browser.close();
await servers.stop();
process.exit(failed ? 1 : 0);
