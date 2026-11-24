/**
 * The mix every listener gets — the saved show, the audience's "Hear the stage", the broadcast —
 * built the same way everywhere, so it never depends on what file the track came from, which
 * microphone a singer has or how they set their effects:
 *
 *   track ─ normalisation ─ pocket EQ ─ limiter ─ duck ─ Track offset ─┐
 *   vocal₁ ─ rider ─ limiter ─┐                        ▲               ├─ sum ─ guard ─ limiter ─ soft clip ─ out
 *   vocal₂ ─ rider ─ limiter ─┴─ Vocal offset ─────────┴───────────────┘
 *
 * The track is brought to MIX_TARGETS.trackLufs (measured once, see loudness.ts) and given its place:
 * the pocket EQ takes a little of the low end and of the presence region (where a voice lives) off the
 * music, and the duck steps the music back by MIX_TARGETS.duckDb while a voice is sung (the voices
 * key it) — the voice in front without either having to be louder than it is; the music's own peaks are
 * held under TRACK_CEILING_DB so the sum's limiter is not driven by the music alone. Each vocal has a slow
 * rider steering it to MIX_TARGETS.vocalDb (K-weighted: the ear's measure) and a limiter of its own
 * under the vocal ceiling (a hot peak never reaches the sum); the two offsets are the device's Track /
 * Vocal controls (dB, ±30, a balance on top of a mix that is already right); the guard (K-weighted)
 * only ever turns the sum down, past MIX_TARGETS.mixDb, so pushing both controls up cannot drive the
 * limiter into crackling; the limiter and clipper keep every sample under the ceiling. Without
 * worklets (no riders, no duck, no guard) the plain gains, the pocket EQ and a corrected native
 * limiter remain.
 */
import { dbToGain } from './gain.ts';
import { makeCompressor, safetyStage, type Compressor, type SafetyStage, LIMITER_LOOKAHEAD_S, LIMITER_RATIO } from './dynamics.ts';
import { kWeighting, MIX_TARGETS, PERFORMER_MONITOR } from './loudness.ts';

/** The buses' ceiling (dBFS): an AAC encoder overshoots a dense mix by about half a decibel; this keeps the decoded file under full scale (the studio e2e measures the saved file's true peak). */
export const MIX_CEILING_DB = -1.5;
/** Each vocal's own ceiling in the mix (dBFS), after its rider: its loudest peak is held here before the sum (the density of a record's vocal; the sum's own ceiling is half a decibel under it). */
export const VOCAL_CEILING_DB = -1;
/** The vocal limiter's release (s): short enough to give the level back between a voice's peaks (the loudness a record's vocal has under its ceiling), long enough never to ripple within a note. */
export const VOCAL_LIMITER_RELEASE_S = 0.05;
/**
 * The music's own ceiling in the mix (dBFS), after its pocket (24 Nov): a mastered track brought to −14 LUFS peaks
 * near the bus's ceiling on its own, and a voice on top of it drove the sum's limiter into taking 2 LU off every
 * sung phrase — the voice lost what its rider gave it. Its loudest peaks held here (a limiter with the same
 * lookahead as the voices', so the two stay in time) cost the music a fraction of a decibel and leave the sum's
 * limiter the little it should do. The singer's ears take the track from the player, not from here.
 */
export const TRACK_CEILING_DB = -4;
/**
 * The music's pocket: a shade off the low end (a bass-heavy backing masks a voice and eats the limiter) and off
 * the presence region (2–5 kHz, where a voice lives), and the rumble under 30 Hz gone — static, gentle, on every
 * track; the voice gets the room, the music keeps its weight.
 */
export const TRACK_POCKET = { hpfHz: 30, lowShelfHz: 100, lowShelfDb: -2, presenceHz: 3000, presenceQ: 0.8, presenceDb: -1.5, makeupDb: 1 } as const;
/** The duck under a voice: how fast the music steps back when a phrase starts and how slowly it comes back after one. */
export const DUCK = { gateDb: -40, attackS: 0.04, releaseS: 0.35 } as const;

