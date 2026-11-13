/**
 * The publisher's sound: the backing track (the show view's audio element, kept in step with the
 * meet's transport) and every singer's vocal (after their own FX, straight off the mesh) through the
 * same mix bus a singer's device records with — the track normalised to the mix target, a rider on
 * every voice, the device's Track / Vocal offsets, a guard and a limiter on top — into one bus the
 * broadcast encoder taps. What the publisher hears on their own speakers is the same mix, with its
 * two monitor switches (vocals, music) that never touch the broadcast.
 *
 * The worklets (riders, guard, limiter) load asynchronously: the graph is built once they are in, and
 * every call before that is queued in order.
 */
import { WORKLET_MODULES } from '../audio/engine.ts';
import { dbToGain } from '../audio/gain.ts';
import { safetyStage } from '../audio/dynamics.ts';
import { MIX_TARGETS, normalizationDb, type Loudness } from '../audio/loudness.ts';
import { leveler, MIX_GUARD, MixBus } from '../audio/mixBus.ts';

export class PublisherBus {
  readonly ctx: AudioContext;
  /** The broadcast mix, after the guard and the safety stage: tap this (there once `ready()` resolves). */
  get output(): AudioNode {
    return this.bus!.output;
  }
  private bus: MixBus | null = null;
  private monitorVocals!: GainNode;
  private monitorMusic!: GainNode;
  private backingEl: HTMLAudioElement | null = null;
  private backingSrc: MediaElementAudioSourceNode | null = null;
  private vocals = new Map<string, { stream: MediaStream; node: MediaStreamAudioSourceNode; monitor: GainNode }>();
  private readonly loading: Promise<void>;
  private queue: Promise<void>;
  private workletAvailable = false;
  /** Participants whose vocal stays out of the monitor (the publisher's own, when they are also on stage — they hear it on stage). */
  private monitorMuted = new Set<string>();
  private balance = { trackDb: 0, vocalDb: 0 };

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
    const base = import.meta.env.BASE_URL;
    this.loading = Promise.all(WORKLET_MODULES.map((m) => this.ctx.audioWorklet.addModule(`${base}worklets/${m}`)))
      .then(() => {
        this.workletAvailable = true;
      })
      .catch((e) => {
        console.warn('publisher worklets', e); // plain gains and a corrected native limiter remain
      })
      .then(() => this.build());
    this.queue = this.loading;
  }

  private build(): void {
    const ctx = this.ctx;
    const bus = new MixBus(ctx, this.workletAvailable);
    bus.setBalance(this.balance.trackDb, this.balance.vocalDb);
    this.bus = bus;
    // The monitor: the same sources (after their riders and the offsets), each behind its own switch, through a guard and a safety stage of its own, to the speakers.
    const monitorSafety = safetyStage(ctx, this.workletAvailable);
    const monitorSum = ctx.createGain();
    const monitorGuard = this.workletAvailable ? leveler(ctx, MIX_GUARD) : null;
    if (monitorGuard) monitorSum.connect(monitorGuard).connect(monitorSafety.input);
    else monitorSum.connect(monitorSafety.input);
    this.monitorVocals = ctx.createGain();
    this.monitorMusic = ctx.createGain();
    this.monitorVocals.connect(monitorSum);
    bus.backingOut.connect(this.monitorMusic).connect(monitorSum);
    monitorSafety.output.connect(ctx.destination);
    this.monitorVocals.gain.value = this.monitorOn.vocals ? dbToGain(this.balance.vocalDb) : 0;
    this.monitorMusic.gain.value = this.monitorOn.music ? 1 : 0;
  }

  /** Runs `fn` once the graph exists, in call order. */
  private then(fn: () => void): void {
    this.queue = this.queue.then(fn, fn);
  }

  /** Resolves when the worklets are loaded and the graph is built. */
  ready(): Promise<void> {
    return this.loading;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined);
  }

  /** The broadcast balance (dB): the track and the voices, applied live (the monitor follows the vocal offset). */
  setBalance(trackDb: number, vocalDb: number): void {
    this.balance = { trackDb, vocalDb };
    this.then(() => {
      this.bus!.setBalance(trackDb, vocalDb);
      this.applyMonitor();
    });
  }

  /** The loaded track's loudness: the bus moves it to the mix target. */
  setBackingLoudness(l: Loudness | null): void {
    this.then(() => this.bus!.setBackingNormalization(l ? normalizationDb(l.lufs, MIX_TARGETS.trackLufs) : 0));
  }

  /** The backing track element (its sound now comes through the bus, not straight out of the element). */
  setBacking(el: HTMLAudioElement | null): void {
    if (el === this.backingEl) return;
    this.backingEl = el;
    this.then(() => {
      this.backingSrc?.disconnect();
      this.backingSrc = null;
      if (!el) return;
      try {
        this.backingSrc = this.ctx.createMediaElementSource(el);
        this.backingSrc.connect(this.bus!.backingIn);
      } catch (e) {
        console.warn('backing source', e); // an element can be wired once; a second call for the same element is ignored
      }
    });
  }

  setVocals(vocals: Record<string, MediaStream>): void {
    this.then(() => {
      const bus = this.bus!;
      for (const [id, v] of [...this.vocals]) {
        if (vocals[id] !== v.stream) {
          bus.removeVocal(id);
          v.node.disconnect();
          v.monitor.disconnect();
          this.vocals.delete(id);
        }
      }
      for (const [id, stream] of Object.entries(vocals)) {
        if (this.vocals.has(id)) continue;
        try {
          const node = this.ctx.createMediaStreamSource(stream);
          const { out } = bus.addVocal(id, node); // the broadcast: every voice, always
          const monitor = this.ctx.createGain();
          monitor.gain.value = this.monitorMuted.has(id) ? 0 : 1;
          out.connect(monitor).connect(this.monitorVocals); // the publisher's own ears
          this.vocals.set(id, { stream, node, monitor });
        } catch (e) {
          console.warn('vocal source', e);
        }
      }
    });
  }

  /** Vocals left out of the monitor (never out of the broadcast). */
  setMonitorMuted(ids: Iterable<string>): void {
    this.monitorMuted = new Set(ids);
    this.then(() => {
      const t = this.ctx.currentTime;
      for (const [id, v] of this.vocals) v.monitor.gain.setTargetAtTime(this.monitorMuted.has(id) ? 0 : 1, t, 0.02);
    });
  }

  private monitorOn = { vocals: true, music: true };

  setMonitor(on: { vocals: boolean; music: boolean }): void {
    this.monitorOn = on;
    this.then(() => this.applyMonitor());
  }

  private applyMonitor(): void {
    const t = this.ctx.currentTime;
    this.monitorVocals.gain.setTargetAtTime(this.monitorOn.vocals ? dbToGain(this.balance.vocalDb) : 0, t, 0.02);
    this.monitorMusic.gain.setTargetAtTime(this.monitorOn.music ? 1 : 0, t, 0.02);
  }

  dispose(): void {
    this.then(() => {
      for (const v of this.vocals.values()) {
        v.node.disconnect();
        v.monitor.disconnect();
      }
      this.vocals.clear();
      this.backingSrc?.disconnect();
      this.bus?.dispose();
      void this.ctx.close().catch(() => undefined);
    });
  }
}
