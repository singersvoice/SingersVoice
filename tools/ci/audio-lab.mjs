// The audio lab: the real vocal chain and mix bus rendered offline in Chromium (OfflineAudioContext +
// the AudioWorklets), measured with synthetic signals — what a listener would hear, in numbers:
//   - the chain's parallel paths land together (no comb filter / echo in its impulse response);
//   - the de-esser never boosts a quiet top end (the browser compressor's hidden makeup is taken out)
//     and does duck a loud "s" (a 9 kHz tone, in its band);
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
    if (worklets) for (const m of ['dynamics.js', 'leveler.js', 'pitch-shifter.js', 'gate.js', 'ducker.js']) await ctx.audioWorklet.addModule('/worklets/' + m);
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
  /** White noise at `dbfs` RMS for `seconds`. */
  function noise(ctx, dbfs, seconds, from = 0) {
    const buf = ctx.createBuffer(1, Math.round(seconds * RATE), RATE);
    const d = buf.getChannelData(0);
    const a = Math.pow(10, dbfs / 20) * Math.sqrt(3); // uniform noise: RMS = peak / √3
    for (let i = 0; i < d.length; i++) d[i] = a * (Math.random() * 2 - 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.start(from);
    return src;
  }
  /** The fundamental of `d` between `from` and `to` (s), by autocorrelation over 50–1300 Hz: Hz, or 0 when nothing periodic. */
  function f0(d, from, to) {
    const a = Math.round(from * RATE);
    const n = Math.round((to - from) * RATE);
    const minLag = Math.floor(RATE / 1300);
    const maxLag = Math.ceil(RATE / 50);
    let best = 0;
    let bestVal = -1;
    let energy = 0;
    for (let i = 0; i < n; i++) energy += d[a + i] * d[a + i];
    if (energy / n < 1e-8) return 0;
    const vals = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acf = 0;
      let m = 0;
      for (let i = 0; i + lag < n; i++) {
        acf += d[a + i] * d[a + i + lag];
        m += d[a + i] * d[a + i] + d[a + i + lag] * d[a + i + lag];
      }
      vals[lag] = m > 0 ? (2 * acf) / m : 0;
    }
    let globalMax = 0;
    for (let lag = minLag; lag <= maxLag; lag++) if (vals[lag] > globalMax) globalMax = vals[lag];
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (vals[lag] > vals[lag - 1] && vals[lag] >= vals[lag + 1] && vals[lag] >= 0.8 * globalMax) {
        best = lag;
        bestVal = vals[lag];
        break;
      }
    }
    if (!best || bestVal < 0.5) return 0;
    const y0 = vals[best - 1];
    const y1 = vals[best];
    const y2 = vals[best + 1];
    const den = y0 - 2 * y1 + y2;
    return RATE / (best + (den !== 0 ? (0.5 * (y0 - y2)) / den : 0));
  }
  /** The ripple of the level (dB, max − min of 10 ms RMS windows) between `from` and `to`: the flutter a grain shifter leaves on a steady tone. */
  function ripple(d, from, to) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = from; t + 0.01 <= to; t += 0.01) {
      const v = rmsDb(d, t, t + 0.01);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  }
  const pitchOnly = (extra) => ({ ...L.VOXFORGE_DEFAULTS, gtOn: false, eqOn: false, compOn: false, pcOn: false, dsOn: false, exOn: false, satOn: false, chOn: false, dlOn: false, rvOn: false, rdOn: false, ...extra });

  // 0. The noise gate: the room between phrases turned down, the voice itself untouched and let through at once.
  {
    const r = {};
    for (const gate of [false, true]) {
      const ctx = await offline(6, 1, true);
      const chain = L.createVoxForgeChain(ctx, true);
      chain.apply({ ...L.presetParams('studio'), gtOn: gate, rvOn: false, rdOn: false });
      noise(ctx, -52, 6).connect(chain.input); // the room: a phone's hiss, all along
      voice(ctx, -20, 2).connect(chain.input); // a phrase…
      voice(ctx, -20, 2, 4).connect(chain.input); // …a break of two seconds, a phrase
      chain.output.connect(ctx.destination);
      const d = (await ctx.startRendering()).getChannelData(0);
      r[gate ? 'on' : 'off'] = { room: +rmsDb(d, 2.6, 3.9).toFixed(1), voice: +rmsDb(d, 4.5, 5.9).toFixed(1), onset: +rmsDb(d, 4.0, 4.03).toFixed(1), tail: +rmsDb(d, 2.0, 2.1).toFixed(1) };
    }
    out.gate = r;
  }

  // 0b. The pitch stage: a shift lands on pitch with hardly a ripple (one head, pitch-synchronous splices); auto-tune pulls a flat tone to its note; the delay is told.
  {
    const r = {};
    for (const [name, params, hz] of [
      ['up1', pitchOnly({ pitchSt: 1 }), 200],
      ['down1', pitchOnly({ pitchSt: -1 }), 200],
      ['up12', pitchOnly({ octave: 1 }), 150],
      ['tune', pitchOnly({ autoStr: 1, autoSpeed: 1 }), 190], // 190 Hz: 46 cents over F#3 (185.0) — the note is F#3
      ['tuneSoft', pitchOnly({ autoStr: 0.6, autoSpeed: 0.3 }), 190],
    ]) {
      const ctx = await offline(3, 1, true);
      const chain = L.createVoxForgeChain(ctx, true);
      chain.apply(params);
      // A harmonic tone (a voice without vibrato: the pitch and the ripple read cleanly).
      const buf = ctx.createBuffer(1, 3 * RATE, RATE);
      const d0 = buf.getChannelData(0);
      for (let i = 0; i < d0.length; i++) {
        let v = 0;
        for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * hz * h * i) / RATE) / h;
        d0[i] = v * 0.12;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(chain.input);
      src.start(0);
      chain.output.connect(ctx.destination);
      const d = (await ctx.startRendering()).getChannelData(0);
      await new Promise((res) => setTimeout(res, 50)); // the worklet's last messages land
      r[name] = { inHz: hz, outHz: +f0(d, 1.5, 2.9).toFixed(2), rippleDb: +ripple(d, 1.5, 2.9).toFixed(2), levelDb: +rmsDb(d, 1.5, 2.9).toFixed(1), inLevelDb: +rmsDb(d0, 1.5, 2.9).toFixed(1), delayMs: chain.pitchDelayMs };
    }
    out.pitch = r;
  }

  // 1. Impulse response of the chain with every parallel stage on: one arrival, no echo.
  for (const worklets of [true, false]) {
    const ctx = await offline(1, 1, worklets);
    const chain = L.createVoxForgeChain(ctx, worklets);
    chain.apply({ ...L.presetParams('studio'), gtOn: false, pcOn: true, pcMx: 1, dsOn: true, dsAmt: 0.6, exOn: true, exAmt: 1, satOn: true, satMx: 1, rvOn: false, dlOn: false, chOn: false, rdOn: false });
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
      tone(ctx, 9000, level, 2).connect(chain.input);
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

  // 3c. Every factory preset at one level: a voice at −12 dBFS peaks (where the leveller holds a singer) comes out of each
  // preset within a few dB of the others — the makeup gives back what the compressor takes — so switching presets changes
  // the character, never the loudness (the rider in the mix and the singer's ears both start from the same place).
  {
    const presets = {};
    for (const id of L.VOXFORGE_PRESET_IDS) {
      const ctx = await offline(3, 1, true);
      const chain = L.createVoxForgeChain(ctx, true);
      chain.apply({ ...L.presetParams(id), rdOn: false, rvOn: false, dlOn: false });
      voice(ctx, -15, 3).connect(chain.input);
      chain.output.connect(ctx.destination);
      const d = (await ctx.startRendering()).getChannelData(0);
      presets[id] = +rmsDb(d, 1.5, 3).toFixed(1);
    }
    out.presets = presets;
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
    out[`mix_${push}`] = { at1s: +rmsDb(d, 0.5, 1).toFixed(1), at5s: +rmsDb(d, 4.5, 5.5).toFixed(1), at10s: +rmsDb(d, 9, 10).toFixed(1), peakDb: +db(peakOf(d)).toFixed(2), target: L.MIX_TARGETS.mixDb, ceiling: -1.5 };
  }
  // 6. The finished mix, every preset, on a song like the ones people sing to — a mastered backing track whose low end
  // carries most of its energy (bass and kick ten dB over the mids, hats on top), normalised to the track target — with a
  // −15 dBFS voice through the preset's chain sung in phrases: how loud the whole lands, how far the voice stands over the
  // track (vocal-only and track-only renders of the same bus: the riders see the same input either way), whether the
  // chain leaves the voice mid-forward (its 1–5 kHz against its 100–400 Hz, more than the raw voice's), and that nothing
  // clips. The user's own recording (22 Nov) had the mix pinned at −15.5 dBFS RMS whatever was sung, the lows 10 dB over
  // the voice's band, and the voice adding 8 dB to the mids and nothing to the whole: these are the numbers that must move.
  {
    /** A mastered, bass-heavy backing track: 120 BPM, a pulsing bass on 55/110 Hz, a kick each beat, a chord pad, hats. */
    function song(ctx, seconds) {
      const n = Math.round(seconds * RATE);
      const buf = ctx.createBuffer(2, n, RATE);
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      let seed = 7;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
      let hp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const beat = (t * 2) % 1; // 120 BPM
        const half = (t * 4) % 1;
        const bassEnv = 0.6 + 0.4 * Math.exp(-beat * 6);
        const bass = (Math.sin(2 * Math.PI * 55 * t) + 0.6 * Math.sin(2 * Math.PI * 110 * t)) * bassEnv * 0.42;
        const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 30)) * t) * Math.exp(-beat * 18) * 0.5;
        const pad = (Math.sin(2 * Math.PI * 330 * t) + Math.sin(2 * Math.PI * 440 * t + 1) + Math.sin(2 * Math.PI * 554 * t + 2) + 0.5 * Math.sin(2 * Math.PI * 1320 * t)) * 0.06;
        const white = rnd();
        hp += (white - hp) * 0.6; // a bright hiss for the hats
        const hat = (white - hp) * Math.exp(-half * 40) * 0.12;
        const m = bass + kick + pad;
        L[i] = Math.tanh((m + hat + 0.02 * Math.sin(2 * Math.PI * 660 * t)) * 1.4) * 0.9;
        R[i] = Math.tanh((m + 0.8 * hat + 0.02 * Math.sin(2 * Math.PI * 880 * t + 1)) * 1.4) * 0.9;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.start(0);
      return src;
    }
    /** The voice in phrases: sung 1–5 s and 6–11 s of a 12 s render (the breaks are what a rider must not lift). */
    function phrased(ctx, dbfs) {
      const a = voice(ctx, dbfs, 4, 1);
      const b = voice(ctx, dbfs, 5, 6);
      const sum = ctx.createGain();
      a.connect(sum);
      b.connect(sum);
      return sum;
    }
    const bandDb = (d, lo, hi, from, to) => {
      // Energy of d in [lo, hi) Hz over [from, to) s: a Goertzel sweep is too slow — an FFT of 32768 points, averaged over hops.
      const N = 32768;
      const a = Math.round(from * RATE);
      const b = Math.round(to * RATE) - N;
      let e = 0;
      let hops = 0;
      for (let start = a; start < b; start += N) {
        const re = new Float64Array(N);
        const im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = d[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
        // in-place radix-2 FFT
        for (let i = 1, j = 0; i < N; i++) {
          let bit = N >> 1;
          for (; j & bit; bit >>= 1) j ^= bit;
          j ^= bit;
          if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
          }
        }
        for (let len = 2; len <= N; len <<= 1) {
          const ang = (-2 * Math.PI) / len;
          const wr = Math.cos(ang);
          const wi = Math.sin(ang);
          for (let i = 0; i < N; i += len) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < len / 2; k++) {
              const ur = re[i + k];
              const ui = im[i + k];
              const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
              const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
              re[i + k] = ur + vr;
              im[i + k] = ui + vi;
              re[i + k + len / 2] = ur - vr;
              im[i + k + len / 2] = ui - vi;
              const nr = cr * wr - ci * wi;
              ci = cr * wi + ci * wr;
              cr = nr;
            }
          }
        }
        const k0 = Math.floor((lo * N) / RATE);
        const k1 = Math.ceil((hi * N) / RATE);
        for (let k = k0; k < k1; k++) e += re[k] * re[k] + im[k] * im[k];
        hops++;
      }
      return 10 * Math.log10(e / Math.max(1, hops) / N + 1e-12);
    };
    const SECONDS = 12;
    const trackLufs = (() => {
      const ctx = new OfflineAudioContext(2, 48000, RATE);
      const s = song(ctx, SECONDS);
      return L.measureLoudness([s.buffer.getChannelData(0), s.buffer.getChannelData(1)], RATE).lufs;
    })();
    /** The bus rendered: channels 0–1 its output, 2–3 its sum before the guard and the safety stage (what the limiter is given). */
    async function render(presetId, what) {
      const ctx = new OfflineAudioContext(4, Math.round(SECONDS * RATE), RATE);
      for (const m of ['dynamics.js', 'leveler.js', 'pitch-shifter.js', 'gate.js', 'ducker.js']) await ctx.audioWorklet.addModule('/worklets/' + m);
      const bus = new L.MixBus(ctx, true);
      bus.setBackingNormalization(L.normalizationDb(trackLufs, L.MIX_TARGETS.trackLufs));
      if (what !== 'vocal') song(ctx, SECONDS).connect(bus.backingIn);
      if (what !== 'track') {
        const chain = L.createVoxForgeChain(ctx, true);
        chain.apply(L.presetParams(presetId));
        phrased(ctx, -15).connect(chain.input);
        bus.addVocal('v', chain.output);
      }
      const merger = ctx.createChannelMerger(4);
      const outSplit = ctx.createChannelSplitter(2);
      const sumSplit = ctx.createChannelSplitter(2);
      bus.output.connect(outSplit);
      bus.sum.connect(sumSplit);
      outSplit.connect(merger, 0, 0);
      outSplit.connect(merger, 1, 1);
      sumSplit.connect(merger, 0, 2);
      sumSplit.connect(merger, 1, 3);
      merger.connect(ctx.destination);
      const r = await ctx.startRendering();
      return [r.getChannelData(0), r.getChannelData(1), r.getChannelData(2), r.getChannelData(3)];
    }
    const lufsOf = (ch, from, to) => L.measureLoudness([ch[0].subarray(Math.round(from * RATE), Math.round(to * RATE)), ch[1].subarray(Math.round(from * RATE), Math.round(to * RATE))], RATE).lufs;
    // The raw voice's own balance (its 1–5 kHz against its 100–400 Hz), the reference for "mid-forward".
    const rawVoice = (() => {
      const ctx = new OfflineAudioContext(1, 48000, RATE);
      const v = voice(ctx, -15, 4);
      const d = v.buffer.getChannelData(0);
      return +(bandDb(d, 1000, 5000, 0.2, 3.8) - bandDb(d, 100, 400, 0.2, 3.8)).toFixed(1);
    })();
    const track = await render('natural', 'track');
    const mixes = { trackLufs: +lufsOf(track, 2, 11).toFixed(1), trackRmsDb: +rmsDb(track[0], 2, 11).toFixed(1), trackTarget: L.MIX_TARGETS.trackLufs, rawVoiceBalanceDb: rawVoice, presets: {} };
    for (const id of L.VOXFORGE_PRESET_IDS) {
      const mix = await render(id, 'mix');
      const vocal = await render(id, 'vocal');
      const sung = lufsOf(mix, 6, 11);
      const quiet = lufsOf(mix, 11.3, 12); // after the last phrase: the track alone (with whatever the guard did)
      const vocalLufs = lufsOf(vocal, 6, 11);
      const balance = bandDb(vocal[0], 1000, 5000, 6.5, 10.5) - bandDb(vocal[0], 100, 400, 6.5, 10.5);
      const sumSung = L.measureLoudness([mix[2].subarray(6 * RATE, 11 * RATE), mix[3].subarray(6 * RATE, 11 * RATE)], RATE).lufs;
      mixes.presets[id] = {
        mixLufs: +lufsOf(mix, 1, 11).toFixed(1),
        sungLufs: +sung.toFixed(1),
        betweenLufs: +quiet.toFixed(1),
        vocalLufs: +vocalLufs.toFixed(1),
        prominenceLu: +(vocalLufs - mixes.trackLufs).toFixed(1),
        voiceBalanceDb: +balance.toFixed(1),
        midForwardDb: +(balance - rawVoice).toFixed(1),
        peakDb: +db(Math.max(peakOf(mix[0]), peakOf(mix[1]))).toFixed(2),
        /** What the guard and the limiter took off the sung part on average (LU), and the sum's own peak (dBFS) they were given. */
        limitedLu: +(sumSung - sung).toFixed(1),
        sumPeakDb: +db(Math.max(peakOf(mix[2], 6, 11), peakOf(mix[3], 6, 11))).toFixed(1),
      };
    }
    out.finished = mixes;
    // The duck itself: the music's own path (bus.backingOut, after the duck and the Track offset) rendered beside the output,
    // with and without a voice in the bus — how far the music steps back while a phrase is sung, and whether it is back a
    // moment after it (the same windows of the same song either way, so only the duck differs).
    {
      const run = async (keyed) => {
        const ctx = new OfflineAudioContext(4, Math.round(SECONDS * RATE), RATE);
        for (const m of ['dynamics.js', 'leveler.js', 'pitch-shifter.js', 'gate.js', 'ducker.js']) await ctx.audioWorklet.addModule('/worklets/' + m);
        const bus = new L.MixBus(ctx, true);
        bus.setBackingNormalization(L.normalizationDb(trackLufs, L.MIX_TARGETS.trackLufs));
        song(ctx, SECONDS).connect(bus.backingIn);
        if (keyed) {
          const chain = L.createVoxForgeChain(ctx, true);
          chain.apply(L.presetParams('studio'));
          phrased(ctx, -15).connect(chain.input);
          bus.addVocal('v', chain.output);
        }
        const merger = ctx.createChannelMerger(4);
        const outSplit = ctx.createChannelSplitter(2);
        const trackSplit = ctx.createChannelSplitter(2);
        bus.output.connect(outSplit);
        bus.backingOut.connect(trackSplit);
        outSplit.connect(merger, 0, 0);
        outSplit.connect(merger, 1, 1);
        trackSplit.connect(merger, 0, 2);
        trackSplit.connect(merger, 1, 3);
        merger.connect(ctx.destination);
        const r = await ctx.startRendering();
        return [r.getChannelData(2), r.getChannelData(3)];
      };
      const plain = await run(false);
      const keyed = await run(true);
      out.duck = { depthDb: L.MIX_TARGETS.duckDb, whileSungDb: +(lufsOf(keyed, 7, 10.5) - lufsOf(plain, 7, 10.5)).toFixed(2), afterDb: +(lufsOf(keyed, 11.6, 12) - lufsOf(plain, 11.6, 12)).toFixed(2) };
    }
    // PERFORMER MODE against PUBLISH MODE: the same voice (the studio preset) through the monitor's rider and through the
    // publish rider, each alone — what the singer hears of themselves, and what the recording gets, before the Track /
    // Vocal controls and the ears' own offset.
    {
      const ride = async (cfg) => {
        const ctx = await offline(SECONDS, 1, true);
        const chain = L.createVoxForgeChain(ctx, true);
        chain.apply(L.presetParams('studio'));
        phrased(ctx, -15).connect(chain.input);
        const node = L.leveler(ctx, cfg);
        chain.output.connect(node).connect(ctx.destination);
        const r = await ctx.startRendering();
        const d = r.getChannelData(0);
        return L.measureLoudness([d.subarray(6 * RATE, 11 * RATE), d.subarray(6 * RATE, 11 * RATE)], RATE).lufs - 3; // (a mono voice counted on two channels: 3 dB back)
      };
      out.ears = { earsLufs: +(await ride(L.MONITOR_RIDER)).toFixed(1), earsTarget: L.PERFORMER_MONITOR.vocalDb, publishLufs: +(await ride(L.VOCAL_RIDER)).toFixed(1), publishTarget: L.PUBLISH_MIX.vocalDb };
    }
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
{
  const g = results.gate;
  check(g.off.room - g.on.room >= 10, `noise gate: the room between phrases ${g.off.room} → ${g.on.room} dBFS (${(g.off.room - g.on.room).toFixed(1)} dB down)`);
  check(Math.abs(g.on.voice - g.off.voice) < 0.5, `noise gate: the sung phrase untouched (${g.on.voice} vs ${g.off.voice} dBFS)`);
  check(Math.abs(g.on.onset - g.off.onset) < 3, `noise gate: the phrase's first 30 ms through at once (${g.on.onset} vs ${g.off.onset} dBFS)`);
  const P = results.pitch;
  const cents = (a, b) => 1200 * Math.log2(a / b);
  check(Math.abs(cents(P.up1.outHz, P.up1.inHz * Math.pow(2, 1 / 12))) < 8, `pitch +1 st: ${P.up1.inHz} → ${P.up1.outHz} Hz (${cents(P.up1.outHz, P.up1.inHz * Math.pow(2, 1 / 12)).toFixed(1)} cents off)`);
  check(Math.abs(cents(P.down1.outHz, P.down1.inHz * Math.pow(2, -1 / 12))) < 8, `pitch −1 st: ${P.down1.inHz} → ${P.down1.outHz} Hz`);
  check(Math.abs(cents(P.up12.outHz, P.up12.inHz * 2)) < 15, `pitch +12 st: ${P.up12.inHz} → ${P.up12.outHz} Hz`);
  check(P.up1.rippleDb < 2 && P.down1.rippleDb < 2, `pitch ±1 st: a steady tone comes out steady (ripple ${P.up1.rippleDb} / ${P.down1.rippleDb} dB)`);
  check(Math.abs(P.up1.levelDb - P.up1.inLevelDb) < 1.5, `pitch +1 st: the level kept (${P.up1.levelDb} vs ${P.up1.inLevelDb} dBFS)`);
  check(Math.abs(cents(P.tune.outHz, 184.997)) < 8, `auto-tune (full, fast): 190 Hz pulled to F#3 — ${P.tune.outHz} Hz (${cents(P.tune.outHz, 184.997).toFixed(1)} cents off the note)`);
  check(Math.abs(cents(P.tuneSoft.outHz, 190 * Math.pow(184.997 / 190, 0.6))) < 8, `auto-tune (0.6, slow): 190 Hz pulled 60 % of the way — ${P.tuneSoft.outHz} Hz`);
  check(P.tune.delayMs > 6 && P.tune.delayMs < 22 && P.up1.delayMs > 6 && P.up1.delayMs < 22, `pitch stage: holds the voice ${P.up1.delayMs} / ${P.tune.delayMs} ms and says so`);
}
for (const k of ['ir_worklet', 'ir_native']) {
  const r = results[k];
  check(r.echoDb < -18, `${k}: parallel paths aligned (secondary arrival ${r.echoDb} dB under the main one)`);
  check(Math.abs(r.latencyMs - r.reportedMs) < 0.3, `${k}: chain latency ${r.latencyMs} ms as reported (${r.reportedMs} ms)`);
}
check(results.ir_worklet.latencyMs < 12, `worklet chain latency ${results.ir_worklet.latencyMs} ms < 12 ms`);
for (const k of ['deesser_worklet', 'deesser_native']) {
  const r = results[k];
  check(Math.abs(r['-40']) < 1, `${k}: a quiet 9 kHz passes at unity (${r['-40']} dB)`);
  check(r['-10'] < -5, `${k}: a loud 9 kHz is ducked (${r['-10']} dB)`);
}
for (const k of ['ceiling_worklet', 'ceiling_native']) check(results[k].peakDb <= -1.5 && results[k].peakDb > -8, `${k}: a voice 10 dB over full scale leaves at ${results[k].peakDb} dBFS (under the −3 dB ceiling, nothing clipped)`);
check(Math.abs(results.studio_gain.rmsDb + 20) < 4, `studio preset: a −20 dBFS voice comes out at ${results.studio_gain.rmsDb} dBFS (no hidden makeup)`);
{
  const levels = Object.values(results.presets);
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  console.log('presets at one level (dBFS RMS of a −15 dBFS voice):', JSON.stringify(results.presets));
  check(hi - lo <= 5, `every factory preset comes out within 5 dB of the others (${lo} … ${hi} dBFS: a spread of ${(hi - lo).toFixed(1)} dB)`);
  for (const [id, v] of Object.entries(results.presets)) check(Math.abs(v + 15) <= 5, `${id}: a −15 dBFS voice comes out at ${v} dBFS (within 5 dB of where it went in)`);
}
check(Math.abs(results.track_norm.mixLufs - results.track_norm.target) < 1, `track normalised from ${results.track_norm.fileLufs} to ${results.track_norm.mixLufs} LUFS (target ${results.track_norm.target})`);
for (const k of ['vocal_rider_-5', 'vocal_rider_-33']) {
  const r = results[k];
  const reachable = Math.min(Math.max(r.target, r.inDb + r.maxCut), r.inDb + r.maxLift); // within the rider's range
  // (a quiet voice is also held by the floor rule — the rider keeps a voice's own quietest moments 12 dB under the target — so a −33 dBFS voice lands a little short)
  check(Math.abs(r.at10s - reachable) < (r.inDb < -30 ? 3 : 2), `${k}: a ${r.inDb} dBFS voice rides to ${r.at10s} dBFS by 10 s (target ${r.target}, reachable ${reachable}; 2 s ${r.at2s}, 4 s ${r.at4s})`);
  check(r.tailPeakDb < -60, `${k}: silence after the singing stays silent (${r.tailPeakDb} dBFS)`);
}
check(Math.abs(results.mix_0.at10s - results.mix_0.at5s) < 1.5 && results.mix_0.at10s < -8 && results.mix_0.at10s > -16, `mix at 0/0: steady at ${results.mix_0.at10s} dBFS once the vocal rider has settled (guard idle; ${results.mix_0.at1s} at 1 s, ${results.mix_0.at5s} at 5 s)`);
check(results.mix_30.at10s < results.mix_30.target + 2, `mix at +30/+30: guard brings it to ${results.mix_30.at10s} dBFS by 10 s (target ${results.mix_30.target} K-weighted)`);
check(results.mix_30.peakDb <= -1.3, `mix at +30/+30: peak ${results.mix_30.peakDb} dBFS never over the ceiling`);
check(results.mix_0.peakDb <= -1.3, `mix at 0/0: peak ${results.mix_0.peakDb} dBFS`);
// 6. The finished mix on a bass-heavy song, every preset: the voice in front, the whole at a record's loudness, nothing clipped.
{
  const f = results.finished;
  console.log(`the finished mix (every preset on a bass-heavy song): track ${f.trackLufs} LUFS (${f.trackRmsDb} dBFS RMS)`, JSON.stringify(f.presets));
  check(Math.abs(f.trackLufs - f.trackTarget) <= 1, `the music in the mix at its target: ${f.trackLufs} LUFS (target ${f.trackTarget}; a bass-heavy track reads ${f.trackRmsDb} dBFS RMS — the old guard's measure)`);
  for (const [id, v] of Object.entries(f.presets)) {
    const octave = id === 'octave-down';
    check(v.prominenceLu >= (octave ? 3 : 5) && v.prominenceLu <= 10, `${id}: PUBLISH MODE — the voice stands ${v.prominenceLu} LU over the music (${v.vocalLufs} against ${f.trackLufs} LUFS; and the music steps back ${results.duck?.depthDb ?? 3} dB more under it)`);
    check(v.sungLufs >= (octave ? -13.5 : -12) && v.sungLufs <= -7.5, `${id}: a sung phrase lands at ${v.sungLufs} LUFS (the whole ${v.mixLufs}, the break after it ${v.betweenLufs}: a record's loudness, the voice in front)`);
    check(v.peakDb <= -1.3, `${id}: the mix peaks at ${v.peakDb} dBFS — under the ceiling, nothing clipped (the limiter took ${v.limitedLu} LU off the sung part on average, from a sum peaking at ${v.sumPeakDb} dBFS)`);
    check(v.limitedLu <= 2.5, `${id}: the limiter works lightly (${v.limitedLu} LU on average while sung: density, not distortion)`);
    if (!octave) check(v.midForwardDb >= 1, `${id}: the chain leaves the voice mid-forward — its 1–5 kHz against its 100–400 Hz ${v.midForwardDb} dB more than the raw voice's (${v.voiceBalanceDb} against ${f.rawVoiceBalanceDb} dB)`);
  }
  const d = results.duck;
  check(d.whileSungDb <= -(d.depthDb - 0.5) && d.afterDb >= -0.7, `the duck: the music steps back ${d.whileSungDb} dB under a sung phrase (depth ${d.depthDb}) and is back within a second after it (${d.afterDb} dB)`);
  // 7. PERFORMER MODE: the same voice through the monitor's rider lands half as loud as PUBLISH MODE's.
  const e = results.ears;
  check(Math.abs(e.earsLufs - e.earsTarget) < 1.5, `PERFORMER MODE — the voice in the singer's ears at ${e.earsLufs} LUFS (target ${e.earsTarget} K-weighted)`);
  check(Math.abs(e.publishLufs - e.earsLufs - 6) < 1.5, `…half as loud as in the recording: ${(e.publishLufs - e.earsLufs).toFixed(1)} dB under PUBLISH MODE's ${e.publishLufs} LUFS (6 wanted)`);
}
console.log(failed ? 'AUDIO LAB FAILED' : 'AUDIO LAB OK');
process.exit(failed ? 1 : 0);
