/**
 * My own camera on the virtual stage: a hidden <video> for the camera stream, the person segmenter
 * that cuts me out of it, the framing (wide / mid / close + vocal-driven auto zoom) applied to the
 * cut-out, and — in a live meet — the alpha packer that turns the framed cut-out into the stream
 * other performers receive. One instance per stage session.
 */
import { AlphaPacker } from './alphaPack.ts';
import { frameRect, presetLevel, SILENCE_HOLD_MS, SING_LEVEL, ZOOM_EASE, type ZoomPreset } from './framing.ts';
import { PersonSegmenter, type SegmenterMode } from './segmenter.ts';
import type { PerformerSource } from './stage.ts';

const W = 480;
const H = 640;

export class LocalFeed {
  readonly video: HTMLVideoElement;
  readonly segmenter = new PersonSegmenter(W, H);
  /** The framed cut-out: what the stage draws for me and what other performers receive. */
  readonly canvas: HTMLCanvasElement;
  readonly maskCanvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private maskCtx: CanvasRenderingContext2D;
  private packer: AlphaPacker | null = null;
  private stream: MediaStream | null = null;
  private useModel = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSeg = -1;
  mode: SegmenterMode = 'off';
  onMode: ((m: SegmenterMode) => void) | null = null;
  /** Framing state: current level eases towards the target (0 = wide … 1 = close). */
  level = 0;
  private baseLevel = 0;
  private autoZoom = true;
  private lastLoudAt = 0;
  private origin = { x: 50, y: 42 };
  /** Increments on every framed frame (compositor redraws only when it changed). */
  frame = 0;

  constructor() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('aria-hidden', 'true');
    v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    this.video = v;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = W;
    this.maskCanvas.height = H;
    this.maskCtx = this.maskCanvas.getContext('2d', { alpha: false })!;
    this.maskCtx.fillStyle = '#000';
    this.maskCtx.fillRect(0, 0, W, H);
  }

  /** Point the feed at a camera stream (or null to go dark). */
  attach(stream: MediaStream | null, useModel = true): void {
    if (stream === this.stream && stream && useModel === this.useModel) return;
    this.stream = stream;
    this.useModel = useModel;
    this.segmenter.stop();
    clearInterval(this.timer);
    if (!stream) {
      this.video.srcObject = null;
      return;
    }
    // The hidden camera <video> lives on the body for the feed's whole life: a media element taken
    // out of the document (a view swapping its stage container) is paused by the browser, and a
    // paused camera means a frozen cut-out for everyone else.
    if (!this.video.isConnected) document.body.appendChild(this.video);
    this.video.onpause = () => {
      if (this.stream && this.video.srcObject) void this.video.play().catch(() => undefined);
    };
    this.video.srcObject = stream;
    void this.video.play().catch(() => undefined);
    void this.segmenter.start(this.video, useModel, (m) => {
      this.mode = m;
      this.onMode?.(m);
    });
    this.timer = setInterval(() => this.tick(), 1000 / 15);
  }

  /** Base framing level (the chosen preset) and whether singing pulls the framing closer. */
  setFraming(preset: ZoomPreset, autoZoom: boolean): void {
    this.baseLevel = presetLevel(preset);
    this.autoZoom = autoZoom;
  }

  /** Crop centre (0..100 %), e.g. from the face detector. */
  setOrigin(o: { x: number; y: number }): void {
    this.origin = o;
  }

  /** Feed the mic level (0..1) a few times a second; singing eases the framing towards "close". */
  reportLevel(level: number): void {
    if (level >= SING_LEVEL) this.lastLoudAt = performance.now();
  }

  private tick(): void {
    const singing = this.autoZoom && performance.now() - this.lastLoudAt < SILENCE_HOLD_MS;
    const target = singing ? 1 : this.baseLevel;
    this.level += (target - this.level) * ZOOM_EASE;
    if (Math.abs(target - this.level) < 0.002) this.level = target;
    if (this.segmenter.frame === this.lastSeg && this.level === target) return; // nothing new to draw
    this.lastSeg = this.segmenter.frame;
    const r = frameRect(W, H, this.level, this.origin);
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.drawImage(this.segmenter.canvas, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
    const m = this.maskCtx;
    m.fillStyle = '#000';
    m.fillRect(0, 0, W, H);
    m.drawImage(this.segmenter.maskCanvas, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
    this.frame++;
  }

  get source(): PerformerSource {
    return this.stream ? { kind: 'person', canvas: this.canvas, version: () => this.frame } : { kind: 'none' };
  }

  /** The alpha-packed outgoing stream (created on first use). */
  packedStream(): MediaStream {
    if (!this.packer) this.packer = new AlphaPacker(320, 426);
    return this.packer.start(this.canvas, this.maskCanvas, 15);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.segmenter.stop();
    this.packer?.stop();
    this.packer = null;
    this.video.onpause = null;
    this.video.srcObject = null;
    this.video.remove();
    this.stream = null;
  }
}
