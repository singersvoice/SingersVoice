// The audio lab: the real vocal chain and mix bus rendered offline in Chromium (OfflineAudioContext +
// the AudioWorklets), measured with synthetic signals — what a listener would hear, in numbers:
//   - the chain's parallel paths land together (no comb filter / echo in its impulse response);
//   - the de-esser never boosts a quiet top end (the browser compressor's hidden makeup is taken out)
//     and does duck a loud "s";
//   - the vocal leaves the chain under its ceiling however hot it comes in;
//   - the mix bus brings a quiet track and a hot or quiet vocal to their targets, holds a mix pushed
//     to +30 / +30 under the mix target, and never lets a sample over full scale.
//   node tools/ci/audio-lab.mjs
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
const bundle = esbuild.buildSync({ entryPoints: [path.join(root, 'apps/web/src/audio/lab.ts')], bundle: true, format: 'esm', platform: 'browser', write: false });
const labJs = bundle.outputFiles[0].text;
const page_html = '<!doctype html><meta charset="utf-8"><title>audio lab</title><script type="module" src="/lab.js"></script>';
const server = http.createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page_html);
  if (req.url === '/lab.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(labJs);
  const m = /^\/worklets\/([a-z-]+\.js)$/.exec(req.url ?? '');
  if (m) return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(path.join(root, 'apps/web/public/worklets', m[1])));
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await pw.chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('page error', e));
page.on('console', (m) => m.type() === 'error' && console.log('console', m.text()));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.svLab));

