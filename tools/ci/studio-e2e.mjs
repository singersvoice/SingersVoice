// Studio e2e: the singer's own stage, in the browser against the built app (device mode, no Google) — the fake
// camera is a synthetic person (fake-person.mjs: the real segmentation model cuts them out), the fake microphone
// sings in phrases (6 s of voice, 5 s of silence, on a loop), so what is measured is the real pipeline:
//
//   1. The voice zoom (video/framing.ts): the seat frames the singer; while they are heard the picture pushes in on
//      the face and goes back out to the chest when they stop — the fake person's head on the stage strip grows by
//      half and shrinks back, with the phrases, and never jumps.
//   2. The Camera & zoom button works during the song: the sheet opens, the zoom choice changes the frame live.
//   3. The Sound sheet: Preview my voice / Stop preview — the microphone through the preset, live, a preset change
//      applied without a restart; Save my sound — both config files in the device's Config store, with the word on it.
//   4. The NONE background: the stage shows the camera picture as it is (the room's wall, no cut-out), at once; the
//      choice survives a reload; another background brings the cut-out back.
//   5. The saved performance (the 'solo' stage, video/stage.ts): the singer half as big again in the file as on the
//      live strip's show stage; the Performances player as tall as the window allows, no blank space under it. The
//      take plays back through the mix bus (audio/takePlayback.ts): the review's Play mix is the saved mix.
//   6. The permissions (lib/permissions.ts, video/capture.ts): on a phone that says it is an iPhone, ONE getUserMedia for
//      camera and microphone together per visit to the stage (none at Start, none for the next song); on a computer the
//      camera alone at entry and the microphone at Start, nothing asked twice. The setup's one question for both. A
//      browser that blocks the camera is told so on the stage, with the way back; Settings says what the browser holds.
//
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/studio-e2e.mjs [outDir]
// Exits 1 when any assertion fails. Needs playwright (local install or /opt/npm-tools) and ffmpeg.
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
/** Polls `fn` every quarter second until it answers something truthy (that), or `ms` have passed (null). */
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await wait(250);
  }
};
const work = path.join(tmpdir(), `sv-studio-e2e-${process.pid}`);
mkdirSync(work, { recursive: true });

const servers = await startServers({ base: process.env.BASE_PATH ?? '/SingersVoice/' });
const base = servers.appUrl;
const control = `control=${servers.controlUrl}`;
const url = (p) => `${base}${p.replace(/^\//, '')}${p.includes('?') ? '&' : '?'}${control}`;

// ---- The song (24 s: a take ends on its own), the fake camera (a synthetic person), the fake microphone (phrases) ----
const SONG_S = 24;
const song = makeSong(path.join(work, 'song.mp3'), SONG_S);
const trackJson = path.join(work, 'song.track.json');
{
  const t = JSON.parse(readFileSync('apps/web/test/fixtures/sample.track.json', 'utf8'));
  t.durationMs = SONG_S * 1000;
  t.title = 'CI Studio Song';
  writeFileSync(trackJson, JSON.stringify(t));
}
const clip = path.join(work, 'fake-person.y4m');
execFileSync('node', [new URL('./fake-person.mjs', import.meta.url).pathname, clip], { stdio: 'inherit' });
// The voice (as live-duet.mjs: harmonics on 180 Hz with a vibrato) in phrases: silent for a second, sung for six,
// silent for five — a 12 s loop, so a 24 s song hears two phrases and two real breaks (the zoom's hold is 1.4 s).
const PHRASE = { period: 12, from: 1, to: 7 };
const voice = path.join(work, 'fake-voice.wav');
const vib = (h) => `sin(2*PI*${h * 180}*t+${((h * 0.012 * 180) / 5.5).toFixed(4)}*sin(2*PI*5.5*t))`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='0.25*(0.7+0.3*sin(2*PI*0.7*t))*between(mod(t,${PHRASE.period}),${PHRASE.from},${PHRASE.to})*(${vib(1)}+0.5*${vib(2)}+0.33*${vib(3)}+0.25*${vib(4)}+0.2*${vib(5)})':s=48000:d=${PHRASE.period}`, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', voice]);

const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, `--use-file-for-fake-audio-capture=${voice}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errors = {};

