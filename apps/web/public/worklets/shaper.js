// SingersVoice — AudioWorklet 'sv-shaper': a waveshaper (a transfer curve over −1..1, taken the way
// WaveShaperNode takes its `curve`: linear interpolation between the points, the ends past ±1) run at
// twice the sample rate — the curve's harmonics above the audible band are made and filtered away at
// 2× instead of folding back into it — with a short half-band filter either side: 15 frames of latency
// in all, against the 128 the browser's own '2x' oversampling holds the signal for. The vocal chain's
// exciter, its saturation and its soft clipper run through this on the way to the singer's ears:
// under a millisecond instead of 8 ms (voxforge.ts, dynamics.ts). The curve arrives on the port ({ type: 'curve',
// curve: Float32Array }) and may change at any time (a preset's drive); until one has arrived the
// signal passes straight through. Any channel count; each channel its own state.
//
// The half-band filter: a windowed sinc (Kaiser, β 5; 31 taps) with every other tap zero and the
// centre 0.5 — at 96 kHz its passband is flat to 19 kHz (−0.3 dB at 20 kHz) and its stopband (−54 dB)
// starts at 30 kHz, so what the curve makes above the original Nyquist is gone before the decimation.
// The interpolator (up by 2) and the decimator (down by 2) use the same taps; the interpolator's are
// doubled (the inserted zeros halve the level). The interpolator holds the signal 7.5 frames, the
// decimator — its centre set one sample further back, so the output lands on an input sample's own
// time and not between two — 7.5 more: 15 frames, exactly (dynamics.ts SHAPER_WORKLET_LATENCY_FRAMES).

const TAPS = 31;
const HALF = (TAPS - 1) / 2; // 15: the latency in frames
const A = (HALF - 1) / 2; // 7: the interpolator's even output is the input this many samples back

function kaiser(n, N, beta) {
  const bessel = (x) => {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 32; k++) {
      term *= (x / (2 * k)) * (x / (2 * k));
      sum += term;
      if (term < 1e-12 * sum) break;
    }
    return sum;
  };
  const r = (2 * n) / (N - 1) - 1;
  return bessel(beta * Math.sqrt(Math.max(0, 1 - r * r))) / bessel(beta);
}

/** The odd taps of one side of the half-band filter (offsets 1, 3, …, HALF), normalised so the passband is unity. */
function halfBandOdd() {
  const odd = [];
  for (let k = 1; k <= HALF; k += 2) odd.push((Math.sin((Math.PI * k) / 2) / (Math.PI * k)) * kaiser(HALF + k, TAPS, 5));
  const sum = odd.reduce((a, b) => a + b, 0);
  return odd.map((v) => (v * 0.25) / sum); // both sides together give 0.5; with the centre's 0.5 that is 1 at DC
}

const ODD = halfBandOdd();
const ODD_N = ODD.length; // 8
const XN = 32; // the interpolator's input history (needs HALF + 1)
const SN = 64; // the decimator's history at 2× (needs 2 · HALF + 2)

class SvShaperProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.curve = null;
    this.states = [];
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === 'curve') this.curve = d.curve && d.curve.length >= 2 ? Float32Array.from(d.curve) : null;
    };
  }

  _state(channels) {
    while (this.states.length < channels) this.states.push({ x: new Float32Array(XN), xi: 0, s: new Float32Array(SN), si: 0 });
  }

  /** The curve at `v` (clamped to −1..1), as WaveShaperNode reads it. */
  _shape(v) {
    const c = this.curve;
    if (!c) return v;
    const n = c.length;
    const p = ((Math.max(-1, Math.min(1, v)) + 1) / 2) * (n - 1);
    const i = Math.floor(p);
    if (i >= n - 1) return c[n - 1];
    const f = p - i;
    return c[i] + (c[i + 1] - c[i]) * f;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channels = Math.min(input ? input.length : 0, output.length);
    if (channels === 0) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }
    this._state(channels);
    for (let ch = 0; ch < channels; ch++) {
      const inp = input[ch];
      const out = output[ch];
      const st = this.states[ch];
      const x = st.x;
      const s = st.s;
      let xi = st.xi;
      let si = st.si;
      for (let i = 0; i < inp.length; i++) {
        x[xi] = inp[i];
        // ---- up by 2 (the interpolator HALF/2 frames behind the input): first the sample between x[n−A−1] and x[n−A] —
        // the odd taps over the inputs either side of it — then x[n−A] itself (the centre tap; the even taps are zero).
        let mid = 0;
        for (let m = 0; m < ODD_N; m++) mid += ODD[m] * (x[(xi - A - 1 - m) & (XN - 1)] + x[(xi - A + m) & (XN - 1)]);
        mid *= 2;
        const own = x[(xi - A) & (XN - 1)];
        xi = (xi + 1) & (XN - 1);
        // ---- the curve, at 2× ----
        s[si] = this._shape(mid);
        si = (si + 1) & (SN - 1);
        s[si] = this._shape(own);
        si = (si + 1) & (SN - 1);
        // ---- down by 2: one output per input, the filter centred HALF + 1 samples (at 2×) behind the newest — on an
        // input sample's own time (a pair's second sample), so the whole is a delay of exactly HALF frames.
        const c0 = (si - 1 - (HALF + 1)) & (SN - 1);
        let y = 0.5 * s[c0];
        for (let m = 0; m < ODD_N; m++) {
          const k = 2 * m + 1;
          y += ODD[m] * (s[(c0 + k) & (SN - 1)] + s[(c0 - k) & (SN - 1)]);
        }
        out[i] = y;
      }
      st.xi = xi;
      st.si = si;
    }
    return true;
  }
}

registerProcessor('sv-shaper', SvShaperProcessor);
