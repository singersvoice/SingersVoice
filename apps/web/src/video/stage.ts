/**
 * The virtual stage: every performer (1..10) is cut out of their camera and drawn side by side
 * over the shared stage background, evenly spaced from left to right by stage slot — as if all
 * of them stood on the same stage, wherever they really are.
 *
 * One rule, every stage: a singer is drawn exactly as their own camera frames them. The frame a
 * device sends (its cut-out, with the singer's own framing: wide / mid / close and the vocal-driven
 * auto zoom, `framing.ts`) is drawn whole — the same crop, the same proportions — on the live stage
 * under the lyrics, on the lobby stage, in the show view, in the broadcast and in the saved
 * performance. Nothing here finds a person and zooms in on its own: what a singer sees of themselves
 * in Performer mode is what the audience gets, only bigger. Two modes differ in the slots alone:
 *
 * - 'show' (Publisher mode: the broadcast picture, the lobby stage, the saved performance): the
 *   singers are the picture — slots as tall as the frame, the frame's bottom edge (the camera's cut)
 *   on the picture's bottom edge, ten in one even row.
 * - 'stage' (Performer mode: the live stage, Studio): the lyrics are the picture — small 3:4 tiles
 *   in the lower part under the lyrics.
 *
 * The canvas is transparent: the background itself is the stage's CSS background (image or
 * video), so nothing is drawn twice; a recorder draws the background under it itself.
 */
import type { UnpackedFrame } from './alphaPack.ts';

export type PerformerSource =
  | { kind: 'person'; canvas: HTMLCanvasElement; version: () => number }
  /** A remote performer's unpacked frames (shared with every other drawer of them). */
  | { kind: 'frame'; frame: UnpackedFrame }
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

/** How a frame is drawn into its slot: the scale from source pixels and the drawn box (CSS px). */
export interface PersonFit {
  scale: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const FPS = 24;
const MAX_WIDTH = 1600;
/** The frame may fill this much of the slot's width (room for the tag). */
const FILL_W = 0.94;
/** Headroom above the frame, as a fraction of the slot height. */
const HEADROOM = 0.045;
/**
 * A cut-out is never blown up past this many times its own pixels (at a 720-tall picture; scaled
 * with the picture): a frame that arrived small (a weak link) stays a sharp figure with stage
 * around it rather than a blur filling the frame. Computers send their cut-out at 720×960, so a
 * full-height frame in a 720p show is drawn near 1:1.
 */
const MAX_UPSCALE = 2.5;

export type StageMode = 'stage' | 'show';

/**
 * Pure layout: N slots evenly spaced across the width, bottom-anchored on the floor line; fewer
 * performers → wider slots. 'stage' (Performer mode) leaves the top ~55 % to the lyrics — small
 * 3:4 tiles, the singers' own camera framing; 'show' (Publisher mode, the lobby stage) has no
 * lyrics: every slot is as tall as the frame, so the performers stand huge, like a televised stage
 * show, in one even row whether there are 1 or 10.
 */
export function layoutStage(width: number, height: number, count: number, mode: StageMode = 'stage'): StageTile[] {
  const n = Math.max(1, count);
  const slotW = width / n;
  let h: number;
  let w: number;
  if (mode === 'show') {
    // One or two singers get a little stage around them; a fuller row stands as tall as the frame allows.
    h = height * (n <= 2 ? 0.93 : 0.96);
    w = Math.min(slotW * FILL_W, h * 0.9);
  } else {
    const hFrac = n === 1 ? 0.44 : n === 2 ? 0.42 : n <= 4 ? 0.4 : n <= 6 ? 0.36 : 0.32;
    h = height * hFrac;
    w = h * 0.75;
    if (w > slotW * 0.96) {
      w = slotW * 0.96;
      h = w / 0.75;
    }
  }
  const y = height - h - height * 0.015;
  return Array.from({ length: n }, (_, i) => ({ id: String(i), x: slotW * i + (slotW - w) / 2, y, w, h }));
}

/**
 * Pure framing: the whole frame, as the singer's camera framed it, as large as the slot allows — as
 * wide as the slot, as tall as the room between the headroom and the picture's bottom edge — its
 * bottom edge (the camera's cut) on the picture's bottom edge like a TV shot, centred in the slot.
 * The same frame keeps the same proportions in every mode; only the slot size differs.
 */
export function fitPerson(t: StageTile, srcW: number, srcH: number, mode: StageMode, canvasH: number): PersonFit {
  const fw = Math.max(1, srcW);
  const fh = Math.max(1, srcH);
  const floor = Math.max(canvasH, t.y + t.h);
  const top = t.y + t.h * HEADROOM;
  const room = Math.max(1, floor - top);
  const scale = Math.min((t.w * FILL_W) / fw, room / fh, mode === 'show' ? MAX_UPSCALE * Math.max(0.5, canvasH / 720) : Infinity);
  const w = fw * scale;
  const h = fh * scale;
  return { scale, x: t.x + (t.w - w) / 2, y: floor - h, w, h };
}

export class StageCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private performers: StagePerformer[] = [];
  private avatars = new Map<string, HTMLImageElement>();
  /** Last time each remote frame advanced (frames stop → placeholder after a grace period). */
  private seen = new Map<string, { t: number; at: number }>();
  private raf = 0;
  private lastDraw = 0;
  private running = false;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  /** Latest layout in CSS pixels (for tests / overlays). */
  tiles: (StageTile & { performer: StagePerformer; fit?: PersonFit })[] = [];

