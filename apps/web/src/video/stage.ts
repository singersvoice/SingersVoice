/**
 * The virtual stage: every performer (1..10) is cut out of their camera and placed in one straight
 * row over the shared stage background — the same size, evenly spaced by stage slot, every head at
 * the same height, behind a lit riser that hides everything below the chest — like performers in
 * a line across a stage, wherever each of them really is.
 *
 * One rule, every stage: a singer is drawn exactly as their own device frames them, and every
 * device frames its singer the same way (the stage frame, `framing.ts`: the head the same size at
 * the same place), so the slots can be one size and the singers come out one size. The frame a
 * device sends is drawn whole — the same crop, the same proportions — on the live stage under the
 * lyrics, on the lobby stage, in the show view, in the broadcast and in the saved performance.
 * Nothing here finds a person and zooms in on its own. Two modes differ in the slot size alone:
 *
 * - 'show' (Publisher mode: the broadcast picture, the lobby stage, the saved performance): the
 *   singers are the picture — slots as tall as the frame allows, one even row of ten at most.
 * - 'stage' (Performer mode: the live stage, Studio): the lyrics are the picture — small 3:4 slots
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
/**
 * The row is one straight line, as performers stand in a line across a stage facing the audience:
 * every slot on the same floor, the same size, evenly spaced — no curve (the lift of the ends is 0;
 * `arcLift` stays as the one place a curve would come from, should a stage ever want one).
 */
export const ARC_LIFT: Record<StageMode, number> = { show: 0, stage: 0 };
/**
 * The riser in front of the row hides this much of every frame from the bottom: the singers show
 * head and shoulders above its edge, whatever their camera's bottom edge cut — the way a chair's
 * front hides a seated coach's lap. The hidden part of a frame may run on below the picture.
 */
export const RISER_COVER = 0.4;
/** The riser band itself, above the picture's bottom edge: never slimmer than this (the names sit on it)… */
const RISER_MIN = 0.09;
/** …and never taller than this in 'show' mode (small slots, a crowd of ten, sit lower rather than behind a wall). */
const RISER_MAX = 0.4;
/** 'show': the row's slots start about here from the top when they are big (one or two singers): the heads a little under. */
const ROW_TOP = 0.08;
/**
 * A stage with nobody's picture on it (the audience's view: no video reaches them; a lobby before the
 * cameras are on) is a still: it is redrawn only now and then, to catch a change — a frame arriving, an
 * avatar loaded, a feed gone quiet — so a hundred phones in the room spend nothing on it.
 */
const IDLE_FPS = 2;
const MAX_WIDTH = 1600;
/** A slot is this much of its share of the width ('show'): a little air between neighbours. */
const FILL_W = 0.94;
/** Headroom above the frame, as a fraction of the slot height. */
export const HEADROOM = 0.045;
/**
 * A cut-out is never blown up past this many times its own pixels (at a 720-tall picture; scaled
 * with the picture): a frame that arrived small (a weak link) stays a sharp figure with stage
 * around it rather than a blur filling the frame. Computers send their cut-out at 720×960, so a
 * full-height frame in a 720p show is drawn near 1:1.
 */
const MAX_UPSCALE = 4.5;
/**
 * A remote performer whose frames keep arriving with nothing moving in them for this long is marked
 * `still` (their camera froze on their device; the stage says so and offers to re-make the link). A
 * coarse sample of the picture is compared once a second — a person, however still, never gives the
 * very same sample for this long (the cut-out's soft edge alone moves).
 */
export const STILL_AFTER_MS = 15_000;
const STILL_SAMPLE_W = 16;
const STILL_SAMPLE_H = 21;

export type StageMode = 'stage' | 'show';

/** How far up the picture the row's floor is at `x` (0 in the middle, `ARC_LIFT` at the ends — 0: a straight line). */
export function arcLift(width: number, height: number, x: number, mode: StageMode): number {
  const u = 2 * (x / Math.max(1, width) - 0.5); // -1..1 across the picture
  return height * ARC_LIFT[mode] * u * u;
}

/**
 * How tall the riser band is (above the picture's bottom edge, in the middle) for slots `slotH` tall:
 * 'show' puts the row's heads near the top of the picture and the riser takes the rest, within
 * bounds; 'stage' (lyrics above) keeps the riser slim at the bottom.
 */
export function riserBand(height: number, slotH: number, mode: StageMode): number {
  if (mode !== 'show') return height * RISER_MIN;
  return Math.max(height * RISER_MIN, Math.min(height * RISER_MAX, height - height * ROW_TOP - slotH * (1 - RISER_COVER)));
}

/** The top edge of the riser at `x`: the band's height up from the picture's bottom edge, lifted along the arc. */
export function riserTop(width: number, height: number, x: number, slotH: number, mode: StageMode): number {
  return height - riserBand(height, slotH, mode) - arcLift(width, height, x, mode);
}