/** A page in device mode, onboarded, with the camera on and the count-in off; `opts.ua` for a phone that says what it is. */
async function person(name, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 900 },
    isMobile: Boolean(opts.mobile),
    hasTouch: Boolean(opts.mobile),
    userAgent: opts.ua,
    permissions: opts.permissions ?? ['microphone', 'camera'],
    deviceScaleFactor: 1,
  });
  ctx.setDefaultTimeout(60000);
  // Every getUserMedia the app makes, counted (what it asked for, when): the permission checks read this.
  await ctx.addInitScript(() => {
    const md = navigator.mediaDevices;
    const gum = md.getUserMedia.bind(md);
    window.__gum = [];
    md.getUserMedia = async (c) => {
      window.__gum.push({ audio: Boolean(c && c.audio), video: Boolean(c && c.video), at: Date.now() });
      return gum(c);
    };
  });
  if (opts.init) await ctx.addInitScript(opts.init);
  errors[name] = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors[name].push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/401|Unauthorized|Failed to load resource/.test(m.text()) && errors[name].push(m.text()));
  page.on('dialog', (d) => void d.accept());
  await page.goto(url('/'), { waitUntil: 'networkidle' });
  await page.evaluate((n) => {
    localStorage.setItem('sv.mode', 'device');
    localStorage.setItem('sv.profile', JSON.stringify({ sub: n, name: n, email: `${n}@dev.local`, picture: '', mode: 'device' }));
    localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true, countIn: false, cameraOn: true, socialOffer: false }));
  }, name);
  return { ctx, page, name };
}
const gumCalls = (page) => page.evaluate(() => window.__gum.map((g) => `${g.audio ? 'audio' : ''}${g.audio && g.video ? '+' : ''}${g.video ? 'video' : ''}`));

/** Import the song through the Tracks portal's Import sheet; the id the import gives it, from the Studio's list. */
async function importSong(p) {
  await p.page.goto(url('/tracks'), { waitUntil: 'networkidle' });
  await p.page.getByRole('button', { name: 'Import' }).first().click();
  const sheet = p.page.locator('.sheet');
  await sheet.waitFor();
  await sheet.locator('input[type=file][accept*=".json"]').setInputFiles(trackJson);
  await sheet.locator('input[type=file][accept*="audio"]').setInputFiles(song);
  await sheet.getByRole('button', { name: 'Import' }).click();
  await p.page.getByText(/^Imported/).waitFor({ timeout: 60000 });
  await p.page.goto(url('/studio'), { waitUntil: 'networkidle' });
  await p.page.locator('.item[data-track]').first().waitFor({ timeout: 15000 });
  return p.page.locator('.item[data-track]').first().getAttribute('data-track');
}
/** Wait until the segmentation model cuts the singer out (the seat frames a real cut-out alone). */
const waitForModel = (page) => until(async () => (await page.locator('.stagebar').getAttribute('data-blend').catch(() => null)) === 'model', 60000);

/**
 * The fake person on a canvas: the box of their skin-tone head (fake-person.mjs: 8d 55 24, lifted by up to half again
 * at the source — enhance.ts; the show paints the background darker, never the person) and how much of the picture is
 * the bright wall of their room (f2 f2 f2 — on the stage only when the camera picture is shown as it is).
 */
const PERSON_IN_CANVAS = `(c) => {
  const x = c.getContext('2d', { willReadFrequently: true });
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const w = c.width;
  let minX = w, maxX = -1, minY = c.height, maxY = -1, n = 0, wall = 0;
  for (let i = 0, px = 0; i + 3 < d.length; i += 4, px++) {
    const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
    if (a > 200 && r > 110 && r < 240 && g > 60 && g < 150 && b > 10 && b < 85 && r > g + 30 && g > b + 20) {
      const X = px % w, Y = (px / w) | 0;
      if (X < minX) minX = X; if (X > maxX) maxX = X; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
      n++;
    } else if (a > 200 && r > 200 && g > 200 && b > 200) wall++;
  }
  return n < 50 ? { n, head: null, wall, w, h: c.height } : { n, head: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, wall, w, h: c.height };
}`;
/** The person on the stage strip (the live stage canvas) right now, and the seat's word on the voice. */
const stageNow = (page) =>
  page.evaluate(`(() => {
    const person = ${PERSON_IN_CANVAS};
    const c = document.querySelector('canvas.stagecanvas');
    const bar = document.querySelector('.stagebar');
    const range = document.querySelector('.sing .timeline input[type=range]');
    const feed = window.__svFeed;
    return { ...(c ? person(c) : { n: 0, head: null, wall: 0, w: 0, h: 0 }), heard: feed ? feed.seat.heardAt(performance.now()) : null, framing: feed ? feed.seat.framing : null, picture: feed ? feed.picture : null, blend: bar ? bar.dataset.blend : null, songMs: range ? Number(range.value) : null };
  })()`);