export interface LevelerConfig {
  target: number;
  minDb: number;
  maxDb: number;
  gate: number;
  /** dB per second, up and down; `farMul` times faster while more than `farDb` off. */
  up: number;
  down: number;
  windowMs: number;
  farDb: number;
  farMul: number;
  /**
   * The floor rule (0: none): the rider opens only for sound standing this many dB above the quietest the input has
   * lately been (its floor — a microphone's hiss, a fan, the room), and never raises that floor past `floorKeep` dB
   * under the target. Without it a dead-quiet microphone's floor was riden up by the full `maxDb` into a loud hiss,
   * and the guard then held the whole mix under it.
   */
  floorMargin?: number;
  floorKeep?: number;
  /** How far back the floor looks (s). */
  floorSeconds?: number;
  /** Measure through the K-weighting (BS.1770: the ear's weighting, the bass counting for less) — the target is then LUFS-like. */
  kWeighted?: boolean;
}

/**
 * The per-vocal rider (PUBLISH MODE): a slow level that brings each voice to the publish vocal target — a
 * two-second view, 1.5 dB/s (a singer's offset, not their phrasing), four times faster until it is within
 * 6 dB (a quiet microphone is up front within the first lines, not the first minute) — and holds still
 * between phrases (the gate is above breath and room noise). A voice is what stands 8 dB above the
 * microphone's own floor; the floor is kept 12 dB under the vocal target, whatever that costs a quiet singer
 * on a noisy microphone. It measures K-weighted, as the ear does: the target is LUFS-like.
 */
export const VOCAL_RIDER: LevelerConfig = { target: MIX_TARGETS.vocalDb, minDb: -12, maxDb: 26, gate: -45, up: 1.5, down: 2, windowMs: 2000, farDb: 6, farMul: 4, floorMargin: 8, floorKeep: 12, floorSeconds: 8, kWeighted: true };
/** The monitor's rider (PERFORMER MODE): the same rider, to the singer's own level in their ears — about half as loud as the published voice (loudness.ts PERFORMER_MONITOR; its own number, never the bus's). */
export const MONITOR_RIDER: LevelerConfig = { ...VOCAL_RIDER, target: PERFORMER_MONITOR.vocalDb };
/** The guard on the sum: turns down (never up) when the mix runs hotter than the mix target on average — K-weighted, so a bass-heavy track is judged by its loudness. */
export const MIX_GUARD: LevelerConfig = { target: MIX_TARGETS.mixDb, minDb: -36, maxDb: 0, gate: -40, up: 1, down: 2, windowMs: 600, farDb: 6, farMul: 3, kWeighted: true };

/** An 'sv-leveler' node set up from a config (null when the worklet is not on this context). */
export function leveler(ctx: BaseAudioContext, cfg: LevelerConfig): AudioWorkletNode | null {
  try {
    const node = new AudioWorkletNode(ctx, 'sv-leveler', { numberOfInputs: 1, numberOfOutputs: 1, processorOptions: { windowMs: cfg.windowMs, farDb: cfg.farDb, farMul: cfg.farMul, floorMargin: cfg.floorMargin ?? 0, floorKeep: cfg.floorKeep ?? 12, floorSeconds: cfg.floorSeconds ?? 8, kWeight: cfg.kWeighted ? kWeighting(ctx.sampleRate) : null } });
    for (const k of ['target', 'minDb', 'maxDb', 'gate', 'up', 'down'] as const) node.parameters.get(k)?.setValueAtTime(cfg[k], 0);
    return node;
  } catch {
    return null;
  }
}

export interface MixVocal {
  /** The voice after its rider and limiter — tap this for a monitor. */
  out: AudioNode;
}

/** The track's pocket EQ (see TRACK_POCKET): three biquads in a row, the same in every bus. */
export function trackPocket(ctx: BaseAudioContext): { input: AudioNode; output: AudioNode; nodes: AudioNode[] } {
  const hpf = ctx.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = TRACK_POCKET.hpfHz;
  hpf.Q.value = 20 * Math.log10(Math.SQRT1_2); // Butterworth (the browser takes this Q in dB)
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = TRACK_POCKET.lowShelfHz;
  low.gain.value = TRACK_POCKET.lowShelfDb;
  const pres = ctx.createBiquadFilter();
  pres.type = 'peaking';
  pres.frequency.value = TRACK_POCKET.presenceHz;
  pres.Q.value = TRACK_POCKET.presenceQ;
  pres.gain.value = TRACK_POCKET.presenceDb;
  const makeup = ctx.createGain(); // what the pocket takes off a typical track's loudness, given back: the track lands at its target
  makeup.gain.value = dbToGain(TRACK_POCKET.makeupDb);
  hpf.connect(low).connect(pres).connect(makeup);
  return { input: hpf, output: makeup, nodes: [hpf, low, pres, makeup] };
}

