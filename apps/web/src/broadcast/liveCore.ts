/**
 * The broadcast's segments, assembled from what the encoders produce — pure logic, no browser APIs, so it is
 * tested on its own (test/liveCore.test.ts) and runs the same in the Worker that drives the encoders.
 *
 * The rule: **the sound is the clock, the picture is best effort.** A segment runs from one keyframe to the next;
 * it goes out the moment the sound's own timeline has reached that next keyframe (so every segment carries all
 * of its sound, in order — never a block that arrives late and lands in the next segment with an earlier stamp,
 * which is what a player turns into a click or a hole). A picture that stops coming (the page's main thread
 * stalled under a crowded stage; the publisher's computer busy) never holds the sound back: once the sound has
 * run a segment's length and a grace past the last keyframe with no newer keyframe in sight, the segment is cut
 * where the sound is, and the caller is asked for a keyframe at that instant (`tick` answers with the timestamp)
 * — it encodes the last picture it has once more, so the stream stays continuous (the viewer sees the last frame
 * held and hears every note) instead of breaking. A frame that turns up late, belonging to a segment already
 * out, is left out. Without sound (a browser that cannot encode AAC), or when the sound itself has stopped
 * coming for AUDIO_STALL_US, the wall clock plays the sound's part.
 */
import type { MediaPacket } from './tsMuxer.ts';

/** Samples in one AAC frame (one ADTS frame, one encoder chunk). */
export const AAC_FRAME = 1024;
export const AUDIO_RATE = 48000;
/** ADTS frames per audio PES. */
const ADTS_PER_PES = 4;
/** How far past "a segment's length after the last keyframe" the clock may run before the picture is given up on for that segment. */
export const STALL_GRACE_US = 400_000;
/** Sound that has not advanced for this long of wall time (the tap gone quiet) hands the clock to the wall. */
export const AUDIO_STALL_US = 2_000_000;

export interface CoreSegment {
  seq: number;
  name: string;
  packets: MediaPacket[];
  /** The span of the broadcast this segment covers (µs): from its keyframe to the next segment's. */
  fromUs: number;
  toUs: number;
  durationMs: number;
  audio: boolean;
}

export interface LiveCoreOptions {
  /** The broadcast carries sound (AAC). */
  audio: boolean;
  /** A segment's length (µs): a keyframe this often. */
  segmentUs: number;
  /** The run's name in the segment names (`sv<run>-<seq>.ts`). */
  run: string;
  onSegment: (seg: CoreSegment) => void;
}

export class LiveCore {
  private packets: MediaPacket[] = [];
  /** Keyframe timestamps not yet consumed as a segment's start, ascending. */
  private keys: number[] = [];
  /** The end (exclusive) of the last segment out: anything stamped before it is late and left out. */
  emittedToUs = -1;
  /** The sound's own timeline: the broadcast clock of the first block fed to the encoder, and the AAC frames out since. */
  private audioBaseUs: number | null = null;
  private aacFrames = 0;
  /** Where the sound's timeline ends so far (µs), -1 before the first frame. */
  audioEndUs = -1;
  /** The caller's clock at the last sound advance, at the first word from the caller, and at the last tick (µs): sound that stops advancing (or never starts) hands the clock to the wall after AUDIO_STALL_US. */
  private audioWallUs = -1;
  private firstWallUs = -1;
  private wallUs = -1;
  private adtsRun: Uint8Array[] = [];
  private adtsRunTs = 0;
  /** A keyframe asked for at this instant and not yet seen (a stalled picture): no second ask until the clock ran a segment past it. */
  private keyAskedUs: number | null = null;
  seq = 0;
  readonly stats = { segments: 0, lateVideo: 0, held: 0, audioTimestampsOff: 0 };

  constructor(private readonly opts: LiveCoreOptions) {}

  get hasAudio(): boolean {
    return this.opts.audio;
  }

  /** An encoded video chunk (Annex B). `key` begins a segment. */
  videoChunk(ts: number, key: boolean, data: Uint8Array): void {
    if (ts < this.emittedToUs) {
      this.stats.lateVideo++;
      return;
    }
    if (key) {
      if (this.keyAskedUs !== null && ts >= this.keyAskedUs) this.keyAskedUs = null;
      if (!this.keys.includes(ts)) {
        this.keys.push(ts);
        this.keys.sort((a, b) => a - b);
      }
    } else if (!this.keys.length) return; // a frame before the first keyframe opens nothing
    this.packets.push({ kind: 'video', ts, key, data });
    this.drain();
  }

