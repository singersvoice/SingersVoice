// The HLS lab: what the in-house watch page plays, measured. The browser's own muxer
// (apps/web/src/broadcast/tsMuxer.ts) is run in Node on real H.264 + AAC that ffmpeg made, packetised
// and cut into one-second segments exactly as the show view's encoder does (video access units
// stamped on a 30 fps clock, four ADTS frames per audio PES, a cut at every keyframe), and the
// segments are served as a live playlist that grows one segment a second. Chromium then plays it
// through hls.js with the watch page's own settings, and the lab checks what a viewer would see:
// the picture starts within a few seconds, keeps advancing, and never stalls — with sound and without.
//   node tools/ci/hls-lab.mjs
// Exits 1 when any check fails. Needs playwright (local install or /opt/npm-tools), esbuild and ffmpeg.
import { createRequire } from 'node:module';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/npm-tools/node_modules/playwright');
}
const esbuild = require('esbuild');

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const SECONDS = 10;
const FPS = 30;
const ADTS_PER_PES = 4;

// The muxer and the playlist writer, as the app and the service run them.
const bundle = esbuild.buildSync({
  stdin: {
    contents: `export { TsMuxer, splitAdts, splitNals } from './apps/web/src/broadcast/tsMuxer.ts'; export { hlsPlaylist } from './services/control/src/live.ts';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  absWorkingDir: root,
  external: ['@singersvoice/protocol'],
  outfile: 'lab.mjs',
});
const labFile = path.join(mkdtempSync(path.join(tmpdir(), 'sv-hls-lab-')), 'lab.mjs');
writeFileSync(labFile, bundle.outputFiles[0].text.replace(/from "@singersvoice\/protocol"/g, `from "${path.join(root, 'packages/protocol/src/index.ts')}"`));
const { TsMuxer, splitAdts, splitNals, hlsPlaylist } = await import(labFile);

const dir = path.dirname(labFile);
const h264 = path.join(dir, 'v.h264');
const aac = path.join(dir, 'a.aac');
// What the show view's encoder makes: Annex B H.264 with an AUD, SPS/PPS before every keyframe, a keyframe a second, no B-frames; AAC-LC ADTS 48 kHz stereo.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${FPS}`, '-t', String(SECONDS), '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-x264-params', `keyint=${FPS}:min-keyint=${FPS}:scenecut=0:bframes=0:aud=1:repeat-headers=1`, '-f', 'h264', h264]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(SECONDS), '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', aac]);

