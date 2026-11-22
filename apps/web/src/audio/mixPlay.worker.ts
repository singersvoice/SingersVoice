/**
 * The audience's mix, received and decoded off the page's main thread: the host's one-second Opus batches come in
 * here — from the service's stream (one request for the whole listen, each batch the moment it is sent) or, where
 * a stream cannot be kept, by polling a second at a time — are decoded with WebCodecs, and the sound goes straight
 * to the `sv-mix-out` worklet through a port of its own. A page busy with the room (a crowded stage drawn, the
 * chat, a lyric sheet, a main thread that stalls for a moment) never costs the listener a block. (It used to: the
 * stream's events and the decoder's output queued behind the page's work, the worklet ran dry, and the cushion had
 * to fill again — three seconds of silence for a stall of one.)
 *
 * Messages in (mixPlayer.ts is the page's side):
 *   start  — where to listen: the stream's address and the poll's (both without `since`), or neither when the
 *            batches are handed over (the mix lab feeds the player that way)
 *   port   — the MessagePort the worklet takes its sound from (transferred)
 *   batch  — a batch handed over by the page
 *   stop
 * Messages out:
 *   tick   — once a second: the last batch's sequence, whether batches arrive, whether they stopped, the stream
 *   mark   — where a batch's first sound sits on the stream's clock (input frames pushed so far) and the track
 *            position it carries: the page's lyrics follow it
 */
import type { MixBatch } from '@singersvoice/protocol';

const POLL_MS = 1000;
/** A stream that failed is tried again this often (the polls carry the sound meanwhile). */
const STREAM_RETRY_MS = 20_000;
/** No batch for this long → the host is not sending (never was, or stopped). */
const SILENT_MS = 6000;

export type MixPlayWorkerIn = { type: 'start'; pollUrl: string | null; streamUrl: string | null } | { type: 'port'; port: MessagePort } | { type: 'batch'; batch: MixBatch } | { type: 'stop' };
export type MixPlayWorkerOut = { type: 'tick'; seq: number; hearing: boolean; silent: boolean; streamed: number; streaming: boolean } | { type: 'mark'; atFrame: number; atMs: number; rate: number };

const post = (m: MixPlayWorkerOut) => (self as unknown as Worker).postMessage(m);
const withSince = (url: string, since: number) => `${url}${url.includes('?') ? '&' : '?'}since=${since}`;

class MixPlayWorker {
  private port: MessagePort | null = null;
  private decoder: AudioDecoder | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pollUrl: string | null = null;
  private streamUrl: string | null = null;
  private since = 0;
  private lastBatchAt = 0;
  private startedAt = 0;
  /** Input frames handed to the worklet so far (the stream's clock). */
  private pushed = 0;
  /**
   * Each batch marks where the track is at its first packet; the mark goes out when that packet's sound comes out
   * of the decoder — found by order (the decoder gives one sound per packet, in order), never by timestamp: a
   * decoder may renumber its output after a packet the host left out.
   */
  private pendingMarks: { packet: number; atMs: number }[] = [];
  /** Packets fed to the decoder, and sounds that came out of it, since the start. */
  private fed = 0;
  private decoded = 0;
  /** The stream, while one is open; the polls run when there is none. */
  private es: EventSource | null = null;
  private streamTriedAt = 0;
  private streamed = 0;

  start(m: Extract<MixPlayWorkerIn, { type: 'start' }>): void {
    if (this.running) return;
    this.running = true;
    this.pollUrl = m.pollUrl;
    this.streamUrl = m.streamUrl;
    this.startedAt = Date.now();
    this.openStream();
    void this.poll();
  }

  takePort(port: MessagePort): void {
    this.port = port;
  }

  /** A batch handed over by the page (the lab): as if it had come by the stream. */
  feed(b: MixBatch): void {
    if (!this.running || b.seq <= this.since) return;
    this.play(b);
    this.since = b.seq;
    this.lastBatchAt = Date.now();
  }

  private get streaming(): boolean {
    return this.es !== null && this.es.readyState === EventSource.OPEN;
  }

