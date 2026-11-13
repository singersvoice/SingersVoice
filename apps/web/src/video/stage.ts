/**
 * The virtual stage: every performer (1..10) is cut out of their camera and drawn side by side
 * over the shared stage background, evenly spaced from left to right by stage slot — as if all
 * of them stood on the same stage, wherever they really are. Two modes, two priorities:
 *
 * - 'show' (Publisher mode: the broadcast picture, the lobby stage, the saved performance): the
 *   singers are the picture. The stage frames each of them itself — it finds the person in their
 *   cut-out (the bounding box of the opaque pixels) and scales them to fill their slot: head near
 *   the top, the camera's cut edge on the picture's bottom edge, feet on the floor when the camera
 *   sees them — so a singer stands as big as the stage allows whatever their camera, distance or
 *   framing, and ten singers make one even row with their heads level.
 * - 'stage' (Performer mode: the live stage, Studio): the lyrics are the picture. Each singer's
 *   frame is drawn as their own camera framed it, small, in the lower part under the lyrics —
 *   no zoom of any kind.
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

/** Where the person is in their cut-out frame, as fractions (0..1) of the frame. */
export interface PersonBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How a person is drawn into their slot: the scale from source pixels and the drawn box (CSS px). */
export interface PersonFit {
  scale: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The camera frame cuts the person (no feet): their cut edge sits on the picture's bottom edge. */
  cut: boolean;
  /** Taller than the slot allows: top-anchored, the bottom runs off the picture (a close-up). */
  cropped: boolean;
}

const FPS = 24;
const MAX_WIDTH = 1600;
/** The person may fill this much of the slot's width (room for an arm, and for the tag). */
const FILL_W = 0.94;
/** Headroom above the head, as a fraction of the slot height. */
const HEADROOM = 0.045;
/** Show mode may stand a singer this much taller than the slot (a close-up, cut at the bottom edge); 1 = never. */
const SHOW_CLOSE_UP = 1;
/**
 * A cut-out is never blown up past this many times its own pixels (at a 720-tall picture; scaled
 * with the picture): a frame that arrived small (a weak link) stays a sharp figure with stage
 * around it rather than a blur filling the frame. Computers send their cut-out at 720×960, so a
 * full-height singer in a 720p show is drawn near 1:1.
 */
const MAX_UPSCALE = 2.5;
/** A cut-out reaching this far down the frame is cut by the camera, not standing in it. */
const CUT_EDGE = 0.985;
/** The person probe: the cut-out's alpha at this size, this often; opaque means alpha above this. */
const PROBE_W = 96;
const PROBE_H = 128;
const PROBE_MS = 100;
const PROBE_ALPHA = 40;
/** The box only moves for a change bigger than this (fraction of the frame) — no breathing from mask noise. */
const PROBE_DEAD = 0.012;
/** How fast the drawn box follows a moved box (per drawn frame). */
const BOX_EASE = 0.15;
/** Until a person is found: the whole frame. */
const WHOLE: PersonBox = { x: 0, y: 0, w: 1, h: 1 };

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
 * Pure framing: scale the person's box to fill the slot — as wide as the slot allows, as tall as
 * the room between the headroom and the floor allows. A person the camera cuts (no feet) sits on
 * the picture's bottom edge like a TV shot; one the camera sees whole stands on the floor line.
 */
export function fitPerson(t: StageTile, srcW: number, srcH: number, box: PersonBox, mode: StageMode, canvasH: number): PersonFit {
  const bw = Math.max(1, box.w * srcW);
  const bh = Math.max(1, box.h * srcH);
  const cut = box.y + box.h >= CUT_EDGE;
  const floor = cut ? Math.max(canvasH, t.y + t.h) : t.y + t.h;
  const top = t.y + t.h * HEADROOM;
  const room = Math.max(1, floor - top);
  const scale = Math.min((t.w * FILL_W) / bw, (room * (mode === 'show' ? SHOW_CLOSE_UP : 1)) / bh, mode === 'show' ? MAX_UPSCALE * Math.max(0.5, canvasH / 720) : Infinity);
  const w = bw * scale;
  const h = bh * scale;
  const cropped = h > room + 0.5;
  return { scale, x: t.x + (t.w - w) / 2, y: cropped ? top : floor - h, w, h, cut, cropped };
}

/**
 * Where the person is in an RGBA buffer (fractions of w×h), or null when nobody is there: top to
 * bottom of the opaque pixels, and across, the body — the width most rows have (the 80th
 * percentile) around the median row centre — so an arm stretched out for a moment never shrinks
 * the singer or pulls them sideways; it just runs past the edge of their slot.
 */
export function boxOfAlpha(data: Uint8ClampedArray, w: number, h: number, threshold = PROBE_ALPHA): PersonBox | null {
  const widths: number[] = [];
  const centres: number[] = [];
  let y0 = -1;
  let y1 = -1;
  let area = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4 + 3;
    let l = -1;
    let r = -1;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4]! > threshold) {
        if (l < 0) l = x;
        r = x;
      }
    }
    if (l < 0) continue;
    if (y0 < 0) y0 = y;
    y1 = y;
    widths.push(r - l + 1);
    centres.push((l + r + 1) / 2);
    area += r - l + 1;
  }
  if (y0 < 0 || area < w * h * 0.01) return null; // a few stray pixels are not a person
  widths.sort((a, b) => a - b);
  centres.sort((a, b) => a - b);
  const bw = widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.8))]! + 2; // + a probe pixel of margin each side (soft edges, hair)
  const cx = centres[Math.floor(centres.length / 2)]!;
  y0 = Math.max(0, y0 - 1);
  y1 = Math.min(h - 1, y1 + 1);
  return { x: (cx - bw / 2) / w, y: y0 / h, w: bw / w, h: (y1 - y0 + 1) / h };
}

