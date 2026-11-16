// What a listener hears, in numbers — used by the live e2e on the sound an audience device plays and
// on the publisher bus that goes out to the world:
//   - clicks: a seam between packets or a resampler losing its place is a step, and a step bursts
//     in the top of the spectrum (9–16 kHz), where the music puts nothing sudden — counted there
//     (for a clean signal); `steps` counts the loud, unmistakable ones in any signal;
//   - gaps: stretches of pure digital silence inside sound that is otherwise there (a stall);
//   - the song: where the capture matches the backing track (normalised cross-correlation, so the
//     answer is a correlation coefficient: 1 = the track itself), and the track position it implies.
// Pure functions over Float32Array PCM; `decodeToPcm` turns any file into mono float PCM with ffmpeg.
import { execFileSync } from 'node:child_process';

/** Mono float32 PCM of an audio file at `rate` Hz (ffmpeg). */
export function decodeToPcm(file, rate = 48000) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
}

/**
 * Clicks: a discontinuity — the end of one block against the start of the next, a resampler losing
 * its place — is a step, and a step is broadband: it bursts in the top of the spectrum, where music
 * (and a sweep below 8 kHz, and a voice's harmonics) put little and nothing sudden. The capture is
 * band-passed to `band` (a brick wall in the frequency domain), its envelope smoothed over half a
 * millisecond, and a click is an envelope peak at least `times` the median envelope of the
 * surrounding 100 ms (and at least `floor`). Peaks within 2 ms count as one click.
 */
export function clicks(x, rate = 48000, { band = [9000, 16000], floor = 0.004, times = 12 } = {}) {
  const n = x.length;
  const y = bandpass(x, rate, band[0], Math.min(band[1], rate / 2 - 100));
  // envelope: |y| smoothed over 0.5 ms
  const w = Math.max(2, Math.round(rate * 0.0005));
  const env = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += Math.abs(y[i]);
    if (i >= w) acc -= Math.abs(y[i - w]);
    env[i] = acc / w;
  }
  let maxJump = 0;
  for (let i = 1; i < n; i++) maxJump = Math.max(maxJump, Math.abs(x[i] - x[i - 1]));
  let sumD = 0;
  for (let i = 1; i < n; i++) sumD += (x[i] - x[i - 1]) * (x[i] - x[i - 1]);
  const rmsJump = Math.sqrt(sumD / Math.max(1, n - 1));
  // the local background: the median of the envelope over ±50 ms, sampled every 5 ms
  const half = Math.round(rate * 0.05);
  const step = Math.round(rate * 0.005);
  const at = [];
  let count = 0;
  let lastFlag = -1e9;
  const gapSamples = Math.round(rate * 0.002);
  let threshold = floor;
  let medianCache = { at: -1, v: 0 };
  const localMedian = (i) => {
    const c = Math.floor(i / step) * step;
    if (medianCache.at === c) return medianCache.v;
    const vals = [];
    for (let k = Math.max(0, c - half); k < Math.min(n, c + half); k += 8) vals.push(env[k]);
    vals.sort((p, q) => p - q);
    const v = vals[Math.floor(vals.length / 2)] ?? 0;
    medianCache = { at: c, v };
    return v;
  };
  for (let i = half; i < n - half; i++) {
    const thr = Math.max(floor, times * localMedian(i));
    if (i === half) threshold = thr;
    if (env[i] <= thr) continue;
    if (i - lastFlag > gapSamples) {
      count++;
      if (at.length < 20) at.push(i);
    }
    lastFlag = i;
  }
  return { count, maxJump, threshold, rmsJump, at };
}

/**
 * Loud steps: a jump of at least `floor` between two neighbouring samples with ordinary movement on
 * both sides of it — an unmistakable click, whatever else is in the sound (a coded voice, a codec's
 * own noise). The coarse check for a capture off a codec; `clicks` is the fine one for a clean signal.
 */
export function steps(x, { floor = 0.25 } = {}) {
  const n = x.length;
  let count = 0;
  const at = [];
  for (let i = 3; i < n - 2; i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d < floor) continue;
    const around = Math.max(Math.abs(x[i - 1] - x[i - 2]), Math.abs(x[i - 2] - x[i - 3]), Math.abs(x[i + 1] - x[i]), Math.abs(x[i + 2] - x[i + 1]));
    if (around < 0.3 * d) {
      count++;
      if (at.length < 20) at.push(i);
    }
  }
  return { count, at };
}

