/**
 * The show view's broadcast, as one object: the publisher's sound bus, a 1280×720 canvas drawing
 * the show picture (the same drawing the saved performance uses), the WebCodecs encoder cutting it
 * into two-second MPEG-TS segments, and the sender delivering them to the service — which keeps
 * them for the in-house portal and forwards them to YouTube.
 */
import { signal } from '@preact/signals';
import type { BackgroundItem, PublishJob } from '@singersvoice/protocol';
import { LIVE_HEIGHT, LIVE_WIDTH, LiveEncoder, liveSupport, type LiveSupport } from '../../broadcast/liveEncoder.ts';
import { LiveSender, type SenderState } from '../../broadcast/liveSender.ts';
import { PublisherBus } from '../../broadcast/publisherBus.ts';
import { ShowRecorder } from '../../video/showRecorder.ts';
import type { StagePerformer } from '../../video/stage.ts';

export class Broadcast {
  readonly bus = new PublisherBus();
  readonly picture = new ShowRecorder(LIVE_WIDTH, LIVE_HEIGHT);
  readonly status = signal<SenderState | null>(null);
  readonly support = signal<LiveSupport | null>(null);
  private encoder: LiveEncoder | null = null;
  private sender: LiveSender | null = null;
  private unsubscribe: (() => void) | null = null;
  /** The job being broadcast (null when nothing goes out). */
  job: PublishJob | null = null;
  /** The encoder's canvas as a stream, for the publisher's own screen while the broadcast runs. */
  readonly mirror = signal<MediaStream | null>(null);

  constructor() {
    void liveSupport().then((s) => {
      this.support.value = s;
    });
  }

  get running(): boolean {
    return this.encoder !== null;
  }

  setBackground(item: BackgroundItem | null | undefined, src: string): void {
    this.picture.setBackground(item, src);
  }

  setPerformers(list: StagePerformer[]): void {
    this.picture.setPerformers(list);
  }

  /** Start sending the show for this job. Resolves with what the browser could do. */
  async start(job: PublishJob, onError: (message: string) => void): Promise<LiveSupport> {
    if (this.encoder) return this.support.value ?? (await liveSupport());
    this.job = job;
    await this.bus.ready();
    await this.bus.resume();
    this.picture.startDrawing(30);
    try {
      this.mirror.value = this.picture.canvas.captureStream(30);
    } catch {
      this.mirror.value = null;
    }
    const sender = new LiveSender(job.jobId);
    sender.start();
    this.sender = sender;
    this.unsubscribe = sender.state.subscribe((s) => {
      this.status.value = s;
    });
    const encoder = new LiveEncoder({
      canvas: this.picture.canvas,
      ctx: this.bus.ctx,
      source: this.bus.output,
      onSegment: (seg) => sender.push(seg),
      onError: (m) => {
        onError(m);
        this.stop();
      },
    });
    this.encoder = encoder;
    const support = await encoder.start();
    this.support.value = support;
    if (!support.ok) {
      this.stop();
    }
    return support;
  }

  stop(): void {
    this.encoder?.stop();
    this.encoder = null;
    this.sender?.stop();
    this.sender = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.picture.stopDrawing();
    this.mirror.value?.getTracks().forEach((t) => t.stop());
    this.mirror.value = null;
    this.job = null;
  }

  /** The broadcast balance (dB), from the device's Track / Vocal controls. */
  setBalance(trackDb: number, vocalDb: number): void {
    this.bus.setBalance(trackDb, vocalDb);
  }

  dispose(): void {
    this.stop();
    this.status.value = null;
    this.picture.dispose();
    this.bus.dispose();
  }
}
