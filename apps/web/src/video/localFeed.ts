/**
 * My own camera on the virtual stage: a hidden <video> for the camera stream, the person segmenter
 * that cuts me out of it, the stage frame (`framing.ts`: my head the standard size at the standard
 * place, so I am the same size as everyone else on every stage) applied to the cut-out, and — in a
 * live meet — the alpha packer that turns the framed cut-out into the stream other performers
 * receive. One instance per stage session.
 */
import { AlphaPacker } from './alphaPack.ts';
import { CROP_DEAD, CROP_EASE, cropFactor, distanceNote, frameRect, measureMask, stageCrop, visiblePart, type FrameRect, type PersonMeasure } from './framing.ts';
import { coverRect, PersonSegmenter, type SegmenterMode } from './segmenter.ts';
import type { PerformerSource } from './stage.ts';

/** The cut-out's own size: computers work at 720×960 so a singer standing full-height in a 720p show is drawn near 1:1; phones at 480×640. */
const COMPUTER = typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 2) >= 4 && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const W = COMPUTER ? 720 : 480;
const H = COMPUTER ? 960 : 640;
/** The person probe: the mask at this size, a few times a second (the head of a singer sitting back is still a dozen pixels wide). */
const PROBE_W = 120;
const PROBE_H = 160;

/** A camera picture whose bottom edge lands above this much of the frame (the riser hides the rest) gets its bottom feathered… */
const FEATHER_BELOW = 0.62;
/** …over this much of its height. */
const FEATHER = 0.14;

/** Fade the bottom of the drawn camera region: on the colour canvas by erasing (destination-out), on the grey mask by darkening (multiply). */
function feather(c: CanvasRenderingContext2D, x: number, w: number, from: number, to: number, op: GlobalCompositeOperation): void {
  const g = c.createLinearGradient(0, from, 0, to);
  if (op === 'destination-out') {
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
  } else {
    g.addColorStop(0, '#fff');
    g.addColorStop(1, '#000');
  }
  c.save();
  c.globalCompositeOperation = op;
  c.fillStyle = g;
  c.fillRect(x, from, w, to - from + 1);
  c.restore();
}

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
  /**
   * What this singer should do about their distance to the camera: 'close' — the stage frame had to
   * reach well past the camera picture (sit back: the stage can only show what the camera sees);
   * 'far' — they are small in the picture (come closer); null — fine.
   */
  note: 'close' | 'far' | null = null;
  onNote: ((n: 'close' | 'far' | null) => void) | null = null;
  private origin = { x: 50, y: 42 };
  /** The person last found in the mask, the crop aimed at and the crop drawn (eased towards it). */
  private person: PersonMeasure | null = null;
  private cropTarget: FrameRect | null = null;
  private crop: FrameRect | null = null;
  private probe: CanvasRenderingContext2D | null = null;
  private lastProbe = 0;
  private noteSince = 0;
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

  /** The person (and their head) in the mask right now, measured a few times a second on a small probe. */
  private findPerson(): PersonMeasure | null {
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
      const found = measureMask(this.probe.getImageData(0, 0, PROBE_W, PROBE_H).data, PROBE_W, PROBE_H);
      if (found) this.person = found; // nobody in frame: keep the last framing rather than jump
    } catch {
      /* a lost context: keep what we had */
    }
    return this.person;
  }

  /**
   * The crop to draw this tick: the stage frame around the head (the whole camera frame until a
   * person is found), eased towards where it should be and deadbanded, so mask noise never makes it
   * breathe. The distance note follows the crop the stage frame asks for, once it has held a second.
   */
  private framing(): FrameRect {
    const person = this.findPerson();
    const wanted = person ? stageCrop(W, H, person.head) : frameRect(W, H, 1, this.origin);
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
    const note = person ? distanceNote(cropFactor(t, H)) : null;
    const now = performance.now();
    if (note !== this.note) {
      if (!this.noteSince) this.noteSince = now;
      else if (now - this.noteSince > 1000) {
        this.note = note;
        this.noteSince = 0;
        this.onNote?.(note);
      }
    } else this.noteSince = 0;
    return this.crop!;
  }

  /** Crop centre (0..100 % of the camera picture), e.g. from the face detector — mapped into the cut-out, which is the camera picture centre-cropped to 3:4. */
  setOrigin(o: { x: number; y: number }): void {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) {
      this.origin = o;
      return;
    }
    const r = coverRect(vw, vh, W, H);
    this.origin = { x: Math.max(0, Math.min(100, (((o.x / 100) * vw - r.sx) / r.sw) * 100)), y: Math.max(0, Math.min(100, (((o.y / 100) * vh - r.sy) / r.sh) * 100)) };
  }

  private tick(): void {
    const settled = this.crop !== null && this.cropTarget !== null && this.crop.sx === this.cropTarget.sx && this.crop.sy === this.cropTarget.sy && this.crop.sh === this.cropTarget.sh;
    if (this.segmenter.frame === this.lastSeg && settled) return; // nothing new to draw
    this.lastSeg = this.segmenter.frame;
    const r = visiblePart(this.framing(), W, H); // the crop may reach past the camera picture: that part stays transparent
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    const m = this.maskCtx;
    m.fillStyle = '#000';
    m.fillRect(0, 0, W, H);
    if (r) {
      c.drawImage(this.segmenter.canvas, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
      m.drawImage(this.segmenter.maskCanvas, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
      // A camera that sees little of the singer (close up) ends above the stage's riser: its bottom edge is
      // feathered, so the figure fades out instead of ending in a straight cut across the chest.
      const bottom = r.dy + r.dh;
      if (bottom < H * FEATHER_BELOW) {
        const from = bottom - r.dh * FEATHER;
        feather(c, r.dx, r.dw, from, bottom, 'destination-out');
        feather(m, r.dx, r.dw, from, bottom, 'multiply');
      }
    }
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
