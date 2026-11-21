/**
 * Putting the voice on the beat it was sung to.
 *
 * A singer hears the track late (the speakers' or headphones' delay), sings to what they hear, and
 * their voice reaches the recording later still (the microphone's delay, the chain) — so a recording
 * holds the track back by that round trip (AudioEngine.roundTripMs). The browser's figures for the
 * device's part are often wrong by a lot — Bluetooth adds 100–250 ms it never reports, many phones
 * 40–80 ms — and then the voice lands late in every saved performance. Two ways to the truth:
 *
 *   · `syncCheck`: a few clicks out of the speakers, the microphone recorded meanwhile, the clicks
 *     found in it: the time from a click sent to the click heard IS the device's round trip (Settings →
 *     Audio → Check the sync). With headphones on, the microphone hears nothing — which also means the
 *     device's delay is small and the browser's figure is good enough.
 *   · `bleedOffset`: after a take, the recorded voice is laid against the track at the alignment the
 *     figures gave and the two are cross-correlated by their envelopes: what the microphone heard of the
 *     track (through the speakers) — and the singer's own phrasing, sung to the beat they heard — peaks
 *     at the true lag. A clear peak corrects the take and is remembered for this device and microphone.
 */

/** The envelopes are read at this rate (Hz): a sample every 2.5 ms, finer than any lag that matters. */
const ENV_RATE = 400;

/** The (log) envelope of a mono signal, `ENV_RATE` samples a second: rectified, smoothed (~20 ms), compressed, mean removed. */
export function envelope(x: Float32Array, rate: number, maxSeconds = 45): Float32Array {
  const hop = rate / ENV_RATE;
  const n = Math.min(Math.floor(x.length / hop), Math.floor(maxSeconds * ENV_RATE));
  const out = new Float32Array(n);
  const a = Math.exp(-1 / (0.02 * rate)); // ~20 ms smoothing
  let env = 0;
  let pos = 0;
  let next = hop;
  let k = 0;
  const end = Math.floor(n * hop);
  for (let i = 0; i < end && k < n; i++) {
    const v = Math.abs(x[i]!);
    env = v + a * (env - v);
    pos++;
    if (pos >= next) {
      out[k++] = Math.log1p(env * 200); // the quiet matters as much as the loud: a log view
      next += hop;
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i]!;
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i++) out[i]! -= mean;
  return out;
}

export interface LagResult {
  /** How far `b` lags `a` (ms; positive: b comes later). */
  lagMs: number;
  /** The normalized correlation at the peak (0..1). */
  peak: number;
  /** The peak against the correlation's mean size away from it (beyond 25 ms): a peak standing out of the ridge is a measurement; a flat ridge is not. */
  prominence: number;
}

/**
 * The lag of envelope `b` behind envelope `a` (both at ENV_RATE) within ±`searchMs`, by normalized
 * cross-correlation. `offsetSamples`: b's sample 0 lies this many samples into a (the nominal alignment).
 */
export function envelopeLag(a: Float32Array, b: Float32Array, offsetSamples: number, searchMs = 600): LagResult {
  const maxLag = Math.round((searchMs / 1000) * ENV_RATE);
  let best = 0;
  let bestVal = -Infinity;
  const vals = new Float32Array(2 * maxLag + 1);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    // b[j] against a[offset + j − lag]: b lagging by `lag` matches a that much earlier
    let dot = 0;
    let na = 0;
    let nb = 0;
    const j0 = Math.max(0, -(offsetSamples - lag));
    const j1 = Math.min(b.length, a.length - offsetSamples + lag);
    if (j1 - j0 < ENV_RATE * 2) {
      vals[lag + maxLag] = 0;
      continue;
    }
    for (let j = j0; j < j1; j++) {
      const va = a[offsetSamples + j - lag]!;
      const vb = b[j]!;
      dot += va * vb;
      na += va * va;
      nb += vb * vb;
    }
    const c = na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
    vals[lag + maxLag] = c;
    if (c > bestVal) {
      bestVal = c;
      best = lag;
    }
  }
  const apart = Math.round((25 / 1000) * ENV_RATE);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < vals.length; i++) {
    if (Math.abs(i - (best + maxLag)) <= apart) continue;
    sum += Math.abs(vals[i]!);
    n++;
  }
  const others = n ? sum / n : 0;
  const prominence = others > 1e-6 ? bestVal / others : bestVal > 0 ? 10 : 0;
  return { lagMs: (best / ENV_RATE) * 1000, peak: Math.max(0, bestVal), prominence };
}

/** A lag worth acting on: a clear peak standing well out of the rest. */
export const lagIsClear = (r: LagResult): boolean => r.peak >= 0.3 && r.prominence >= 2;
/** A lag worth remembering for the device: a strong one. */
export const lagIsStrong = (r: LagResult): boolean => r.peak >= 0.5 && r.prominence >= 2.5;