/** The floor line of the row at `x` — where a slot's bottom edge is: `RISER_COVER` of the slot below the riser's top edge (often below the picture). */
export function floorAt(width: number, height: number, x: number, slotH: number, mode: StageMode): number {
  return riserTop(width, height, x, slotH, mode) + slotH * RISER_COVER;
}

/**
 * Pure layout: N slots of ONE size, evenly spaced across the width, each standing on the row's
 * floor where it is (the ends a little up the picture: the arc). Fewer performers → bigger slots,
 * never different sizes within a row. 'stage' (Performer mode) leaves the top ~55 % to the lyrics —
 * small 3:4 slots; 'show' (Publisher mode, the lobby stage) has no lyrics: every slot is as tall
 * as the picture allows, so the performers stand big, like a televised stage show, one even row
 * whether there are 1 or 10.
 */
export function layoutStage(width: number, height: number, count: number, mode: StageMode = 'stage'): StageTile[] {
  const n = Math.max(1, count);
  const slotW = width / n;
  let h: number;
  let w: number;
  if (mode === 'show') {
    // The singers are the picture: a slot taller than it (its lower part hides behind the riser and runs on below the
    // picture), so one or two singers stand big; a fuller row is as wide as its slots allow.
    h = height * 1.2;
    w = h * 0.75;
    if (w > slotW * FILL_W) {
      w = slotW * FILL_W;
      h = w / 0.75;
    }
  } else {
    const hFrac = n === 1 ? 0.5 : n === 2 ? 0.48 : n <= 4 ? 0.45 : n <= 6 ? 0.4 : 0.36;
    h = height * hFrac;
    w = h * 0.75;
    if (w > slotW * 0.96) {
      w = slotW * 0.96;
      h = w / 0.75;
    }
  }
  return Array.from({ length: n }, (_, i) => {
    const cx = slotW * (i + 0.5);
    return { id: String(i), x: cx - w / 2, y: floorAt(width, height, cx, h, mode) - h, w, h };
  });
}

/**
 * Pure framing: the whole frame, as the singer's device framed it, as large as the slot allows — as
 * wide as the slot, as tall as the room between the headroom and the slot's floor — its bottom edge
 * on the slot's floor, centred in the slot. Every frame is the stage frame (the same proportions,
 * the head at the same place), so equal slots give equal singers.
 */
