/**
 * Hearing the stage: an audience device (or the public watch page) fetches the host's one-second
 * mix batches, decodes the Opus packets with WebCodecs and hands the sound to one AudioWorklet
 * (`sv-mix-out`) that plays it as a single continuous stream on the audio clock — resampled in
 * one piece to whatever rate this device runs at, never a seam between packets, a couple of seconds
 * behind the stage (a cushion against a late batch; silence, not a stutter, if it ever runs dry) —
 * with the track position of what is being heard right now on offer, so the lyrics follow the sound,
 * not the clock. (An earlier version scheduled fifty buffer nodes a second back to back; on a device
 * running at 44.1 kHz each node resampled on its own and every seam clicked.)
 */
import { signal } from '@preact/signals';
import type { MixBatch } from '@singersvoice/protocol';

export const mixPlaySupported = (): boolean => typeof AudioDecoder !== 'undefined' && typeof AudioWorkletNode !== 'undefined';

/**
 * How far behind the newest batch playback runs: room for a batch that comes a poll late — the edge
 * cache in front of the relay may hold an answer for a second, so a batch can take two polls to arrive
 * (and then two come at once) — and for the host's device holding its breath for a couple of seconds
 * (a phone hosting ten singers: the batches are built on its main thread and come in a burst after a
 * stall). The lyrics follow the sound, so the audience never notices the delay; a stutter they would.
 */
const JITTER_S = 3.0;
const POLL_MS = 1000;
/** No batch for this long → the host is not sending (never was, or stopped). */
const SILENT_MS = 6000;
/** The worklet module, loaded on the context if the engine has not loaded it already. */
const MODULE = 'worklets/mix-out.js';

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
  private lastBatchAt = 0;
  private startedAt = 0;
  private node: AudioWorkletNode | null = null;
  private nodeReady: Promise<AudioWorkletNode | null> | null = null;
  private inRate = 48000;
  /** Input frames handed to the worklet so far (the stream's clock). */
  private pushed = 0;
  /** What the worklet last said: input frames played, frames queued, at which audio-clock time. */
  private played = { consumed: 0, queued: 0, playing: false, contextTime: 0 };
  /** Where each batch starts on the stream's clock, and the track position it carries. */
  private timeline: { atFrame: number; atMs: number }[] = [];
  /**
   * Each batch marks where the track is at its first packet; the entry goes on the timeline when that
   * packet's sound comes out of the decoder — found by order (the decoder gives one sound per packet,
   * in order), never by timestamp: a decoder may renumber its output after a packet the host left out.
   */
  private pendingMarks: { packet: number; atMs: number }[] = [];
  /** Packets fed to the decoder, and sounds that came out of it, since the start. */
  private fed = 0;
  private decoded = 0;
  /** The player's output (support / e2e: a tap here hears exactly what the audience hears). */
  readonly out: GainNode;

  constructor(
    readonly ctx: AudioContext,
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
    this.startedAt = Date.now();
    this.lastBatchAt = 0;
    this.pushed = 0;
    this.played = { consumed: 0, queued: 0, playing: false, contextTime: 0 };
    this.timeline = [];
    this.pendingMarks = [];
    this.fed = 0;
    this.decoded = 0;
    this.state.value = { hearing: false, seq: 0, behindS: 0, silent: false };
    void this.poll();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    const dec = this.decoder;
    this.decoder = null;
    if (dec && dec.state !== 'closed') dec.close();
    const node = this.node;
    this.node = null;
    this.nodeReady = null;
    if (node) {
      try {
        node.port.postMessage({ type: 'reset' });
        node.disconnect();
      } catch {
        /* gone */
      }
    }
    this.state.value = { hearing: false, seq: 0, behindS: 0, silent: false };
  }

  /** The track position (ms) of the sound being heard right now, or null when nothing is playing. */
  positionMs(): number | null {
    const p = this.played;
    if (!p.playing || !this.timeline.length) return null;
    const now = Math.max(p.consumed, p.consumed + (this.ctx.currentTime - p.contextTime) * this.inRate);
    let cur: { atFrame: number; atMs: number } | null = null;
    for (const t of this.timeline) if (t.atFrame <= now) cur = t;
    if (!cur) return null;
    if (now - cur.atFrame > this.inRate * 2.5) return null; // nothing newer for a long while: the sound stopped
    return cur.atMs + ((now - cur.atFrame) / this.inRate) * 1000;
  }

  /** How far the sound being heard runs behind the stage: the cushion of queued sound plus the relay's second. */
  behindS(): number {
    return Math.round((this.played.queued / this.inRate + POLL_MS / 1000) * 10) / 10;
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

  /** The output node: made once, for the rate of the first batch (the host's mix is 48 kHz mono). */
  private ensureNode(rate: number): Promise<AudioWorkletNode | null> {
    if (this.nodeReady) return this.nodeReady;
    this.inRate = rate;
    const make = () =>
      new AudioWorkletNode(this.ctx, 'sv-mix-out', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { sampleRate: rate, cushionFrames: Math.round(rate * JITTER_S) },
      });
    this.nodeReady = (async () => {
      let node: AudioWorkletNode;
      try {
        node = make();
      } catch {
        try {
          await this.ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}${MODULE}`);
          node = make();
        } catch (e) {
          console.warn('mix out', e);
          return null;
        }
      }
      if (!this.running) return null;
      node.port.onmessage = (e: MessageEvent<{ type: string; consumed: number; queued: number; playing: boolean; contextTime: number }>) => {
        if (e.data.type === 'pos') this.played = { consumed: e.data.consumed, queued: e.data.queued, playing: e.data.playing, contextTime: e.data.contextTime };
      };
      node.connect(this.out);
      this.node = node;
      return node;
    })();
    return this.nodeReady;
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
    void this.ensureNode(b.sampleRate || 48000);
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

  /** Decoded sound → the worklet, mono (a stereo mix is summed), in order; the batch marks go on the stream's clock. */
  private push(data: AudioData): void {
    const frames = data.numberOfFrames;
    const ch = data.numberOfChannels;
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
      this.timeline.push({ atFrame: this.pushed, atMs: m.atMs });
      if (this.timeline.length > 12) this.timeline.shift();
    }
    this.pushed += frames;
    void this.ensureNode(data.sampleRate).then((node) => {
      if (node && this.running) node.port.postMessage({ type: 'pcm', data: mono }, [mono.buffer]);
    });
  }
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
