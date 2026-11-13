// SingersVoice — AudioWorklet 'sv-leveler': an automatic level for program material — a slow gain that
// steers a signal's RMS toward a target and otherwise leaves it alone. Three jobs in the mix buses:
// each singer's vocal is brought to the vocal target (different microphones and presets arrive at very
// different levels), and the whole mix is held under the mix target (a guard: it only ever turns down,
// so the Track / Vocal controls can be pushed without driving the limiter). It measures the INPUT, so
// the gain it wants is simply target − level, within [minDb, maxDb]; below the gate it holds still.
//
// Rates are in dB per second — slow (a phrase, never a syllable), `farMul` times faster while the level
// is more than `farDb` off (a new singer joins at the wrong level: fixed within a few seconds).
//
// processorOptions: { windowMs = 300, farDb = 6, farMul = 3 }   the RMS window (an exponential one), the "far" rule
// Parameters (k-rate): target dB, minDb, maxDb, gate dB, up dB/s, down dB/s.

class SvLevelerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'target', defaultValue: -16, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      { name: 'minDb', defaultValue: -12, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      { name: 'maxDb', defaultValue: 12, minValue: 0, maxValue: 40, automationRate: 'k-rate' },
      { name: 'gate', defaultValue: -50, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'up', defaultValue: 2, minValue: 0, maxValue: 60, automationRate: 'k-rate' },
      { name: 'down', defaultValue: 4, minValue: 0, maxValue: 60, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const windowMs = o.windowMs || 300;
    this.farDb = o.farDb || 6;
    this.farMul = o.farMul || 3;
    this.alpha = 1 - Math.exp(-128 / ((windowMs / 1000) * sampleRate)); // per 128-frame block
    this.alphaFast = 1 - Math.exp(-128 / (0.05 * sampleRate)); // the gate's own 50 ms view
    this.ms = 0; // mean square of what is sung, smoothed over the window (silence is not averaged in)
    this.fast = 0; // mean square right now, for the gate
    this.gainDb = 0;
    this.reportEvery = Math.max(1, Math.round(sampleRate / 128 / 4)); // 4 readings a second
    this.blocks = 0;
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
    // Level of this block: the mean square over channels and frames.
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const d = input[ch];
      for (let i = 0; i < frames; i++) sum += d[i] * d[i];
    }
    const blockMs = sum / (channels * frames);
    this.fast += (blockMs - this.fast) * this.alphaFast;
    const target = parameters.target[0];
    const minDb = parameters.minDb[0];
    const maxDb = parameters.maxDb[0];
    const from = this.gainDb;
    // The gate looks at the last 50 ms: the moment the singer stops, the level holds — and the pause is
    // not averaged into the window, so the next phrase is judged against what was sung, not the silence.
    const open = 10 * Math.log10(this.fast + 1e-12) > parameters.gate[0];
    let levelDb = 10 * Math.log10(this.ms + 1e-12);
    if (open) {
      this.ms += (blockMs - this.ms) * this.alpha;
      levelDb = 10 * Math.log10(this.ms + 1e-12);
      const wanted = Math.max(minDb, Math.min(maxDb, target - levelDb));
      const diff = wanted - this.gainDb;
      const far = Math.abs(diff) > this.farDb ? this.farMul : 1;
      const rate = (diff > 0 ? parameters.up[0] : parameters.down[0]) * far; // dB per second
      const step = (rate * frames) / sampleRate;
      this.gainDb += Math.max(-step, Math.min(step, diff));
    } else {
      // Nothing to measure: keep the gain inside the current limits anyway (they may have changed).
      this.gainDb = Math.max(minDb, Math.min(maxDb, this.gainDb));
    }
    // Apply with a linear ramp across the block (no zipper).
    const g0 = Math.pow(10, from / 20);
    const g1 = Math.pow(10, this.gainDb / 20);
    const dg = (g1 - g0) / frames;
    for (let ch = 0; ch < channels; ch++) {
      const d = input[ch];
      const o = output[ch];
      let g = g0;
      for (let i = 0; i < frames; i++) {
        o[i] = d[i] * g;
        g += dg;
      }
    }
    if (++this.blocks >= this.reportEvery) {
      this.blocks = 0;
      this.port.postMessage({ type: 'level', levelDb, gainDb: this.gainDb });
    }
    return true;
  }
}

registerProcessor('sv-leveler', SvLevelerProcessor);