export function fitPerson(t: StageTile, srcW: number, srcH: number, mode: StageMode, canvasH: number): PersonFit {
  const fw = Math.max(1, srcW);
  const fh = Math.max(1, srcH);
  const floor = t.y + t.h;
  const top = t.y + t.h * HEADROOM;
  const room = Math.max(1, floor - top);
  const scale = Math.min(t.w / fw, room / fh, mode === 'show' ? MAX_UPSCALE * Math.max(0.5, canvasH / 720) : Infinity);
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
  /** Whether the last draw put anybody's live picture on the stage (else the stage is a still). */
  live = false;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  /** Latest layout in CSS pixels (for tests / overlays). */
  tiles: (StageTile & { performer: StagePerformer; fit?: PersonFit })[] = [];
  /** A coarse sample of each remote performer's picture, once a second: the same sample for STILL_AFTER_MS is a still picture. */
  private samples = new Map<string, { key: string; since: number; at: number }>();
  private sampler: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  /** Remote performers whose picture is still (frames arriving, nothing moving in them — their camera froze on their device). */
  still = new Set<string>();
  /** Called with the ids whenever the set of still pictures changes. */
  onStill: ((ids: string[]) => void) | null = null;

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
    for (const id of [...this.samples.keys()]) if (!this.performers.some((p) => p.id === id && p.source.kind === 'frame')) this.clearStill(id);
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
      if (t - this.lastDraw >= 1000 / (this.live ? FPS : IDLE_FPS)) {
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
    this.live = false;
    if (!this.performers.length) {
      this.tiles = []; // an empty stage: just the background
      return;
    }
    const tiles = layoutStage(W, H, this.performers.length, this.mode);
    this.tiles = tiles.map((t, i) => ({ ...t, id: this.performers[i]!.id, performer: this.performers[i]! }));
    // Every singer's frame, whole, as their own device framed it — the same picture in every mode.
    const now = performance.now();
    for (const t of this.tiles) {
      const p = t.performer;
      const src = this.sourceCanvas(p);
      if (src) {
        this.live = true;
        t.fit = fitPerson(t, src.width, src.height, this.mode, H);
        this.drawPerson(c, src, p, t.fit, t);
        if (p.source.kind === 'frame') this.sampleStill(p.id, src, now);
        else this.clearStill(p.id);
      } else {
        t.fit = undefined;
        this.clearStill(p.id);
        this.drawPlaceholder(c, p, t);
      }
    }
    // The riser in front of the row, then every singer's name on it.
    this.drawRiser(c, W, H, tiles[0]!.h);
    for (const t of this.tiles) this.drawTag(c, t.performer, t, W, H);
  }

  /**
   * Once a second, a 16×21 sample of a remote performer's picture against the last: the very same bytes for
   * STILL_AFTER_MS means the frames arrive but nothing in them moves — their camera froze on their device
   * (the stage draws whatever arrives; this is how the host comes to know). A changed sample ends it.
   */
  private sampleStill(id: string, src: HTMLCanvasElement, now: number): void {
    const last = this.samples.get(id);
    if (last && now - last.at < 1000) return;
    if (!this.sampler) {
      const canvas = document.createElement('canvas');
      canvas.width = STILL_SAMPLE_W;
      canvas.height = STILL_SAMPLE_H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      this.sampler = { canvas, ctx };
    }
    let key: string;
    try {
      const { ctx } = this.sampler;
      ctx.clearRect(0, 0, STILL_SAMPLE_W, STILL_SAMPLE_H);
      ctx.drawImage(src, 0, 0, STILL_SAMPLE_W, STILL_SAMPLE_H);
      key = Array.from(ctx.getImageData(0, 0, STILL_SAMPLE_W, STILL_SAMPLE_H).data).join(',');
    } catch {
      return; // a lost context: not judged
    }
    const since = last && last.key === key ? last.since : now;
    this.samples.set(id, { key, since, at: now });
    const still = now - since >= STILL_AFTER_MS;
    if (still !== this.still.has(id)) {
      if (still) this.still.add(id);
      else this.still.delete(id);
      this.onStill?.([...this.still]);
    }
  }

  private clearStill(id: string): void {
    this.samples.delete(id);
    if (this.still.delete(id)) this.onStill?.([...this.still]);
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
   * The riser: a curved band from its lit top edge (following the arc) to the bottom of the picture,
   * in front of the row — deep stage purple, a glowing edge, a soft pool of each singer's colour
   * where they stand. It hides whatever is below the chest in every frame (a camera's bottom edge,
   * a table), so the row reads as one line of performers.
   */
  private drawRiser(c: CanvasRenderingContext2D, W: number, H: number, slotH: number): void {
    const top = (x: number) => riserTop(W, H, x, slotH, this.mode);
    const edge = () => {
      c.beginPath();
      c.moveTo(0, top(0));
      for (let x = 16; x < W; x += 16) c.lineTo(x, top(x));
      c.lineTo(W, top(W));
    };
    c.save();
    edge();
    c.lineTo(W, H);
    c.lineTo(0, H);
    c.closePath();
    const g = c.createLinearGradient(0, top(W / 2), 0, H);
    g.addColorStop(0, 'rgba(26, 12, 48, 0.9)');
    g.addColorStop(0.35, 'rgba(14, 7, 28, 0.94)');
    g.addColorStop(1, 'rgba(6, 3, 12, 0.97)');
    c.fillStyle = g;
    c.fill();
    // Each singer's spot on the riser: a soft pool of their colour below their name.
    c.clip();
    for (const t of this.tiles) {
      const cx = t.x + t.w / 2;
      const y = top(cx);
      const r = t.w * 0.55;
      const pool = c.createRadialGradient(cx, y, 0, cx, y, r);
      pool.addColorStop(0, hexAlpha(t.performer.color ?? '#b388ff', 0.28));
      pool.addColorStop(1, hexAlpha(t.performer.color ?? '#b388ff', 0));
      c.fillStyle = pool;
      c.fillRect(cx - r, y, r * 2, r);
    }
    c.restore();
    // The lit edge: a glowing strip along the top of the riser, and its reflection just under it.
    c.save();
    edge();
    c.lineWidth = Math.max(2, slotH * 0.012);
    c.strokeStyle = 'rgba(236, 224, 255, 0.95)';
    c.shadowColor = 'rgba(179, 136, 255, 0.9)';
    c.shadowBlur = Math.max(6, slotH * 0.04);
    c.stroke();
    c.restore();
    c.save();
    c.translate(0, Math.max(3, slotH * 0.02));
    edge();
    c.lineWidth = Math.max(1, slotH * 0.006);
    c.strokeStyle = 'rgba(179, 136, 255, 0.35)';
    c.stroke();
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

  /** The singer's name on the riser, under their spot. */
  private drawTag(c: CanvasRenderingContext2D, p: StagePerformer, t: StageTile, W: number, H: number): void {
    const fontPx = this.mode === 'show' ? Math.max(14, Math.min(26, t.w * 0.1)) : Math.max(11, Math.min(16, t.w * 0.09));
    c.save();
    c.font = `600 ${fontPx}px system-ui, -apple-system, sans-serif`;
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    const text = p.label;
    const tw = c.measureText(text).width + fontPx * 1.6;
    const th = fontPx * 1.7;
    const x = t.x + t.w / 2 - tw / 2;
    const y = Math.min(H - th - 2, riserTop(W, H, t.x + t.w / 2, t.h, this.mode) + th * 0.5);
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

/** `#rrggbb` (or any CSS colour, passed through at full alpha) with the given alpha. */
function hexAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return alpha <= 0 ? 'rgba(0,0,0,0)' : color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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
