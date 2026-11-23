/**
 * Playing a take back — the backing track and the vocal recorded over it — the way the saved show mixes them,
 * through the same mix bus (mixBus.ts): the track normalised to the mix target, the vocal on its rider, the
 * device's Track / Vocal volume on top, the guard and the limiter under the ceiling. The review used to play the
 * raw vocal at full level over the track at the singer's listening level — a louder voice than the saved show
 * had, so a take that sounded right in the review came back weaker from Performances. Now the two agree: what
 * the review plays is what the file has.
 *
 * One AudioContext per player, its worklets loaded once (plain gains and the native limiter where they cannot
 * be); `play` decodes, measures the track (remembered per track id), schedules both and resolves at once;
 * `stop` cuts; `close` lets the context go.
 */
import { WORKLET_MODULES } from './engine.ts';
import { bufferLoudnessAsync, cachedLoudness, MIX_TARGETS, normalizationDb, rememberLoudness } from './loudness.ts';
import { MixBus } from './mixBus.ts';

export interface TakePlayOptions {
  backing: Blob | null;
  /** Its track id: the loudness measured once per device is kept under it. */
  trackId?: string;
  vocal: Blob | null;
  /** Where the vocal's first sample sits on the track's timeline (ms; negative: the vocal started before the track). */
  vocalAtMs: number;
  /** The device's Track / Vocal volume (dB). */
  trackDb: number;
  vocalDb: number;
  onEnded?: () => void;
}

export class TakePlayback {
  readonly ctx: AudioContext;
  private readonly ready: Promise<boolean>;
  private bus: MixBus | null = null;
  private nodes: AudioBufferSourceNode[] = [];
  private decoded = new Map<Blob, Promise<AudioBuffer>>();

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000 });
    const base = import.meta.env.BASE_URL;
    this.ready = Promise.all(WORKLET_MODULES.map((m) => this.ctx.audioWorklet.addModule(`${base}worklets/${m}`))).then(
      () => true,
      (e) => {
        console.warn('take playback worklets', e);
        return false;
      },
    );
  }

  private decode(blob: Blob): Promise<AudioBuffer> {
    let p = this.decoded.get(blob);
    if (!p) {
      p = blob.arrayBuffer().then((b) => this.ctx.decodeAudioData(b));
      this.decoded.set(blob, p);
    }
    return p;
  }

  /** Whether something plays right now. */
  get playing(): boolean {
    return this.nodes.length > 0;
  }

  async play(o: TakePlayOptions): Promise<void> {
    this.stop();
    const worklets = await this.ready;
    await this.ctx.resume();
    const [backing, vocal] = await Promise.all([o.backing ? this.decode(o.backing) : Promise.resolve(null), o.vocal && o.vocal.size ? this.decode(o.vocal) : Promise.resolve(null)]);
    if (!backing && !vocal) return;
    this.bus?.dispose();
    const bus = new MixBus(this.ctx, worklets);
    bus.setBalance(o.trackDb, o.vocalDb);
    bus.output.connect(this.ctx.destination);
    this.bus = bus;
    const at = this.ctx.currentTime + 0.2;
    let ended = 0;
    const want = (backing ? 1 : 0) + (vocal ? 1 : 0);
    const done = () => {
      if (++ended >= want) {
        this.nodes = [];
        o.onEnded?.();
      }
    };
    if (backing) {
      let loud = o.trackId ? cachedLoudness(o.trackId) : null;
      if (!loud) {
        loud = await bufferLoudnessAsync(backing);
        if (o.trackId) rememberLoudness(o.trackId, loud);
      }
      bus.setBackingNormalization(normalizationDb(loud.lufs, MIX_TARGETS.trackLufs));
      const b = this.ctx.createBufferSource();
      b.buffer = backing;
      b.connect(bus.backingIn);
      b.onended = done;
      b.start(at);
      this.nodes.push(b);
    }
    if (vocal) {
      const v = this.ctx.createBufferSource();
      v.buffer = vocal;
      bus.addVocal('take', v);
      v.onended = done;
      if (o.vocalAtMs >= 0) v.start(at + o.vocalAtMs / 1000);
      else v.start(at, -o.vocalAtMs / 1000);
      this.nodes.push(v);
    }
  }

  /** The balance changed while playing: applied on the spot. */
  setBalance(trackDb: number, vocalDb: number): void {
    this.bus?.setBalance(trackDb, vocalDb);
  }

  stop(): void {
    for (const n of this.nodes) {
      n.onended = null;
      try {
        n.stop();
      } catch {
        /* not started */
      }
    }
    this.nodes = [];
  }

  close(): void {
    this.stop();
    this.bus?.dispose();
    this.bus = null;
    void this.ctx.close().catch(() => undefined);
  }
}
