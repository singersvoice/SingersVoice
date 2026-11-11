// SingersVoice VoxForge pitch stage — AudioWorklet 'sv-pitch-shifter'.
//
// Dual-grain granular delay-line shifter (same design as SVOld's sv_pitch_worklet.js:
// two read heads half a window apart, Hann crossfaded, dry passthrough when neutral)
// plus a chromatic auto-tune: a normalized autocorrelation (NSDF) pitch tracker runs on
// a 2x-decimated copy of the input every 512 frames; the detected note is snapped to
// the nearest semitone and the correction is folded into the grain ratio.
//
// Parameters (k-rate):
//   pitch        total manual shift in semitones, -24..+24 (octave*12 + semitones + cents/100)
//   autoStrength 0..1  how far toward the nearest semitone we pull (0 = off)
//   autoSpeed    0..1  retune speed (1 = hard snap, 0 = ~250 ms glide)
//
// Latency: one grain window (~46 ms) when shifting; ~0 when neutral (dry path).

class SvPitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitch', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'autoStrength', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'autoSpeed', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const windowMs = 46;
    this.windowSize = Math.max(512, Math.round((sampleRate * windowMs) / 1000));
    this.buffers = [];
    this.writeIndex = [];
    this.phase = [];
    this.wet = 0;

    // --- pitch tracker state (mono, decimated by 2) ---
    this.decim = 2;
    this.detRate = sampleRate / this.decim;
    this.detWin = 1024;
    this.detBuf = new Float32Array(this.detWin);
    this.detPos = 0;
    this.detHop = 256; // decimated frames between analyses (= 512 input frames)
    this.detCount = 0;
    this.minLag = Math.max(8, Math.floor(this.detRate / 1200)); // 1200 Hz
    this.maxLag = Math.min(this.detWin - 2, Math.ceil(this.detRate / 60)); // 60 Hz
    this.nsdf = new Float32Array(this.maxLag + 1);
    this.correction = 0; // semitones, smoothed
    this.targetCorrection = 0;
    this.voiced = false;
    this.lastHz = 0;
    this.reportCounter = 0;
    this.decimAcc = 0;
    this.decimCount = 0;
  }

  _ensureChannels(count) {
    while (this.buffers.length < count) {
      this.buffers.push(new Float32Array(this.windowSize));
      this.writeIndex.push(0);
      this.phase.push(0);
    }
  }

  _track(mono, frames) {
    // Decimate by averaging pairs into the analysis ring, run NSDF every detHop decimated frames.
    for (let i = 0; i < frames; i++) {
      this.decimAcc += mono[i];
      if (++this.decimCount === this.decim) {
        this.detBuf[this.detPos] = this.decimAcc / this.decim;
        this.detPos = (this.detPos + 1) % this.detWin;
        this.decimAcc = 0;
        this.decimCount = 0;
        if (++this.detCount >= this.detHop) {
          this.detCount = 0;
          this._analyse();
        }
      }
    }
  }

  _analyse() {
    const n = this.detWin;
    const buf = this.detBuf;
    const start = this.detPos; // oldest sample
    // Linearise ring into a scratch (reuse nsdf array sizes: allocate once).
    if (!this.lin) this.lin = new Float32Array(n);
    const lin = this.lin;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = buf[(start + i) % n];
      lin[i] = v;
      energy += v * v;
    }
    if (energy / n < 1e-6) {
      this.voiced = false;
      this.targetCorrection = 0;
      return;
    }
    const nsdf = this.nsdf;
    const maxLag = this.maxLag;
    const minLag = this.minLag;
    let best = -1;
    let bestVal = 0;
    // NSDF: 2*acf / (m(tau)); computed for the lag range only.
    for (let tau = minLag; tau <= maxLag; tau++) {
      let acf = 0;
      let m = 0;
      for (let i = 0; i + tau < n; i++) {
        const a = lin[i];
        const b = lin[i + tau];
        acf += a * b;
        m += a * a + b * b;
      }
      nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
    }
    // Peak picking: first key maximum above 0.8 * global max (McLeod).
    let globalMax = 0;
    for (let tau = minLag; tau <= maxLag; tau++) if (nsdf[tau] > globalMax) globalMax = nsdf[tau];
    const threshold = 0.8 * globalMax;
    let tau = minLag + 1;
    while (tau < maxLag) {
      if (nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1] && nsdf[tau] >= threshold) {
        best = tau;
        bestVal = nsdf[tau];
        break;
      }
      tau++;
    }
    if (best < 0 || bestVal < 0.6) {
      this.voiced = false;
      this.targetCorrection = 0;
      return;
    }
    // Parabolic interpolation around the peak.
    const y0 = nsdf[best - 1];
    const y1 = nsdf[best];
    const y2 = nsdf[best + 1];
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    const period = best + shift;
    const hz = this.detRate / period;
    if (hz < 55 || hz > 1300) {
      this.voiced = false;
      this.targetCorrection = 0;
      return;
    }
    this.voiced = true;
    this.lastHz = hz;
    const midi = 69 + 12 * Math.log2(hz / 440);
    const nearest = Math.round(midi);
    this.targetCorrection = nearest - midi; // semitones to reach the nearest note
    if (++this.reportCounter >= 8) {
      this.reportCounter = 0;
      this.port.postMessage({ type: 'pitch', hz, midi, cents: Math.round((midi - nearest) * 100), clarity: bestVal });
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || input.length === 0 || output.length === 0) return true;
    const channels = Math.min(input.length, output.length);
    this._ensureChannels(channels);
    const frames = output[0].length;

    const pitchParam = parameters.pitch;
    const manual = pitchParam && pitchParam.length > 0 ? pitchParam[pitchParam.length - 1] : 0;
    const strengthParam = parameters.autoStrength;
    const strength = strengthParam && strengthParam.length > 0 ? strengthParam[strengthParam.length - 1] : 0;
    const speedParam = parameters.autoSpeed;
    const speed = speedParam && speedParam.length > 0 ? speedParam[speedParam.length - 1] : 0.5;

    if (strength > 0) {
      this._track(input[0], frames);
      // One-pole glide toward the target correction; speed 1 = instant.
      const target = this.voiced ? this.targetCorrection * strength : 0;
      const tc = 0.004 + (1 - speed) * 0.25; // seconds
      const alpha = speed >= 0.999 ? 1 : 1 - Math.exp(-frames / (tc * sampleRate));
      this.correction += (target - this.correction) * alpha;
    } else {
      this.correction = 0;
    }

    const semitones = manual + this.correction;
    const ratio = Math.pow(2, semitones / 12);
    const drift = 1 - ratio;
    const targetWet = Math.abs(semitones) >= 0.01 ? 1 : 0;
    const win = this.windowSize;
    const halfWin = win * 0.5;
    const twoPi = Math.PI * 2;
    const rampFrames = Math.max(1, Math.min(frames, 256));
    const wetStep = (targetWet - this.wet) / rampFrames;

    for (let ch = 0; ch < channels; ch++) {
      const data = this.buffers[ch];
      const source = input[ch];
      const dest = output[ch];
      let w = this.writeIndex[ch];
      let phase = this.phase[ch];
      let wet = this.wet;

      for (let i = 0; i < frames; i++) {
        const dry = source[i];
        data[w] = dry;

        phase += drift;
        if (phase >= win) phase -= win;
        else if (phase < 0) phase += win;

        const readA = w - phase;
        const floorA = Math.floor(readA);
        const a0 = ((floorA % win) + win) % win;
        const a1 = (a0 + 1) % win;
        const fracA = readA - floorA;
        const sampleA = data[a0] * (1 - fracA) + data[a1] * fracA;
        const gainA = 0.5 - 0.5 * Math.cos(twoPi * (phase / win));

        let phaseB = phase + halfWin;
        if (phaseB >= win) phaseB -= win;
        const readB = w - phaseB;
        const floorB = Math.floor(readB);
        const b0 = ((floorB % win) + win) % win;
        const b1 = (b0 + 1) % win;
        const fracB = readB - floorB;
        const sampleB = data[b0] * (1 - fracB) + data[b1] * fracB;
        const gainB = 0.5 - 0.5 * Math.cos(twoPi * (phaseB / win));

        const shifted = sampleA * gainA + sampleB * gainB;
        wet += wetStep;
        if (wet < 0) wet = 0;
        else if (wet > 1) wet = 1;
        dest[i] = dry * (1 - wet) + shifted * wet;

        w = (w + 1) % win;
      }
      this.writeIndex[ch] = w;
      this.phase[ch] = phase;
    }

    this.wet += wetStep * frames;
    if (this.wet < 0) this.wet = 0;
    else if (this.wet > 1) this.wet = 1;
    return true;
  }
}

registerProcessor('sv-pitch-shifter', SvPitchShifterProcessor);
