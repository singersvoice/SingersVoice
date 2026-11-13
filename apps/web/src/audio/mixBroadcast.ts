/**
 * The host's device sends the stage mix to the audience: the blend it already builds for the
 * recording (backing track + every singer's vocal after their FX) is tapped by an AudioWorklet in
 * 20 ms blocks, encoded with WebCodecs (Opus, 64 kbps, mono, 48 kHz) and posted a second at a
 * time, each batch tagged with the track position of its first frame. Needs WebCodecs (Chrome,
 * Edge, Safari 16.4+, Firefox 130+); without it the audience gets the backing track alone, as before.
 */
import { MIX_BITRATE, type MixBatch, type MixPacket } from '@singersvoice/protocol';

const OUT_RATE = 48000;
const BATCH_MS = 1000;

export const mixBroadcastSupported = (): boolean => typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';

export class MixBroadcaster {
  private tap: AudioWorkletNode | null = null;
  private encoder: AudioEncoder | null = null;
  private packets: MixPacket[] = [];
  private batchAtMs: number | null = null;
  private seq = 0;
  private frames = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private failed = false;
  /** Batches sent so far (for the UI / e2e). */
  sent = 0;

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
    this.batchAtMs = null;
    tap.port.onmessage = (e: MessageEvent<{ type: string; data: Float32Array<ArrayBuffer>; contextTime: number; sampleRate: number }>) => {
      const m = e.data;
      if (m.type !== 'block' || !this.running || this.failed || encoder.state !== 'configured') return;
      if (this.batchAtMs === null) this.batchAtMs = Math.max(0, Math.round(this.positionAt(m.contextTime)));
      const data: Float32Array<ArrayBuffer> = m.sampleRate === OUT_RATE ? m.data : resample(m.data, m.sampleRate, OUT_RATE);
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

  private async flush(): Promise<void> {
    if (!this.packets.length || this.batchAtMs === null) return;
    const batch: MixBatch = { seq: ++this.seq, atMs: this.batchAtMs, codec: 'opus', sampleRate: OUT_RATE, channels: 1, packets: this.packets };
    this.packets = [];
    this.batchAtMs = null;
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
    this.batchAtMs = null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}

/** Linear resampling of a short mono block (only when the context does not run at 48 kHz). */
function resample(input: Float32Array, from: number, to: number): Float32Array<ArrayBuffer> {
  const n = Math.round((input.length * to) / from);
  const out = new Float32Array(new ArrayBuffer(n * 4));
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const f = x - i0;
    out[i] = input[i0]! * (1 - f) + input[i1]! * f;
  }
  return out;
}
