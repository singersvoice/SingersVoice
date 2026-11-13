/**
 * My own camera on the virtual stage: a hidden <video> for the camera stream, the person segmenter
 * that cuts me out of it, the framing (wide / mid / close + vocal-driven auto zoom) applied to the
 * cut-out, and — in a live meet — the alpha packer that turns the framed cut-out into the stream
 * other performers receive. One instance per stage session.
 */
import { AlphaPacker } from './alphaPack.ts';
import { boxOfMask, chestCrop, CROP_DEAD, CROP_EASE, frameRect, presetLevel, SILENCE_HOLD_MS, SING_LEVEL, ZOOM_EASE, type FrameRect, type PersonBox, type ZoomPreset } from './framing.ts';
import { PersonSegmenter, type SegmenterMode } from './segmenter.ts';
import type { PerformerSource } from './stage.ts';

/** The cut-out's own size: computers work at 720×960 so a singer standing full-height in a 720p show is drawn near 1:1; phones at 480×640. */
const COMPUTER = typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 2) >= 4 && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const W = COMPUTER ? 720 : 480;
const H = COMPUTER ? 960 : 640;
/** The person probe: the mask at this size, a few times a second. */
const PROBE_W = 96;
const PROBE_H = 128;

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
  /** Framing state: current level eases towards the target (0 = wide … 1 = close; for chest: how much singing tightens). */
  level = 0;
  private preset: ZoomPreset = 'chest';
  private baseLevel = 0;
  private autoZoom = true;
  private lastLoudAt = 0;
  private origin = { x: 50, y: 42 };
  /** Chest framing: the person last found in the mask, the crop aimed at and the crop drawn (eased). */
  private person: PersonBox | null = null;
  private cropTarget: FrameRect | null = null;
  private crop: FrameRect | null = null;
  private probe: CanvasRenderingContext2D | null = null;
  private lastProbe = 0;
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

  /** The chosen framing (chest = framed from the person; wide / mid / close = fixed) and whether singing pulls it closer. */
  setFraming(preset: ZoomPreset, autoZoom: boolean): void {
    this.preset = preset;
    this.baseLevel = presetLevel(preset);
    this.autoZoom = autoZoom;
  }

  /** The person in the mask right now (fractions of the frame), measured a few times a second on a small probe. */
  private findPerson(): PersonBox | null {
    const now = performance.now();
    if (now - this.lastProbe < 150) return this.person;
    this.lastProbe = now;
    if (!this.probe) {
      const pc = document.createElement('canvas');
      pc.width = PROBE_W;
      pc.height = PROBE_H;
      this.probe = pc.getContext('2d', { willReadFrequently: true });
      if (!this.probe) return this.person;
    }
    try {
      this.probe.drawImage(this.segmenter.maskCanvas, 0, 0, PROBE_W, PROBE_H);
      const found = boxOfMask(this.probe.getImageData(0, 0, PROBE_W, PROBE_H).data, PROBE_W, PROBE_H);
      if (found) this.person = found; // nobody in frame: keep the last framing rather than jump
    } catch {
      /* a lost context: keep what we had */
    }
    return this.person;
  }

  /** The crop to draw this tick: chest framing follows the person (deadbanded, eased); the fixed presets crop by level. */
  private framing(): FrameRect {
    if (this.preset !== 'chest') return frameRect(W, H, this.level, this.origin);
    const person = this.findPerson();
    if (!person) return frameRect(W, H, 0, this.origin); // until someone is found: the whole frame
    const wanted = chestCrop(W, H, person, this.level);
    const moved = (a: FrameRect, b: FrameRect) => Math.max(Math.abs(a.sx - b.sx) / W, Math.abs(a.sy - b.sy) / H, Math.abs(a.sw - b.sw) / W, Math.abs(a.sh - b.sh) / H);
    if (!this.cropTarget || moved(this.cropTarget, wanted) > CROP_DEAD) this.cropTarget = wanted;
    const t = this.cropTarget;
    const c = this.crop;
    if (!c) this.crop = { ...t };
    else {
      const k = CROP_EASE;
      const next = { ...t, sx: c.sx + (t.sx - c.sx) * k, sy: c.sy + (t.sy - c.sy) * k, sw: c.sw + (t.sw - c.sw) * k, sh: c.sh + (t.sh - c.sh) * k };
      this.crop = moved(next, t) < 0.0005 ? { ...t } : next;
    }
    return this.crop!;
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
    const settled = this.preset !== 'chest' || (this.crop !== null && this.cropTarget !== null && this.crop.sx === this.cropTarget.sx && this.crop.sh === this.cropTarget.sh);
    if (this.segmenter.frame === this.lastSeg && this.level === target && settled) return; // nothing new to draw
    this.lastSeg = this.segmenter.frame;
    const r = this.framing();
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
