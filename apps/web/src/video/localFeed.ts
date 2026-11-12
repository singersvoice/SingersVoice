/**
 * My own camera on the virtual stage: a hidden <video> for the camera stream, the person
 * segmenter that cuts me out of it, and (in a live meet) the alpha packer that turns the cut-out
 * into the stream other performers receive. One instance per stage session.
 */
import { AlphaPacker } from './alphaPack.ts';
import { PersonSegmenter, type SegmenterMode } from './segmenter.ts';
import type { PerformerSource } from './stage.ts';

export class LocalFeed {
  readonly video: HTMLVideoElement;
  readonly segmenter = new PersonSegmenter(480, 640);
  private packer: AlphaPacker | null = null;
  private stream: MediaStream | null = null;
  private useModel = true;
  mode: SegmenterMode = 'off';
  onMode: ((m: SegmenterMode) => void) | null = null;

  constructor() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('aria-hidden', 'true');
    v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
    this.video = v;
  }

  /** Point the feed at a camera stream (or null to go dark). `useModel=false` = oval vignette only. */
  attach(stream: MediaStream | null, useModel = true): void {
    if (stream === this.stream && stream && useModel === this.useModel) return;
    this.stream = stream;
    this.useModel = useModel;
    this.segmenter.stop();
    if (!stream) {
      this.video.srcObject = null;
      return;
    }
    this.video.srcObject = stream;
    void this.video.play().catch(() => undefined);
    void this.segmenter.start(this.video, useModel, (m) => {
      this.mode = m;
      this.onMode?.(m);
    });
  }

  get source(): PerformerSource {
    return this.stream ? { kind: 'person', canvas: this.segmenter.canvas, version: () => this.segmenter.frame } : { kind: 'none' };
  }

  /** The alpha-packed outgoing stream (created on first use). */
  packedStream(): MediaStream {
    if (!this.packer) this.packer = new AlphaPacker(320, 426);
    return this.packer.start(this.segmenter.canvas, this.segmenter.maskCanvas, 15);
  }

  dispose(): void {
    this.segmenter.stop();
    this.packer?.stop();
    this.packer = null;
    this.video.srcObject = null;
    this.video.remove();
    this.stream = null;
  }
}
