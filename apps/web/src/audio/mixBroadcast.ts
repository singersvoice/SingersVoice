/**
 * The host's device sends the stage mix to the audience: the blend it already builds for the recording (backing
 * track + every singer's vocal after their FX) is tapped by an AudioWorklet in 20 ms blocks, encoded with
 * WebCodecs (Opus, 64 kbps, mono, 48 kHz) and posted a second at a time, each batch tagged with the track
 * position of its first frame. The encoding and the posting run in a Worker of their own (mix.worker.ts), fed
 * straight from the tap: a host's page busy with a crowded stage never costs the audience a block. This is the
 * page's side: the tap, the Worker, and what the Worker needs to know — where to send, whether anybody listens,
 * and the track's schedule (every quarter second), from which the Worker labels every block with the position
 * the song had at that instant. Needs WebCodecs (Chrome, Edge, Safari 16.4+, Firefox 130+); without it the
 * audience gets the backing track alone, as before.
 */
import type { MixSchedule, MixStats, MixWorkerIn, MixWorkerOut } from './mix.worker.ts';

/** Where a batch goes: the service's mix route for the meet, this device's resume token (the batch carries it) and the sign-in headers (read again whenever asked: a renewed token). */
export interface MixTarget {
  url: string;
  resumeToken: string;
  headers: Record<string, string>;
}

/** How often the Worker is told the track's schedule, whether anybody listens, and the sign-in (when it changed). */
const TELL_MS = 250;

export const mixBroadcastSupported = (): boolean => typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined' && typeof Worker !== 'undefined';

export class MixBroadcaster {
  private tap: AudioWorkletNode | null = null;
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastHeaders = '';
  private lastWanted: boolean | null = null;
  /** As the Worker reports, once a second: batches sent, blocks left out (a starved encoder), seconds not encoded for want of a listener, the encoder's queue. */
  sent = 0;
  dropped = 0;
  idle = 0;
  queue = 0;
  /** The encoder's queue as the Worker reports it (support / e2e, where the encoder itself used to be read). */
  get encoder(): { encodeQueueSize: number } {
    return { encodeQueueSize: this.queue };
  }

  constructor(
    private readonly ctx: AudioContext,
    /** Where the batches go (null: nowhere yet — nothing is started). */
    private readonly target: () => MixTarget | null,
    /** The track's schedule right now: the position at this instant of the audio clock (shifted by the mix's lag), whether it plays, the tempo, the length. */
    private readonly schedule: () => MixSchedule | null,
    /** Whether anybody is listening right now: while nobody is, no block is encoded and nothing is sent (the device's CPU and the service's day are spared). */
    private readonly wanted: () => boolean = () => true,
  ) {}

  start(source: AudioNode): void {
    if (this.running || !mixBroadcastSupported()) return;
    const target = this.target();
    if (!target) return;
    let tap: AudioWorkletNode;
    try {
      tap = new AudioWorkletNode(this.ctx, 'sv-mix-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    } catch {
      return;
    }
    const worker = new Worker(new URL('./mix.worker.ts', import.meta.url), { type: 'module', name: 'sv-mix' });
    worker.onmessage = (e: MessageEvent<MixWorkerOut>) => {
      if (e.data.type !== 'stats') return;
      const s: MixStats = e.data.stats;
      this.sent = s.sent;
      this.dropped = s.dropped;
      this.idle = s.idle;
      this.queue = s.queue;
    };
    worker.onerror = (e) => console.warn('mix worker', e.message);
    const send = (m: MixWorkerIn, transfer?: Transferable[]) => worker.postMessage(m, transfer ?? []);
    // The tap posts its blocks to the Worker's own port: the sound never waits for this page.
    const channel = new MessageChannel();
    tap.port.postMessage({ type: 'port', port: channel.port1 }, [channel.port1]);
    send({ type: 'port', port: channel.port2 }, [channel.port2]);
    this.lastHeaders = JSON.stringify(target.headers);
    this.lastWanted = this.wanted();
    send({ type: 'start', url: target.url, headers: target.headers, resumeToken: target.resumeToken, wanted: this.lastWanted });
    const sch = this.schedule();
    if (sch) send({ type: 'schedule', schedule: sch });
    this.worker = worker;
    this.tap = tap;
    this.running = true;
    source.connect(tap);
    this.timer = setInterval(() => this.tell(), TELL_MS);
  }

  /** The Worker is told what changed: the schedule (always — the song moves), whether anybody listens, the sign-in. */
  private tell(): void {
    const w = this.worker;
    if (!w || !this.running) return;
    const sch = this.schedule();
    if (sch) w.postMessage({ type: 'schedule', schedule: sch } satisfies MixWorkerIn);
    const wanted = this.wanted();
    if (wanted !== this.lastWanted) {
      this.lastWanted = wanted;
      w.postMessage({ type: 'wanted', on: wanted } satisfies MixWorkerIn);
    }
    const t = this.target();
    const h = JSON.stringify(t?.headers ?? {});
    if (t && h !== this.lastHeaders) {
      this.lastHeaders = h;
      w.postMessage({ type: 'auth', headers: t.headers } satisfies MixWorkerIn);
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
    const w = this.worker;
    this.worker = null;
    if (w) {
      try {
        w.postMessage({ type: 'stop' } satisfies MixWorkerIn);
      } catch {
        /* gone */
      }
      setTimeout(() => w.terminate(), 1500); // the last batch on its way out first
    }
  }
}