/** The person in a frame of a video element (seeked to `atS`), drawn to a canvas. */
const videoFrame = (page, selector, atS) =>
  page.evaluate(`(async () => {
    const person = ${PERSON_IN_CANVAS};
    const v = document.querySelector(${JSON.stringify(selector)});
    if (!v) return null;
    if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    v.pause();
    v.currentTime = ${atS};
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const r = v.getBoundingClientRect();
    return { ...person(c), shown: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) }, win: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }, duration: v.duration };
  })()`);

const alice = await person('alice');
try {
  // ======== The stage: the voice zoom, the Camera & zoom sheet, the NONE background, the sound sheet ========
  const trackId = await importSong(alice);
  check(Boolean(trackId), `the song imported (${trackId})`);
  const page = alice.page;
  await page.goto(url(`/studio/sing/${encodeURIComponent(trackId)}`), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Start singing' }).waitFor({ timeout: 60000 });
  check((await waitForModel(page)) !== null, 'the segmentation model is cutting the singer out on the stage');
  // The seat settles on the singer (the frame glides in over a second or so) and holds: the head on the strip stays put.
  const seatHeld = (pg) => until(() => pg.evaluate(() => (window.__svFeed && window.__svFeed.seatState === 'held' ? true : null)), 30000);
  const settled = await until(async () => {
    if (!(await seatHeld(page))) return null;
    const a = await stageNow(page);
    await wait(700);
    const b = await stageNow(page);
    return a.head && b.head && Math.abs(a.head.h - b.head.h) <= 2 ? b : null;
  }, 40000);
  check(Boolean(settled?.head), `the singer is framed on the live stage strip before the song (head ${settled?.head ? `${settled.head.w}×${settled.head.h} of ${settled.w}×${settled.h}` : 'not found'})`);
  const strip = settled;
  check(strip?.framing === 'voice' && strip.picture === 'cutout', `the defaults: the frame zooms with the voice, the picture is the cut-out (${strip?.framing}, ${strip?.picture})`);
  check(strip?.heard === false, 'before the song nobody is heard: no push-in');
  // The live strip is the show stage (the meet's size for a singer): the saved file is measured against it below — by the
  // head's WIDTH against the picture's height (the fake person stands close: their chin can meet the riser, their width never).
  const liveHeadFrac = strip?.head ? strip.head.w / strip.h : 0;
  console.log(`info the live strip draws the head ${strip?.head?.w} px wide, ${strip?.head?.h} px tall, on its ${strip?.h} px height`);
  await page.screenshot({ path: path.join(out, 'studio-01-ready.png') });

  // ---- 4. The NONE background, before the song: the camera picture as it is, at once ----
  await page.getByRole('button', { name: 'Stage background' }).click();
  const bgSheet = page.locator('.sheet');
  await bgSheet.waitFor();
  check((await bgSheet.locator('[data-bg-none]').count()) === 1, 'the Stage background sheet offers NONE (the camera as it is) first');
  const before = await stageNow(page);
  await bgSheet.locator('[data-bg-none]').click();
  const noneOn = await until(async () => {
    const s = await stageNow(page);
    return s.picture === 'camera' && s.wall > s.w * s.h * 0.05 ? s : null;
  }, 8000);
  check(Boolean(noneOn), `NONE: the stage shows the camera picture at once — the room's wall is on the strip (${noneOn ? `${noneOn.wall} wall pixels, was ${before.wall}` : 'not within 8 s'})`);
  const bgEl = await page.evaluate(() => {
    const el = document.querySelector('.sing .bg');
    return el ? { bg: el.getAttribute('data-bg'), image: getComputedStyle(el).backgroundImage, video: Boolean(el.querySelector('video')) } : null;
  });
  check(bgEl?.bg === 'none' && bgEl.image === 'none' && !bgEl.video, `NONE: no stage backdrop behind the singer (${JSON.stringify(bgEl)})`);
  check((await page.evaluate(() => JSON.parse(localStorage.getItem('sv.settings.app')).backgroundId)) === 'none', 'NONE is the saved choice');
  await page.screenshot({ path: path.join(out, 'studio-02-none.png') });
  await page.keyboard.press('Escape');
  // The choice survives a reload (and the picker shows it chosen); another background brings the cut-out back.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Start singing' }).waitFor({ timeout: 60000 });
  await waitForModel(page);
  const afterReload = await until(async () => {
    const s = await stageNow(page);
    return s.picture === 'camera' && s.wall > s.w * s.h * 0.05 ? s : null;
  }, 15000);
  check(Boolean(afterReload), 'NONE survives a reload: the camera picture as it is, again');
  await page.getByRole('button', { name: 'Stage background' }).click();
  await bgSheet.waitFor();
  check((await bgSheet.locator('[data-bg-none][aria-selected="true"]').count()) === 1, 'the picker shows NONE as the choice');
  await bgSheet.locator('.bg-grid button:not([data-bg-none])').first().click();
  const cutoutBack = await until(async () => {
    const s = await stageNow(page);
    return s.picture === 'cutout' && s.wall < Math.max(before.wall * 2, s.w * s.h * 0.03) ? s : null;
  }, 8000);
  check(Boolean(cutoutBack), `another background: the cut-out is back, the wall gone (${cutoutBack ? `${cutoutBack.wall} wall pixels` : 'not within 8 s'})`);
  await page.keyboard.press('Escape');

  // ---- 3. The Sound sheet: Preview / Stop preview, a preset change without a restart, Save my sound ----
  await page.getByRole('button', { name: 'Sound' }).click();
  const sound = page.locator('.sheet').last();
  await sound.waitFor();
  const previewBtn = sound.locator('[data-preview-button]');
  check((await previewBtn.count()) === 1 && /Preview my voice/.test(await previewBtn.innerText()), 'the Sound sheet has Preview my voice');
  await previewBtn.click();
  check((await until(() => sound.locator('[data-voice-preview="on"]').count(), 10000)) !== null, 'the preview is on: the microphone through the preset, into the ears');
  const gumBefore = (await gumCalls(page)).length;
  const presets = sound.locator('.preset-grid button');
  const presetCount = await presets.count();
  check(presetCount === 16, `16 presets to preview (${presetCount})`);
  for (const i of [3, 9, 15]) {
    await presets.nth(i).click();
    await wait(300);
  }
  const chosen = await page.evaluate(() => JSON.parse(localStorage.getItem('sv.settings.audio')).activePresetId);
  check((await sound.locator('[data-voice-preview="on"]').count()) === 1 && (await gumCalls(page)).length === gumBefore, `three presets tried with the preview running: it stayed on, nothing restarted (preset now ${chosen}, no new capture)`);
  await sound.locator('[data-preview-button]').click();
  check((await until(() => sound.locator('[data-voice-preview="off"]').count(), 5000)) !== null, 'Stop preview: off');
  // Save my sound: both files in the device's Config store, and the word on it.
  await sound.locator('[data-save-sound-button]').click();
  check((await until(() => sound.locator('[data-save-sound="ok"]').count(), 10000)) !== null, 'Save my sound: saved (the word on when and where)');
  const stored = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('singersvoice');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('config', 'readonly');
          const st = tx.objectStore('config');
          const a = st.get('audio_plugin_settings.json');
          const b = st.get('app_settings.json');
          tx.oncomplete = () => resolve({ audio: a.result ?? null, app: b.result ?? null });
          tx.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      }),
  );
  check(stored?.audio?.activePresetId === chosen && stored.app?.schema === 'singersvoice.app-settings.v2', `the Config store holds audio_plugin_settings.json (preset ${stored?.audio?.activePresetId}) and app_settings.json`);
  check(Math.abs(Number(stored?.app?.trackDb) - 1.6) < 0.01 && Math.abs(Number(stored?.app?.vocalDb) - 4.6) < 0.01, `the saved Track / Vocal volume is the default (+1.6 / +4.6 dB): ${stored?.app?.trackDb} / ${stored?.app?.vocalDb}`);
  await page.screenshot({ path: path.join(out, 'studio-03-sound.png') });
  await page.keyboard.press('Escape');
  // Back to the natural voice for the take (the preview's last preset was a character one).
  await page.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('sv.settings.audio'));
    localStorage.setItem('sv.settings.audio', JSON.stringify({ ...a, activePresetId: 'natural' }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Start singing' }).waitFor({ timeout: 60000 });
  await waitForModel(page);
  check((await seatHeld(page)) !== null, 'the seat holds the singer again after the reload (the take starts from the held frame)');
  const gumAtEntry = await gumCalls(page);
  check(gumAtEntry.length === 1 && gumAtEntry[0] === 'video', `a computer's Studio opens the camera alone at entry (${gumAtEntry.join(', ')})`);

  // ---- 1. The voice zoom, while the song runs ----
  await page.getByRole('button', { name: 'Start singing' }).click();
  await page.locator('button', { hasText: 'Finish' }).waitFor({ timeout: 30000 });
  const gumAtStart = await gumCalls(page);
  check(gumAtStart.length === 2 && gumAtStart[1] === 'audio', `Start opens the microphone (${gumAtStart.join(', ')})`);
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const s = await stageNow(page);
    samples.push({ t: Date.now() - t0, heard: s.heard, head: s.head ? s.head.w : 0, songMs: s.songMs });
    await wait(100);
  }
  const heardAt = samples.filter((s) => s.heard);
  const quietAfter = samples.filter((s, i) => !s.heard && samples.slice(0, i).some((x) => x.heard));
  check(heardAt.length > 0, `the singer is heard while the microphone sings (${heardAt.length} of ${samples.length} samples)`);
  check(quietAfter.length > 0, `…and not heard again when the phrase ends (${quietAfter.length} samples after a phrase)`);
  // The head while heard for ≥ 0.7 s (the push-in has landed) against the head while quiet for ≥ 1.6 s (the push-out has).
  const sinceChange = (i) => {
    let j = i;
    while (j > 0 && samples[j - 1].heard === samples[i].heard) j--;
    return samples[i].t - samples[j].t;
  };
  const inHeads = samples.filter((s, i) => s.heard && sinceChange(i) >= 700 && s.head).map((s) => s.head);
  const outHeads = samples.filter((s, i) => !s.heard && sinceChange(i) >= 1600 && s.head && samples.slice(0, i).some((x) => x.heard)).map((s) => s.head);
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
  const zoomRatio = median(inHeads) / Math.max(1, median(outHeads));
  check(inHeads.length > 0 && outHeads.length > 0 && zoomRatio > 1.3 && zoomRatio < 1.75, `the push-in: the head is ${zoomRatio.toFixed(2)}× as wide while heard as when quiet (${median(inHeads)} px against ${median(outHeads)} px; expected ×1.5)`);
  console.log(`info the camera during the song: ${await page.evaluate(() => window.__svFeed.cameraLine)}`);
  await page.screenshot({ path: path.join(out, 'studio-04-singing.png') });

  // ---- 2. The Camera & zoom button during the song ----
  const zoomBtn = page.getByRole('button', { name: 'Camera & zoom' });
  check((await zoomBtn.isEnabled()) === true, 'the Camera & zoom button is enabled during the song');
  await zoomBtn.click();
  const zoomSheet = page.locator('[data-camera-zoom-sheet]');
  await zoomSheet.waitFor({ timeout: 10000 });
  const zoomGroup = zoomSheet.getByRole('radiogroup', { name: 'Zoom' });
  check((await zoomGroup.count()) === 1, 'the Camera & zoom sheet opens during the song with the zoom choice');
  await zoomGroup.getByRole('radio', { name: 'Still' }).click();
  check((await until(async () => ((await stageNow(page)).framing === 'still' ? true : null), 5000)) !== null, 'Still: the frame holds still from now (the feed follows the choice live)');
  await zoomGroup.getByRole('radio', { name: 'Zoom with my voice' }).click();
  check((await until(async () => ((await stageNow(page)).framing === 'voice' ? true : null), 5000)) !== null, 'Zoom with my voice: back on, live');
  await page.screenshot({ path: path.join(out, 'studio-05-camera-zoom-sheet.png') });
  await page.keyboard.press('Escape');
  await zoomSheet.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);

  // ---- 5. The take: the review plays through the mix; the saved file has the singer half as big again ----
  await page.locator('[data-review]').waitFor({ timeout: (SONG_S + 40) * 1000 });
  const savedId = await until(() => page.locator('[data-review]').getAttribute('data-saved-id'), 60000);
  check(Boolean(savedId), `the take saved (${savedId})`);
  const review = page.locator('[data-review]');
  check((await review.locator('[data-mix-default]').count()) === 0, 'the review balance stands at the defaults (no Default button to press)');
  await review.getByRole('button', { name: 'Play mix' }).click();
  await wait(1500);
  const reviewPlaying = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-review] button')].find((x) => /Stop/.test(x.textContent || ''));
    return Boolean(b);
  });
  check(reviewPlaying, 'Play mix plays the take (the track and the vocal through the mix bus) — Stop is offered');
  await review.getByRole('button', { name: 'Stop', exact: true }).click();
  await review.getByRole('button', { name: 'Keep', exact: true }).click();
  await page.locator('[data-review][data-saved-state="kept"]').waitFor({ timeout: 60000 });
  // The saved performance in Performances: the player, and the frames.
  await page.goto(url('/studio/performances'), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^Play CI Studio Song/ }).first().click();
  const perfVideo = page.locator('[data-perf-video]');
  await perfVideo.waitFor({ timeout: 60000 });
  // The file, frame by frame (every half second from 2 s on — the seat has settled by then): the smallest head is the
  // held frame (the phrase's breaks), the largest the push-in; the file itself goes to the output folder for a look.
  const frames = [];
  for (let at = 2; at < SONG_S - 1; at += 0.5) {
    const f = await videoFrame(page, '[data-perf-video]', at);
    if (f) frames.push({ at, ...f });
  }
  const withHead = frames.filter((f) => f.head);
  const smallest = withHead.reduce((a, f) => (!a || f.head.w < a.head.w ? f : a), null);
  const largest = withHead.reduce((a, f) => (!a || f.head.w > a.head.w ? f : a), null);
  const quietFrame = smallest;
  const savedHeadFrac = quietFrame?.head ? quietFrame.head.w / quietFrame.h : 0;
  check(withHead.length >= frames.length * 0.9 && frames.length > 30, `the saved file shows the singer in ${withHead.length} of ${frames.length} frames sampled (${quietFrame?.w}×${quietFrame?.h})`);
  console.log(`info the saved file's head widths: ${withHead.map((f) => `${f.at}s:${f.head.w}`).join(' ')}`);
  const soloRatio = liveHeadFrac ? savedHeadFrac / liveHeadFrac : 0;
  check(soloRatio > 1.3 && soloRatio < 1.7, `the saved performance draws the singer half as big again as the live show stage: the head is ${quietFrame?.head?.w} px wide on the ${quietFrame?.h} px frame (at ${quietFrame?.at} s, quiet) against ${strip?.head?.w} px on the strip's ${strip?.h} px (×${soloRatio.toFixed(2)}, expected ×1.5)`);
  check(Boolean(quietFrame?.head) && quietFrame.head.y > quietFrame.h * 0.05 && quietFrame.head.y < quietFrame.h * 0.5, `the head's top sits in the upper half of the saved frame, under the top edge (row ${quietFrame?.head?.y} of ${quietFrame?.h})`);
  const savedZoom = largest?.head && quietFrame?.head ? largest.head.w / quietFrame.head.w : 0;
  check(savedZoom > 1.3 && savedZoom < 1.75, `the push-in is in the saved file too: the head ${savedZoom.toFixed(2)}× as wide at ${largest?.at} s (sung) as at ${quietFrame?.at} s (quiet)`);
  // Smooth: the push-in takes 0.45 s and the push-out 1.1 s, eased — in the file (30 fps of the same picture) the head
  // passes through sizes between the two around each change, never the whole way in one step. (The way out is the
  // slower: with the test machine's camera rate — see the camera line above — the way in may land in one or two frames.)
  const lo = quietFrame.head.w;
  const hi = largest.head.w;
  const between = (w) => w > lo * 1.08 && w < hi * 0.92;
  const changes = [];
  for (let i = 1; i < withHead.length; i++) {
    const a = withHead[i - 1].head.w;
    const b = withHead[i].head.w;
    if ((a > hi * 0.92 && b < hi * 0.92) || (a < lo * 1.08 && b > lo * 1.08)) changes.push({ from: withHead[i - 1].at, to: withHead[i].at, out: a > b });
  }
  let inBetween = 0;
  let outBetween = 0;
  for (const ch of changes.slice(0, 4)) {
    const step = ch.out ? 0.1 : 0.05;
    for (let at = ch.from; at <= ch.to + 0.6; at += step) {
      const f = await videoFrame(page, '[data-perf-video]', Number(at.toFixed(2)));
      if (f?.head && between(f.head.w)) ch.out ? outBetween++ : inBetween++;
    }
  }
  check(outBetween >= 3 && changes.some((c) => c.out), `the zoom glides out, eased: ${outBetween} frames caught between the two sizes on the way out (100 ms apart; ${changes.filter((c) => c.out).length} push-outs in the file)`);
  check(inBetween >= 1 && changes.some((c) => !c.out), `…and in: ${inBetween} on the way in (50 ms apart; ${changes.filter((c) => !c.out).length} push-ins)`);
  // The file itself, for a look.
  {
    const b64 = await page.evaluate(async () => {
      const v = document.querySelector('[data-perf-video]');
      const blob = await (await fetch(v.src)).blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { type: blob.type, data: btoa(bin) };
    });
    writeFileSync(path.join(out, `take.${/mp4/.test(b64.type) ? 'mp4' : 'webm'}`), Buffer.from(b64.data, 'base64'));
  }
  check(Boolean(quietFrame?.shown) && quietFrame.shown.h >= quietFrame.win.h * 0.45 && quietFrame.shown.bottom <= quietFrame.win.h, `the Performances player uses the window: ${quietFrame?.shown?.w}×${quietFrame?.shown?.h} shown in a ${quietFrame?.win?.w}×${quietFrame?.win?.h} window, inside it`);
  check(Boolean(quietFrame) && Math.abs(quietFrame.shown.w / quietFrame.shown.h - quietFrame.w / quietFrame.h) < 0.05, `…at the file's own aspect (${quietFrame?.w}:${quietFrame?.h})`);
  await page.screenshot({ path: path.join(out, 'studio-06-performance.png') });
  await page.keyboard.press('Escape');

  // ======== 6. The permissions ========
  // A phone that says it is an iPhone: the camera comes WITH the microphone at the stage's entry (one question), the
  // engine takes that microphone at Start (nothing asked), the next song reuses it (nothing asked).
  const iphone = await person('iphone', { viewport: { width: 390, height: 844 }, mobile: true, ua: pw.devices['iPhone 13'].userAgent });
  const iTrack = await importSong(iphone);
  await iphone.page.goto(url(`/studio/sing/${encodeURIComponent(iTrack)}`), { waitUntil: 'networkidle' });
  await iphone.page.getByRole('button', { name: 'Start singing' }).waitFor({ timeout: 60000 });
  await wait(2500);
  const iEntry = await gumCalls(iphone.page);
  check(iEntry.length === 1 && iEntry[0] === 'audio+video', `iPhone: ONE capture at the stage's entry, camera and microphone together (${iEntry.join(', ') || 'none'})`);
  await iphone.page.getByRole('button', { name: 'Start singing' }).click();
  await iphone.page.locator('button', { hasText: 'Finish' }).waitFor({ timeout: 30000 });
  await wait(3000);
  const iStart = await gumCalls(iphone.page);
  check(iStart.length === 1, `iPhone: Start asked for nothing — the engine took the camera's microphone (${iStart.length} capture in all)`);
  const iMeter = await until(async () => ((await stageNow(iphone.page)).heard ? true : null), 12000);
  check(iMeter !== null, 'iPhone: the adopted microphone is heard (the meter runs, the voice zoom follows)');
  await iphone.page.getByRole('button', { name: 'Finish' }).click();
  await iphone.page.locator('[data-review]').waitFor({ timeout: 60000 });
  await iphone.page.getByRole('button', { name: 'Sing again' }).click();
  await iphone.page.getByRole('button', { name: 'Start singing' }).waitFor({ timeout: 60000 });
  await wait(1000);
  await iphone.page.getByRole('button', { name: 'Start singing' }).click();
  await iphone.page.locator('button', { hasText: 'Finish' }).waitFor({ timeout: 30000 });
  await wait(2000);
  const iSecond = await gumCalls(iphone.page);
  check(iSecond.length === 1, `iPhone: the next song asked for nothing either — the parked microphone sings again (${iSecond.length} capture in all)`);
  await iphone.page.screenshot({ path: path.join(out, 'studio-07-iphone-stage.png') });
  await iphone.page.getByRole('button', { name: 'Finish' }).click();
  await iphone.page.locator('[data-review]').waitFor({ timeout: 60000 });
  // Away from the stage the capture is let go: the camera light goes off.
  await iphone.page.goto(url('/studio'), { waitUntil: 'networkidle' });
  await iphone.ctx.close();

  // The setup's one question for both: Allow both → one getUserMedia for camera + microphone, the step ticked. (A browser
  // that has not been asked yet: no permissions granted up front; the fake UI says yes when asked.)
  const fresh = await person('fresh', { permissions: [] });
  await fresh.page.evaluate(() => localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: false, countIn: false, cameraOn: true, socialOffer: false })));
  await fresh.page.goto(url('/setup'), { waitUntil: 'networkidle' });
  const step = fresh.page.locator('[data-media-step]');
  await step.waitFor({ timeout: 30000 });
  check((await step.getAttribute('data-media-step')) !== 'ok', 'the setup has the Camera & microphone step, not yet answered');
  await fresh.page.locator('[data-allow-media]').click();
  check((await until(async () => ((await step.getAttribute('data-media-step')) === 'ok' ? true : null), 15000)) !== null, 'Allow both: the step is ticked');
  const setupGum = await gumCalls(fresh.page);
  check(setupGum.length === 1 && setupGum[0] === 'audio+video', `…with ONE question for both (${setupGum.join(', ')})`);
  check(Boolean((await fresh.page.evaluate(() => JSON.parse(localStorage.getItem('sv.settings.app')).mediaAskedAt))), 'the setup remembers that the question was put (mediaAskedAt)');
  await fresh.page.screenshot({ path: path.join(out, 'studio-08-setup-media.png') });
  await fresh.page.getByRole('button', { name: 'Go to my stage' }).click();
  await fresh.page.waitForURL(/\/home/);
  await fresh.ctx.close();
  // Settings says what the browser holds (a browser that allows both).
  const settled2 = await person('settled');
  await settled2.page.goto(url('/settings'), { waitUntil: 'networkidle' });
  await settled2.page.locator('[data-permission]').first().waitFor({ timeout: 15000 });
  const perms = await settled2.page.evaluate(() => [...document.querySelectorAll('[data-permission]')].map((e) => `${e.dataset.permission}:${e.dataset.permissionState}`));
  check(perms.includes('microphone:granted') && perms.includes('camera:granted'), `Settings shows the browser's word: ${perms.join(', ')}`);
  await settled2.ctx.close();

  // A browser that blocks the camera: the stage says so, with the way back; Settings says blocked.
  const blocked = await person('blocked', {
    init: () => {
      const md = navigator.mediaDevices;
      const gum = md.getUserMedia.bind(md);
      md.getUserMedia = async (c) => {
        if (c && c.video) throw new DOMException('Permission denied', 'NotAllowedError');
        return gum(c);
      };
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = async (d) => (d && d.name === 'camera' ? { state: 'denied', addEventListener() {}, removeEventListener() {} } : q(d));
    },
  });
  const bTrack = await importSong(blocked);
  await blocked.page.goto(url(`/studio/sing/${encodeURIComponent(bTrack)}`), { waitUntil: 'networkidle' });
  await blocked.page.getByRole('button', { name: 'Start singing' }).waitFor({ timeout: 60000 });
  const camNote = await until(() => blocked.page.locator('[data-cam-blocked]').textContent().catch(() => null), 15000);
  check(Boolean(camNote) && /lock|address bar|Allow/.test(camNote), `the stage says the camera is blocked, with the way back: "${(camNote || '').slice(0, 90)}…"`);
  await blocked.page.getByRole('button', { name: 'Start singing' }).click();
  await blocked.page.locator('button', { hasText: 'Finish' }).waitFor({ timeout: 30000 });
  check(true, 'a blocked camera never costs the song: the take runs with the microphone');
  await blocked.page.screenshot({ path: path.join(out, 'studio-09-camera-blocked.png') });
  await blocked.page.getByRole('button', { name: 'Finish' }).click();
  await blocked.page.locator('[data-review]').waitFor({ timeout: 60000 });
  await blocked.page.goto(url('/settings'), { waitUntil: 'networkidle' });
  const bPerms = await blocked.page.evaluate(() => [...document.querySelectorAll('[data-permission]')].map((e) => `${e.dataset.permission}:${e.dataset.permissionState}`));
  check(bPerms.includes('camera:denied') && bPerms.includes('microphone:granted'), `Settings shows the blocked camera and the way back: ${bPerms.join(', ')}`);
  await blocked.ctx.close();

  for (const [who, errs] of Object.entries(errors)) {
    // "Failed to load resource" is the browser noting a non-2xx fetch (device mode has no account on the service: 401s); a
    // VideoFrame the browser collected unclosed is its own note on a frame dropped inside a stopped track (not an error of
    // the page — it is listed, not counted).
    const real = errs.filter((e) => !/favicon|401|Unauthorized|Failed to load resource/.test(e));
    const notes = real.filter((e) => /VideoFrame was garbage collected/.test(e));
    if (notes.length) console.log(`info ${who}: ${notes.length} VideoFrame-collected note(s) from the browser`);
    const counted = real.filter((e) => !/VideoFrame was garbage collected/.test(e));
    check(counted.length === 0, `${who}: no page errors${counted.length ? ` — ${counted.slice(0, 3).join(' | ').slice(0, 300)}` : ''}`);
  }
} catch (e) {
  failed = true;
  console.log(`FAIL ${e && e.stack ? e.stack : e}`);
  await alice.page.screenshot({ path: path.join(out, 'studio-error.png') }).catch(() => undefined);
}
await browser.close();
await servers.stop();
process.exit(failed ? 1 : 0);
