// SingersVoice — AudioWorklet 'sv-ducker': the music steps back under the voice. Two inputs: the signal to
// duck (the backing track, input 0) and the key (the voices, input 1); one output: the signal, turned down by
// `depth` dB while the key is heard — above `gate` dB (its level over the last 20 ms) — and back up when it
// is not. The gain moves with one-pole time constants (`attack` s down, `release` s up), so a phrase's first
// word pulls the music back within a few dozen milliseconds and a breath between words does not bring it
// back: a mix trick as old as radio, the one thing that makes a voice sit in front of a full track without
// either having to be louder than it is. The output is the signal alone (the key is only listened to).
//
// Parameters (k-rate): depth dB (0: off), gate dB, attack s, release s. Posts { type: 'duck', gainDb } four times a second.

class SvDuckerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'depth', defaultValue: 2.5, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
      { name: 'gate', defaultValue: -40, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.04, minValue: 0.001, maxValue: 2, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.35, minValue: 0.01, maxValue: 5, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.keyMs = 0; // the key's mean square, smoothed over 20 ms
    this.alphaKey = 1 - Math.exp(-128 / (0.02 * sampleRate));
    this.gainDb = 0;
    this.reportEvery = Math.max(1, Math.round(sampleRate / 128 / 4));
    this.blocks = 0;
  }

  process(inputs, outputs, parameters) {
    const signal = inputs[0];
    const key = inputs[1];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const channels = Math.min(signal ? signal.length : 0, output.length);
    if (channels === 0) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }
    // The key's level over this block.
    let sum = 0;
    const keyChannels = key ? key.length : 0;
    for (let ch = 0; ch < keyChannels; ch++) {
      const d = key[ch];
      for (let i = 0; i < frames; i++) sum += d[i] * d[i];
    }
    const blockMs = keyChannels ? sum / (keyChannels * frames) : 0;
    this.keyMs += (blockMs - this.keyMs) * this.alphaKey;
    const keyDb = 10 * Math.log10(this.keyMs + 1e-12);
    const depth = parameters.depth[0];
    const wanted = depth > 0 && keyDb > parameters.gate[0] ? -depth : 0;
    const tc = wanted < this.gainDb ? parameters.attack[0] : parameters.release[0];
    const from = this.gainDb;
    this.gainDb += (wanted - this.gainDb) * (1 - Math.exp(-frames / (tc * sampleRate)));
    const g0 = Math.pow(10, from / 20);
    const g1 = Math.pow(10, this.gainDb / 20);
    const dg = (g1 - g0) / frames;
    for (let ch = 0; ch < channels; ch++) {
      const d = signal[ch];
      const o = output[ch];
      let g = g0;
      for (let i = 0; i < frames; i++) {
        o[i] = d[i] * g;
        g += dg;
      }
    }
    if (++this.blocks >= this.reportEvery) {
      this.blocks = 0;
      this.port.postMessage({ type: 'duck', gainDb: this.gainDb, keyDb });
    }
    return true;
  }
}

registerProcessor('sv-ducker', SvDuckerProcessor);
