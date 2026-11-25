// SingersVoice — AudioWorklet 'sv-gate': the voice gate — a downward expander that lets the VOICE through and
// turns everything else down: the room (the hiss of a phone's mic, a fan, the street) and, since 24 Nov, the
// singer's own breaths and the noises of the microphone between phrases, however loud they are.
//
// A level alone cannot tell a breath from a soft phrase — a breath taken close to the microphone is as loud as
// quiet singing, and the chain behind this stage (the compressor's makeup, the parallel compressor, the rider,
// the mix bus's rider) lifts whatever passes until a breath in an interlude stands as loud as a sung line. So
// the gate opens on EVIDENCE OF A VOICE and closes without it:
//
//   · voiced: the input is periodic — a normalized autocorrelation (NSDF, the pitch tracker's measure) on a
//     decimated copy (12 kHz, a 32 ms window, 75 Hz–1 kHz) finds a clear period. Every sung vowel is; a
//     breath, a fan, a handling noise never are;
//   · loud: the level stands within `loudUnder` dB of the voice's own recent level (`singRef`, the level the
//     voiced moments reached, falling slowly) — a shout, a growl, a strong consonant at the singing level
//     (a breath taken close to the microphone stands 6–20 dB under it: never this);
//   · bright: the energy is mostly above 4 kHz and the level near the voice's (a sibilant: an "s", an "sh" starting a word);
//   · a transient: the level jumps `transientDb` within one hop (a plosive, the first syllable).
//   Each of these must also stand `offset` dB over the room (the floor, tracked as before: down at once to a
//   quieter moment, up slowly) — a fan's blade tone or music playing in the room is periodic too, but it is the
//   room, at its floor.
//
// With evidence the gate is open (gain 0 dB, reached in `attack`); voiced evidence holds it open `hold` s more
// (the tail of a word, the "s" at its end); the other kinds hold it a few tens of ms. Without any, the gain goes
// down to −`range` dB over `release` — a breath that starts right after a phrase is turned down from a few
// hundred ms into it, a breath in a break is turned down whole, a sung phrase that follows opens it within
// milliseconds. An expander, not a cut: at the default range (18 dB) a breath is softened out of the way, not
// chopped, and a sung phrase that this stage somehow doubts is softened at worst.
//
// Parameters (k-rate): enabled (0 bypasses), range dB, offset dB, thresholdMax dB (over this a sound is never the
// room), hold s, attack s, release s, loudUnder dB, transientDb. No latency. Reports { type: 'gate', floorDb, gainDb, voiced, singRef } four times a second.

const DECIM = 4; // 48 kHz → 12 kHz
const WIN = 384; // the analysis window, decimated samples (32 ms at 48 kHz)
const HOP = 64; // decimated samples between analyses (256 frames: 5.3 ms)
const CLARITY = 0.6; // NSDF over this: a period, a voice
const LAG_AGREE = 0.1; // the period found within this (fraction) of the last hop's: a voice holds its period for many hops; noise's chance peaks land anywhere
const SHORT_HOLD_S = 0.06; // the hold after unvoiced evidence (a transient, a sibilant, a loud moment)
const SING_REF_FALL_DB_PER_S = 2;
/** Where the voice's recent level starts (a leveled microphone's singing sits at −22…−30 dBFS RMS) and the least it falls to in a long break — so a breath or a noise before the first phrase is never "loud". */
const SING_REF_START = -30;
const SING_REF_MIN = -45;
const HF_RATIO = 0.6; // bright: this much of the hop's energy above the high-pass…
const BRIGHT_UNDER_DB = 12; // …and within this of the voice's recent level (an "s" starts a word at nearly the vowel's level; a breath's hiss sits far under it)

class SvGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'range', defaultValue: 18, minValue: 0, maxValue: 60, automationRate: 'k-rate' },
      { name: 'offset', defaultValue: 8, minValue: 0, maxValue: 30, automationRate: 'k-rate' },
      { name: 'thresholdMax', defaultValue: -34, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 0.15, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.003, minValue: 0.0005, maxValue: 0.1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.18, minValue: 0.01, maxValue: 3, automationRate: 'k-rate' },
      { name: 'loudUnder', defaultValue: 3, minValue: 0, maxValue: 30, automationRate: 'k-rate' },
      { name: 'transientDb', defaultValue: 10, minValue: 1, maxValue: 40, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.rms2 = 0; // the detector's mean square (~4 ms)
    this.floorDb = -60; // the room, tracked
    this.gainDb = 0; // the expander's gain now (≤ 0)
    this.floorRiseDbPerS = 2;
    this.reportLeft = 0;
    // The decimated copy for the period finder.
    this.det = new Float32Array(WIN * 2);
    this.detPos = 0;
    this.decAcc = 0;
    this.decCount = 0;
    this.hopCount = 0;
    this.lin = new Float32Array(WIN);
    this.minLag = Math.max(2, Math.round(sampleRate / DECIM / 1000)); // 1 kHz
    this.maxLag = Math.min(WIN - 2, Math.round(sampleRate / DECIM / 75)); // 75 Hz
    this.nsdf = new Float32Array(this.maxLag + 2);
    // The hop's own measures.
    this.hopX2 = 0; // energy of the hop (full rate)
    this.hopH2 = 0; // energy of the hop above the high-pass
    this.hopN = 0;
    this.hp = 0;
    this.hpPrev = 0;
    this.hpA = Math.exp((-2 * Math.PI * 4000) / sampleRate); // one-pole high-pass at 4 kHz
    this.prevHopDb = -120;
    this.singRef = SING_REF_START; // the voice's own recent level (dB RMS of the hop)
    this.lastPeriod = 0;
    this.voiced = false;
    this.evidence = false;
    this.holdUntil = 0; // in frames (this.clock)
    this.clock = 0;
  }

  /** One hop of the decimated copy is in: the period (decimated samples) found in the last WIN samples, 0 when there is none. */
  _period() {
    const n = WIN;
    const det = this.det;
    const lin = this.lin;
    const start = (this.detPos - n + det.length) % det.length;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = det[(start + i) % det.length];
      lin[i] = v;
      energy += v * v;
    }
    if (energy / n < 1e-9) return 0; // −90 dB: nothing to find a period in
    const nsdf = this.nsdf;
    const minLag = this.minLag;
    const maxLag = this.maxLag;
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
    // The first key maximum over 0.8 of the global one (McLeod): its clarity says whether this is a voice.
    let globalMax = 0;
    for (let tau = minLag; tau <= maxLag; tau++) if (nsdf[tau] > globalMax) globalMax = nsdf[tau];
    if (globalMax < CLARITY) return 0;
    const threshold = 0.8 * globalMax;
    for (let tau = minLag + 1; tau < maxLag; tau++) {
      if (nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1] && nsdf[tau] >= threshold) return nsdf[tau] >= CLARITY ? tau : 0;
    }
    return 0;
  }

  /** The end of a hop: the evidence for this one, and the hold it earns. */
  _analyse(parameters) {
    const hopDb = this.hopN ? 10 * Math.log10(this.hopX2 / this.hopN + 1e-12) : -120;
    const hfRatio = this.hopX2 > 0 ? this.hopH2 / this.hopX2 : 0;
    // Over the room: `offset` dB over the floor — but never asked past `thresholdMax` (the floor climbs 2 dB/s through a long
    // phrase; a sound over −34 dBFS is singing, not the room, however long the phrase has run).
    const overRoom = hopDb >= Math.min(parameters.thresholdMax[0], this.floorDb + parameters.offset[0]);
    // Voiced: a period found now and in the hop before, the two agreeing — a voice keeps its period; noise's chance peaks do not.
    // (over the room as well: a fan's blade tone, a fridge, music playing in the room are periodic too — but they ARE
    // the room, at its floor; a voice stands over it)
    const period = hopDb > -70 && overRoom ? this._period() : 0;
    const voiced = period > 0 && this.lastPeriod > 0 && Math.abs(period - this.lastPeriod) <= LAG_AGREE * period;
    this.lastPeriod = period;
    const hopS = (HOP * DECIM) / sampleRate;
    this.singRef = Math.max(SING_REF_MIN, this.singRef - SING_REF_FALL_DB_PER_S * hopS);
    if (voiced && hopDb > this.singRef) this.singRef = hopDb;
    const loud = overRoom && hopDb >= this.singRef - parameters.loudUnder[0];
    const bright = overRoom && hfRatio >= HF_RATIO && hopDb >= this.singRef - BRIGHT_UNDER_DB;
    const transient = overRoom && hopDb - this.prevHopDb >= parameters.transientDb[0] && hopDb > -50;
    this.prevHopDb = hopDb;
    this.voiced = voiced;
    this.evidence = voiced || loud || bright || transient;
    if (voiced) this.holdUntil = this.clock + Math.round(parameters.hold[0] * sampleRate);
    else if (this.evidence) this.holdUntil = Math.max(this.holdUntil, this.clock + Math.round(SHORT_HOLD_S * sampleRate));
    this.hopX2 = 0;
    this.hopH2 = 0;
    this.hopN = 0;
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
    const aDet = Math.exp(-1 / (0.004 * sampleRate)); // the detector: ~4 ms
    const aAtk = Math.exp(-1 / (parameters.attack[0] * sampleRate));
    const aRel = Math.exp(-1 / (parameters.release[0] * sampleRate));
    const floorRise = this.floorRiseDbPerS / sampleRate;
    const det = this.det;
    let rms2 = this.rms2;
    let floorDb = this.floorDb;
    let gainDb = this.gainDb;
    let hp = this.hp;
    let hpPrev = this.hpPrev;
    const hpA = this.hpA;
    for (let i = 0; i < frames; i++) {
      let x = 0;
      for (let ch = 0; ch < channels; ch++) x += input[ch][i];
      x /= channels;
      const x2 = x * x;
      rms2 = x2 + aDet * (rms2 - x2);
      const levelDb = rms2 > 1e-12 ? 10 * Math.log10(rms2) : -120;
      // The floor: down at once to a quieter moment, up slowly — the room, never a held note (a note is over before the floor reaches it).
      if (levelDb < floorDb) floorDb = levelDb;
      else floorDb += floorRise;
      if (floorDb < -90) floorDb = -90;
      // The hop's energy, whole and above 4 kHz.
      hp = hpA * (hp + x - hpPrev);
      hpPrev = x;
      this.hopX2 += x2;
      this.hopH2 += hp * hp;
      this.hopN++;
      // The decimated copy (12 kHz): every DECIM samples averaged into the ring; every HOP of them an analysis.
      this.decAcc += x;
      if (++this.decCount === DECIM) {
        det[this.detPos] = this.decAcc / DECIM;
        this.detPos = (this.detPos + 1) % det.length;
        this.decAcc = 0;
        this.decCount = 0;
        if (++this.hopCount >= HOP) {
          this.hopCount = 0;
          this._analyse(parameters);
        }
      }
      this.clock++;
      const open = this.evidence || this.clock < this.holdUntil;
      const wantDb = open ? 0 : -range;
      if (wantDb > gainDb) gainDb = wantDb + aAtk * (gainDb - wantDb);
      else gainDb = wantDb + aRel * (gainDb - wantDb);
      const g = Math.pow(10, gainDb / 20);
      for (let ch = 0; ch < channels; ch++) output[ch][i] = input[ch][i] * g;
    }
    this.rms2 = rms2;
    this.floorDb = floorDb;
    this.gainDb = gainDb;
    this.hp = hp;
    this.hpPrev = hpPrev;
    // Now and then, what the gate sees (support / tests): the floor, the gain, whether it hears a voice.
    if ((this.reportLeft -= frames) <= 0) {
      this.reportLeft = Math.round(sampleRate / 4);
      this.port.postMessage({ type: 'gate', floorDb: Math.round(floorDb), gainDb: Math.round(gainDb * 10) / 10, voiced: this.voiced, singRef: Math.round(this.singRef) });
    }
    return true;
  }
}

registerProcessor('sv-gate', SvGateProcessor);
