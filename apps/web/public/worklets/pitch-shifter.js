// SingersVoice VoxForge pitch stage — AudioWorklet 'sv-pitch-shifter'.
//
// A pitch-synchronous delay-line shifter (the time-domain idea behind PSOLA) plus a chromatic auto-tune.
//
// The shifter: one read head on a ring buffer, reading `ratio` times as fast as the input is written,
// so its delay drifts — down when the voice is raised, up when it is lowered. When the delay leaves
// its range the head is spliced back into it: a crossfade of one pitch period from where it was to a
// place exactly a whole number of periods away, so for a sung note — a periodic wave — the two are
// the same wave and the splice is inaudible. Between splices a single head reads the voice: nothing
// else is mixed with it, so there is no comb filter, no hollow "down a well" colour, no flutter — the
// coloration of the usual two-grain shifter, whose grains sit half a window apart in time and
// cancel and reinforce each other's harmonics all the while. Splices come every few hundred
// milliseconds at a semitone, every few seconds at the few cents an auto-tune corrects. Where there
// is no period (a consonant, a breath) the splice is a few milliseconds long over a few milliseconds:
// noise splices with noise and nothing is heard. The head sits DELAY_LO..DELAY_HI ms behind the
// input (about 14 ms on average) — reported to the page every quarter second (`delay` messages) so
// the recordings and the live mix can take it into account; when the stage has nothing to do the
// voice passes straight through, at no delay.
//
// The auto-tune: a normalized autocorrelation (NSDF) pitch tracker on a 2x-decimated copy of the
// input every 512 frames; the note is the nearest semitone, kept while the voice stays within
// 50 + HYSTERESIS cents of it (a vibrato or a slide around the halfway point never flips the
// note back and forth), and the correction toward it is glided (`autoSpeed`), so the vibrato,
// which is faster than the glide, comes through and only the centre of the note is moved. The
// correction stays through a short unvoiced gap (a "t", a breath).
//
// Parameters (k-rate):
//   pitch        total manual shift in semitones, -24..+24 (octave*12 + semitones + cents/100)
//   autoStrength 0..1  how far toward the nearest semitone we pull (0 = off)
//   autoSpeed    0..1  retune speed (1 = hard snap, 0 = ~250 ms glide)