export class MixBus {
  readonly ctx: BaseAudioContext;
  /** Connect the backing track here (as it comes; `setBackingNormalization` moves it to the target). */
  readonly backingIn: GainNode;
  /** The track at its mix level (normalised, offset applied) — tap this for a monitor. */
  readonly backingOut: GainNode;
  /** The sum of track and voices before the guard and the safety stage. */
  readonly sum: GainNode;
  /** The finished mix: feed this to a recorder, an encoder, the speakers. */
  readonly output: AudioNode;
  readonly safety: SafetyStage;
  private readonly backingNorm: GainNode;
  private readonly pocket: { input: AudioNode; output: AudioNode; nodes: AudioNode[] };
  private readonly trackLimiter: Compressor;
  private readonly ducker: AudioWorkletNode | null;
  private readonly vocalOffset: GainNode;
  private readonly guard: AudioWorkletNode | null;
  private vocals = new Map<string, { source: AudioNode; rider: AudioWorkletNode | null; limiter: Compressor; out: GainNode; meter: AnalyserNode }>();
  private balance = { trackDb: 0, vocalDb: 0 };
  readonly workletAvailable: boolean;
  /** A meter on the track (after normalisation and offset) and on every voice (after its rider): what each source brings to the mix, in dB, for the stage's mix line. */
  private readonly backingMeter: AnalyserNode;
  private meterBuf = new Float32Array(2048);
  /** The duck as it stands (dB, ≤ 0): what the music is stepped back by right now (the lab, the stage's mix line). */
  duckDb = 0;

  constructor(ctx: BaseAudioContext, workletAvailable: boolean, opts: { ceilingDb?: number } = {}) {
    this.ctx = ctx;
    this.workletAvailable = workletAvailable;
    this.backingIn = ctx.createGain();
    this.backingNorm = ctx.createGain();
    this.backingOut = ctx.createGain();
    this.vocalOffset = ctx.createGain();
    this.sum = ctx.createGain();
    this.pocket = trackPocket(ctx);
    this.trackLimiter = makeCompressor(ctx, workletAvailable, { lookaheadFrames: Math.round(LIMITER_LOOKAHEAD_S * ctx.sampleRate), ramp: 0.01 });
    this.trackLimiter.set({ thresholdDb: TRACK_CEILING_DB, kneeDb: 0, ratio: LIMITER_RATIO, attackS: 0.0003, releaseS: 0.1, makeupDb: 0 }, 0);
    this.ducker = workletAvailable ? this.makeDucker() : null;
    this.backingIn.connect(this.backingNorm).connect(this.pocket.input);
    this.pocket.output.connect(this.trackLimiter.input);
    if (this.ducker) {
      this.trackLimiter.output.connect(this.ducker, 0, 0);
      this.vocalOffset.connect(this.ducker, 0, 1); // the voices key the duck
      this.ducker.connect(this.backingOut);
    } else this.trackLimiter.output.connect(this.backingOut);
    this.backingOut.connect(this.sum);
    this.vocalOffset.connect(this.sum);
    this.backingMeter = ctx.createAnalyser();
    this.backingMeter.fftSize = 2048;
    this.backingOut.connect(this.backingMeter);
    this.guard = workletAvailable ? leveler(ctx, MIX_GUARD) : null;
    this.safety = safetyStage(ctx, workletAvailable, opts.ceilingDb ?? MIX_CEILING_DB);
    if (this.guard) {
      this.sum.connect(this.guard).connect(this.safety.input);
    } else {
      this.sum.connect(this.safety.input);
    }
    this.output = this.safety.output;
  }

