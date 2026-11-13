/**
 * The mix every listener gets — the saved show, the audience's "Hear the stage", the broadcast —
 * built the same way everywhere, so it never depends on what file the track came from, which
 * microphone a singer has or how they set their effects:
 *
 *   track ─ normalisation ─ Track offset ─┐
 *   vocal₁ ─ rider ─┐                     ├─ sum ─ guard ─ limiter ─ soft clip ─ out
 *   vocal₂ ─ rider ─┴─ Vocal offset ──────┘
 *
 * The track is brought to MIX_TARGETS.trackLufs (measured once, see loudness.ts); each vocal has a
 * slow rider steering it to MIX_TARGETS.vocalDb; the two offsets are the device's Track / Vocal
 * controls (dB, ±30, a balance on top of a mix that is already right); the guard only ever turns the
 * sum down, so pushing both controls up cannot drive the limiter into crackling; the limiter and
 * clipper keep every sample under the ceiling. Without worklets (no riders, no guard) the plain
 * gains and a corrected native limiter remain.
 */
import { dbToGain } from './gain.ts';
import { safetyStage, type SafetyStage } from './dynamics.ts';
import { MIX_TARGETS } from './loudness.ts';

/** The buses' ceiling (dBFS): what YouTube and every encoder take without overshoot. */
export const MIX_CEILING_DB = -1.5;

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
}

/**
 * The per-vocal rider: a slow level that brings each voice to the vocal target — a two-second view,
 * 1 dB/s (a singer's offset, not their phrasing), three times faster until it is within 6 dB — and holds
 * still between phrases (the gate is above breath and room noise).
 */
export const VOCAL_RIDER: LevelerConfig = { target: MIX_TARGETS.vocalDb, minDb: -12, maxDb: 18, gate: -45, up: 1, down: 2, windowMs: 2000, farDb: 6, farMul: 3 };
/** The guard on the sum: turns down (never up) when the mix runs hotter than the mix target on average. */
export const MIX_GUARD: LevelerConfig = { target: MIX_TARGETS.mixDb, minDb: -36, maxDb: 0, gate: -40, up: 1, down: 2, windowMs: 600, farDb: 6, farMul: 3 };

/** An 'sv-leveler' node set up from a config (null when the worklet is not on this context). */
export function leveler(ctx: BaseAudioContext, cfg: LevelerConfig): AudioWorkletNode | null {
  try {
    const node = new AudioWorkletNode(ctx, 'sv-leveler', { numberOfInputs: 1, numberOfOutputs: 1, processorOptions: { windowMs: cfg.windowMs, farDb: cfg.farDb, farMul: cfg.farMul } });
    for (const k of ['target', 'minDb', 'maxDb', 'gate', 'up', 'down'] as const) node.parameters.get(k)?.setValueAtTime(cfg[k], 0);
    return node;
  } catch {
    return null;
  }
}

export interface MixVocal {
  /** The voice after its rider — tap this for a monitor. */
  out: AudioNode;
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
  private readonly vocalOffset: GainNode;
  private readonly guard: AudioWorkletNode | null;
  private vocals = new Map<string, { source: AudioNode; rider: AudioWorkletNode | null; out: GainNode }>();
  private balance = { trackDb: 0, vocalDb: 0 };
  readonly workletAvailable: boolean;

  constructor(ctx: BaseAudioContext, workletAvailable: boolean, opts: { ceilingDb?: number } = {}) {
    this.ctx = ctx;
    this.workletAvailable = workletAvailable;
    this.backingIn = ctx.createGain();
    this.backingNorm = ctx.createGain();
    this.backingOut = ctx.createGain();
    this.vocalOffset = ctx.createGain();
    this.sum = ctx.createGain();
    this.backingIn.connect(this.backingNorm).connect(this.backingOut).connect(this.sum);
    this.vocalOffset.connect(this.sum);
    this.guard = workletAvailable ? leveler(ctx, MIX_GUARD) : null;
    this.safety = safetyStage(ctx, workletAvailable, opts.ceilingDb ?? MIX_CEILING_DB);
    if (this.guard) {
      this.sum.connect(this.guard).connect(this.safety.input);
    } else {
      this.sum.connect(this.safety.input);
    }
    this.output = this.safety.output;
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

  /** A voice joins the mix (through its own rider). Adding the same id again replaces the source. */
  addVocal(id: string, source: AudioNode): MixVocal {
    this.removeVocal(id);
    const rider = this.workletAvailable ? leveler(this.ctx, VOCAL_RIDER) : null;
    const out = this.ctx.createGain();
    if (rider) source.connect(rider).connect(out);
    else source.connect(out);
    out.connect(this.vocalOffset);
    this.vocals.set(id, { source, rider, out });
    return { out };
  }

  removeVocal(id: string): void {
    const v = this.vocals.get(id);
    if (!v) return;
    this.vocals.delete(id);
    try {
      v.source.disconnect(v.rider ?? v.out);
    } catch {
      /* already gone */
    }
    v.rider?.disconnect();
    v.out.disconnect();
  }

  get vocalIds(): string[] {
    return [...this.vocals.keys()];
  }

  dispose(): void {
    for (const id of this.vocalIds) this.removeVocal(id);
    for (const n of [this.backingIn, this.backingNorm, this.backingOut, this.vocalOffset, this.sum, this.safety.output]) n.disconnect();
    this.guard?.disconnect();
    this.safety.limiter.disconnect();
  }
}
