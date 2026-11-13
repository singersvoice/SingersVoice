/**
 * The publisher's sound: the backing track (the show view's audio element, kept in step with the
 * meet's transport) and every singer's vocal (after their own FX, straight off the mesh) mixed the
 * way the saved show mixes them — the voices a little up, the track a little under, a limiter on
 * top — into one bus the broadcast encoder taps. What the publisher hears on their own speakers is
 * the same mix, with its two monitor switches (vocals, music) that never touch the broadcast.
 */
import { BACKING_IN_MIX, VOCAL_IN_MIX } from '../video/showRecorder.ts';

export class PublisherBus {
  readonly ctx: AudioContext;
  /** The broadcast mix (after the limiter): tap this.
   */
  readonly output: DynamicsCompressorNode;
  private readonly vocalSum: GainNode;
  private readonly backingLevel: GainNode;
  private readonly bus: GainNode;
  private readonly monitorVocals: GainNode;
  private readonly monitorMusic: GainNode;
  private backingEl: HTMLAudioElement | null = null;
  private backingSrc: MediaElementAudioSourceNode | null = null;
  private vocals = new Map<string, { stream: MediaStream; node: MediaStreamAudioSourceNode; level: GainNode }>();
  private workletReady: Promise<void> | null = null;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
    const ctx = this.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.85;
    this.output = ctx.createDynamicsCompressor();
    this.output.threshold.value = -8;
    this.output.knee.value = 6;
    this.output.ratio.value = 6;
    this.output.attack.value = 0.003;
    this.output.release.value = 0.12;
    this.bus.connect(this.output);
    this.vocalSum = ctx.createGain();
    this.vocalSum.gain.value = VOCAL_IN_MIX;
    this.vocalSum.connect(this.bus);
    this.backingLevel = ctx.createGain();
    this.backingLevel.gain.value = BACKING_IN_MIX;
    this.backingLevel.connect(this.bus);
    // The monitor: the same two sources, each behind its own switch, to the speakers.
    this.monitorVocals = ctx.createGain();
    this.monitorMusic = ctx.createGain();
    this.vocalSum.connect(this.monitorVocals).connect(ctx.destination);
    this.backingLevel.connect(this.monitorMusic).connect(ctx.destination);
  }

  /** The tap worklet, loaded once (the same module the singers' devices use for the audience mix). */
  ready(): Promise<void> {
    this.workletReady ??= this.ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/mix-tap.js`).catch((e) => {
      console.warn('mix-tap worklet', e);
    });
    return this.workletReady;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined);
  }

  /** The backing track element (its sound now comes through the bus, not straight out of the element). */
  setBacking(el: HTMLAudioElement | null): void {
    if (el === this.backingEl) return;
    this.backingSrc?.disconnect();
    this.backingSrc = null;
    this.backingEl = el;
    if (!el) return;
    try {
      this.backingSrc = this.ctx.createMediaElementSource(el);
      this.backingSrc.connect(this.backingLevel);
    } catch (e) {
      console.warn('backing source', e); // an element can be wired once; a second call for the same element is ignored
    }
  }

  setVocals(vocals: Record<string, MediaStream>): void {
    for (const [id, v] of [...this.vocals]) {
      if (vocals[id] !== v.stream) {
        v.node.disconnect();
        v.level.disconnect();
        this.vocals.delete(id);
      }
    }
    for (const [id, stream] of Object.entries(vocals)) {
      if (this.vocals.has(id)) continue;
      try {
        const node = this.ctx.createMediaStreamSource(stream);
        const level = this.ctx.createGain();
        node.connect(level).connect(this.vocalSum);
        this.vocals.set(id, { stream, node, level });
      } catch (e) {
        console.warn('vocal source', e);
      }
    }
  }

  setMonitor(on: { vocals: boolean; music: boolean }): void {
    const t = this.ctx.currentTime;
    this.monitorVocals.gain.setTargetAtTime(on.vocals ? 1 : 0, t, 0.02);
    this.monitorMusic.gain.setTargetAtTime(on.music ? 1 : 0, t, 0.02);
  }

  dispose(): void {
    for (const v of this.vocals.values()) {
      v.node.disconnect();
      v.level.disconnect();
    }
    this.vocals.clear();
    this.backingSrc?.disconnect();
    void this.ctx.close().catch(() => undefined);
  }
}
