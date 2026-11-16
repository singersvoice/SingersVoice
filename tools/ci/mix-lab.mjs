// The mix lab: what an audience device plays, measured. The real `MixPlayer` (audio/mixPlayer.ts) and
// the real `sv-mix-out` worklet run in Chromium on a song encoded exactly as the host's device
// encodes the stage mix (Opus batches, one a second), on an AudioContext at 48 kHz and again at
// 44.1 kHz (a laptop's rate: every packet resampled), and six seconds of the output are recorded on
// the audio thread (the `sv-tap` worklet) and measured (audio-measure.mjs):
//   - the output is the song (correlation with the track above 0.9), located exactly where the
//     player says it is (the lyrics follow the sound): within 0.3 s;
//   - not one click (the song puts nothing in the top of the spectrum: a burst there is a seam);
//   - not one gap; the player's position advances at real time; it runs 3–5 s behind the newest batch.
//   node tools/ci/mix-lab.mjs
// Exits 1 when any check fails. Needs playwright (local install or /opt/npm-tools), esbuild and ffmpeg.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeToPcm, measure } from './audio-measure.mjs';
import { makeSong } from './e2e-song.mjs';
const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/npm-tools/node_modules/playwright');
}
const esbuild = require('esbuild');

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const songFile = makeSong(path.join(tmpdir(), 'sv-mix-lab-song.mp3'), 60);
const bundle = esbuild.buildSync({ entryPoints: [path.join(root, 'apps/web/src/audio/mixLab.ts')], bundle: true, format: 'esm', platform: 'browser', write: false, define: { 'import.meta.env.BASE_URL': '"/"' }, absWorkingDir: root });
const labJs = bundle.outputFiles[0].text;
const html = '<!doctype html><meta charset="utf-8"><title>mix lab</title><script type="module" src="/lab.js"></script>';
const song = readFileSync(songFile);
const server = http.createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  if (req.url === '/lab.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(labJs);
  if (req.url === '/song.mp3') return res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(song);
  const m = /^\/worklets\/([a-z-]+\.js)$/.exec(req.url ?? '');
  if (m) return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(path.join(root, 'apps/web/public/worklets', m[1])));
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('page error', e));
page.on('console', (m) => m.type() === 'error' && console.log('console', m.text()));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.svMixLab));

for (const ctxRate of [48000, 44100]) {
  const r = await page.evaluate((o) => window.svMixLab(o), { ctxRate, seconds: 6, songUrl: '/song.mp3', startMs: 0, arrivalMs: 1000, workletBase: '/worklets/' });
  const bytes = Buffer.from(r.b64, 'base64');
  const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const m = measure(pcm, decodeToPcm(songFile, r.rate), r.rate);
  console.log(`device at ${ctxRate} Hz:`, JSON.stringify({ rate: r.rate, rms: m.rms.toFixed(3), clicks: m.clicks.count, maxJump: m.clicks.maxJump.toFixed(3), gaps: m.gaps, song: { r: m.song.r.toFixed(3), positionS: m.song.positionS.toFixed(3) }, fetched: r.fetched, batches: r.batches }));
  console.log('  the player says:', JSON.stringify(r.positions.map((p) => [p.t, p.pos === null ? null : Math.round(p.pos), p.behind, p.hearing ? 'H' : '-'])));
  check(r.rate === ctxRate, `the context runs at ${ctxRate} Hz`);
  check(m.rms > 0.05, `the player plays the song (RMS ${m.rms.toFixed(3)})`);
  check(m.song.r > 0.9, `the output is the song itself (correlation ${m.song.r.toFixed(3)})`);
  check(m.clicks.count === 0, `not one click in six seconds (${m.clicks.count}; the biggest jump ${m.clicks.maxJump.toFixed(3)})`);
  check(m.gaps.count === 0 && !m.gaps.silent, `not one gap (${m.gaps.count}, longest ${m.gaps.longestMs} ms)`);
  // the player's reading at the moment the capture started: the first sample after the start, extrapolated to the capture's start
  const told = r.positions.filter((p) => p.pos !== null);
  const first = told[0];
  const last = told[told.length - 1];
  check(Boolean(first && last) && last.t > first.t, 'the player reports the track position of what is being heard');
  if (first && last && last.t > first.t) {
    const slope = (last.pos - first.pos) / (last.t - first.t);
    check(Math.abs(slope - 1) < 0.05, `the position advances at real time (×${slope.toFixed(3)})`);
    // the capture began right after start (before the first reading): the reading extrapolated back to t = 0
    const atStartS = (first.pos - first.t * slope) / 1000;
    check(Math.abs(m.song.positionS - atStartS) < 0.3, `the sound is where the player says it is (heard ${m.song.positionS.toFixed(2)} s, said ${atStartS.toFixed(2)} s)`);
  }
  const behind = told.map((p) => p.behind);
  check(behind.every((b) => b >= 3 && b <= 5.5), `the sound runs 3–5 s behind the newest batch (${Math.min(...behind)}–${Math.max(...behind)} s)`);
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
