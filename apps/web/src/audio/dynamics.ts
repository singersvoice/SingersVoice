/**
 * Dynamics that do what they say.
 *
 * The browser's DynamicsCompressorNode (the same Blink/WebKit kernel in Chrome, Edge, Safari and
 * Firefox) quietly adds two things: an automatic makeup gain — (1 / its gain at 0 dBFS)^0.6, which is
 * +6.9 dB on a −20 dB / 3:1 vocal compressor and +14.5 dB on a −30 dB / 6.5:1 one, so a de-esser built
 * on it BOOSTS the top band by 14 dB — and a fixed 6 ms lookahead delay, so anything summed with it in
 * parallel (a dry path) lands 6 ms early and comb-filters. A WaveShaper with oversampling delays too
 * (128 frames at 2x, 192 at 4x).
 *
 * `compressorMakeupDb` reproduces the kernel's knee maths exactly, so a native node can be corrected
 * with a gain of −makeup after it; `makeCompressor` prefers the 'sv-dynamics' worklet (explicit makeup,
 * a lookahead of our choosing, no hidden delay) and falls back to a corrected native node.
 */

export const COMPRESSOR_LOOKAHEAD_S = 0.006;
/** A limiter's ratio: as good as a wall in the worklet (the native node stops at 20:1 — a twentieth of any overshoot leaks). */
export const LIMITER_RATIO = 1000;
/** Our limiters look 2 ms ahead (the gain is down before the peak arrives; the attack is a third of that). */
export const LIMITER_LOOKAHEAD_S = 0.002;
/** The DynamicsCompressorNode's lookahead, in frames (288 at 48 kHz, 264 at 44.1 kHz). */
export const compressorLatencyFrames = (sampleRate: number): number => Math.floor(COMPRESSOR_LOOKAHEAD_S * sampleRate);
/** A WaveShaperNode's latency by oversampling mode, in frames (any sample rate). */
export const SHAPER_LATENCY_FRAMES: Record<OverSampleType, number> = { none: 0, '2x': 128, '4x': 192 };

const dbToLin = (db: number): number => Math.pow(10, db / 20);
const linToDb = (x: number): number => 20 * Math.log10(x);

/**
 * The automatic makeup gain (dB) the DynamicsCompressorNode applies for these settings — what every
 * signal under the threshold is lifted by. The kernel's exponential knee: `k` is solved so the knee
 * curve meets the ratio's slope at threshold + knee, then makeup = −0.6 × (gain at 0 dBFS in dB).
 */
export function compressorMakeupDb(thresholdDb: number, kneeDb: number, ratio: number): number {
  if (ratio <= 1 && kneeDb <= 0) return 0;
  const linearThreshold = dbToLin(thresholdDb);
  const kneeThresholdDb = thresholdDb + kneeDb;
  const kneeThreshold = dbToLin(kneeThresholdDb);
  const kneeCurve = (x: number, k: number): number => (x < linearThreshold ? x : linearThreshold + (1 - Math.exp(-k * (x - linearThreshold))) / k);
  const slopeAt = (x: number, k: number): number => {
    if (x < linearThreshold) return 1;
    const x2 = x * 1.001;
    return (linToDb(kneeCurve(x2, k)) - linToDb(kneeCurve(x, k))) / (linToDb(x2) - linToDb(x));
  };
  const slope = 1 / ratio;
  let minK = 0.1;
  let maxK = 10000;
  let k = 5;
  for (let i = 0; i < 15; i++) {
    if (slopeAt(kneeThreshold, k) < slope) maxK = k;
    else minK = k;
    k = Math.sqrt(minK * maxK);
  }
  const yKneeThresholdDb = linToDb(kneeCurve(kneeThreshold, k));
  const fullRangeGain = 1 < kneeThreshold ? kneeCurve(1, k) : dbToLin(yKneeThresholdDb + slope * (0 - kneeThresholdDb));
  return linToDb(Math.pow(1 / fullRangeGain, 0.6));
}

export interface CompressorSettings {
  thresholdDb: number;
  kneeDb: number;
  ratio: number;
  attackS: number;
  releaseS: number;
  /** The makeup gain actually wanted (dB); the node's own automatic one is taken out. */
  makeupDb?: number;
}