  /** An encoded audio chunk: one ADTS frame (or several), stamped by counting samples from the first block in; `chunkTs` is the encoder's own stamp, checked against it. */
  audioChunk(chunkTs: number, frames: Uint8Array[], wallUs: number): void {
    if (!this.opts.audio) return;
    const ts = this.audioBaseUs === null ? chunkTs : this.audioBaseUs + Math.round((this.aacFrames * AAC_FRAME * 1e6) / AUDIO_RATE);
    if (this.audioBaseUs === null) this.audioBaseUs = ts;
    if (Math.abs(chunkTs - ts) > 100_000) this.stats.audioTimestampsOff++;
    this.aacFrames += frames.length || 1;
    this.audioEndUs = this.audioBaseUs + Math.round((this.aacFrames * AAC_FRAME * 1e6) / AUDIO_RATE);
    this.audioWallUs = wallUs;
    if (this.firstWallUs < 0) this.firstWallUs = wallUs;
    if (this.wallUs < wallUs) this.wallUs = wallUs;
    if (!this.adtsRun.length) this.adtsRunTs = ts;
    this.adtsRun.push(...frames);
    if (this.adtsRun.length >= ADTS_PER_PES) this.flushAdts();
    this.drain();
  }

  private flushAdts(): void {
    if (!this.adtsRun.length) return;
    const len = this.adtsRun.reduce((n, f) => n + f.length, 0);
    const data = new Uint8Array(len);
    let o = 0;
    for (const f of this.adtsRun) {
      data.set(f, o);
      o += f.length;
    }
    this.packets.push({ kind: 'audio', ts: this.adtsRunTs, key: false, data });
    this.adtsRun = [];
  }

  /** The sound keeps the clock: the broadcast carries it, and it has not stopped (or failed to start) for AUDIO_STALL_US of wall time. */
  private soundKeepsTime(): boolean {
    if (!this.opts.audio) return false;
    const since = this.audioEndUs >= 0 ? this.audioWallUs : this.firstWallUs;
    return since < 0 || this.wallUs - since < AUDIO_STALL_US;
  }

  /**
   * Called every so often (and after every chunk): segments whose span is complete go out. Where the picture has
   * stopped — the clock ran a segment's length and STALL_GRACE_US past the last keyframe with no newer keyframe —
   * the segment is cut there and the caller is asked for a keyframe at that instant: the timestamp returned.
   * `wallUs` is the caller's clock on the broadcast's timeline (µs).
   */
  tick(wallUs: number): number | null {
    if (this.firstWallUs < 0) this.firstWallUs = wallUs;
    if (wallUs > this.wallUs) this.wallUs = wallUs;
    this.drain();
    if (this.keys.length !== 1) return null;
    const last = this.keys[0]!;
    const clock = this.soundKeepsTime() ? this.audioEndUs : this.wallUs;
    if (clock < 0 || clock < last + this.opts.segmentUs + STALL_GRACE_US) return null;
    if (this.keyAskedUs !== null && clock < this.keyAskedUs + this.opts.segmentUs) return null; // asked already, not yet come
    // The picture stalled: the segment that began at `last` ends where the clock is; the next begins with the keyframe asked for now.
    this.emit(last, clock);
    this.keys = [];
    this.keyAskedUs = clock;
    this.stats.held++;
    return clock;
  }

  private drain(): void {
    for (;;) {
      if (this.keys.length < 2) return;
      const from = this.keys[0]!;
      const to = this.keys[1]!;
      if (this.soundKeepsTime() && this.audioEndUs < to) return; // the sound has not reached the next keyframe yet (or not begun): its blocks for this span are still to come
      this.emit(from, to);
      this.keys.shift();
    }
  }

  private emit(from: number, to: number): void {
    // Sound straddling the end goes with the segment it starts in: the run is flushed so the stamps decide.
    if (this.adtsRun.length && this.adtsRunTs < to) this.flushAdts();
    const seg = this.packets.filter((p) => p.ts >= from && p.ts < to);
    this.packets = this.packets.filter((p) => p.ts >= to);
    this.emittedToUs = to;
    if (!seg.some((p) => p.kind === 'video')) return; // a segment without a picture is nothing to a player (cannot happen: `from` is a keyframe's own stamp)
    const s: CoreSegment = { seq: this.seq, name: `sv${this.opts.run}-${this.seq}.ts`, packets: seg, fromUs: from, toUs: to, durationMs: Math.max(1, Math.round((to - from) / 1000)), audio: this.opts.audio };
    this.seq++;
    this.stats.segments++;
    this.opts.onSegment(s);
  }

  /** The packets still waiting (diagnostics). */
  get pending(): number {
    return this.packets.length;
  }
}