  private makeDucker(): AudioWorkletNode | null {
    try {
      // Two inputs, so the output's channel count must be said (a worklet with more than one input is mono otherwise): the track's stereo.
      const node = new AudioWorkletNode(this.ctx, 'sv-ducker', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
      node.parameters.get('depth')?.setValueAtTime(MIX_TARGETS.duckDb, 0);
      node.parameters.get('gate')?.setValueAtTime(DUCK.gateDb, 0);
      node.parameters.get('attack')?.setValueAtTime(DUCK.attackS, 0);
      node.parameters.get('release')?.setValueAtTime(DUCK.releaseS, 0);
      node.port.onmessage = (e: MessageEvent) => {
        const m = e.data as { type?: string; gainDb?: number };
        if (m.type === 'duck' && typeof m.gainDb === 'number') this.duckDb = m.gainDb;
      };
      return node;
    } catch {
      return null;
    }
  }

  /** How far the backing track is moved to sit at the mix target (dB) — from its measured loudness. */
  setBackingNormalization(db: number): void {
    this.backingNorm.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.05);
  }

  /** The device's Track / Vocal controls (dB), on top of the normalised mix. */
  setBalance(trackDb: number, vocalDb: number): void {
    this.balance = { trackDb, vocalDb };
    const t = this.ctx.currentTime;
    this.backingOut.gain.setTargetAtTime(dbToGain(trackDb), t, 0.03);
    this.vocalOffset.gain.setTargetAtTime(dbToGain(vocalDb), t, 0.03);
  }

  getBalance(): { trackDb: number; vocalDb: number } {
    return this.balance;
  }

  /** A voice joins the mix (through its own rider and limiter). Adding the same id again replaces the source. */
  addVocal(id: string, source: AudioNode): MixVocal {
    this.removeVocal(id);
    const rider = this.workletAvailable ? leveler(this.ctx, VOCAL_RIDER) : null;
    // The voice's own ceiling: a limiter with a short lookahead, so its loudest peak after the rider never reaches the sum
    // (its release short enough to give the level back between a voice's peaks — the density of a record's vocal).
    const limiter = makeCompressor(this.ctx, this.workletAvailable, { lookaheadFrames: Math.round(LIMITER_LOOKAHEAD_S * this.ctx.sampleRate), ramp: 0.01 });
    limiter.set({ thresholdDb: VOCAL_CEILING_DB, kneeDb: 0, ratio: LIMITER_RATIO, attackS: 0.0003, releaseS: VOCAL_LIMITER_RELEASE_S, makeupDb: 0 }, 0);
    const out = this.ctx.createGain();
    if (rider) source.connect(rider).connect(limiter.input);
    else source.connect(limiter.input);
    limiter.output.connect(out);
    out.connect(this.vocalOffset);
    const meter = this.ctx.createAnalyser();
    meter.fftSize = 2048;
    out.connect(meter);
    this.vocals.set(id, { source, rider, limiter, out, meter });
    return { out };
  }

  removeVocal(id: string): void {
    const v = this.vocals.get(id);
    if (!v) return;
    this.vocals.delete(id);
    try {
      v.source.disconnect(v.rider ?? v.limiter.input);
    } catch {
      /* already gone */
    }
    v.rider?.disconnect();
    v.limiter.disconnect();
    v.out.disconnect();
    v.meter.disconnect();
  }

  private readDb(meter: AnalyserNode): number {
    meter.getFloatTimeDomainData(this.meterBuf);
    let sum = 0;
    for (let i = 0; i < this.meterBuf.length; i++) sum += this.meterBuf[i]! * this.meterBuf[i]!;
    return Math.max(-100, 20 * Math.log10(Math.sqrt(sum / this.meterBuf.length) + 1e-6));
  }

  /** What each source brings to the mix right now (dBFS over the last 43 ms; -100 when nothing): the track and every voice by id. */
  levels(): { track: number; vocals: Record<string, number> } {
    const vocals: Record<string, number> = {};
    for (const [id, v] of this.vocals) vocals[id] = this.readDb(v.meter);
    return { track: this.readDb(this.backingMeter), vocals };
  }

  get vocalIds(): string[] {
    return [...this.vocals.keys()];
  }

  dispose(): void {
    for (const id of this.vocalIds) this.removeVocal(id);
    for (const n of [this.backingIn, this.backingNorm, ...this.pocket.nodes, this.backingOut, this.vocalOffset, this.sum, this.safety.output]) n.disconnect();
    this.trackLimiter.disconnect();
    this.ducker?.disconnect();
    this.guard?.disconnect();
    this.safety.limiter.disconnect();
  }
}
