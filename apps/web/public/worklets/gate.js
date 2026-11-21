// SingersVoice — AudioWorklet 'sv-gate': a downward expander that keeps the room out of the vocal.
//
// Between phrases a microphone picks up the room — the hiss of a phone's mic, a fan, the street — and
// the chain behind this stage (the compressor's makeup, the parallel compressor, the exciter, the air
// shelf, the rider) lifts all of it until it hisses over the track. This stage turns the room down
// while nobody sings and gets out of the way the moment somebody does:
//
//   · the detector is the smoothed RMS of the input (a few ms), in dB;
//   · the noise floor is tracked from it: the floor drops to the level at once and climbs slowly
//     (`floorRiseDbPerS`), so it sits on the room, never on the voice;
//   · the threshold is the floor plus `offset` dB (6–12 dB above the room; never above `thresholdMax`,
//     so a singer who sings softly in a noisy room is not gated with the room);
//   · below the threshold the gain falls `ratio` dB per dB — a soft knee of `knee` dB around it — down
//     to `range` dB at most (an expander, not a hard gate: a breath is softened, not cut);
//   · the gain opens in `attack` s, holds `hold` s after the voice, and closes over `release` s — never
//     a chatter on a word's tail.
//
// `enabled` 0 bypasses (gain 1). No latency.

class SvGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'range', defaultValue: 18, minValue: 0, maxValue: 60, automationRate: 'k-rate' },
      { name: 'offset', defaultValue: 8, minValue: 0, maxValue: 30, automationRate: 'k-rate' },
      { name: 'thresholdMax', defaultValue: -34, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 3, minValue: 1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'knee', defaultValue: 6, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.003, minValue: 0.0005, maxValue: 0.1, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 0.12, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.18, minValue: 0.01, maxValue: 3, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.rms2 = 0; // the detector's mean square
    this.floorDb = -60; // the room, tracked
    this.gainDb = 0; // the expander's gain now (≤ 0)
    this.holdLeft = 0; // frames of hold left after the last open moment
    this.floorRiseDbPerS = 2;
    this.reportLeft = 0;
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
      this.gainDb = 0;
      return true;
    }
    const range = parameters.range[0];
    const offset = parameters.offset[0];
    const thresholdMax = parameters.thresholdMax[0];
    const ratio = parameters.ratio[0];
    const knee = parameters.knee[0];
    const aDet = Math.exp(-1 / (0.004 * sampleRate)); // the detector: ~4 ms
    const aAtk = Math.exp(-1 / (parameters.attack[0] * sampleRate));
    const aRel = Math.exp(-1 / (parameters.release[0] * sampleRate));
    const holdFrames = Math.round(parameters.hold[0] * sampleRate);
    const floorRise = this.floorRiseDbPerS / sampleRate;
    const slope = ratio - 1; // dB of cut per dB under the threshold
    let rms2 = this.rms2;
    let floorDb = this.floorDb;
    let gainDb = this.gainDb;
    let holdLeft = this.holdLeft;
    for (let i = 0; i < frames; i++) {
      let x2 = 0;
      for (let ch = 0; ch < channels; ch++) {
        const v = input[ch][i];
        x2 += v * v;
      }
      x2 /= channels;
      rms2 = x2 + aDet * (rms2 - x2);
      const levelDb = rms2 > 1e-12 ? 10 * Math.log10(rms2) : -120;
      // The floor: down at once to a quieter moment, up slowly — the room, never a held note (a note is over before the floor reaches it).
      if (levelDb < floorDb) floorDb = levelDb;
      else floorDb += floorRise;
      if (floorDb < -90) floorDb = -90;
      const threshold = Math.min(thresholdMax, floorDb + offset);
      const under = threshold - levelDb; // > 0: below the threshold
      let wantDb;
      if (under <= -knee / 2) wantDb = 0;
      else if (under >= knee / 2) wantDb = -slope * under;
      else {
        const t = under + knee / 2;
        wantDb = (-slope * t * t) / (2 * knee);
      }
      if (wantDb < -range) wantDb = -range;
      if (wantDb >= -0.01) {
        holdLeft = holdFrames; // open: the hold starts over
        gainDb = wantDb + aAtk * (gainDb - wantDb);
      } else if (holdLeft > 0) {
        holdLeft--; // the tail of a word: held open
        gainDb = aAtk * gainDb; // (toward 0, if it was below)
      } else gainDb = wantDb + aRel * (gainDb - wantDb);
      const g = Math.pow(10, gainDb / 20);
      for (let ch = 0; ch < channels; ch++) output[ch][i] = input[ch][i] * g;
    }
    this.rms2 = rms2;
    this.floorDb = floorDb;
    this.gainDb = gainDb;
    this.holdLeft = holdLeft;
    // Now and then, what the gate sees (support / tests): the floor and the gain.
    if ((this.reportLeft -= frames) <= 0) {
      this.reportLeft = Math.round(sampleRate / 4);
      this.port.postMessage({ type: 'gate', floorDb: Math.round(floorDb), gainDb: Math.round(gainDb * 10) / 10 });
    }
    return true;
  }
}

registerProcessor('sv-gate', SvGateProcessor);
