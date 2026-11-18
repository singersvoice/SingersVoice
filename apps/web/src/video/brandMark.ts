/**
 * The brand on the picture: the animated mark — the same small silent loop the app's corner
 * watermark plays — drawn in the top-right corner of the show picture by `ShowRecorder`, so every
 * saved performance (the Studio's, a meet's), every chapter of a meet's film and the broadcast
 * carry it. A rounded tile an eighth of the picture tall, a little see-through, with a soft shadow:
 * the page's watermark, in the recording. The loop's still (its poster) stands in until the loop plays, and
 * where it never does. Nothing loads until the first frame is drawn.
 */
import { asset } from '../lib/nav.ts';

/** The tile's height as a share of the picture's (the loop is 16:9) — the size of a channel's mark on a broadcast. */
export const MARK_HEIGHT = 0.12;
/** The tile's distance from the top and right edges, as a share of the picture's height. */
export const MARK_MARGIN = 0.022;
/** The tile's opacity — the page's watermark is half; on a recording the brand has to read over any stage, so more. */
export const MARK_ALPHA = 0.75;

export interface MarkPlace {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The corners' radius. */
  r: number;
}

/** Where the mark goes on a W×H picture: the top-right corner, an eighth of the height, 16:9. */
export function markPlace(W: number, H: number): MarkPlace {
  const h = Math.round(H * MARK_HEIGHT);
  const w = Math.round((h * 16) / 9);
  const m = Math.round(H * MARK_MARGIN);
  return { x: W - m - w, y: m, w, h, r: Math.round(h * 0.14) };
}

function roundedPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export class BrandMark {
  private video: HTMLVideoElement | null = null;
  private still: HTMLImageElement | null = null;
  private tile: HTMLCanvasElement | null = null;
  private loaded = false;
  private lastPlay = 0;
  /** How many frames carried the mark (tests). */
  drawn = 0;

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const v = document.createElement('video');
      v.src = asset('brand/sv-loop-sm.mp4');
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = 'auto';
      void v.play().catch(() => undefined);
      this.video = v;
    } catch {
      this.video = null;
    }
    if (typeof Image === 'function') {
      const img = new Image();
      img.src = asset('brand/poster.jpg');
      this.still = img;
    }
  }

  /** What there is to draw right now: the loop once it plays, else its still, else nothing (the first frames of a cold start). */
  private source(now: number): CanvasImageSource | null {
    const v = this.video;
    if (v && v.paused && now - this.lastPlay > 2000) {
      this.lastPlay = now; // a loop that never started (a browser that held it back) is asked again now and then, never every frame
      void v.play().catch(() => undefined);
    }
    if (v && v.readyState >= 2 && v.videoWidth) return v;
    const s = this.still;
    if (s && s.complete && s.naturalWidth) return s;
    return null;
  }

  /** Draw the mark over a finished W×H frame. One bad frame never stops the picture. */
  draw(c: CanvasRenderingContext2D, W: number, H: number, now = Date.now()): void {
    this.load();
    const src = this.source(now);
    if (!src) return;
    const { x, y, w, h, r } = markPlace(W, H);
    // The tile is made whole first — the loop inside rounded corners — so its shadow on the picture follows the corners,
    // and the picture gets one faint layer, not a tile over a fill.
    const t = this.tile ?? (this.tile = document.createElement('canvas'));
    if (t.width !== w || t.height !== h) {
      t.width = w;
      t.height = h;
    }
    const tc = t.getContext('2d');
    if (!tc) return;
    tc.clearRect(0, 0, w, h);
    tc.save();
    roundedPath(tc, 0, 0, w, h, r);
    tc.clip();
    tc.drawImage(src, 0, 0, w, h);
    tc.restore();
    c.save();
    c.globalAlpha = MARK_ALPHA;
    c.shadowColor = 'rgba(0, 0, 0, 0.35)';
    c.shadowBlur = Math.round(h * 0.25);
    c.shadowOffsetY = Math.round(h * 0.08);
    c.drawImage(t, x, y);
    c.restore();
    this.drawn++;
  }

  dispose(): void {
    this.video?.pause();
    this.video = null;
    this.still = null;
    this.tile = null;
    this.loaded = false;
  }
}