/** A brick-wall band-pass in the frequency domain (the signal padded to a power of two). */
export function bandpass(x, rate, lo, hi) {
  let n = 1;
  while (n < x.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  const a = Math.round((lo / rate) * n);
  const b = Math.round((hi / rate) * n);
  for (let i = 0; i < n; i++) {
    const k = i <= n / 2 ? i : n - i;
    if (k < a || k > b) {
      re[i] = 0;
      im[i] = 0;
    }
  }
  fft(re, im, true);
  return Float32Array.from(re.subarray(0, x.length));
}

/** Gaps: runs of digital silence of at least `minMs` inside the sound (after it starts, before it ends). */
export function gaps(x, rate, { minMs = 10, quiet = 1e-5 } = {}) {
  const min = Math.round((rate * minMs) / 1000);
  let first = -1;
  let last = -1;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > quiet) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { count: 0, longestMs: 0, silent: true };
  let count = 0;
  let longest = 0;
  let run = 0;
  for (let i = first; i <= last; i++) {
    if (Math.abs(x[i]) <= quiet) {
      run++;
      continue;
    }
    if (run >= min) {
      count++;
      if (run > longest) longest = run;
    }
    run = 0;
  }
  return { count, longestMs: Math.round((longest / rate) * 1000), silent: false };
}

export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

/** Average `factor` samples into one (a box filter: enough for correlation at a lower rate). */
export function decimate(x, factor) {
  const n = Math.floor(x.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += x[i * factor + j];
    out[i] = s / factor;
  }
  return out;
}

/** In-place iterative radix-2 FFT (re, im of length 2^k). */
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j];
        const ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br;
        im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br;
        im[i + j + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
}

/**
 * Where `capture` sits in `track` (both mono at `rate`): the best normalised cross-correlation over
 * every lag — a coefficient between -1 and 1 — and the track position (s) the capture starts at.
 * Works at `workRate` (decimated) so a minute of track correlates in well under a second.
 */
export function locate(capture, track, rate, { workRate = 16000, minOverlapS = 2, bandHz = [4000, 8000], window = null } = {}) {
  // only a stretch of the track (seconds), when the caller knows roughly where to look: far quicker on a long song
  let offsetS = 0;
  if (window) {
    const a = Math.max(0, Math.floor(window[0] * rate));
    const b = Math.min(track.length, Math.ceil(window[1] * rate));
    track = track.subarray(a, b);
    offsetS = a / rate;
  }
  const f = Math.max(1, Math.round(rate / workRate));
  const x0 = decimate(capture, f);
  const y0 = decimate(track, f);
  const wr = rate / f;
  const prep = (a) => {
    const out = new Float64Array(a.length);
    for (let i = 1; i < a.length; i++) out[i] = a[i] - a[i - 1]; // first difference: whitens the music a little
    return out;
  };
  const x = prep(x0);
  const y = prep(y0);
  let n = 1;
  while (n < x.length + y.length) n <<= 1;
  // Both signals band-limited in the frequency domain (the band where the track lives and a voice
  // mixed over it leaves it alone), then band-limited again on the way back: x and y both filtered.
  const band = (re, im) => {
    const lo = Math.round((bandHz[0] / wr) * n);
    const hi = Math.round((bandHz[1] / wr) * n);
    for (let i = 0; i < n; i++) {
      const k = i <= n / 2 ? i : n - i;
      if (k < lo || k > hi) {
        re[i] = 0;
        im[i] = 0;
      }
    }
  };
  const filtered = (src) => {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re.set(src);
    fft(re, im);
    band(re, im);
    const tr = Float64Array.from(re);
    const ti = Float64Array.from(im);
    fft(tr, ti, true);
    return { re, im, time: tr.subarray(0, src.length) };
  };
  const X = filtered(x);
  const Y = filtered(y);
  // correlation = IFFT(conj(X) · Y): c[k] = Σ x[i] y[i + k]
  const cr = new Float64Array(n);
  const ci = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cr[i] = X.re[i] * Y.re[i] + X.im[i] * Y.im[i];
    ci[i] = X.re[i] * Y.im[i] - X.im[i] * Y.re[i];
  }
  fft(cr, ci, true);
  // running energy of the filtered y over windows of x's length, for the normalisation
  const yt = Y.time;
  const cum = new Float64Array(yt.length + 1);
  for (let i = 0; i < yt.length; i++) cum[i + 1] = cum[i] + yt[i] * yt[i];
  let xx = 0;
  for (let i = 0; i < x.length; i++) xx += X.time[i] * X.time[i];
  const minOverlap = Math.round(minOverlapS * wr);
  let best = { r: 0, lag: 0 };
  for (let k = 0; k + minOverlap <= yt.length; k++) {
    const end = Math.min(yt.length, k + x.length);
    const yy = cum[end] - cum[k];
    if (yy <= 0 || xx <= 0) continue;
    const r = cr[k] / Math.sqrt(xx * yy);
    if (r > best.r) best = { r, lag: k };
  }
  return { r: best.r, positionS: offsetS + best.lag / wr };
}

/** Everything the e2e asks about a capture (`capture`, `track`: mono float PCM at `rate`). */
export function measure(capture, track, rate, { window = null } = {}) {
  return { rms: rms(capture), clicks: clicks(capture, rate), steps: steps(capture), gaps: gaps(capture, rate), song: locate(capture, track, rate, { window }) };
}
