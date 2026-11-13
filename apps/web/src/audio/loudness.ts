/**
 * Loudness, the way broadcast and the streaming platforms measure it (ITU-R BS.1770 / EBU R128):
 * K-weighting (a high shelf and a high-pass that follow the ear), 400 ms blocks, an absolute gate at
 * −70 LUFS and a relative gate 10 LU under the ungated mean — so a long quiet intro or a pause does
 * not drag a track's loudness down. `measureLoudness` is the one-off measurement of a decoded track;
 * `MIX_TARGETS` are the levels every bus mixes to: the track and the voices at a fixed distance, the
 * whole at what YouTube and the others play back without turning it down (−14 LUFS).
 */

export const MIX_TARGETS = {
  /** The backing track's integrated loudness in the mix (LUFS) — the music, under the voices. */
  trackLufs: -19,
  /** Each vocal's level in the mix, as a short-term RMS the rider steers toward (dBFS). */
  vocalDb: -17,
  /** The whole mix must not run hotter than this on average (RMS, dBFS): the guard turns down, never up. */
  mixDb: -13,
  /** The furthest a track may be lifted or lowered to reach its target (dB). */
  trackRangeDb: 18,
} as const;

/** How far to move a signal measured at `lufs` to land at `target` (dB), within ±range. */
export function normalizationDb(lufs: number, target: number, range = MIX_TARGETS.trackRangeDb): number {
  if (!Number.isFinite(lufs)) return 0;
  return Math.max(-range, Math.min(range, target - lufs));
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The two K-weighting stages for any sample rate (BS.1770's tables are for 48 kHz; these are the same filters re-derived). */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high shelf, +3.9998 dB, f0 1681.97 Hz, Q 0.7071752.
  const shelf = (() => {
    const f0 = 1681.974450955533;
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / sampleRate);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    return {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
  })();
  // Stage 2: the RLB high-pass, f0 38.13547 Hz, Q 0.5003270 — its numerator is left as the standard
  // writes it ({1, −2, 1}, not normalised), which the −0.691 LUFS offset is calibrated against.
  const hp = (() => {
    const f0 = 38.13547087602444;
    const Q = 0.5003270373238773;
    const K = Math.tan((Math.PI * f0) / sampleRate);
    const a0 = 1 + K / Q + K * K;
    return {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
  })();
  return [shelf, hp];
}

function filterInPlace(x: Float32Array, f: Biquad): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!;
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
}

export interface Loudness {
  /** Integrated loudness (LUFS); −Infinity for silence. */
  lufs: number;
  /** The sample peak (dBFS); −Infinity for silence. */
  peakDb: number;
}

/**
 * Integrated loudness of decoded audio (one Float32Array per channel; up to five channels weighted as
 * BS.1770 does: surrounds +1.5 dB). The channels are copied before filtering — the caller's data is
 * left as it was.
 */
export function measureLoudness(channels: Float32Array[], sampleRate: number): Loudness {
  const chs = channels.filter((c) => c.length > 0);
  if (chs.length === 0) return { lufs: -Infinity, peakDb: -Infinity };
  let peak = 0;
  const [shelf, hp] = kWeighting(sampleRate);
  const n = Math.min(...chs.map((c) => c.length));
  const blockLen = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const weights = chs.length >= 5 ? [1, 1, 1, Math.pow(10, 0.15), Math.pow(10, 0.15)] : chs.map(() => 1);
  // Per-channel cumulative sums of the K-weighted squares, so every block's mean square is two lookups.
  const blockPower: number[] = [];
  const cum: Float64Array[] = [];
  for (let c = 0; c < chs.length; c++) {
    const src = chs[c]!;
    const x = new Float32Array(src.subarray(0, n));
    for (let i = 0; i < n; i++) {
      const a = Math.abs(src[i]!);
      if (a > peak) peak = a;
    }
    filterInPlace(x, shelf);
    filterInPlace(x, hp);
    const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i]! + x[i]! * x[i]!;
    cum.push(cs);
  }
  if (n < blockLen) {
    // Shorter than one block: measure what there is as one block.
    let z = 0;
    for (let c = 0; c < chs.length; c++) z += (weights[c] ?? 1) * (cum[c]![n]! / n);
    return { lufs: z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity, peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity };
  }
  for (let start = 0; start + blockLen <= n; start += hop) {
    let z = 0;
    for (let c = 0; c < chs.length; c++) z += (weights[c] ?? 1) * ((cum[c]![start + blockLen]! - cum[c]![start]!) / blockLen);
    blockPower.push(z);
  }
  const toLufs = (z: number) => -0.691 + 10 * Math.log10(z);
  const abs = blockPower.filter((z) => z > 0 && toLufs(z) > -70);
  if (abs.length === 0) return { lufs: -Infinity, peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity };
  const meanAbs = abs.reduce((s, z) => s + z, 0) / abs.length;
  const relGate = toLufs(meanAbs) - 10;
  const kept = abs.filter((z) => toLufs(z) > relGate);
  const mean = kept.reduce((s, z) => s + z, 0) / kept.length;
  return { lufs: toLufs(mean), peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity };
}