export interface Compressor {
  input: AudioNode;
  output: AudioNode;
  /** Frames the signal is delayed by (align any parallel path with a DelayNode of this length). */
  latencyFrames: number;
  set(s: CompressorSettings, at?: number): void;
  disconnect(): void;
}

/**
 * A compressor: the 'sv-dynamics' worklet with `lookaheadFrames` (0 for a compressor, a few dozen for a
 * limiter) when worklets are loaded, else the native node with its makeup corrected and its 6 ms latency
 * reported. Parameter changes glide over `ramp` seconds (never a click on a preset change).
 */
export function makeCompressor(ctx: BaseAudioContext, workletAvailable: boolean, opts: { lookaheadFrames?: number; ramp?: number } = {}): Compressor {
  const ramp = opts.ramp ?? 0.03;
  const look = opts.lookaheadFrames ?? 0;
  // The first settings land at once (a limiter must be a limiter from its first frame); later ones glide.
  let first = true;
  const move = (p: AudioParam, value: number, at: number) => {
    if (first) p.setValueAtTime(value, at);
    else p.setTargetAtTime(value, at, ramp);
  };
  if (workletAvailable) {
    try {
      const node = new AudioWorkletNode(ctx, 'sv-dynamics', { numberOfInputs: 1, numberOfOutputs: 1, processorOptions: { lookaheadFrames: look } });
      const param = (name: string) => node.parameters.get(name)!;
      return {
        input: node,
        output: node,
        latencyFrames: look,
        set(s, at = ctx.currentTime) {
          move(param('threshold'), s.thresholdDb, at);
          move(param('knee'), s.kneeDb, at);
          move(param('ratio'), s.ratio, at);
          move(param('attack'), s.attackS, at);
          move(param('release'), s.releaseS, at);
          move(param('makeup'), s.makeupDb ?? 0, at);
          first = false;
        },
        disconnect() {
          node.disconnect();
        },
      };
    } catch {
      /* the worklet module is not loaded on this context: native below */
    }
  }
  const comp = ctx.createDynamicsCompressor();
  const trim = ctx.createGain();
  comp.connect(trim);
  return {
    input: comp,
    output: trim,
    latencyFrames: compressorLatencyFrames(ctx.sampleRate),
    set(s, at = ctx.currentTime) {
      const ratio = Math.min(20, s.ratio); // the node's range
      move(comp.threshold, s.thresholdDb, at);
      move(comp.knee, s.kneeDb, at);
      move(comp.ratio, ratio, at);
      move(comp.attack, s.attackS, at);
      move(comp.release, s.releaseS, at);
      move(trim.gain, dbToLin((s.makeupDb ?? 0) - compressorMakeupDb(s.thresholdDb, s.kneeDb, ratio)), at);
      first = false;
    },
    disconnect() {
      comp.disconnect();
      trim.disconnect();
    },
  };
}

/** A soft clipper's transfer curve: straight up to `knee`, a smooth tanh bend above, never past ±1. */
export function clipperCurve(knee: number, n = 4096): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    curve[i] = a <= knee ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
  }
  return curve;
}

export interface SafetyStage {
  input: AudioNode;
  output: AudioNode;
  limiter: Compressor;
  latencyFrames: number;
}

/**
 * The end of every bus: a brick-wall stage — a limiter at `ceilingDb` (its makeup taken out, so the
 * ceiling is the ceiling) and a soft clipper behind it that only bends what the limiter lets through
 * (the native fallback leaks a twentieth of any overshoot; the clipper is straight up to −1.4 dB), so
 * nothing above full scale ever reaches an encoder — a clipped encoder crackles.
 */
export function safetyStage(ctx: BaseAudioContext, workletAvailable = false, ceilingDb = -3): SafetyStage {
  const limiter = makeCompressor(ctx, workletAvailable, { lookaheadFrames: Math.round(LIMITER_LOOKAHEAD_S * ctx.sampleRate), ramp: 0.01 });
  limiter.set({ thresholdDb: ceilingDb, kneeDb: 0, ratio: LIMITER_RATIO, attackS: 0.0003, releaseS: 0.1, makeupDb: 0 }, 0);
  const clip = ctx.createWaveShaper();
  clip.curve = clipperCurve(0.85);
  clip.oversample = '2x';
  limiter.output.connect(clip);
  return { input: limiter.input, output: clip, limiter, latencyFrames: limiter.latencyFrames + SHAPER_LATENCY_FRAMES['2x'] };
}