  private openStream(): void {
    if (!this.streamUrl || typeof EventSource !== 'function' || this.es) return;
    this.streamTriedAt = Date.now();
    let es: EventSource;
    try {
      es = new EventSource(withSince(this.streamUrl, this.since));
    } catch {
      return;
    }
    this.es = es;
    es.addEventListener('batch', (ev) => {
      if (this.es !== es || !this.running) return;
      try {
        const b = JSON.parse(String((ev as MessageEvent).data)) as MixBatch;
        if (b.seq <= this.since) return; // a poll had it already
        this.play(b);
        this.since = b.seq;
        this.lastBatchAt = Date.now();
        this.streamed++;
      } catch {
        /* a batch the next one makes up for */
      }
    });
    es.addEventListener('end', () => {
      if (this.es === es) this.closeStream();
    });
    es.onerror = () => {
      // The browser reconnects by itself from where it was; closed for good: the polls carry on, the stream is tried again later.
      if (this.es === es && es.readyState === EventSource.CLOSED) this.closeStream();
    };
  }

  private closeStream(): void {
    const es = this.es;
    this.es = null;
    es?.close();
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    // The stream carries the sound; the poll is the fallback — and the way back to a stream that was lost.
    if (this.pollUrl && !this.streaming) {
      if (!this.es && this.streamUrl && Date.now() - this.streamTriedAt > STREAM_RETRY_MS) this.openStream();
      try {
        const res = await fetch(withSince(this.pollUrl, this.since));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const r = (await res.json()) as { batches: MixBatch[]; latest: number };
        if (!this.running) return;
        // A late joiner starts from the newest few seconds, not from the beginning of the window.
        if (this.since === 0 && r.batches.length > 3) r.batches = r.batches.slice(-3);
        for (const b of r.batches) {
          if (b.seq <= this.since) continue;
          this.play(b);
          this.since = b.seq;
          this.lastBatchAt = Date.now();
        }
        if (!r.batches.length && r.latest > this.since) this.since = r.latest - 1; // we fell behind the window: skip ahead
      } catch {
        /* try again next second */
      }
    }
    const quiet = this.lastBatchAt ? Date.now() - this.lastBatchAt : Date.now() - this.startedAt;
    const hearing = this.lastBatchAt > 0 && quiet < SILENT_MS;
    post({ type: 'tick', seq: this.since, hearing, silent: quiet >= SILENT_MS, streamed: this.streamed, streaming: this.streaming });
    this.timer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private ensureDecoder(b: MixBatch): AudioDecoder | null {
    if (this.decoder && this.decoder.state === 'configured') return this.decoder;
    try {
      const dec = new AudioDecoder({
        output: (data) => this.push(data),
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

  private play(b: MixBatch): void {
    const dec = this.ensureDecoder(b);
    if (!dec || !b.packets.length) return;
    this.pendingMarks.push({ packet: this.fed, atMs: b.atMs });
    for (const p of b.packets) {
      try {
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.ts, data: fromBase64(p.b64) }));
        this.fed++;
      } catch (e) {
        console.warn('mix packet', e);
      }
    }
  }

  /** Decoded sound → the worklet, mono (a stereo mix is summed), in order; the batch marks go to the page on the stream's clock. */
  private push(data: AudioData): void {
    const frames = data.numberOfFrames;
    const ch = data.numberOfChannels;
    const rate = data.sampleRate;
    const mono = new Float32Array(new ArrayBuffer(frames * 4));
    if (ch === 1) data.copyTo(mono, { planeIndex: 0, format: 'f32-planar' });
    else {
      const tmp = new Float32Array(frames);
      for (let c = 0; c < ch; c++) {
        data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < frames; i++) mono[i] = mono[i]! + tmp[i]! / ch;
      }
    }
    data.close();
    const index = this.decoded++;
    while (this.pendingMarks.length && this.pendingMarks[0]!.packet <= index) {
      const m = this.pendingMarks.shift()!;
      post({ type: 'mark', atFrame: this.pushed, atMs: m.atMs, rate });
    }
    this.pushed += frames;
    if (this.running && this.port) this.port.postMessage({ type: 'pcm', data: mono, rate }, [mono.buffer]);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer);
    this.closeStream();
    const dec = this.decoder;
    this.decoder = null;
    if (dec && dec.state !== 'closed') {
      try {
        dec.close();
      } catch {
        /* closed */
      }
    }
    this.port?.close();
    this.port = null;
    this.pendingMarks = [];
  }
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const player = new MixPlayWorker();
self.onmessage = (e: MessageEvent<MixPlayWorkerIn>) => {
  const m = e.data;
  switch (m.type) {
    case 'start':
      player.start(m);
      break;
    case 'port':
      player.takePort(m.port);
      break;
    case 'batch':
      player.feed(m.batch);
      break;
    case 'stop':
      player.stop();
      break;
  }
};
