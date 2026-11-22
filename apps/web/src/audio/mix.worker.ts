/**
 * The audience's mix, encoded off the page's main thread: the host's device sends the stage mix (backing track +
 * every singer's vocal after their FX) to the audience a second at a time (WebCodecs Opus, 64 kbps, mono, 48 kHz),
 * each batch tagged with the track position of its first frame. The mix tap (an AudioWorklet) posts its 20 ms
 * blocks straight to this Worker's port, the encoder runs here, and the batch is POSTed from here — so a host's
 * page busy with a crowded stage never costs the audience a block (it used to: the blocks queued on the main
 * thread, the encoder fell seconds behind, and blocks were dropped to catch up — a stutter for every listener).
 *
 * Messages in (mixBroadcast.ts is the page's side):
 *   start     — where to send (the service's URL, the sign-in headers, the resume token), whether anybody listens
 *   port      — the MessagePort the worklet posts its blocks to (transferred)
 *   schedule  — the track's position at an audio-clock instant and whether it plays (every quarter second, and at every transport change): the batches' labels
 *   wanted    — whether anybody is listening (nothing is encoded or sent while nobody is)
 *   auth      — the sign-in headers again
 *   stop
 * Messages out: stats (sent, dropped, idle, the encoder's queue), once a second.
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

export interface MixSchedule {
  /** The audio clock (s) the position was read at, and the track's position then (ms), already shifted by the mix's lag. */
  ctxTime: number;
  posMs: number;
  playing: boolean;
  /** The player's tempo (1 = as recorded). */
  tempo: number;
  durationMs: number;
}
export type MixWorkerIn = { type: 'start'; url: string; headers: Record<string, string>; resumeToken: string; wanted: boolean } | { type: 'port'; port: MessagePort } | { type: 'schedule'; schedule: MixSchedule } | { type: 'wanted'; on: boolean } | { type: 'auth'; headers: Record<string, string> } | { type: 'stop' };
export interface MixStats {
  sent: number;
  dropped: number;
  idle: number;
  queue: number;
  blocks: number;
}
export type MixWorkerOut = { type: 'stats'; stats: MixStats };

const post = (m: MixWorkerOut) => (self as unknown as Worker).postMessage(m);

class MixWorker {
  private encoder: AudioEncoder | null = null;
  private port: MessagePort | null = null;
  private packets: MixPacket[] = [];
  /** Where the track was at each block as it arrived: a batch is labelled from the frame its first packet starts at (exact even when the encoder runs behind). */
  private marks: { frame: number; posMs: number }[] = [];
  private batchPeak = 0;
  private seq = 0;
  private frames = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private failed = false;
  private skipping = false;
  private resampler: LinearResampler | null = null;
  private url = '';
  private headers: Record<string, string> = {};
  private resumeToken = '';
  private wanted = true;
  private schedule: MixSchedule | null = null;
  private stats: MixStats = { sent: 0, dropped: 0, idle: 0, queue: 0, blocks: 0 };

  start(m: Extract<MixWorkerIn, { type: 'start' }>): void {
    if (this.running) return;
    this.url = m.url;
    this.headers = m.headers;
    this.resumeToken = m.resumeToken;
    this.wanted = m.wanted;
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
    this.running = true;
    this.timer = setInterval(() => void this.flush(), BATCH_MS);
    this.statsTimer = setInterval(() => post({ type: 'stats', stats: { ...this.stats, queue: this.encoder?.encodeQueueSize ?? 0 } }), 1000);
  }

  takePort(port: MessagePort): void {
    this.port = port;
    port.onmessage = (e: MessageEvent<{ type: string; data: Float32Array<ArrayBuffer>; contextTime: number; sampleRate: number }>) => this.onBlock(e.data);
    port.start?.();
  }

  /** The track position (ms) at an audio-clock instant, from the schedule last told: on the current (pre-cue) schedule, as the player itself would say. */
  private positionAt(ctxTime: number): number {
    const s = this.schedule;
    if (!s) return 0;
    if (!s.playing) return Math.max(0, s.posMs);
    return Math.max(0, Math.min(s.durationMs, s.posMs + Math.max(0, ctxTime - s.ctxTime) * s.tempo * 1000));
  }

  private onBlock(m: { type: string; data: Float32Array<ArrayBuffer>; contextTime: number; sampleRate: number }): void {
    const encoder = this.encoder;
    if (m.type !== 'block' || !this.running || this.failed || !encoder || encoder.state !== 'configured') return;
    this.stats.blocks++;
    if (!this.wanted) {
      // Nobody listening: the block is let go (the batches are labelled by track position, so the sound picks up where the stage is when a listener comes).
      if (this.packets.length || this.marks.length) {
        this.packets = [];
        this.marks = [];
        this.batchPeak = 0;
      }
      return;
    }
    // An encoder that cannot keep up would queue sound without end and the audience would drift ever further behind:
    // past the bound the block is left out — a skip, and the audience stays near. (Off the main thread this is rare.)
    if (this.skipping ? encoder.encodeQueueSize > RESUME_QUEUE_BLOCKS : encoder.encodeQueueSize > MAX_QUEUE_BLOCKS) {
      this.skipping = true;
      this.stats.dropped++;
      return;
    }
    this.skipping = false;
    this.marks.push({ frame: this.frames, posMs: this.positionAt(m.contextTime) });
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
    if (!this.packets.length) {
      if (this.running && !this.wanted) this.stats.idle++;
      return;
    }
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
      const r = await fetch(this.url, { method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...batch, resumeToken: this.resumeToken }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.stats.sent++;
    } catch (e) {
      console.warn('mix send', e); // the next second goes out anyway; the audience bridges the gap
    }
  }

  setSchedule(s: MixSchedule): void {
    this.schedule = s;
  }
  setWanted(on: boolean): void {
    this.wanted = on;
  }
  setHeaders(h: Record<string, string>): void {
    this.headers = h;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    clearInterval(this.statsTimer);
    this.port?.close();
    this.port = null;
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

const mix = new MixWorker();
self.onmessage = (e: MessageEvent<MixWorkerIn>) => {
  const m = e.data;
  switch (m.type) {
    case 'start':
      mix.start(m);
      break;
    case 'port':
      mix.takePort(m.port);
      break;
    case 'schedule':
      mix.setSchedule(m.schedule);
      break;
    case 'wanted':
      mix.setWanted(m.on);
      break;
    case 'auth':
      mix.setHeaders(m.headers);
      break;
    case 'stop':
      mix.stop();
      break;
  }
};
