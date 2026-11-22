/**
 * Hearing the stage: an audience device (or the public watch page) takes the host's one-second mix
 * batches — from the service's stream (one request for the whole listen, each batch the moment it is
 * sent), or by polling a second at a time where a stream cannot be kept — decodes the Opus packets
 * with WebCodecs and hands the sound to one AudioWorklet (`sv-mix-out`) that plays it as a single
 * continuous stream on the audio clock — resampled in one piece to whatever rate this device runs at,
 * never a seam between packets, a couple of seconds behind the stage (a cushion against a late batch;
 * silence, not a stutter, if it ever runs dry) — with the track position of what is being heard right
 * now on offer, so the lyrics follow the sound, not the clock. The receiving and the decoding run in a
 * Worker of their own (mixPlay.worker.ts) that feeds the worklet through a port of its own: a page
 * busy with the room never costs the listener a block. This is the page's side: the worklet, the
 * Worker, the state, and where the sound is. (An earlier version scheduled fifty buffer nodes a
 * second back to back; on a device running at 44.1 kHz each node resampled on its own and every seam
 * clicked. The one before this decoded on the main thread; a page stalled for a second cost the
 * cushion, three seconds of silence.)
 */
import { signal } from '@preact/signals';
import type { MixBatch } from '@singersvoice/protocol';
import type { MixPlayWorkerIn, MixPlayWorkerOut } from './mixPlay.worker.ts';

export const mixPlaySupported = (): boolean => typeof AudioDecoder !== 'undefined' && typeof AudioWorkletNode !== 'undefined' && typeof Worker !== 'undefined';

/**
 * How far behind the newest batch playback runs: room for a batch that comes a poll late — the edge
 * cache in front of the relay may hold an answer for a second, so a batch can take two polls to arrive
 * (and then two come at once) — and for the host's device holding its breath for a couple of seconds
 * (a phone hosting ten singers). The lyrics follow the sound, so the audience never notices the delay;
 * a stutter they would.
 */
const JITTER_S = 3.0;
const POLL_MS = 1000;
/** The worklet module, loaded on the context if the engine has not loaded it already. */
const MODULE = 'worklets/mix-out.js';
/** The host's mix is 48 kHz mono (the worklet is made for that rate; a batch at another rate retunes it). */
const MIX_RATE = 48000;

/** Where the batches come from: the service's poll route and its stream (both without `since`); null when the page hands them over (`feed`). */
export interface MixSource {
  pollUrl: string;
  streamUrl: string | null;
}

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
  private running = false;
  private worker: Worker | null = null;
  private node: AudioWorkletNode | null = null;
  private nodeReady: Promise<AudioWorkletNode | null> | null = null;
  private inRate = MIX_RATE;
  /** What the worklet last said: input frames played, frames queued, at which audio-clock time. */
  private played = { consumed: 0, queued: 0, playing: false, contextTime: 0 };
  /** Where each batch starts on the stream's clock, and the track position it carries (the Worker's marks). */
  private timeline: { atFrame: number; atMs: number }[] = [];
  /** The player's output (support / e2e: a tap here hears exactly what the audience hears). */
  readonly out: GainNode;
  /** Batches taken from the stream rather than a poll (for the UI / e2e), and whether the stream carries the sound right now. */
  streamed = 0;
  private streamingNow = false;
  /** Batches handed over before the Worker is up (the worklet module loading): they go in first. */
  private handed: MixBatch[] = [];

  constructor(
    readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly source: MixSource | null,
  ) {
    this.out = ctx.createGain();
    this.out.connect(destination);
  }

  start(): void {
    if (this.running || !mixPlaySupported()) return;
    this.running = true;
    this.played = { consumed: 0, queued: 0, playing: false, contextTime: 0 };
    this.timeline = [];
    this.streamed = 0;
    this.streamingNow = false;
    this.state.value = { hearing: false, seq: 0, behindS: 0, silent: false };
    void this.boot();
  }

  /** The worklet first, then the Worker with the worklet's port in hand: nothing decoded has nowhere to go. */
  private async boot(): Promise<void> {
    const node = await this.ensureNode();
    if (!node || !this.running) return;
    const worker = new Worker(new URL('./mixPlay.worker.ts', import.meta.url), { type: 'module', name: 'sv-mix-play' });
    worker.onmessage = (e: MessageEvent<MixPlayWorkerOut>) => this.onMessage(e.data);
    worker.onerror = (e) => console.warn('mix play worker', e.message);
    const channel = new MessageChannel();
    node.port.postMessage({ type: 'port', port: channel.port1 }, [channel.port1]);
    worker.postMessage({ type: 'port', port: channel.port2 } satisfies MixPlayWorkerIn, [channel.port2]);
    worker.postMessage({ type: 'start', pollUrl: this.source?.pollUrl ?? null, streamUrl: this.source?.streamUrl ?? null } satisfies MixPlayWorkerIn);
    this.worker = worker;
    for (const batch of this.handed.splice(0)) worker.postMessage({ type: 'batch', batch } satisfies MixPlayWorkerIn);
  }

  private onMessage(m: MixPlayWorkerOut): void {
    if (!this.running) return;
    if (m.type === 'mark') {
      this.inRate = m.rate;
      this.timeline.push({ atFrame: m.atFrame, atMs: m.atMs });
      if (this.timeline.length > 12) this.timeline.shift();
    } else if (m.type === 'tick') {
      this.streamed = m.streamed;
      this.streamingNow = m.streaming;
      this.state.value = { hearing: m.hearing, seq: m.seq, behindS: m.hearing ? this.behindS() : 0, silent: m.silent };
    }
  }

  /** Whether the stream carries the sound right now (the polls then only keep the state fresh). */
  get streaming(): boolean {
    return this.streamingNow;
  }

  /** A batch handed over by the page (the mix lab feeds the player this way, in place of the service). */
  feed(batch: MixBatch): void {
    if (!this.running) return;
    if (this.worker) this.worker.postMessage({ type: 'batch', batch } satisfies MixPlayWorkerIn);
    else this.handed.push(batch);
  }

  stop(): void {
    this.running = false;
    this.handed = [];
    const w = this.worker;
    this.worker = null;
    if (w) {
      try {
        w.postMessage({ type: 'stop' } satisfies MixPlayWorkerIn);
      } catch {
        /* gone */
      }
      setTimeout(() => w.terminate(), 500);
    }
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

  /** The output node: made once, for the host's mix rate. */
  private ensureNode(): Promise<AudioWorkletNode | null> {
    if (this.nodeReady) return this.nodeReady;
    const make = () =>
      new AudioWorkletNode(this.ctx, 'sv-mix-out', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { sampleRate: MIX_RATE, cushionFrames: Math.round(MIX_RATE * JITTER_S) },
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
}