  /** 'stage' (lyrics above the performers) or 'show' (performers fill the frame); may be switched while running. */
  mode: StageMode;

  constructor(mode: StageMode = 'stage') {
    this.mode = mode;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stagecanvas';
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
  }

  /** Size the canvas; `pixelRatio` fixes the backing pixels (a recorder's 1280×720) instead of following the screen. */
  resize(cssW: number, cssH: number, pixelRatio?: number): void {
    const dpr = pixelRatio ?? Math.min(2, window.devicePixelRatio || 1);
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
    for (const id of [...this.seen.keys()]) if (!this.performers.some((p) => p.id === id && p.source.kind === 'frame')) this.seen.delete(id);
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
    // Every singer's frame, whole, as their own camera framed it — the same picture in every mode.
    for (const t of this.tiles) {
      const p = t.performer;
      const src = this.sourceCanvas(p);
      if (src) {
        t.fit = fitPerson(t, src.width, src.height, this.mode, H);
        this.drawPerson(c, src, p, t.fit, t);
      } else {
        t.fit = undefined;
        this.drawShadow(c, t.x + t.w / 2, t.y + t.h, t.w);
        this.drawPlaceholder(c, p, t);
      }
      this.drawTag(c, p, t);
    }
  }

  /** The RGBA person image for a performer (local person canvas, or the unpacked remote frame). */
  private sourceCanvas(p: StagePerformer): HTMLCanvasElement | null {
    if (p.source.kind === 'person') return p.source.canvas;
    if (p.source.kind === 'frame') {
      const f = p.source.frame;
      const c = f.current();
      if (!c) return null;
      // Frames stopped (camera off on their side, link dropped) → placeholder after a short grace;
      // judged by the video clock advancing, which is robust at any frame rate.
      const now = performance.now();
      const seen = this.seen.get(p.id);
      if (!seen || seen.t !== f.currentTime) this.seen.set(p.id, { t: f.currentTime, at: now });
      else if (now - seen.at > 2500) return null;
      return c;
    }
    return null;
  }

  /** A soft ellipse of shadow on the floor line, `w` wide (the gradient is made inside the squashed space so it lands there). */
  private drawShadow(c: CanvasRenderingContext2D, cx: number, floor: number, w: number): void {
    c.save();
    c.translate(0, floor);
    c.scale(1, 0.18);
    const g = c.createRadialGradient(cx, 0, 0, cx, 0, w * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(cx - w * 0.7, -w * 0.5, w * 1.4, w);
    c.restore();
  }

  /** Draw the whole cut-out frame on its fit — centred in the slot, mirrored if asked. */
  private drawPerson(c: CanvasRenderingContext2D, src: HTMLCanvasElement, p: StagePerformer, fit: PersonFit, t: StageTile): void {
    const s = fit.scale;
    c.save();
    c.beginPath();
    c.rect(t.x - t.w * 0.25, 0, t.w * 1.5, this.cssH); // never across the neighbour's slot
    c.clip();
    c.translate(fit.x, fit.y);
    c.scale(s, s);
    if (p.mirror) {
      c.translate(src.width, 0);
      c.scale(-1, 1);
    }
    c.drawImage(src, 0, 0);
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