const DELAY_LO_MS = 3;
const DELAY_HI_MS = 25;
/** The note is kept while the voice stays within this many semitones past the halfway point to the next one. */
const HYSTERESIS = 0.2;
/** The splice where no period is known (ms): the jump and the crossfade. */
const UNVOICED_SPLICE_MS = 5;

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
    this.ringBits = 13; // 8192 frames: 170 ms at 48 kHz — the head's range, the splice and the crossfade fit many times over
    this.ringSize = 1 << this.ringBits;
    this.ringMask = this.ringSize - 1;
    this.rings = [];
    this.w = 0;
    this.lo = (DELAY_LO_MS / 1000) * sampleRate;
    this.hi = (DELAY_HI_MS / 1000) * sampleRate;
    this.mid = (this.lo + this.hi) / 2;
    this.d = this.mid; // the head's delay (frames)
    this.d2 = 0; // the head's new delay during a splice
    this.spliceLeft = 0; // frames of crossfade left
    this.spliceLen = 1;
    this.wet = 0;
    this.delayAvg = this.mid;
    this.reportLeft = 0;
    this.saidDry = false;

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
    this.heldCorrection = 0; // the last voiced correction, kept through a short unvoiced gap
    this.holdFrames = 0;
    this.holdLength = Math.round(0.3 * sampleRate); // a consonant or a breath, not a pause
    this.voiced = false;
    this.note = null; // the note being held (midi), null between phrases
    this.periodFrames = 0; // the voice's period in input frames (0: unvoiced)
    this.lastHz = 0;
    this.reportCounter = 0;
    this.decimAcc = 0;
    this.decimCount = 0;
  }

  _ensureChannels(count) {
    while (this.rings.length < count) this.rings.push(new Float32Array(this.ringSize));
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

  _unvoiced() {
    this.voiced = false;
    this.periodFrames = 0;
    this.targetCorrection = 0;
  }

  _analyse() {
    const n = this.detWin;
    const buf = this.detBuf;
    const start = this.detPos; // oldest sample
    if (!this.lin) this.lin = new Float32Array(n);
    const lin = this.lin;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = buf[(start + i) % n];
      lin[i] = v;
      energy += v * v;
    }
    if (energy / n < 1e-6) return this._unvoiced();
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
    if (best < 0 || bestVal < 0.6) return this._unvoiced();
    // Parabolic interpolation around the peak.
    const y0 = nsdf[best - 1];
    const y1 = nsdf[best];
    const y2 = nsdf[best + 1];
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    const period = best + shift;
    const hz = this.detRate / period;
    if (hz < 55 || hz > 1300) return this._unvoiced();
    this.voiced = true;
    this.lastHz = hz;
    this.periodFrames = period * this.decim;
    const midi = 69 + 12 * Math.log2(hz / 440);
    // The note: the nearest semitone — kept while the voice stays within half a semitone and the hysteresis of it.
    if (this.note === null || Math.abs(midi - this.note) > 0.5 + HYSTERESIS) this.note = Math.round(midi);
    this.targetCorrection = this.note - midi; // semitones to reach the note
    if (++this.reportCounter >= 8) {
      this.reportCounter = 0;
      this.port.postMessage({ type: 'pitch', hz, midi, cents: Math.round((midi - this.note) * 100), clarity: bestVal });
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

    // The tracker runs whenever the stage has work — a manual shift's splices are period-synchronous too.
    if (strength > 0 || Math.abs(manual) >= 0.01) this._track(input[0], frames);
    else this.periodFrames = 0;
    if (strength > 0) {
      // The correction stays through a short unvoiced gap (a "t", a breath): the voice does not fall
      // back to its untuned pitch on every consonant and jump back on the next vowel.
      if (this.voiced) {
        this.heldCorrection = this.targetCorrection;
        this.holdFrames = this.holdLength;
      } else if (this.holdFrames > 0) {
        this.holdFrames -= frames;
      } else {
        this.heldCorrection = 0;
        this.note = null; // a pause: the next phrase picks its note afresh
      }
      // One-pole glide toward the target correction; speed 1 = instant.
      const target = this.heldCorrection * strength;
      const tc = 0.004 + (1 - speed) * 0.25; // seconds
      const alpha = speed >= 0.999 ? 1 : 1 - Math.exp(-frames / (tc * sampleRate));
      this.correction += (target - this.correction) * alpha;
    } else {
      this.correction = 0;
      this.heldCorrection = 0;
      this.holdFrames = 0;
      this.note = null;
    }

    const semitones = manual + this.correction;
    const ratio = Math.pow(2, semitones / 12);
    const slope = 1 - ratio; // the head's delay changes this much a frame
    // Wet while the stage has work (auto-tune on, or a shift asked): a constant character, never a flicker between the
    // dry voice and the shifted one at a correction of a cent. Dry — straight through, no delay — only when idle.
    const targetWet = strength > 0 || Math.abs(manual) >= 0.01 ? 1 : 0;
    const rampFrames = 256;
    const wetStep = (targetWet - this.wet) / rampFrames;
    const mask = this.ringMask;
    const lo = this.lo;
    const hi = this.hi;
    // The splice: a whole number of periods — enough of them to land near the middle of the range — or a few milliseconds of noise;
    // the crossfade one period long (shorter at a big shift, so the head never runs out of the range while it fades), and the
    // splice called early enough for the head to stay inside the range throughout.
    const unit = this.periodFrames > 0 ? this.periodFrames : (UNVOICED_SPLICE_MS / 1000) * sampleRate;
    const jump = unit * Math.max(1, Math.round((hi - lo) / 2 / unit));
    const absSlope = Math.abs(slope);
    let spliceLen = Math.max(64, Math.min(1024, Math.round(unit)));
    if (absSlope > 1e-6) spliceLen = Math.min(spliceLen, Math.max(32, Math.floor((hi - lo) / 2 / absSlope)));
    const loTrig = lo + (slope < 0 ? -slope * spliceLen : 0);
    const hiTrig = hi - (slope > 0 ? slope * spliceLen : 0);

    if (this.wet === 0 && targetWet === 0) {
      // Neutral: the voice passes straight through; the rings still fill so a correction can start at once, from the middle of the range.
      for (let ch = 0; ch < channels; ch++) {
        const data = this.rings[ch];
        const source = input[ch];
        const dest = output[ch];
        let w = this.w;
        for (let i = 0; i < frames; i++) {
          data[w] = source[i];
          dest[i] = source[i];
          w = (w + 1) & mask;
        }
      }
      this.w = (this.w + frames) & mask;
      this.d = this.mid;
      this.spliceLeft = 0;
      this.delayAvg = this.mid;
      if (!this.saidDry) {
        this.saidDry = true; // straight through: no hold on the voice — said once
        this.port.postMessage({ type: 'delay', delayMs: 0 });
      }
      return true;
    }
    this.saidDry = false;

    let d = this.d;
    let d2 = this.d2;
    let spliceLeft = this.spliceLeft;
    let spliceTotal = this.spliceLen;
    let wet = this.wet;
    const w0 = this.w;
    for (let i = 0; i < frames; i++) {
      const w = (w0 + i) & mask;
      for (let ch = 0; ch < channels; ch++) this.rings[ch][w] = input[ch][i];
      d += slope;
      if (spliceLeft > 0) d2 += slope;
      else if (d < loTrig || d > hiTrig) {
        // Leaving the range: splice to a whole number of periods away, back inside — the crossfade starts now.
        d2 = d < loTrig ? d + jump : d - jump;
        if (d2 < lo || d2 > hi) d2 = this.mid; // (a period longer than the range: no such voice; a safe landing)
        spliceTotal = spliceLen;
        spliceLeft = spliceLen;
      }
      let x = 0; // the crossfade weight of the new head
      if (spliceLeft > 0) {
        const t = 1 - spliceLeft / spliceTotal; // 0 → 1 over the splice
        x = 0.5 - 0.5 * Math.cos(Math.PI * t);
        spliceLeft--;
        if (spliceLeft === 0) {
          d = d2;
          x = 0;
        }
      }
      wet += wetStep;
      if (wet < 0) wet = 0;
      else if (wet > 1) wet = 1;
      for (let ch = 0; ch < channels; ch++) {
        const data = this.rings[ch];
        const dry = input[ch][i];
        let v = read(data, w, d, mask);
        if (x > 0) v = v * (1 - x) + read(data, w, d2, mask) * x;
        output[ch][i] = dry * (1 - wet) + v * wet;
      }
    }
    this.w = (w0 + frames) & mask;
    this.d = d;
    this.d2 = d2;
    this.spliceLeft = spliceLeft;
    this.spliceLen = spliceTotal;
    this.wet = wet;
    // What the stage holds the voice by, averaged over the last couple of seconds; told every quarter second.
    this.delayAvg += (d - this.delayAvg) * 0.002;
    if ((this.reportLeft -= frames) <= 0) {
      this.reportLeft = Math.round(sampleRate / 4);
      this.port.postMessage({ type: 'delay', delayMs: Math.round((this.delayAvg / sampleRate) * 10000) / 10 });
    }
    return true;
  }
}

/** The ring read `delay` frames (fractional) behind the write position `w`, linearly interpolated. */
function read(data, w, delay, mask) {
  const pos = w - delay;
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  const a = data[i0 & mask];
  const b = data[(i0 + 1) & mask];
  return a + (b - a) * frac;
}

registerProcessor('sv-pitch-shifter', SvPitchShifterProcessor);