/** Access units of an Annex B stream: each starts at an AUD (type 9). */
function accessUnits(bytes) {
  const nals = splitNals(bytes);
  const units = [];
  let cur = [];
  for (const n of nals) {
    if ((n[0] & 0x1f) === 9 && cur.length) {
      units.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length) units.push(cur);
  return units.map((ns) => {
    const len = ns.reduce((s, n) => s + 4 + n.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    let key = false;
    for (const n of ns) {
      out.set([0, 0, 0, 1], o);
      out.set(n, o + 4);
      o += 4 + n.length;
      if ((n[0] & 0x1f) === 5) key = true;
    }
    return { data: out, key };
  });
}

/** Segments as the encoder cuts them (`audio`: with the AAC track or video only). */
function makeSegments(audio) {
  const units = accessUnits(new Uint8Array(readFileSync(h264)));
  const frames = splitAdts(new Uint8Array(readFileSync(aac)));
  const packets = [];
  units.forEach((u, i) => packets.push({ kind: 'video', ts: Math.round((i * 1e6) / FPS), key: u.key, data: u.data }));
  if (audio) {
    for (let i = 0; i < frames.length; i += ADTS_PER_PES) {
      const run = frames.slice(i, i + ADTS_PER_PES);
      const data = new Uint8Array(run.reduce((n, f) => n + f.length, 0));
      let o = 0;
      for (const f of run) {
        data.set(f, o);
        o += f.length;
      }
      packets.push({ kind: 'audio', ts: Math.round((i * 1024 * 1e6) / 48000), key: false, data });
    }
  }
  const keys = packets.filter((p) => p.kind === 'video' && p.key).map((p) => p.ts);
  const mux = new TsMuxer(audio ? 'aac' : 'none');
  const segments = [];
  for (let k = 0; k < keys.length; k++) {
    const from = keys[k];
    const to = keys[k + 1] ?? Infinity;
    const seg = packets.filter((p) => p.ts >= from && p.ts < to);
    if (!seg.some((p) => p.kind === 'video')) continue;
    const { bytes } = mux.muxSegment(seg, 1e6 / FPS);
    const first = seg.find((p) => p.kind === 'video').ts;
    const last = seg.filter((p) => p.kind === 'video').pop().ts;
    segments.push({ seq: k, name: `lab${audio ? 'a' : 'v'}-${k}.ts`, bytes, durationMs: Math.round(((to === Infinity ? last + 1e6 / FPS : to) - first) / 1000), createdAt: new Date().toISOString() });
  }
  return segments;
}

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};

// What ffprobe sees of the first segment with sound: both streams, the audio starting beside the video.
{
  const segs = makeSegments(true);
  const f = path.join(dir, segs[0].name);
  writeFileSync(f, segs[0].bytes);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', f]).toString());
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  const firstPts = (kind) => Number(probe.packets.find((p) => p.codec_type === kind)?.pts_time ?? NaN);
  console.log('segment 0:', JSON.stringify({ video: v && `${v.codec_name} ${v.width}x${v.height}`, audio: a && `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch`, firstVideoPts: firstPts('video'), firstAudioPts: firstPts('audio'), durationMs: segs[0].durationMs, bytes: segs[0].bytes.length }));
  check(Boolean(v && a), 'the segment carries the H.264 picture and the AAC sound');
  check(Math.abs(firstPts('audio') - firstPts('video')) < 0.1, `the sound starts beside the picture (${(firstPts('audio') - firstPts('video')).toFixed(3)} s apart)`);
}

const hlsJs = readFileSync(path.join(root, 'node_modules/hls.js/dist/hls.js'));
const html = `<!doctype html><meta charset="utf-8"><title>hls lab</title><video id="v" playsinline muted style="width:640px;height:360px"></video><script src="/hls.js"></script>
<script>
window.lab = { events: [], errors: [], times: [] };
const v = document.getElementById('v');
for (const e of ['playing', 'waiting', 'stalled', 'pause', 'ended', 'error']) v.addEventListener(e, () => lab.events.push([e, Math.round(performance.now())]));
setInterval(() => lab.times.push([Math.round(performance.now()), Number(v.currentTime.toFixed(2)), v.readyState]), 500);
// the watch page's own settings (components/LiveShow.tsx)
const hls = new Hls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8, maxBufferLength: 10, enableWorker: true, lowLatencyMode: false, backBufferLength: 20 });
hls.on(Hls.Events.ERROR, (_e, d) => lab.errors.push({ type: d.type, details: d.details, fatal: d.fatal }));
hls.loadSource('/live.m3u8');
hls.attachMedia(v);
hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch((e) => lab.errors.push({ play: String(e) })));
</script>`;

async function playLive(audio) {
  const segments = makeSegments(audio);
  const t0 = Date.now();
  // the show has been on for three seconds when the viewer arrives; one more segment a second after that
  const available = () => segments.slice(0, Math.min(segments.length, 3 + Math.floor((Date.now() - t0) / 1000))).slice(-12);
  const server = http.createServer((req, res) => {
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    if (req.url === '/hls.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(hlsJs);
    if (req.url === '/live.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' }).end(hlsPlaylist(available(), (n) => `live/${n}`));
    const m = /^\/live\/(.+\.ts)$/.exec(req.url ?? '');
    const seg = m && segments.find((s) => s.name === m[1]);
    if (seg) return res.writeHead(200, { 'content-type': 'video/MP2T' }).end(Buffer.from(seg.bytes));
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('page error', e));
  await page.goto(url);
  await page.waitForTimeout(12_000);
  const lab = await page.evaluate(() => window.lab);
  await browser.close();
  server.close();
  const playingAt = lab.events.find((e) => e[0] === 'playing')?.[1] ?? null;
  const last = lab.times[lab.times.length - 1];
  const advanced = last ? last[1] : 0;
  const stalls = lab.events.filter((e) => e[0] === 'waiting' || e[0] === 'stalled').length;
  const fatal = lab.errors.filter((e) => e.fatal);
  console.log(`${audio ? 'with sound' : 'video only'}:`, JSON.stringify({ playingAtMs: playingAt, currentTime: advanced, stalls, errors: lab.errors.slice(0, 5), segments: segments.length, durations: segments.slice(0, 4).map((s) => s.durationMs) }));
  check(playingAt !== null && playingAt < 8000, `${audio ? 'with sound' : 'video only'}: the show starts playing within a few seconds (${playingAt} ms)`);
  check(advanced >= 5, `${audio ? 'with sound' : 'video only'}: the picture keeps advancing (${advanced} s played in 12 s)`);
  check(fatal.length === 0, `${audio ? 'with sound' : 'video only'}: no fatal player error (${JSON.stringify(fatal.slice(0, 2))})`);
}

await playLive(false);
await playLive(true);
process.exit(failed ? 1 : 0);
