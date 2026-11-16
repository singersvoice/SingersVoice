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
// The floor (a vocal rider's option): a microphone's own hiss, a fan, a room — steady, above the gate on
// a laptop's built-in mic — must never be "sung" up to the target, nor the guard then squash the whole
// mix under it. With `floorMargin` > 0 the processor tracks the quietest the input has lately been (the
// floor: the 50 ms level's minimum over the last `floorSeconds`) and opens only for sound standing
// `floorMargin` dB above it — a voice, never a steady hiss; and it never raises the floor past
// `floorKeep` dB under the target (the gain is capped by the floor: a noisy microphone gets a quieter
// voice rather than a loud hiss between the phrases).
//
// processorOptions: { windowMs = 300, farDb = 6, farMul = 3, floorMargin = 0, floorKeep = 12, floorSeconds = 8 }
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
    this.floorMargin = o.floorMargin || 0;
    this.floorKeep = o.floorKeep === undefined ? 12 : o.floorKeep;
    this.bucketBlocks = Math.max(1, Math.round(((o.floorSeconds || 8) / 2) * (sampleRate / 128))); // two buckets span floorSeconds
    this.bucketLeft = this.bucketBlocks;
    this.bucketMin = Infinity;
    this.prevMin = Infinity;
    this.floorDb = -Infinity; // the quietest 50 ms level lately
    this.warm = Math.round((0.2 * sampleRate) / 128); // the 50 ms view's own settling: not a floor
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
    let maxDb = parameters.maxDb[0];
    const from = this.gainDb;
    // The gate looks at the last 50 ms: the moment the singer stops, the level holds — and the pause is
    // not averaged into the window, so the next phrase is judged against what was sung, not the silence.
    const fastDb = 10 * Math.log10(this.fast + 1e-12);
    let open = fastDb > parameters.gate[0];
    if (this.floorMargin > 0) {
      // The floor: the quietest 50 ms the input has had over the last `floorSeconds` (two buckets' minimum — it
      // follows a quieter input at once and a louder one within a bucket, and a phrase's own breath dips keep it
      // under the voice). A sound has to stand well above it to be a voice. The first 200 ms are the 50 ms view
      // filling up, not a floor: the gate stays shut and the floor starts from where the input really is.
      if (this.warm > 0) {
        this.warm--;
        this.bucketMin = fastDb;
        open = false;
      } else if (fastDb < this.bucketMin) this.bucketMin = fastDb;
      if (--this.bucketLeft <= 0) {
        this.prevMin = this.bucketMin;
        this.bucketMin = fastDb;
        this.bucketLeft = this.bucketBlocks;
      }
      this.floorDb = Math.min(this.prevMin, this.bucketMin);
      open = open && fastDb > this.floorDb + this.floorMargin;
      maxDb = Math.min(maxDb, Math.max(minDb, target - this.floorKeep - this.floorDb)); // the floor stays under the target by floorKeep
    }
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
