// The rider lab: the mix's automatic vocal level, measured. The real `sv-leveler` worklet with the real
// VOCAL_RIDER settings (audio/mixBus.ts) runs in Chromium on an OfflineAudioContext, fed a synthetic
// microphone (audio/riderLab.ts): a steady hiss at one level and, over it, a voice sung in phrases.
//   - a microphone that only hisses is left alone: the hiss is never riden up (a film of a meet once
//     carried a dead-quiet mic's floor at -22 dB — its -40 dB raised by the rider's full +18 — and the
//     mix's guard then held the whole mix under it);
//   - a voice standing over the hiss is brought to the vocal target, and the hiss between its phrases
//     stays at least 12 dB under the target (a noisy microphone gets a quieter voice, not a loud hiss);
//   - a quiet singer on a quiet microphone still gets the full lift; a loud one is brought down;
//   - the guard (MIX_GUARD) is as it was: a hot mix is held at the mix target.
//   node tools/ci/rider-lab.mjs
// Exits 1 when any check fails. Needs playwright (local install or /opt/npm-tools) and esbuild.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync } from 'node:fs';
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
const bundle = esbuild.buildSync({ entryPoints: [path.join(root, 'apps/web/src/audio/riderLab.ts')], bundle: true, format: 'esm', platform: 'browser', write: false, define: { 'import.meta.env.BASE_URL': '"/"' }, absWorkingDir: root });
const labJs = bundle.outputFiles[0].text;
const html = '<!doctype html><meta charset="utf-8"><title>rider lab</title><script type="module" src="/lab.js"></script>';
const server = http.createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  if (req.url === '/lab.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(labJs);
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
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : String(x));

const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('page error', e));
page.on('console', (m) => m.type() === 'error' && console.log('console', m.text()));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.svRiderLab));

/** Run one microphone through the rider; the windows after `fromS`, split by whether a phrase is sung. */
async function run(opts, fromS) {
  const r = await page.evaluate((o) => window.svRiderLab(o), { workletBase: '/worklets/', seconds: 40, phraseOnS: 2, phraseOffS: 1, voiceFromS: 2, config: 'vocal', ...opts });
  const late = r.windows.filter((w) => w.t >= fromS);
  return { on: median(late.filter((w) => w.voice === 'on').map((w) => w.rms)), off: median(late.filter((w) => w.voice === 'off').map((w) => w.rms)), all: median(late.map((w) => w.rms)), max: Math.max(...late.map((w) => w.rms)), windows: r.windows };
}

const TARGET = -17; // MIX_TARGETS.vocalDb
try {
  // 1. A microphone that only hisses (a laptop's fan, a dead-quiet room at a built-in mic's floor): left alone.
  const hiss = await run({ noiseDb: -40, voiceDb: null }, 10);
  console.log('hiss alone:', JSON.stringify({ median: fmt(hiss.all), loudest: fmt(hiss.max) }));
  check(hiss.max < -38, `a microphone's hiss alone is never riden up: -40 dB in, ${fmt(hiss.max)} dB out at the loudest (the old rider made it ${fmt(-40 + 18)})`);
  // 2. A voice over that hiss: brought to the target; the hiss between phrases 12 dB under the target at most.
  const over = await run({ noiseDb: -40, voiceDb: -28 }, 20);
  console.log('voice over hiss:', JSON.stringify({ sung: fmt(over.on), between: fmt(over.off) }));
  check(Math.abs(over.on - TARGET) < 2.5, `a voice 12 dB over the hiss is brought to the vocal target: ${fmt(over.on)} dB sung (target ${TARGET})`);
  check(over.off <= TARGET - 12 + 1, `the hiss between its phrases stays 12 dB under the target: ${fmt(over.off)} dB`);
  // 3. A quiet singer on a quiet microphone: the full lift.
  const quiet = await run({ noiseDb: -70, voiceDb: -34 }, 20);
  console.log('quiet singer, quiet mic:', JSON.stringify({ sung: fmt(quiet.on), between: fmt(quiet.off) }));
  check(Math.abs(quiet.on - TARGET) < 2.5, `a quiet singer on a quiet microphone gets the full lift: ${fmt(quiet.on)} dB sung from -34 in`);
  check(quiet.off < -45, `and nothing to speak of between the phrases: ${fmt(quiet.off)} dB`);
  // 4. A loud singer: brought down, the hiss with them.
  const loud = await run({ noiseDb: -40, voiceDb: -8 }, 20);
  console.log('loud singer:', JSON.stringify({ sung: fmt(loud.on), between: fmt(loud.off) }));
  check(Math.abs(loud.on - TARGET) < 2.5, `a loud singer is brought down to the target: ${fmt(loud.on)} dB sung from -8 in`);
  check(loud.off < -45, `the hiss goes down with them: ${fmt(loud.off)} dB between phrases`);
  // 5. A voice that barely stands over the hiss (5 dB): not a voice to the rider — the rider holds, nothing is riden up.
  const buried = await run({ noiseDb: -40, voiceDb: -35 }, 20);
  console.log('voice barely over the hiss:', JSON.stringify({ sung: fmt(buried.on), between: fmt(buried.off) }));
  check(buried.off < -38, `a voice only 5 dB over the hiss does not open the rider: the hiss stays put at ${fmt(buried.off)} dB`);
  // 6. The guard is as it was: a hot mix (no floor rule) is held at the mix target.
  const guard = await run({ noiseDb: -8, voiceDb: null, config: 'guard' }, 10);
  console.log('guard:', JSON.stringify({ median: fmt(guard.all) }));
  check(Math.abs(guard.all - -15) < 1.5, `the guard holds a hot mix at the mix target: -8 dB in, ${fmt(guard.all)} dB out (target -15)`);
} catch (e) {
  console.log('rider lab error', e);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
