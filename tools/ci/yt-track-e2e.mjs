// YouTube song tracks, in the browser — the built app (device mode) against the real sv-control and the
// real relay, the relay's yt-dlp a stub (a search answered as yt-dlp prints it):
//   1. Tracks → YouTube: the service says the relay is there, a search lists the results with their thumbnails,
//      and "Add to my Drive" without Google says what it needs (the files are the singer's own).
//   2. A track with a karaoke video (imported with its video reference; the video itself served to the browser
//      as the service would hand it over) sings with the video where the lyrics would be: muted, on the song's
//      clock while it plays, paused with it, moved by a seek.
//   npm run build && node tools/ci/yt-track-e2e.mjs [outDir]
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { freePort, startServers } from './servers.mjs';

const require = createRequire(import.meta.url);
const pw = (() => {
  for (const spec of ['playwright', '/opt/npm-tools/node_modules/playwright']) {
    try {
      return require(spec);
    } catch {
      /* try next */
    }
  }
  throw new Error('playwright not found — run: npm i -D playwright && npx playwright install chromium');
})();
const { chromium } = pw;

const out = process.argv[2] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const base = process.env.BASE_PATH ?? '/SingersVoice/';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) failures += 1;
};

// A 20 s karaoke-looking video: a moving test picture with a clock burned in, and a tone.
const work = path.join(tmpdir(), `sv-yt-e2e-${process.pid}`);
mkdirSync(work, { recursive: true });
const videoFile = path.join(work, 'karaoke.mp4');
execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', videoFile]);

// The relay with a stub yt-dlp (the search answered; yt-dlp's own words on a refusal).
const ytdlp = path.join(work, 'yt-dlp');
writeFileSync(
  ytdlp,
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2025.11.12"; exit 0; fi
if [ "$1" = "-U" ]; then echo "up to date"; exit 0; fi
case "$*" in
  *--dump-json*)
    case "$*" in *nothing*) exit 0 ;; esac
    echo '{"id":"dQw4w9WgXcQ","title":"Never Gonna Give You Up (Karaoke Version)","channel":"Sing King","duration":213,"view_count":1234567}'
    echo '{"id":"abcdefghijk","title":"Amma Karaoke with Lyrics","uploader":"Karaoke Hits","duration":283.5,"view_count":4321}'
    exit 0 ;;
esac
echo "ERROR: [youtube] Sign in to confirm you’re not a bot" >&2
exit 1
`,
);
chmodSync(ytdlp, 0o755);
const relayPort = await freePort();
const relay = spawn('node', ['src/server.mjs'], { cwd: path.resolve('services/relay'), stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PORT: String(relayPort), RELAY_SECRET: 'e2e-relay-secret', RELAY_YTDLP: ytdlp, RELAY_YTDLP_UPDATE: '0' } });
process.on('exit', () => {
  try {
    relay.kill();
  } catch {
    /* gone */
  }
});
process.env.RELAY_URL = `http://localhost:${relayPort}`;
process.env.RELAY_SECRET = 'e2e-relay-secret';
const servers = await startServers({ base });
const { port, controlPort } = servers;
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`http://localhost:${relayPort}/health`)).ok) break;
  } catch {
    await wait(250);
  }
}

