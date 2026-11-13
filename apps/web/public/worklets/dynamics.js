// SingersVoice — AudioWorklet 'sv-dynamics': a feed-forward compressor / limiter that does exactly
// what its parameters say. The browser's own DynamicsCompressorNode adds a hidden makeup gain
// ((1 / gain at 0 dBFS)^0.6: +14 dB on a −30 dB / 6:1 setting) and a fixed 6 ms lookahead; this one
// has an explicit `makeup` and the lookahead it is built with (processorOptions.lookaheadFrames,
// default 0), so a vocal chain can stack several without piling up latency.
//
// Detector: the linked instantaneous peak over all channels — with a lookahead, the largest peak in the
// coming `lookahead` frames — through a soft-knee gain computer in dB, then attack/release ballistics
// on the gain itself; the gain is applied to the signal `lookahead` frames later, so a limiter's gain is
// already down when the transient arrives.
//
// Parameters (k-rate): threshold dB, knee dB (width), ratio, attack s, release s, makeup dB.

class SvDynamicsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -24, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'knee', defaultValue: 6, minValue: 0, maxValue: 40, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 3, minValue: 1, maxValue: 1000, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.005, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.1, minValue: 0.001, maxValue: 3, automationRate: 'k-rate' },
      { name: 'makeup', defaultValue: 0, minValue: -60, maxValue: 60, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.look = Math.max(0, Math.round(o.lookaheadFrames || 0));
    this.rings = [];
    this.writeIndex = 0;
    this.gainDb = 0; // the smoothed gain reduction (≤ 0 dB)
    // The sliding maximum over the lookahead window: a monotonic queue of (frame, peak) — the front is the
    // window's maximum, candidates that can never win again are dropped as they arrive (O(1) a frame).
    this.qFrame = new Float64Array(this.look + 129);
    this.qPeak = new Float32Array(this.look + 129);
    this.qHead = 0;
    this.qTail = 0;
    this.frame = 0;
  }

  _ensure(channels) {
    const size = this.look + 128;
    while (this.rings.length < channels) this.rings.push(new Float32Array(size));
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
    this._ensure(channels);
    const T = parameters.threshold[0];
    const W = parameters.knee[0];
    const R = parameters.ratio[0];
    const attack = parameters.attack[0];
    const release = parameters.release[0];
    const makeup = Math.pow(10, parameters.makeup[0] / 20);
    const slope = 1 / R - 1;
    const aAtk = attack > 0 ? Math.exp(-1 / (attack * sampleRate)) : 0;
    const aRel = Math.exp(-1 / (release * sampleRate));
    const look = this.look;
    const size = look + 128;
    let w = this.writeIndex;
    let gainDb = this.gainDb;
    const qFrame = this.qFrame;
    const qPeak = this.qPeak;
    const qSize = qFrame.length;
    let qHead = this.qHead;
    let qTail = this.qTail;
    let frame = this.frame;
    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let ch = 0; ch < channels; ch++) {
        const v = Math.abs(input[ch][i]);
        if (v > peak) peak = v;
      }
      if (look > 0) {
        // The level that matters is the loudest frame about to come out of the delay — the max over the lookahead.
        while (qTail !== qHead && qPeak[(qTail - 1 + qSize) % qSize] <= peak) qTail = (qTail - 1 + qSize) % qSize;
        qFrame[qTail] = frame;
        qPeak[qTail] = peak;
        qTail = (qTail + 1) % qSize;
        while (qFrame[qHead] < frame - look) qHead = (qHead + 1) % qSize;
        peak = qPeak[qHead];
      }
      frame++;
      const xDb = peak > 1e-7 ? 20 * Math.log10(peak) : -140;
      const over = xDb - T;
      let wantDb;
      if (2 * over <= -W) wantDb = 0;
      else if (2 * over >= W) wantDb = over / R - over;
      else {
        const t = over + W / 2;
        wantDb = (slope * t * t) / (2 * W);
      }
      const coef = wantDb < gainDb ? aAtk : aRel;
      gainDb = wantDb + coef * (gainDb - wantDb);
      const g = Math.pow(10, gainDb / 20) * makeup;
      const r = (w - look + size) % size;
      for (let ch = 0; ch < channels; ch++) {
        const ring = this.rings[ch];
        ring[w] = input[ch][i];
        output[ch][i] = ring[r] * g;
      }
      w = (w + 1) % size;
    }
    this.writeIndex = w;
    this.gainDb = gainDb;
    this.qHead = qHead;
    this.qTail = qTail;
    this.frame = frame;
    return true;
  }
}

registerProcessor('sv-dynamics', SvDynamicsProcessor);