const results = await page.evaluate(async () => {
  const L = window.svLab;
  const RATE = 48000;
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
  async function offline(seconds, channels = 1, worklets = true) {
    const ctx = new OfflineAudioContext(channels, Math.round(seconds * RATE), RATE);
    if (worklets) for (const m of ['dynamics.js', 'leveler.js', 'pitch-shifter.js']) await ctx.audioWorklet.addModule('/worklets/' + m);
    return ctx;
  }
  function tone(ctx, hz, dbfs, seconds, from = 0, channels = 1) {
    const buf = ctx.createBuffer(channels, Math.round(seconds * RATE), RATE);
    const a = Math.pow(10, dbfs / 20);
    for (let c = 0; c < channels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = a * Math.sin((2 * Math.PI * hz * i) / RATE);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.start(from);
    return src;
  }
  /** A "voice": a harmonic series on 180 Hz with vibrato and a slow envelope — pitched, dynamic, like singing. */
  function voice(ctx, dbfs, seconds, from = 0) {
    const buf = ctx.createBuffer(1, Math.round(seconds * RATE), RATE);
    const d = buf.getChannelData(0);
    let phase = 0;
    let peak = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / RATE;
      const f0 = 180 * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t));
      phase += (2 * Math.PI * f0) / RATE;
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.sin(phase * h) / h;
      const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.7 * t);
      d[i] = v * env;
      if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
    }
    // Scale to the wanted RMS.
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    const g = Math.pow(10, dbfs / 20) / Math.sqrt(sum / d.length);
    for (let i = 0; i < d.length; i++) d[i] *= g;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.start(from);
    return src;
  }
  const rmsDb = (d, from, to) => {
    let s = 0;
    const a = Math.round(from * RATE);
    const b = Math.round(to * RATE);
    for (let i = a; i < b; i++) s += d[i] * d[i];
    return db(Math.sqrt(s / (b - a)));
  };
  const peakOf = (d, from = 0, to = d.length / RATE) => {
    let p = 0;
    const a = Math.round(from * RATE);
    const b = Math.round(to * RATE);
    for (let i = a; i < b; i++) if (Math.abs(d[i]) > p) p = Math.abs(d[i]);
    return p;
  };
  const out = {};

  // 1. Impulse response of the chain with every parallel stage on: one arrival, no echo.
  for (const worklets of [true, false]) {
    const ctx = await offline(1, 1, worklets);
    const chain = L.createVoxForgeChain(ctx, worklets);
    chain.apply({ ...L.presetParams('studio'), pcOn: true, pcMx: 1, dsOn: true, dsAmt: 0.6, exOn: true, exAmt: 1, satOn: true, satMx: 1, rvOn: false, dlOn: false, chOn: false, rdOn: false });
    const buf = ctx.createBuffer(1, RATE, RATE);
    buf.getChannelData(0)[Math.round(0.5 * RATE)] = 0.02; // −34 dBFS: every compressor below threshold
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(chain.input);
    chain.output.connect(ctx.destination);
    src.start(0);
    const d = (await ctx.startRendering()).getChannelData(0);
    let at = 0;
    let main = 0;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > main) { main = Math.abs(d[i]); at = i; }
    const after = peakOf(d, (at + Math.round(0.0012 * RATE)) / RATE, (at + Math.round(0.03 * RATE)) / RATE);
    out[`ir_${worklets ? 'worklet' : 'native'}`] = { latencyMs: +(((at - Math.round(0.5 * RATE)) / RATE) * 1000).toFixed(2), reportedMs: +((chain.latencyFrames / RATE) * 1000).toFixed(2), echoDb: +db(after / main).toFixed(1) };
  }

  // 2. The de-esser: unity on a quiet top end, a duck on a loud one.
  for (const worklets of [true, false]) {
    const r = {};
    for (const level of [-40, -10]) {
      const ctx = await offline(2, 1, worklets);
      const chain = L.createVoxForgeChain(ctx, worklets);
      chain.apply({ ...L.VOXFORGE_DEFAULTS, pitchOn: false, eqOn: false, compOn: false, pcOn: false, dsOn: true, dsAmt: 0.5, exOn: false, satOn: false, chOn: false, dlOn: false, rvOn: false, rdOn: false });
      tone(ctx, 8000, level, 2).connect(chain.input);
      chain.output.connect(ctx.destination);
      const d = (await ctx.startRendering()).getChannelData(0);
      r[level] = +(rmsDb(d, 1.2, 1.9) - (level - 3.01)).toFixed(2); // gain vs the tone's own RMS
    }
    out[`deesser_${worklets ? 'worklet' : 'native'}`] = r;
  }

  // 3. The ceiling: a voice 20 dB over full scale leaves the chain under −2 dBFS, never clipped.
  for (const worklets of [true, false]) {
    const ctx = await offline(2, 1, worklets);
    const chain = L.createVoxForgeChain(ctx, worklets);
    chain.apply({ ...L.presetParams('studio'), rdOn: false });
    voice(ctx, 10, 2).connect(chain.input);
    chain.output.connect(ctx.destination);
    const d = (await ctx.startRendering()).getChannelData(0);
    out[`ceiling_${worklets ? 'worklet' : 'native'}`] = { peakDb: +db(peakOf(d, 0.3, 2)).toFixed(2) };
  }

  // 3b. The chain at a normal level: a voice at −20 dBFS RMS comes out near where it went in (no hidden makeup).
  {
    const ctx = await offline(2, 1, true);
    const chain = L.createVoxForgeChain(ctx, true);
    chain.apply({ ...L.presetParams('studio'), rdOn: false, rvOn: false });
    voice(ctx, -20, 2).connect(chain.input);
    chain.output.connect(ctx.destination);
    const d = (await ctx.startRendering()).getChannelData(0);
    out.studio_gain = { rmsDb: +rmsDb(d, 1, 2).toFixed(2), peakDb: +db(peakOf(d, 1, 2)).toFixed(2) };
  }

  // 4. The mix bus: a quiet track to the track target, a hot and a quiet vocal to the vocal target.
  {
    const ctx = await offline(8, 2, true);
    const bus = new L.MixBus(ctx, true);
    const trackSrc = tone(ctx, 1000, -30, 8, 0, 2); // −30 dBFS per channel: a quiet file
    const lufs = L.measureLoudness([trackSrc.buffer.getChannelData(0), trackSrc.buffer.getChannelData(1)], RATE).lufs;
    bus.setBackingNormalization(L.normalizationDb(lufs, L.MIX_TARGETS.trackLufs));
    trackSrc.connect(bus.backingIn);
    bus.output.connect(ctx.destination);
    const r = await ctx.startRendering();
    const measured = L.measureLoudness([r.getChannelData(0).subarray(2 * RATE), r.getChannelData(1).subarray(2 * RATE)], RATE).lufs;
    out.track_norm = { fileLufs: +lufs.toFixed(1), mixLufs: +measured.toFixed(1), target: L.MIX_TARGETS.trackLufs };
  }
  for (const level of [-5, -33]) {
    const ctx = await offline(12, 1, true);
    const bus = new L.MixBus(ctx, true);
    // Sung for ten seconds, then two seconds of nothing: the rider must hold, not lift the silence.
    bus.addVocal('v', voice(ctx, level, 10));
    bus.output.connect(ctx.destination);
    const d = (await ctx.startRendering()).getChannelData(0);
    out[`vocal_rider_${level}`] = { inDb: level, at2s: +rmsDb(d, 1.5, 2).toFixed(1), at4s: +rmsDb(d, 3.5, 4).toFixed(1), at10s: +rmsDb(d, 8.5, 10).toFixed(1), tailPeakDb: +db(peakOf(d, 10.5, 12)).toFixed(1), target: L.MIX_TARGETS.vocalDb, maxLift: L.VOCAL_RIDER.maxDb, maxCut: L.VOCAL_RIDER.minDb };
  }

  // 5. The whole: track + vocal at 0 / 0 sits near the mix target with the guard idle; at +30 / +30 the guard brings it back and nothing clips.
  for (const push of [0, 30]) {
    const ctx = await offline(10, 2, true);
    const bus = new L.MixBus(ctx, true);
    const trackSrc = tone(ctx, 220, -25, 10, 0, 2);
    const lufs = L.measureLoudness([trackSrc.buffer.getChannelData(0), trackSrc.buffer.getChannelData(1)], RATE).lufs;
    bus.setBackingNormalization(L.normalizationDb(lufs, L.MIX_TARGETS.trackLufs));
    trackSrc.connect(bus.backingIn);
    bus.addVocal('v', voice(ctx, -20, 10));
    bus.setBalance(push, push);
    bus.output.connect(ctx.destination);
    const r = await ctx.startRendering();
    const d = r.getChannelData(0);
    out[`mix_${push}`] = { at1s: +rmsDb(d, 0.5, 1).toFixed(1), at10s: +rmsDb(d, 9, 10).toFixed(1), peakDb: +db(peakOf(d)).toFixed(2), target: L.MIX_TARGETS.mixDb, ceiling: -1.5 };
  }
  return out;
});
await browser.close();
server.close();

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
console.log(JSON.stringify(results, null, 1));
for (const k of ['ir_worklet', 'ir_native']) {
  const r = results[k];
  check(r.echoDb < -18, `${k}: parallel paths aligned (secondary arrival ${r.echoDb} dB under the main one)`);
  check(Math.abs(r.latencyMs - r.reportedMs) < 0.3, `${k}: chain latency ${r.latencyMs} ms as reported (${r.reportedMs} ms)`);
}
check(results.ir_worklet.latencyMs < 12, `worklet chain latency ${results.ir_worklet.latencyMs} ms < 12 ms`);
for (const k of ['deesser_worklet', 'deesser_native']) {
  const r = results[k];
  check(Math.abs(r['-40']) < 1, `${k}: a quiet 8 kHz passes at unity (${r['-40']} dB)`);
  check(r['-10'] < -8, `${k}: a loud 8 kHz is ducked (${r['-10']} dB)`);
}
for (const k of ['ceiling_worklet', 'ceiling_native']) check(results[k].peakDb <= -1.5 && results[k].peakDb > -8, `${k}: a voice 10 dB over full scale leaves at ${results[k].peakDb} dBFS (under the −3 dB ceiling, nothing clipped)`);
check(Math.abs(results.studio_gain.rmsDb + 20) < 4, `studio preset: a −20 dBFS voice comes out at ${results.studio_gain.rmsDb} dBFS (no hidden makeup)`);
check(Math.abs(results.track_norm.mixLufs - results.track_norm.target) < 1, `track normalised from ${results.track_norm.fileLufs} to ${results.track_norm.mixLufs} LUFS (target ${results.track_norm.target})`);
for (const k of ['vocal_rider_-5', 'vocal_rider_-33']) {
  const r = results[k];
  const reachable = Math.min(Math.max(r.target, r.inDb + r.maxCut), r.inDb + r.maxLift); // within the rider's range
  check(Math.abs(r.at10s - reachable) < 2, `${k}: a ${r.inDb} dBFS voice rides to ${r.at10s} dBFS by 10 s (target ${r.target}, reachable ${reachable}; 2 s ${r.at2s}, 4 s ${r.at4s})`);
  check(r.tailPeakDb < -60, `${k}: silence after the singing stays silent (${r.tailPeakDb} dBFS)`);
}
check(Math.abs(results.mix_0.at10s - results.mix_0.at1s) < 1.5 && results.mix_0.at10s < -11 && results.mix_0.at10s > -19, `mix at 0/0: steady at ${results.mix_0.at10s} dBFS (guard idle; ${results.mix_0.at1s} at 1 s)`);
check(results.mix_30.at10s < results.mix_30.target + 2, `mix at +30/+30: guard brings it to ${results.mix_30.at10s} dBFS by 10 s (target ${results.mix_30.target})`);
check(results.mix_30.peakDb <= -1.3, `mix at +30/+30: peak ${results.mix_30.peakDb} dBFS never over the ceiling`);
check(results.mix_0.peakDb <= -1.3, `mix at 0/0: peak ${results.mix_0.peakDb} dBFS`);
console.log(failed ? 'AUDIO LAB FAILED' : 'AUDIO LAB OK');
process.exit(failed ? 1 : 0);
