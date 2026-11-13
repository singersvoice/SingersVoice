/**
 * Hearing the stage: an audience device (or the public watch page) fetches the host's one-second
 * mix batches, decodes the Opus packets with WebCodecs and plays them back to back on the audio
 * clock, a couple of seconds behind the stage (a jitter buffer), with the track position of what
 * is being heard right now on offer — so the lyrics follow the sound, not the clock.
 */
import { signal } from '@preact/signals';
import type { MixBatch } from '@singersvoice/protocol';

export const mixPlaySupported = (): boolean => typeof AudioDecoder !== 'undefined';

/** How far behind the newest batch playback runs: room for a late second. */
const JITTER_S = 1.6;
const POLL_MS = 1000;
/** No batch for this long → the host is not sending (never was, or stopped). */
const SILENT_MS = 6000;

export interface MixState {
  /** Batches are arriving and playing. */
  hearing: boolean;
  /** Last batch sequence seen. */
  seq: number;
  /** Seconds the sound runs behind the stage (approximate). */
  behindS: number;
  /** Batches were never received, or stopped arriving. */
  silent: boolean;
}

export class MixPlayer {
  readonly state = signal<MixState>({ hearing: false, seq: 0, behindS: 0, silent: false });
  private decoder: AudioDecoder | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private since = 0;
  private nextPlayAt = 0;
  private lastBatchAt = 0;
  private startedAt = 0;
  /** What is scheduled: the track position at the moment each batch starts playing. */
  private timeline: { atMs: number; playAt: number; durS: number }[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private readonly out: GainNode;

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly fetchSince: (since: number) => Promise<{ batches: MixBatch[]; latest: number }>,
  ) {
    this.out = ctx.createGain();
    this.out.connect(destination);
  }

  start(): void {
    if (this.running || !mixPlaySupported()) return;
    this.running = true;
    this.since = 0;
    this.nextPlayAt = 0;
    this.startedAt = Date.now();
    this.lastBatchAt = 0;
    this.timeline = [];
    this.marks.clear();
    this.state.value = { hearing: false, seq: 0, behindS: 0, silent: false };
    void this.poll();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    this.sources.clear();
    const dec = this.decoder;
    this.decoder = null;
    if (dec && dec.state !== 'closed') dec.close();
    this.state.value = { hearing: false, seq: 0, behindS: 0, silent: false };
  }

  /** The track position (ms) of the sound being heard right now, or null when nothing is playing. */
  positionMs(): number | null {
    const now = this.ctx.currentTime;
    let cur: { atMs: number; playAt: number; durS: number } | null = null;
    for (const t of this.timeline) if (t.playAt <= now) cur = t;
    if (!cur || now > cur.playAt + cur.durS + 1.5) return null;
    return cur.atMs + (now - cur.playAt) * 1000;
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      const r = await this.fetchSince(this.since);
      if (!this.running) return;
      // A late joiner starts from the newest few seconds, not from the beginning of the window.
      if (this.since === 0 && r.batches.length > 3) r.batches = r.batches.slice(-3);
      for (const b of r.batches) this.play(b);
      if (r.batches.length) {
        this.since = r.batches[r.batches.length - 1]!.seq;
        this.lastBatchAt = Date.now();
      } else if (r.latest > this.since) this.since = r.latest - 1; // we fell behind the window: skip ahead
    } catch {
      /* try again next second */
    }
    const quiet = this.lastBatchAt ? Date.now() - this.lastBatchAt : Date.now() - this.startedAt;
    const hearing = this.lastBatchAt > 0 && quiet < SILENT_MS;
    this.state.value = { hearing, seq: this.since, behindS: hearing ? this.behindS() : 0, silent: quiet >= SILENT_MS };
    this.timer = setTimeout(() => void this.poll(), POLL_MS);
  }

  /** How far the sound being heard runs behind the stage: the cushion of scheduled audio plus the relay's second. */
  behindS(): number {
    const cushion = Math.max(0, this.nextPlayAt - this.ctx.currentTime);
    return Math.round((cushion + POLL_MS / 1000) * 10) / 10;
  }

  private ensureDecoder(b: MixBatch): AudioDecoder | null {
    if (this.decoder && this.decoder.state === 'configured') return this.decoder;
    try {
      const dec = new AudioDecoder({
        output: (data) => this.schedule(data),
        error: (e) => {
          console.warn('mix decoder', e);
          this.decoder = null;
        },
      });
      dec.configure({ codec: 'opus', sampleRate: b.sampleRate || 48000, numberOfChannels: b.channels || 1 });
      this.decoder = dec;
      return dec;
    } catch {
      return null;
    }
  }

  /** The first packet of each batch (by its timestamp) marks where the track is; the entry is made when that packet is scheduled. */
  private marks = new Map<number, number>();

  private play(b: MixBatch): void {
    const dec = this.ensureDecoder(b);
    if (!dec || !b.packets.length) return;
    this.marks.set(b.packets[0]!.ts, b.atMs);
    for (const p of b.packets) {
      try {
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.ts, data: fromBase64(p.b64) }));
      } catch (e) {
        console.warn('mix packet', e);
      }
    }
  }

  private schedule(data: AudioData): void {
    const frames = data.numberOfFrames;
    const ch = data.numberOfChannels;
    const buf = this.ctx.createBuffer(ch, frames, data.sampleRate);
    for (let c = 0; c < ch; c++) {
      const arr = new Float32Array(frames);
      data.copyTo(arr, { planeIndex: c, format: 'f32-planar' });
      buf.copyToChannel(arr, c);
    }
    const ts = data.timestamp;
    data.close();
    const now = this.ctx.currentTime;
    if (this.nextPlayAt < now) this.nextPlayAt = now + JITTER_S; // first sound, or we ran dry: rebuild the cushion
    const durS = frames / buf.sampleRate;
    const atMs = this.marks.get(ts);
    if (atMs !== undefined) {
      this.marks.delete(ts);
      this.timeline.push({ atMs, playAt: this.nextPlayAt, durS: 1 });
      if (this.timeline.length > 12) this.timeline.shift();
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    src.start(this.nextPlayAt);
    src.onended = () => this.sources.delete(src);
    this.sources.add(src);
    this.nextPlayAt += durS;
  }
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