// A track with a karaoke video: the sample track, its lyrics taken away (the words are in the picture), a video reference on it.
const sample = JSON.parse(readFileSync('apps/web/test/fixtures/sample.track.json', 'utf8'));
const withVideo = { ...sample, trackId: 'trk-yt-e2e', title: 'Karaoke E2E Song', artist: 'Sing King', origin: 'youtube', lyrics: [], video: { fileId: 'ytvideo0000000e2e', mimeType: 'video/mp4', width: 640, height: 360, youtubeId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', channel: 'Sing King' } };
const trackJson = path.join(work, 'karaoke.track.json');
writeFileSync(trackJson, JSON.stringify(withVideo));

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, permissions: ['microphone', 'camera'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const url = (p) => `http://localhost:${port}${base}${p.replace(/^\//, '')}`;
const shot = (name) => page.screenshot({ path: path.join(out, `yt--${name}.png`) });
// The video, as the service would hand it over from the owner's Drive.
let videoAsked = 0;
await page.route(/\/catalog\/tracks\/[^/]+\/file\/video$/, (route) => {
  videoAsked += 1;
  route.fulfill({ status: 200, contentType: 'video/mp4', body: readFileSync(videoFile) });
});

try {
  await page.goto(`${url('/')}?control=http://localhost:${controlPort}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Developer preview|Try it on this/ }).click();
  await page.waitForURL(/\/setup/);
  await page.getByRole('button', { name: 'Go to my stage' }).click();
  await page.waitForURL(/\/home/);

  // 1. The YouTube section.
  await page.goto(url('/tracks'), { waitUntil: 'networkidle' });
  await page.getByRole('radio', { name: 'YouTube' }).click();
  await page.locator('[data-yt-section]').waitFor({ timeout: 10000 });
  await wait(1500);
  ok((await page.locator('[data-yt-unavailable]').count()) === 0, 'the YouTube section finds the relay (yt-dlp on it) through the service');
  await page.locator('[data-yt-query]').fill('amma karaoke');
  await page.locator('[data-yt-search]').click();
  await page.locator('[data-yt-result]').first().waitFor({ timeout: 30000 });
  const results = await page.locator('[data-yt-result]').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-yt-result'), text: e.textContent, img: e.querySelector('img')?.getAttribute('src') })));
  ok(results.length === 2, `two results listed (${results.length})`);
  ok(results[0]?.id === 'dQw4w9WgXcQ' && /Sing King/.test(results[0].text) && /3:33/.test(results[0].text) && /1\.2M views/.test(results[0].text), `the first result carries title, channel, duration and views: ${results[0]?.text?.trim()}`);
  ok(results[0]?.img === 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', 'a thumbnail per result');
  await shot('01-youtube-results');
  await page.locator('[data-yt-add]').first().click();
  const needsGoogle = await page.getByText(/sign in with Google first/).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  ok(needsGoogle, 'without Google Drive, "Add to my Drive" says the files are the singer\'s own and need the sign-in');

  // 2. A track with a video, imported and sung.
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.locator('input[type=file][accept*=".json"]').setInputFiles(trackJson);
  await page.locator('input[type=file][accept*="audio"]').setInputFiles('apps/web/test/fixtures/sample.mp3');
  await page.getByRole('button', { name: /^Import$/ }).last().click();
  await page.getByText(/^Imported/).waitFor({ timeout: 30000 });
  await page.getByRole('radio', { name: /My Drive|This device/ }).click();
  await wait(800);
  ok((await page.locator('.list .item', { hasText: 'Karaoke E2E Song' }).locator('.chip', { hasText: 'video' }).count()) === 1, 'the library marks the track as a video track');
  await shot('02-library-video-track');
  await page.locator('.list .item', { hasText: 'Karaoke E2E Song' }).getByRole('link', { name: 'Sing' }).click();
  await page.waitForURL(/\/sing\//);
  await page.locator('[data-karaoke="ready"] video').waitFor({ timeout: 30000 });
  ok(videoAsked === 1, `the video was fetched through the service once (${videoAsked})`);
  ok((await page.locator('.lyrics.karaoke').count()) === 1 && (await page.locator('.lyric.active').count()) === 0, 'the karaoke video stands where the lyrics would be');
  const box = await page.locator('[data-karaoke] video').boundingBox();
  const stage = await page.locator('.sing').boundingBox();
  ok(box && stage && box.y < stage.y + stage.height * 0.2 && box.height <= stage.height * 0.55 && box.width <= stage.width, `the video sits at the top of the stage, within its upper half (${box && Math.round(box.width)}×${box && Math.round(box.height)} at y=${box && Math.round(box.y)} of ${stage && Math.round(stage.height)})`);
  ok(await page.locator('[data-karaoke] video').evaluate((v) => v.muted && v.paused), 'the video is muted and waits for the song');
  await wait(600);
  await shot('03-sing-video-ready');
  await page.getByRole('button', { name: 'Start singing' }).click();
  await page.locator('.lyrics.karaoke .countdown').waitFor({ timeout: 5000 });
  await shot('04-sing-video-countdown');
  await wait(9000);
  const during = await page.evaluate(() => {
    const v = document.querySelector('[data-karaoke] video');
    const bar = document.querySelector('.sing .timeline input[type="range"]');
    return { videoMs: v ? Math.round(v.currentTime * 1000) : -1, tMs: bar ? Number(bar.value) : -1, paused: v?.paused, rate: v?.playbackRate };
  });
  ok(during.videoMs > 3000 && Math.abs(during.videoMs - during.tMs) < 450, `the video runs on the song's clock while it plays (video ${during.videoMs} ms, song ${during.tMs} ms)`);
  ok(during.paused === false && during.rate === 1, 'the video plays at the song\'s tempo');
  await shot('05-sing-video-playing');
  await page.getByRole('button', { name: 'Pause' }).click();
  await wait(1200);
  const paused = await page.evaluate(() => {
    const v = document.querySelector('[data-karaoke] video');
    return { paused: v?.paused, videoMs: v ? Math.round(v.currentTime * 1000) : -1 };
  });
  ok(paused.paused === true, 'the video pauses with the song');
  await page.locator('.sing .timeline.seekable input[type="range"]').fill('3000');
  await wait(1200);
  const sought = await page.evaluate(() => {
    const v = document.querySelector('[data-karaoke] video');
    return v ? Math.round(v.currentTime * 1000) : -1;
  });
  ok(Math.abs(sought - 3000) < 300, `a seek moves the picture too (video at ${sought} ms after a seek to 3000 ms)`);
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByText('Your take').waitFor({ timeout: 30000 });
  await shot('06-review');
  ok(errors.filter((e) => !/ResizeObserver|AudioContext|interact/.test(e)).length === 0, `no page errors (${errors.length ? errors.join(' | ') : 'none'})`);
} catch (e) {
  failures += 1;
  console.log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
  await shot('error').catch(() => undefined);
} finally {
  await browser.close();
  servers.stop();
  relay.kill();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
