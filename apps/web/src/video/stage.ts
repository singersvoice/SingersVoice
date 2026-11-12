/**
 * The virtual stage: every performer (1..10) is cut out of their camera and drawn side by side
 * over the shared stage background, evenly spaced from left to right by stage slot — as if all
 * of them stood on the same stage, wherever they really are. The canvas is transparent: the
 * background itself is the stage's CSS background (image or video), so nothing is drawn twice.
 */
import { AlphaUnpacker } from './alphaPack.ts';

export type PerformerSource =
  | { kind: 'person'; canvas: HTMLCanvasElement; version: () => number }
  | { kind: 'packed'; video: HTMLVideoElement }
  | { kind: 'none' };

export interface StagePerformer {
  id: string;
  /** 1..10 — the left-to-right order on stage. */
  slot: number;
  label: string;
  picture?: string;
  color?: string;
  source: PerformerSource;
  /** Front camera: draw mirrored so the singer sees themselves as in a mirror. */
  mirror?: boolean;
  /** 1 = full frame; >1 crops in around `origin` (0..100 %). */
  zoom?: number;
  origin?: { x: number; y: number };
  isMe?: boolean;
}

export interface StageTile {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const FPS = 24;
const MAX_WIDTH = 1600;

export type StageMode = 'stage' | 'show';

/**
 * Pure layout: N portrait tiles (3:4) evenly spaced, bottom-anchored; fewer performers → bigger tiles.
 * 'stage' leaves the top ~40 % to the lyrics; 'show' (Publishing mode) has no lyrics and fills the
 * frame with the performers, like a televised stage show.
 */
export function layoutStage(width: number, height: number, count: number, mode: StageMode = 'stage'): StageTile[] {
  const n = Math.max(1, count);
  const slotW = width / n;
  const hFrac = mode === 'show' ? (n <= 2 ? 0.96 : n <= 4 ? 0.92 : 0.86) : n === 1 ? 0.62 : n === 2 ? 0.6 : n <= 4 ? 0.56 : n <= 6 ? 0.5 : 0.44;
  let h = height * hFrac;
  let w = h * 0.75;
  if (w > slotW * 0.96) {
    w = slotW * 0.96;
    h = w / 0.75;
  }
  const y = height - h - height * 0.015;
  return Array.from({ length: n }, (_, i) => ({ id: String(i), x: slotW * i + (slotW - w) / 2, y, w, h }));
}

export class StageCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private performers: StagePerformer[] = [];
  private unpackers = new Map<string, AlphaUnpacker>();
  private avatars = new Map<string, HTMLImageElement>();
  /** Last time each packed <video> advanced (frames stop → placeholder after a grace period). */
  private seen = new Map<string, { t: number; at: number }>();
  private raf = 0;
  private lastDraw = 0;
  private running = false;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  /** Latest layout in CSS pixels (for tests / overlays). */
  tiles: (StageTile & { performer: StagePerformer })[] = [];

  /** 'stage' (lyrics above the performers) or 'show' (performers fill the frame); may be switched while running. */
  mode: StageMode;

