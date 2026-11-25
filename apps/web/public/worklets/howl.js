// SingersVoice — AudioWorklet 'sv-howl': a feedback suppressor at the start of the vocal chain.
//
// A microphone that hears the speakers — or an earphone's inline microphone with the earbud dangling by it —
// closes a loop: one frequency where the loop gains more than it loses grows by itself into a squeal (the
// 7 and 9 kHz tones that climbed 20 dB over two seconds in the owner's recording of 24 Nov). Nothing a
// singer does makes a sound like that: one pure tone, standing still in frequency to a few hertz, with
// nothing beside it and no partials under it, that keeps its level or grows. This stage looks for exactly
// that in the microphone and, the moment it finds one, puts a narrow notch on it — in the singer's ears, the
// recording and the mix alike (the chain is one for all), which also breaks the loop. The notch stays
// `NOTCH_HOLD_S` after the tone was last heard; up to `MAX_NOTCHES` tones at a time.
//
// The look: a 2048-point FFT (Hann) every 512 frames on the input as it comes in (before the notches, so a
// tone still there keeps its notch). A candidate is a bin over `MIN_LEVEL_DB`, a local maximum, standing
// `PROMINENCE_DB` over the median of the ±500 Hz around it with no other peak within ±600 Hz inside
// `LONELY_DB` of it, and without a peak at a half or a third of its frequency (a voice's harmonic has its
// fundamental and its neighbours; a howl has nothing). It becomes a howl when it has stood within a bin of
// the same place for `PERSIST_FRAMES` looks running, never losing more than `MAY_FALL_DB` from one look to
// the next — a vibrato or a slide moves a sung harmonic many bins in that time. Below `LOW_HZ` the bar is
// higher (more prominence, longer) — a whistle, a flute, a sung top note live there.
//
// The notches are peaking biquads (RBJ) cut `NOTCH_DB` deep at Q `NOTCH_Q`. No latency. `enabled` 0 passes the
// signal through (the notches cleared). Reports { type: 'howl', notches: [{ hz, db }], found } now and then.

const N = 2048;
const HOP = 512;
const MAX_NOTCHES = 4;
const NOTCH_DB = -36;
const NOTCH_Q = 24;
const NOTCH_HOLD_S = 10;
const MIN_HZ = 1000;
const LOW_HZ = 1500; // under this: the stricter bar
const MAX_HZ = 16000;
const MIN_LEVEL_DB = -55; // a bin's magnitude (dBFS of a full-scale sine in that bin) under this is nothing
const PROMINENCE_DB = 20;
const PROMINENCE_LOW_DB = 28;
const LONELY_DB = 12;
const SUB_DB = 15; // a peak at f/2 or f/3 within this of the candidate: a harmonic, not a howl
const PERSIST_FRAMES = 8; // 8 × 10.7 ms ≈ 85 ms
const PERSIST_LOW_FRAMES = 18; // ≈ 190 ms
const MAY_FALL_DB = 2;
const WITHIN_TOTAL_DB = 30; // the tone must carry at least this much of the whole (a faint tone is a leak, not a loop)

class SvHowlProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.ring = new Float32Array(N);
    this.pos = 0;
    this.sinceLook = 0;
    this.window = new Float32Array(N);
    for (let i = 0; i < N; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
    this.mag = new Float32Array(N / 2);
    // Twiddles and the bit-reversal table.
    this.cos = new Float32Array(N / 2);
    this.sin = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / N);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / N);
    }
    this.rev = new Uint16Array(N);
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.binHz = sampleRate / N;
    this.minBin = Math.max(3, Math.ceil(MIN_HZ / this.binHz));
    this.maxBin = Math.min(N / 2 - 3, Math.floor(Math.min(MAX_HZ, sampleRate * 0.45) / this.binHz));
    this.sideBins = Math.max(4, Math.round(500 / this.binHz));
    this.lonelyBins = Math.max(4, Math.round(600 / this.binHz));
    /** Candidates being watched: { bin, frames, levelDb }. */
    this.watch = [];
    /** The notches in place: { bin, hz, until (frames of this.clock), b0, b1, b2, a1, a2, z1, z2 } per channel state. */
    this.notches = [];
    this.states = [];
    this.clock = 0;
    this.found = 0;
    this.reportLeft = 0;
    this.scratch = new Float32Array(2 * this.sideBins + 1);
  }

  _fft() {
    const re = this.re;
    const im = this.im;
    const rev = this.rev;
    const ring = this.ring;
    const w = this.window;
    const start = this.pos; // the oldest sample
    for (let i = 0; i < N; i++) {
      re[rev[i]] = ring[(start + i) & (N - 1)] * w[i];
      im[rev[i]] = 0;
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = this.cos[k];
          const s = this.sin[k];
          const a = i + j;
          const b = a + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    // Magnitudes in dB, scaled so a full-scale sine reads 0 dB in its bin (Hann: the sum of the window is N/2).
    const mag = this.mag;
    const scale = 4 / N;
    for (let i = 0; i < N / 2; i++) {
      const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * scale;
      mag[i] = m > 1e-9 ? 20 * Math.log10(m) : -180;
    }
  }

  /** The median of the bins around `bin` (±sideBins), the three nearest left out. */
  _median(bin) {
    const mag = this.mag;
    const s = this.scratch;
    let n = 0;
    for (let k = -this.sideBins; k <= this.sideBins; k++) {
      if (Math.abs(k) <= 2) continue;
      const b = bin + k;
      if (b < 1 || b >= N / 2) continue;
      s[n++] = mag[b];
    }
    const arr = Array.prototype.slice.call(s, 0, n).sort((a, b) => a - b);
    return n ? arr[n >> 1] : -180;
  }

  /** Whether the bin is a local maximum (over ±2) that stands alone: no other local maximum within ±lonelyBins inside LONELY_DB of it. */
  _lonely(bin) {
    const mag = this.mag;
    const v = mag[bin];
    for (let k = -this.lonelyBins; k <= this.lonelyBins; k++) {
      if (Math.abs(k) <= 2) continue;
      const b = bin + k;
      if (b < 2 || b >= N / 2 - 2) continue;
      if (mag[b] > mag[b - 1] && mag[b] >= mag[b + 1] && mag[b] >= v - LONELY_DB) return false;
    }
    return true;
  }

  /** The strongest bin within ±2 of `around`. */
  _peakNear(around) {
    let best = -180;
    for (let b = Math.max(1, around - 2); b <= Math.min(N / 2 - 1, around + 2); b++) if (this.mag[b] > best) best = this.mag[b];
    return best;
  }

  _look() {
    this._fft();
    const mag = this.mag;
    // The whole: the level of the loudest bin (a tone carrying the signal), for the within-total rule.
    let top = -180;
    for (let b = 1; b < N / 2; b++) if (mag[b] > top) top = mag[b];
    const candidates = [];
    for (let b = this.minBin; b <= this.maxBin; b++) {
      const v = mag[b];
      if (v < MIN_LEVEL_DB || v < top - WITHIN_TOTAL_DB) continue;
      if (!(v > mag[b - 1] && v >= mag[b + 1] && v > mag[b - 2] && v >= mag[b + 2])) continue;
      const low = b * this.binHz < LOW_HZ;
      if (v - this._median(b) < (low ? PROMINENCE_LOW_DB : PROMINENCE_DB)) continue;
      if (!this._lonely(b)) continue;
      // A harmonic of a voice has its fundamental (or a lower partial) under it.
      if (this._peakNear(Math.round(b / 2)) >= v - SUB_DB || this._peakNear(Math.round(b / 3)) >= v - SUB_DB) continue;
      candidates.push({ bin: b, levelDb: v });
    }
    // Carry the watch list: a candidate within a bin of a watched one that did not fall keeps counting; the rest start over.
    const next = [];
    for (const c of candidates) {
      const w = this.watch.find((x) => Math.abs(x.bin - c.bin) <= 1);
      const frames = w && c.levelDb >= w.levelDb - MAY_FALL_DB ? w.frames + 1 : 1;
      next.push({ bin: c.bin, frames, levelDb: c.levelDb });
      const need = c.bin * this.binHz < LOW_HZ ? PERSIST_LOW_FRAMES : PERSIST_FRAMES;
      if (frames >= need) this._notch(c.bin);
    }
    this.watch = next;
    // Notches past their hold go.
    this.notches = this.notches.filter((n) => n.until > this.clock);
  }

  /** A notch on `bin` (one already within 1.5 bins is renewed), the oldest making room when all are taken. */
  _notch(bin) {
    const hz = bin * this.binHz;
    const until = this.clock + Math.round(NOTCH_HOLD_S * sampleRate);
    const have = this.notches.find((n) => Math.abs(n.hz - hz) <= 1.5 * this.binHz);
    if (have) {
      have.until = until;
      return;
    }
    if (this.notches.length >= MAX_NOTCHES) this.notches.sort((a, b) => a.until - b.until).shift();
    // RBJ peaking EQ, NOTCH_DB at hz, Q NOTCH_Q.
    const A = Math.pow(10, NOTCH_DB / 40);
    const w0 = (2 * Math.PI * hz) / sampleRate;
    const alpha = Math.sin(w0) / (2 * NOTCH_Q);
    const a0 = 1 + alpha / A;
    const n = { hz, until, b0: (1 + alpha * A) / a0, b1: (-2 * Math.cos(w0)) / a0, b2: (1 - alpha * A) / a0, a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha / A) / a0, z: [] };
    this.notches.push(n);
    this.found++;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const channels = Math.min(input ? input.length : 0, output.length);
    if (channels === 0) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }
    if (parameters.enabled[0] < 0.5) {
      for (let ch = 0; ch < channels; ch++) output[ch].set(input[ch]);
      this.notches = [];
      this.watch = [];
      return true;
    }
    // The look runs on the input (mono) as it comes in.
    const ring = this.ring;
    for (let i = 0; i < frames; i++) {
      let x = 0;
      for (let ch = 0; ch < channels; ch++) x += input[ch][i];
      ring[this.pos] = x / channels;
      this.pos = (this.pos + 1) & (N - 1);
    }
    this.clock += frames;
    this.sinceLook += frames;
    if (this.sinceLook >= HOP) {
      this.sinceLook = 0;
      this._look();
    }
    // The notches, in series, per channel (direct form II transposed).
    const notches = this.notches;
    for (let ch = 0; ch < channels; ch++) {
      const inp = input[ch];
      const out = output[ch];
      if (!notches.length) {
        out.set(inp);
        continue;
      }
      for (let i = 0; i < frames; i++) {
        let v = inp[i];
        for (let k = 0; k < notches.length; k++) {
          const n = notches[k];
          let z = n.z[ch];
          if (!z) z = n.z[ch] = [0, 0];
          const y = n.b0 * v + z[0];
          z[0] = n.b1 * v - n.a1 * y + z[1];
          z[1] = n.b2 * v - n.a2 * y;
          v = y;
        }
        out[i] = v;
      }
    }
    if ((this.reportLeft -= frames) <= 0) {
      this.reportLeft = Math.round(sampleRate / 4);
      this.port.postMessage({ type: 'howl', notches: notches.map((n) => ({ hz: Math.round(n.hz), db: NOTCH_DB })), found: this.found });
    }
    return true;
  }
}

registerProcessor('sv-howl', SvHowlProcessor);
