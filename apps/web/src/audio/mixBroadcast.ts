/**
 * The host's device sends the stage mix to the audience: the blend it already builds for the
 * recording (backing track + every singer's vocal after their FX) is tapped by an AudioWorklet in
 * 20 ms blocks, encoded with WebCodecs (Opus, 64 kbps, mono, 48 kHz) and posted a second at a
 * time, each batch tagged with the track position of its first frame. Needs WebCodecs (Chrome,
 * Edge, Safari 16.4+, Firefox 130+); without it the audience gets the backing track alone, as before.
 */
import { MIX_BITRATE, type MixBatch, type MixPacket } from '@singersvoice/protocol';
import { LinearResampler } from './resample.ts';

const OUT_RATE = 48000;
const BATCH_MS = 1000;
/** How much sound may wait in the encoder before blocks are left out (20 ms blocks: two seconds) — and until the wait is down to a second again, so skips come in stretches, not as a constant stutter. */
const MAX_QUEUE_BLOCKS = 100;
const RESUME_QUEUE_BLOCKS = 50;
/** A second whose loudest sample is under this (−54 dBFS) is silence — nobody is singing or talking — and is not sent. */
const SILENCE_PEAK = 0.002;

export const mixBroadcastSupported = (): boolean => typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';

export class MixBroadcaster {
  private tap: AudioWorkletNode | null = null;
  private encoder: AudioEncoder | null = null;
  private packets: MixPacket[] = [];
  /**
   * Where the track was at each block as it arrived (the stream's frame the block starts at, and the
   * position then): a batch is labelled from the frame its first packet starts at, so the label is the
   * sound's own — exact even when the encoder runs behind (a starved device: the packets of a second
   * come out later, and a label taken at flush time would name a position the sound has not reached).
   */
  private marks: { frame: number; posMs: number }[] = [];
  /** The loudest sample of the batch being built: a silent second (the stage between songs, nobody talking) is not sent. */
  private batchPeak = 0;
  private seq = 0;
  private frames = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private failed = false;
  /** Batches sent so far (for the UI / e2e). */
  sent = 0;
  /** Blocks left out because the encoder was too far behind (a starved device): the audience skipped ahead instead of drifting behind. */
  dropped = 0;
  private skipping = false;
  /** Only on a context that does not run at 48 kHz: one converter for the whole stream, carried from block to block (no seam). */
  private resampler: LinearResampler | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly send: (batch: MixBatch) => Promise<void>,
    /** The track position (ms) of the mix at an audio-clock time. */
    private readonly positionAt: (ctxTime: number) => number,
  ) {}

  start(source: AudioNode): void {
    if (this.running || !mixBroadcastSupported()) return;
    let tap: AudioWorkletNode;
    try {
      tap = new AudioWorkletNode(this.ctx, 'sv-mix-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    } catch {
      return;
    }
    const encoder = new AudioEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        this.packets.push({ ts: chunk.timestamp, b64: toBase64(buf) });
      },
      error: (e) => {
        console.warn('mix encoder', e);
        this.failed = true;
      },
    });
    encoder.configure({ codec: 'opus', sampleRate: OUT_RATE, numberOfChannels: 1, bitrate: MIX_BITRATE });
    this.encoder = encoder;
    this.tap = tap;
    this.running = true;
    this.frames = 0;
    this.packets = [];
    this.marks = [];
    this.resampler = null;
    tap.port.onmessage = (e: MessageEvent<{ type: string; data: Float32Array<ArrayBuffer>; contextTime: number; sampleRate: number }>) => {
      const m = e.data;
      if (m.type !== 'block' || !this.running || this.failed || encoder.state !== 'configured') return;
      // An encoder that cannot keep up (the device is starved) would queue sound without end and the audience
      // would drift ever further behind: past the bound the block is left out — a skip, and the audience stays near.
      if (this.skipping ? encoder.encodeQueueSize > RESUME_QUEUE_BLOCKS : encoder.encodeQueueSize > MAX_QUEUE_BLOCKS) {
        this.skipping = true;
        this.dropped++;
        return;
      }
      this.skipping = false;
      this.marks.push({ frame: this.frames, posMs: Math.max(0, this.positionAt(m.contextTime)) });
      if (this.marks.length > 1000) this.marks.splice(0, this.marks.length - 1000); // the last twenty seconds
      let peak = this.batchPeak;
      for (let i = 0; i < m.data.length; i++) {
        const a = Math.abs(m.data[i]!);
        if (a > peak) peak = a;
      }
      this.batchPeak = peak;
      let data: Float32Array<ArrayBuffer> = m.data;
      if (m.sampleRate !== OUT_RATE) {
        if (!this.resampler || this.resampler.from !== m.sampleRate) this.resampler = new LinearResampler(m.sampleRate, OUT_RATE);
        data = this.resampler.push(m.data);
      }
      try {
        encoder.encode(new AudioData({ format: 'f32', sampleRate: OUT_RATE, numberOfFrames: data.length, numberOfChannels: 1, timestamp: Math.round((this.frames / OUT_RATE) * 1e6), data }));
      } catch (err) {
        console.warn('mix encode', err);
      }
      this.frames += data.length;
    };
    source.connect(tap);
    this.timer = setInterval(() => void this.flush(), BATCH_MS);
  }

  /** The track position (ms) of the stream's frame `f`, from the block it fell in. */
  private positionOfFrame(f: number): number {
    let mark: { frame: number; posMs: number } | null = null;
    for (const m of this.marks) {
      if (m.frame <= f) mark = m;
      else break;
    }
    if (!mark) return 0;
    return Math.max(0, Math.round(mark.posMs + ((f - mark.frame) / OUT_RATE) * 1000));
  }

  private async flush(): Promise<void> {
    if (!this.packets.length) return;
    const silent = this.batchPeak < SILENCE_PEAK;
    const first = this.packets[0]!;
    const batch: MixBatch = { seq: ++this.seq, atMs: this.positionOfFrame(Math.round((first.ts / 1e6) * OUT_RATE)), codec: 'opus', sampleRate: OUT_RATE, channels: 1, packets: this.packets };
    this.packets = [];
    this.batchPeak = 0;
    if (silent) {
      this.seq--; // nothing to hear: the next audible second takes this number
      return;
    }
    try {
      await this.send(batch);
      this.sent++;
    } catch (e) {
      console.warn('mix send', e); // the next second goes out anyway; the audience bridges the gap
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.tap?.disconnect();
    } catch {
      /* gone */
    }
    this.tap = null;
    const enc = this.encoder;
    this.encoder = null;
    if (enc && enc.state !== 'closed') {
      try {
        enc.close();
      } catch {
        /* closed */
      }
    }
    this.packets = [];
    this.marks = [];
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}