  constructor(mode: StageMode = 'stage') {
    this.mode = mode;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stagecanvas';
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
  }

  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.min(1, MAX_WIDTH / Math.max(1, cssW * dpr));
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr * scale;
    this.canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.lastDraw = 0;
  }

  setPerformers(list: StagePerformer[]): void {
    this.performers = [...list].sort((a, b) => a.slot - b.slot);
    for (const id of [...this.unpackers.keys()]) {
      if (!this.performers.some((p) => p.id === id && p.source.kind === 'packed')) {
        this.unpackers.get(id)?.dispose();
        this.unpackers.delete(id);
        this.seen.delete(id);
      }
    }
    for (const p of this.performers) {
      if (p.picture && !this.avatars.has(p.id)) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.referrerPolicy = 'no-referrer';
        img.src = p.picture;
        this.avatars.set(p.id, img);
      }
    }
    this.lastDraw = 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (t: number) => {
      if (!this.running) return;
      if (t - this.lastDraw >= 1000 / FPS) {
        this.lastDraw = t;
        try {
          this.draw();
        } catch (e) {
          console.warn('stage draw', e); // one bad frame never stops the stage
        }
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    for (const u of this.unpackers.values()) u.dispose();
    this.unpackers.clear();
  }

  draw(): void {
    const c = this.ctx;
    const { cssW: W, cssH: H, dpr } = this;
    if (!W || !H) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    if (!this.performers.length) {
      this.tiles = []; // an empty stage: just the background
      return;
    }
    const tiles = layoutStage(W, H, this.performers.length, this.mode);
    this.tiles = tiles.map((t, i) => ({ ...t, id: this.performers[i]!.id, performer: this.performers[i]! }));
    for (const t of this.tiles) {
      const p = t.performer;
      // Floor shadow grounds the performer on the stage.
      const g = c.createRadialGradient(t.x + t.w / 2, t.y + t.h, 0, t.x + t.w / 2, t.y + t.h, t.w * 0.5);
      g.addColorStop(0, 'rgba(0,0,0,0.45)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.save();
      c.translate(0, t.y + t.h);
      c.scale(1, 0.18);
      c.fillStyle = g;
      c.fillRect(t.x - t.w * 0.2, -t.w * 0.5, t.w * 1.4, t.w);
      c.restore();

      const src = this.sourceCanvas(p);
      if (src) this.drawPerson(c, src, p, t);
      else this.drawPlaceholder(c, p, t);
      this.drawTag(c, p, t);
    }
  }

  /** The RGBA person image for a performer (local person canvas, or the unpacked remote frame). */
  private sourceCanvas(p: StagePerformer): HTMLCanvasElement | null {
    if (p.source.kind === 'person') return p.source.canvas;
    if (p.source.kind === 'packed') {
      const v = p.source.video;
      if (v.readyState < 2 || !v.videoWidth) return null;
      // Frames stopped (camera off on their side, link dropped) → placeholder after a short grace;
      // judged by the video clock advancing, which is robust at any frame rate.
      const now = performance.now();
      const seen = this.seen.get(p.id);
      if (!seen || seen.t !== v.currentTime) this.seen.set(p.id, { t: v.currentTime, at: now });
      else if (now - seen.at > 2500) return null;
      let u = this.unpackers.get(p.id);
      if (!u) {
        u = new AlphaUnpacker(Math.round(v.videoWidth / 2), v.videoHeight);
        this.unpackers.set(p.id, u);
      }
      u.draw(v);
      return u.canvas;
    }
    return null;
  }

  /** The framed cut-out is already composed (crop + stage scale by its own device); fit it into the tile. */
  private drawPerson(c: CanvasRenderingContext2D, src: HTMLCanvasElement, p: StagePerformer, t: StageTile): void {
    const sr = src.width / src.height;
    const dr = t.w / t.h;
    let cw = src.width;
    let ch = src.height;
    if (sr > dr) cw = src.height * dr;
    else ch = src.width / dr;
    const sx = (src.width - cw) / 2;
    const sy = src.height - ch; // keep the floor: crop from the top if the tile is wider
    c.save();
    if (p.mirror) {
      c.translate(t.x + t.w, t.y);
      c.scale(-1, 1);
      c.drawImage(src, sx, sy, cw, ch, 0, 0, t.w, t.h);
    } else {
      c.drawImage(src, sx, sy, cw, ch, t.x, t.y, t.w, t.h);
    }
    c.restore();
  }

  private drawPlaceholder(c: CanvasRenderingContext2D, p: StagePerformer, t: StageTile): void {
    const r = Math.min(t.w, t.h) * 0.22;
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h * 0.42;
    c.save();
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.closePath();
    c.fillStyle = 'rgba(30, 14, 50, 0.75)';
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = p.color ?? '#b388ff';
    c.stroke();
    const img = this.avatars.get(p.id);
    if (img && img.complete && img.naturalWidth) {
      c.clip();
      c.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    } else {
      c.fillStyle = '#fff';
      c.font = `${Math.round(r)}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText((p.label || '?').charAt(0).toUpperCase(), cx, cy);
    }
    c.restore();
  }

  private drawTag(c: CanvasRenderingContext2D, p: StagePerformer, t: StageTile): void {
    const fontPx = this.mode === 'show' ? Math.max(14, Math.min(26, t.w * 0.1)) : Math.max(11, Math.min(16, t.w * 0.09));
    c.save();
    c.font = `600 ${fontPx}px system-ui, -apple-system, sans-serif`;
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    const text = p.label;
    const tw = c.measureText(text).width + fontPx * 1.6;
    const th = fontPx * 1.7;
    const x = t.x + t.w / 2 - tw / 2;
    const y = t.y + t.h - th - 4;
    c.fillStyle = 'rgba(12, 6, 24, 0.72)';
    roundRect(c, x, y, tw, th, th / 2);
    c.fill();
    c.fillStyle = p.color ?? '#b388ff';
    c.beginPath();
    c.arc(x + fontPx * 0.8, y + th / 2, fontPx * 0.28, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#fff';
    c.fillText(text, x + tw / 2 + fontPx * 0.25, y + th / 2 + 0.5);
    c.restore();
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