/**
 * The loudness of an encoded file (a track blob), decoded on `ctx` — remembered per track id so every
 * later visit answers from the cache without decoding.
 */
export async function blobLoudness(ctx: BaseAudioContext, blob: Blob, trackId?: string): Promise<Loudness> {
  const cached = trackId ? cachedLoudness(trackId) : null;
  if (cached) return cached;
  const data = await blob.arrayBuffer();
  const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, (e) => reject(e ?? new Error('Could not decode this audio file')));
    if (p && typeof (p as Promise<AudioBuffer>).then === 'function') (p as Promise<AudioBuffer>).then(resolve, reject);
  });
  const l = await bufferLoudnessAsync(buffer);
  if (trackId) rememberLoudness(trackId, l);
  return l;
}

/** The loudness of a decoded AudioBuffer, on this thread (tests, and the fallback when no worker can be made). */
export function bufferLoudness(buffer: AudioBuffer): Loudness {
  const chs: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  return measureLoudness(chs, buffer.sampleRate);
}

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, (l: Loudness) => void>();

/**
 * The loudness of a decoded AudioBuffer, measured in a worker (the channels are copied out and
 * transferred, so the buffer itself stays where it is): nothing on the main thread stalls for a long
 * track. Falls back to measuring here when workers are not available.
 */
export function bufferLoudnessAsync(buffer: AudioBuffer): Promise<Loudness> {
  if (worker === undefined) {
    try {
      worker = new Worker(new URL('./loudness.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; lufs: number; peakDb: number }>) => {
        const resolve = pending.get(e.data.id);
        pending.delete(e.data.id);
        // JSON-less structured clone keeps ±Infinity as it is.
        resolve?.({ lufs: e.data.lufs, peakDb: e.data.peakDb });
      };
      worker.onerror = () => {
        for (const [, resolve] of pending) resolve({ lufs: -Infinity, peakDb: -Infinity });
        pending.clear();
        worker?.terminate();
        worker = null;
      };
    } catch {
      worker = null;
    }
  }
  if (!worker) return Promise.resolve(bufferLoudness(buffer));
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(new Float32Array(buffer.getChannelData(c)));
  const id = nextId++;
  const w = worker;
  return new Promise<Loudness>((resolve) => {
    pending.set(id, resolve);
    try {
      w.postMessage({ id, channels, sampleRate: buffer.sampleRate }, channels.map((c) => c.buffer));
    } catch {
      pending.delete(id);
      resolve(bufferLoudness(buffer));
    }
  });
}

const CACHE_KEY = 'sv.loudness';
/** Remembered measurements by track id (a track is decoded once per device for its loudness; afterwards this answers). */
export function cachedLoudness(trackId: string): Loudness | null {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, { lufs: number; peakDb: number }>;
    const v = all[trackId];
    return v && Number.isFinite(v.lufs) ? v : null;
  } catch {
    return null;
  }
}

export function rememberLoudness(trackId: string, l: Loudness): void {
  if (!Number.isFinite(l.lufs)) return;
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, { lufs: number; peakDb: number }>;
    all[trackId] = { lufs: Math.round(l.lufs * 10) / 10, peakDb: Math.round(l.peakDb * 10) / 10 };
    const ids = Object.keys(all);
    for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete all[id];
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: measure again next time */
  }
}