/**
 * After a take: how far the recorded voice lags the track beyond the alignment the figures gave.
 * `vocal` (mono, `vocalRate`) is laid on the track with its sample 0 at `alignMs` on the track's
 * timeline (the take's `vocalOffsetMs − latencyCompMs`); the lag found is what `latencyCompMs` was
 * short by (positive: the voice lands late and should be pulled earlier). Null when nothing clear
 * was heard — headphones, a short take, a voice with nothing to go by.
 */
export function bleedOffset(vocal: Float32Array, vocalRate: number, track: Float32Array, trackRate: number, alignMs: number): { shiftMs: number; result: LagResult } | null {
  if (vocal.length < vocalRate * 8 || track.length < trackRate * 8) return null;
  const skipMs = Math.max(0, -alignMs);
  const vocalEnv = envelope(skipMs > 0 ? vocal.subarray(Math.round((skipMs / 1000) * vocalRate)) : vocal, vocalRate);
  const trackEnv = envelope(track, trackRate, 50);
  const offsetSamples = Math.round(((alignMs + skipMs) / 1000) * ENV_RATE);
  const r = envelopeLag(trackEnv, vocalEnv, offsetSamples);
  if (!lagIsClear(r) || Math.abs(r.lagMs) > 500) return null;
  return { shiftMs: Math.round(r.lagMs), result: r };
}

/** Where a 1 kHz click sounds in a recording: the magnitude at 1 kHz over time, sampled at ENV_RATE. */
export function toneEnvelope(x: Float32Array, rate: number, hz = 1000): Float32Array {
  const hop = rate / ENV_RATE;
  const n = Math.floor(x.length / hop);
  const out = new Float32Array(n);
  const a = Math.exp(-1 / (0.003 * rate)); // 3 ms: the click's own length
  let re = 0;
  let im = 0;
  let next = hop;
  let k = 0;
  const w = (2 * Math.PI * hz) / rate;
  for (let i = 0; i < x.length && k < n; i++) {
    const v = x[i]!;
    re = v * Math.cos(w * i) + a * (re - v * Math.cos(w * i));
    im = v * Math.sin(w * i) + a * (im - v * Math.sin(w * i));
    if (i + 1 >= next) {
      out[k++] = Math.sqrt(re * re + im * im);
      next += hop;
    }
  }
  return out;
}

/**
 * The clicks of a sync check as heard: for each click sent at `sentMs[k]` (on the recording's clock),
 * when it was heard — the first moment within 900 ms after it that stands 12 dB above the quiet before
 * it — and the device's round trip: the median of the lags, when at least three agree within 15 ms.
 */
export function clicksHeard(recording: Float32Array, rate: number, sentMs: number[]): { roundTripMs: number; lags: number[] } | null {
  const env = toneEnvelope(recording, rate);
  const lags: number[] = [];
  for (const sent of sentMs) {
    const from = Math.round((sent / 1000) * ENV_RATE);
    const to = Math.min(env.length, from + Math.round(0.9 * ENV_RATE));
    if (from < 0 || to - from < 10) continue;
    // The quiet: the median magnitude over the 120 ms before the click left.
    const q0 = Math.max(0, from - Math.round(0.12 * ENV_RATE));
    const quiet = [...env.subarray(q0, Math.max(q0 + 1, from))].sort((x, y) => x - y);
    const floor = Math.max(1e-6, quiet[Math.floor(quiet.length / 2)]!);
    let at = -1;
    let wasQuiet = env[from]! <= floor * 2; // (an earlier click still ringing at the start is not this one: a rise is needed)
    for (let i = from; i < to; i++) {
      const v = env[i]!;
      if (v <= floor * 2) wasQuiet = true;
      else if (wasQuiet && v > floor * 4) {
        // 12 dB above the quiet, out of quiet: the click. Its onset is a sample or two earlier; take the rise's start.
        at = i;
        while (at > from && env[at - 1]! > floor * 2) at--;
        break;
      }
    }
    if (at >= 0) lags.push(((at - from) / ENV_RATE) * 1000);
  }
  if (lags.length < 3) return null;
  const sorted = [...lags].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const agree = sorted.filter((l) => Math.abs(l - median) <= 15);
  if (agree.length < 3) return null;
  return { roundTripMs: Math.round(agree.reduce((s, v) => s + v, 0) / agree.length), lags: lags.map((l) => Math.round(l)) };
}

/** The first `seconds` of an AudioBuffer as one channel (the channels averaged). */
export function monoOf(buffer: AudioBuffer, seconds: number): Float32Array {
  const n = Math.min(buffer.length, Math.floor(seconds * buffer.sampleRate));
  const out = new Float32Array(n);
  const ch = buffer.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i]! += d[i]! / ch;
  }
  return out;
}
