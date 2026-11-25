/**
 * Playing a take back — the backing track and the vocal recorded over it — the way the saved show mixes them,
 * through the same mix bus (mixBus.ts): the track normalised to the mix target, the vocal on its rider, the
 * device's Track / Vocal volume on top, the guard and the limiter under the ceiling. The review used to play the
 * raw vocal at full level over the track at the singer's listening level — a louder voice than the saved show
 * had, so a take that sounded right in the review came back weaker from Performances. Now the two agree: what
 * the review plays is what the file has.
 *
 * One AudioContext per player, its worklets loaded once (plain gains and the native limiter where they cannot
 * be); `play` decodes, measures the track (remembered per track id), schedules both from any position on the
 * take's timeline and resolves at once; `seek` moves (playing or paused), `pause` holds the position, `stop`
 * cuts; `positionMs` is where the take is, on the audio clock; `close` lets the context go.
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
  /** What plays (for a seek, which starts it again elsewhere). */
  private opts: TakePlayOptions | null = null;
  /** The context time the take's position 0 fell on at the last start, and the position held while paused (ms). */
  private originCtx = 0;
  private heldMs = 0;
  /** The take's length on its timeline (ms): the longer of the track and the vocal's end. */
  durationMs = 0;

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

  /** Where the take is on its timeline (ms): on the audio clock while it plays, the held position otherwise. */
  positionMs(): number {
    if (!this.playing) return this.heldMs;
    return Math.max(0, Math.min(this.durationMs || Infinity, (this.ctx.currentTime - this.originCtx) * 1000));
  }

  /** Play from `fromMs` on the take's timeline (0: the top). */
  async play(o: TakePlayOptions, fromMs = 0): Promise<void> {
    this.stop();
    this.opts = o;
    const worklets = await this.ready;
    await this.ctx.resume();
    const [backing, vocal] = await Promise.all([o.backing ? this.decode(o.backing) : Promise.resolve(null), o.vocal && o.vocal.size ? this.decode(o.vocal) : Promise.resolve(null)]);
    if (!backing && !vocal) return;
    if (this.opts !== o) return; // stopped or started elsewhere while decoding
    this.durationMs = Math.max(backing ? backing.duration * 1000 : 0, vocal ? o.vocalAtMs + vocal.duration * 1000 : 0);
    const from = Math.max(0, Math.min(this.durationMs, fromMs));
    // The track's loudness first (measured once per track id; a moment the first time): the start is timed after it, so
    // the two never start out of step.
    let loud = backing ? (o.trackId ? cachedLoudness(o.trackId) : null) : null;
    if (backing && !loud) {
      loud = await bufferLoudnessAsync(backing);
      if (o.trackId) rememberLoudness(o.trackId, loud);
      if (this.opts !== o) return;
    }
    this.bus?.dispose();
    const bus = new MixBus(this.ctx, worklets);
    bus.setBalance(o.trackDb, o.vocalDb);
    bus.output.connect(this.ctx.destination);
    this.bus = bus;
    const at = this.ctx.currentTime + 0.2;
    this.originCtx = at - from / 1000;
    this.heldMs = from;
    let ended = 0;
    let want = 0;
    const nodes: AudioBufferSourceNode[] = [];
    const done = () => {
      if (++ended >= want && this.nodes === nodes) {
        this.heldMs = this.durationMs;
        this.nodes = [];
        o.onEnded?.();
      }
    };
    if (backing && loud && from < backing.duration * 1000) {
      bus.setBackingNormalization(normalizationDb(loud.lufs, MIX_TARGETS.trackLufs));
      const b = this.ctx.createBufferSource();
      b.buffer = backing;
      b.connect(bus.backingIn);
      b.onended = done;
      b.start(at, from / 1000);
      nodes.push(b);
      want++;
    }
    if (vocal && from < o.vocalAtMs + vocal.duration * 1000) {
      const v = this.ctx.createBufferSource();
      v.buffer = vocal;
      bus.addVocal('take', v);
      v.onended = done;
      // The vocal's sample 0 sits at vocalAtMs on the timeline: later than `from`, it waits; earlier, it starts part-way in.
      const lead = (o.vocalAtMs - from) / 1000;
      if (lead >= 0) v.start(at + lead);
      else v.start(at, -lead);
      nodes.push(v);
      want++;
    }
    this.nodes = nodes;
    if (!want) o.onEnded?.();
  }

  /** Move to `ms` on the take's timeline: playing, it plays on from there; paused, it waits there. */
  async seek(ms: number): Promise<void> {
    const to = Math.max(0, Math.min(this.durationMs || ms, ms));
    if (this.playing && this.opts) return this.play(this.opts, to);
    this.heldMs = to;
  }

  /** Hold where the take is (a later `resume` goes on from there). */
  pause(): void {
    if (!this.playing) return;
    const pos = this.positionMs();
    this.stop();
    this.heldMs = pos;
  }

  /** Play on from where the take was held. */
  async resume(): Promise<void> {
    if (this.playing || !this.opts) return;
    return this.play(this.opts, this.heldMs >= this.durationMs ? 0 : this.heldMs);
  }

  /** The balance changed while playing: applied on the spot. */
  setBalance(trackDb: number, vocalDb: number): void {
    this.bus?.setBalance(trackDb, vocalDb);
  }

  /** Cut, where the take is remembered (a `resume` goes on from there; `play` starts over). */
  stop(): void {
    if (this.playing) this.heldMs = this.positionMs();
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