/**
 * Pure: nobody towers over the row. Heads line up on a real stage, but a camera that sees a singer
 * whole (feet and all) makes them stand twice as tall as the bust shots beside them — so whoever's
 * head stands clearly above the row's head line (the median, ties going to the taller) is scaled
 * down, feet or cut edge staying put, until it is level. Mutates the fits in place.
 */
export function levelHeads(fits: (PersonFit | undefined)[], tolerance: number): void {
  const heads = fits
    .filter((f): f is PersonFit => f !== undefined)
    .map((f) => f.y)
    .sort((a, b) => a - b);
  if (heads.length < 2) return;
  const line = heads[Math.floor((heads.length - 1) / 2)]!;
  for (const f of fits) {
    if (!f || f.cropped || f.y >= line - tolerance) continue;
    const bottom = f.y + f.h;
    const k = (bottom - line) / f.h;
    const cx = f.x + f.w / 2;
    f.scale *= k;
    f.w *= k;
    f.h = bottom - line;
    f.x = cx - f.w / 2;
    f.y = line;
  }
}

const boxMoved = (a: PersonBox, b: PersonBox): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.x + a.w - b.x - b.w), Math.abs(a.y + a.h - b.y - b.h));

export class StageCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private performers: StagePerformer[] = [];
  private avatars = new Map<string, HTMLImageElement>();
  /** Last time each remote frame advanced (frames stop → placeholder after a grace period). */
  private seen = new Map<string, { t: number; at: number }>();
  /** Where each person is in their frame: the box drawn (eased) and the box last measured. */
  private boxes = new Map<string, { box: PersonBox; target: PersonBox; at: number }>();
  private probe: CanvasRenderingContext2D | null = null;
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
    for (const id of [...this.boxes.keys()]) if (!this.performers.some((p) => p.id === id)) this.boxes.delete(id);
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
    // Frame everyone first (so heads can be levelled across the row), then draw left to right.
    // Performer mode draws the whole frame as the singer's own camera framed it — no zoom.
    const show = this.mode === 'show';
    const frames = this.tiles.map((t) => {
      const src = this.sourceCanvas(t.performer);
      if (!src) return null;
      const box = show ? this.personBox(t.performer.id, src) : WHOLE;
      t.fit = fitPerson(t, src.width, src.height, box, this.mode, H);
      return { src, box };
    });
    if (show)
      levelHeads(
        this.tiles.map((t) => t.fit),
        H * 0.02,
      );
    for (const [i, t] of this.tiles.entries()) {
      const p = t.performer;
      const f = frames[i];
      const fit = t.fit;
      if (f && fit) {
        if (!fit.cut) this.drawShadow(c, fit.x + fit.w / 2, t.y + t.h, fit.w * 1.5); // feet on the floor: a shadow grounds them
        this.drawPerson(c, f.src, p, f.box, fit, t);
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

  /**
   * Where the person is in their frame: measured from the cut-out's alpha a few times a second
   * (on a small probe canvas), moved only when it really changed, and eased so the stage never
   * jitters with the mask. Nobody found yet → the whole frame.
   */
  private personBox(id: string, src: HTMLCanvasElement): PersonBox {
    const now = performance.now();
    let e = this.boxes.get(id);
    if (!e || now - e.at >= PROBE_MS) {
      const m = this.measure(src);
      if (m) {
        if (!e) {
          e = { box: m, target: m, at: now };
          this.boxes.set(id, e);
        } else {
          e.at = now;
          if (boxMoved(e.target, m) > PROBE_DEAD) e.target = m;
        }
      } else if (e) e.at = now; // nobody in frame right now: keep the last box rather than jump
    }
    if (!e) return WHOLE;
    const { box, target } = e;
    if (box !== target) {
      const k = BOX_EASE;
      const next = { x: box.x + (target.x - box.x) * k, y: box.y + (target.y - box.y) * k, w: box.w + (target.w - box.w) * k, h: box.h + (target.h - box.h) * k };
      e.box = boxMoved(next, target) < 0.001 ? target : next;
    }
    return e.box;
  }

  private measure(src: HTMLCanvasElement): PersonBox | null {
    if (!this.probe) {
      const pc = document.createElement('canvas');
      pc.width = PROBE_W;
      pc.height = PROBE_H;
      this.probe = pc.getContext('2d', { willReadFrequently: true });
      if (!this.probe) return null;
    }
    const c = this.probe;
    try {
      c.clearRect(0, 0, PROBE_W, PROBE_H);
      c.drawImage(src, 0, 0, PROBE_W, PROBE_H);
      return boxOfAlpha(c.getImageData(0, 0, PROBE_W, PROBE_H).data, PROBE_W, PROBE_H);
    } catch {
      return null; // a tainted or lost canvas: the whole frame then
    }
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

  /** Draw the whole cut-out frame scaled so the person's box lands on the fit — centred in the slot, mirrored if asked. */
  private drawPerson(c: CanvasRenderingContext2D, src: HTMLCanvasElement, p: StagePerformer, box: PersonBox, fit: PersonFit, t: StageTile): void {
    const s = fit.scale;
    const bcx = (p.mirror ? 1 - (box.x + box.w / 2) : box.x + box.w / 2) * src.width;
    const dx0 = t.x + t.w / 2 - bcx * s;
    const dy0 = fit.y - box.y * src.height * s;
    c.save();
    c.beginPath();
    c.rect(t.x - t.w * 0.25, 0, t.w * 1.5, this.cssH); // an arm may reach past the slot, never across the neighbour
    c.clip();
    c.translate(dx0, dy0);
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
