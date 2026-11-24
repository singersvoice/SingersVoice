/**
 * The stage frame: every singer is framed the same way, whatever their camera sees. The frame a
 * device sends (its cut-out) always has the singer's head the same size at the same place — the top
 * of the head 8 % of the way down, the head 22 % of the frame tall, centred — so on every stage all
 * the singers come out the same size, like performers in one row of chairs on a TV stage, however
 * near or far each of them sits from their camera. A singer sitting back is brought up (never more
 * than 3.3×: a blur helps nobody); a singer too close is brought back — the frame then has
 * transparent room around what the camera could see, since the camera cannot see wider — and the
 * device tells them to sit back. Nobody chooses a framing of their own: this framing IS the picture
 * of the singer, drawn whole by every stage (`stage.ts`) in slots of one size.
 */

/** The standard: where the head sits in the frame and how big it is. */
export const STAGE_FRAME = {
  /** The top of the head this far down the frame. */
  headroom: 0.08,
  /** The head (crown to chin) this tall, as a fraction of the frame. */
  headHeight: 0.22,
  /** Never bring a singer up more than this (the crop never smaller than this fraction of the camera frame). */
  minCrop: 0.3,
  /** Never bring a singer back more than this (the crop never bigger than this many camera frames). */
  maxOut: 2.4,
  /** Past this much bringing back / up the device says "sit back" / "come closer". */
  tooClose: 1.3,
  tooFar: 0.4,
} as const;

/** Where the person is in their cut-out frame, as fractions (0..1) of the frame. */
export interface PersonBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The head in the frame (crown to chin, ear to ear) and the body under it, as fractions of the frame. */
export interface PersonMeasure {
  head: PersonBox;
  body: PersonBox;
}

/** The neck is this much narrower than the head; the shoulders this much wider; the jaw under the ears at most this much of the head's width. */
const NECK = 0.62;
const SHOULDERS = 1.4;
const DIP = 0.92;

/**
 * Where the person is in a mask (grey: bright = person), as fractions of w×h, or null when nobody
 * is there: top to bottom of the person pixels, and across, the body — the width most rows have
 * (the 80th percentile) around the median row centre — so an arm stretched out for a moment never
 * widens the framing or pulls it sideways.
 */
export function boxOfMask(data: Uint8ClampedArray, w: number, h: number, threshold = 100): PersonBox | null {
  return measureMask(data, w, h, threshold)?.body ?? null;
}

/** Scratch for `largestBlob` (one probe at a time; grown to the biggest probe seen). */
let blobLabel = new Int32Array(0);
let blobStack = new Int32Array(0);

/**
 * Of the lit pixels (`on`, w×h), the biggest 4-connected blob — the person; a plant, a poster, the
 * corner of a chair the model also lit are not, and left out of the measurement. `on` is overwritten
 * with the blob alone.
 */
function largestBlob(on: Uint8Array, w: number, h: number): void {
  const n = w * h;
  if (blobLabel.length < n) {
    blobLabel = new Int32Array(n);
    blobStack = new Int32Array(n);
  }
  const label = blobLabel;
  const stack = blobStack;
  label.fill(0, 0, n);
  let next = 0;
  let best = 0;
  let bestSize = 0;
  for (let start = 0; start < n; start++) {
    if (!on[start] || label[start]) continue;
    const id = ++next;
    let size = 0;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    while (sp) {
      const i = stack[--sp]!;
      size++;
      const x = i % w;
      if (x > 0 && on[i - 1] && !label[i - 1]) (label[i - 1] = id), (stack[sp++] = i - 1);
      if (x < w - 1 && on[i + 1] && !label[i + 1]) (label[i + 1] = id), (stack[sp++] = i + 1);
      if (i >= w && on[i - w] && !label[i - w]) (label[i - w] = id), (stack[sp++] = i - w);
      if (i < n - w && on[i + w] && !label[i + w]) (label[i + w] = id), (stack[sp++] = i + w);
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
  }
  if (next > 1) for (let i = 0; i < n; i++) if (label[i] !== best) on[i] = 0;
}

/**
 * The person and their head in a mask. The person is the biggest blob of lit pixels; the body as
 * `boxOfMask` has it; the head from the top of the figure down its middle: its width grows from the
 * crown and tops out at the ears or the hair — the first row narrower than that (the jaw) or the
 * width standing still (within 4 % over a quarter of itself) settles it, whatever widens below (a
 * collar, a sweater the model lit along with the room behind it, the shoulders) — and the head ends
 * where the figure narrows to the neck or widens to the shoulders; when neither shows, a head is as
 * tall as 1.35 of its width. The head is always between 1.1 and 1.6 times as tall as it is wide — a
 * measurement outside that is brought into it.
 */
export function measureMask(data: Uint8ClampedArray, w: number, h: number, threshold = 100): PersonMeasure | null {
  const n = w * h;
  const on = new Uint8Array(n);
  let area = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 4]! > threshold) {
      on[i] = 1;
      area++;
    }
  }
  if (area < n * 0.01) return null; // a few stray pixels are not a person
  largestBlob(on, w, h);
  const widths: number[] = [];
  const centres: number[] = [];
  let y0 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let l = -1;
    let r = -1;
    for (let x = 0; x < w; x++) {
      if (on[row + x]) {
        if (l < 0) l = x;
        r = x;
      }
    }
    if (l < 0) continue;
    if (y0 < 0) y0 = y;
    y1 = y;
    widths.push(r - l + 1);
    centres.push((l + r + 1) / 2);
  }
  if (y0 < 0) return null;
  widths.sort((a, b) => a - b);
  centres.sort((a, b) => a - b);
  const bw = widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.8))]! + 2; // + a probe pixel of margin each side (soft edges, hair)
  const cx = centres[Math.floor(centres.length / 2)]!;
  const body: PersonBox = { x: (cx - bw / 2) / w, y: Math.max(0, y0 - 1) / h, w: bw / w, h: (Math.min(h - 1, y1 + 1) - Math.max(0, y0 - 1) + 1) / h };

  // The head: the figure's middle column band, from the top down.
  const bandL = Math.max(0, Math.floor(cx - bw * 0.6));
  const bandR = Math.min(w, Math.ceil(cx + bw * 0.6));
  const core = (y: number): { l: number; r: number } | null => {
    const row = y * w;
    let l = -1;
    let r = -1;
    for (let x = bandL; x < bandR; x++) {
      if (on[row + x]) {
        if (l < 0) l = x;
        r = x;
      }
    }
    return l < 0 ? null : { l, r };
  };
  let top = -1;
  for (let y = y0; y <= y1; y++) {
    const c = core(y);
    if (c && c.r - c.l + 1 >= 2) {
      top = y;
      break;
    }
  }
  if (top < 0) top = y0;
  let headW = 0;
  let settled = false;
  const maxAt: number[] = [];
  let sumC = 0;
  let nC = 0;
  let bottom = -1;
  const figureH = y1 - top + 1;
  for (let y = top; y <= y1; y++) {
    const c = core(y);
    const cw = c ? c.r - c.l + 1 : 0;
    const down = y - top;
    if (down >= 0.6 * headW && headW >= 3) {
      if (cw <= NECK * headW || cw >= SHOULDERS * headW) {
        bottom = y - 1;
        break;
      }
      if (down > 1.9 * headW || down > 0.5 * figureH) break; // no neck in sight: a head is only so tall
    }
    if (!settled) {
      // Past the round crown, the head's width is settled by the first row narrower than the widest so far (the jaw
      // under the ears, with or without a neck below it) or by the width standing still for a quarter of itself.
      if (headW >= 3 && down >= 0.5 * headW && cw <= DIP * headW) settled = true;
      else {
        if (cw > headW) headW = cw;
        maxAt[down] = headW;
        const back = Math.max(2, Math.round(0.25 * headW));
        if (headW >= 3 && down >= Math.max(3, 0.5 * headW) && down >= back && headW - maxAt[down - back]! <= Math.max(1, 0.04 * headW)) settled = true;
      }
    }
    if (c) {
      sumC += (c.l + c.r + 1) / 2;
      nC++;
    }
  }
  if (headW < 2) headW = 2;
  let headH = bottom >= top ? bottom - top + 1 : 1.35 * headW;
  headH = Math.max(1.1 * headW, Math.min(1.6 * headW, headH));
  const hcx = nC ? sumC / nC : cx;
  const head: PersonBox = { x: (hcx - headW / 2) / w, y: top / h, w: headW / w, h: headH / h };
  return { head, body };
}

export interface FrameRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * The whole camera frame (nobody found in the mask yet): the crop around `origin` (0..100 %), clamped
 * to the frame, drawn to the whole canvas of the same size.
 */
export function frameRect(srcW: number, srcH: number, crop: number, origin: { x: number; y: number } = { x: 50, y: 42 }): FrameRect {
  const k = Math.max(1, crop);
  const sw = srcW / k;
  const sh = srcH / k;
  const sx = Math.max(0, Math.min(srcW - sw, (srcW * origin.x) / 100 - sw / 2));
  const sy = Math.max(0, Math.min(srcH - sh, (srcH * origin.y) / 100 - sh / 2));
  return { sx, sy, sw, sh, dx: 0, dy: 0, dw: srcW, dh: srcH };
}

/**
 * The stage frame for a person whose head is at `head` in a `srcW`×`srcH` camera frame: a crop in
 * the frame's own proportions, sized so the head is `headHeight` of it, the top of the head
 * `headroom` down, centred on the head. The crop may reach past the camera frame (a singer close to
 * the camera): what the camera never saw is transparent in the frame that goes out. Inside the
 * frame the crop is shifted to stay within it rather than padded.
 */
export function stageCrop(srcW: number, srcH: number, head: PersonBox): FrameRect {
  const aspect = srcW / srcH;
  let sh = (head.h * srcH) / STAGE_FRAME.headHeight;
  sh = Math.max(srcH * STAGE_FRAME.minCrop, Math.min(srcH * STAGE_FRAME.maxOut, sh));
  const sw = sh * aspect;
  const cx = (head.x + head.w / 2) * srcW;
  const headTop = head.y * srcH;
  let sx = cx - sw / 2;
  let sy = headTop - sh * STAGE_FRAME.headroom;
  if (sw <= srcW) sx = Math.max(0, Math.min(srcW - sw, sx));
  else sx = (srcW - sw) / 2; // wider than the camera sees: the camera picture centred, transparent either side
  if (sh <= srcH) sy = Math.max(0, Math.min(srcH - sh, sy));
  else sy = Math.max(srcH - sh, Math.min(0, sy)); // taller than the camera sees: the whole camera picture stays inside the frame
  return { sx, sy, sw, sh, dx: 0, dy: 0, dw: srcW, dh: srcH };
}

/** How far the stage frame brings a singer back (>1: the crop is bigger than the camera frame) or up (<1). */
export const cropFactor = (r: FrameRect, srcH: number): number => r.sh / Math.max(1, srcH);

/** What a singer should do about their distance to the camera, from the frame's crop factor — or nothing. */
export function distanceNote(factor: number): 'close' | 'far' | null {
  if (factor >= STAGE_FRAME.tooClose) return 'close';
  if (factor <= STAGE_FRAME.tooFar) return 'far';
  return null;
}

/**
 * The part of the crop that lies inside the camera frame, and where it lands on the output canvas —
 * for a crop that may reach past the frame (transparent padding), drawn without relying on how a
 * browser clips a source rectangle outside its image.
 */
export function visiblePart(r: FrameRect, srcW: number, srcH: number): FrameRect | null {
  const ix0 = Math.max(0, r.sx);
  const iy0 = Math.max(0, r.sy);
  const ix1 = Math.min(srcW, r.sx + r.sw);
  const iy1 = Math.min(srcH, r.sy + r.sh);
  if (ix1 <= ix0 || iy1 <= iy0) return null;
  const kx = r.dw / r.sw;
  const ky = r.dh / r.sh;
  return { sx: ix0, sy: iy0, sw: ix1 - ix0, sh: iy1 - iy0, dx: r.dx + (ix0 - r.sx) * kx, dy: r.dy + (iy0 - r.sy) * ky, dw: (ix1 - ix0) * kx, dh: (iy1 - iy0) * ky };
}


/**
 * The seat: how the stage frame is set and held. A stage camera on a seated performer is framed once
 * and left alone; it is never steered after the performer's every sway. The head is measured a few
 * times a second and the measurement is noisy — hair, an ear, a hand near the face, the mask's soft
 * edge, a model that loses half the figure for a moment — so a frame that followed it would breathe
 * and zoom. The seat takes the median of a settling window of measurements that agree with each
 * other, frames once, and holds that frame. It re-frames only when the singer has clearly moved —
 * the head's centre, top or size away from where the frame has it by more than a margin — and stayed
 * there for `reseatAfterMs`, the measurements again agreeing: then one smooth glide (`glideMs`) to
 * the new frame, held again. Nothing moves with the singer frame by frame.
 */
export const SEAT = {
  /** The first frame is set from this long a window of measurements (at least `minSamples` of them) — quick: the singer is framed within the first second, not left as the camera sees them. */
  settleMs: 700,
  /** A move has to hold this long — `sustained` of the window's measurements beyond the margins — before the seat follows it. */
  reseatAfterMs: 2500,
  sustained: 0.8,
  minSamples: 3,
  /**
   * Measurements that agree: a window's middle half (its 25th to 75th percentile) spans at most this much of the frame in
   * the head's place, and this fraction of its median in the head's size — a model losing and finding the figure is
   * not a singer moving.
   */
  agreePlace: 0.08,
  agreeSize: 0.25,
  /** The glide from the held frame to the new one. */
  glideMs: 900,
  /** The head's centre may be this far (fraction of the frame width) from where the frame has it. */
  driftX: 0.12,
  /** The top of the head may rise this far above where the frame has it (fraction of the frame height): any higher and the crown nears the edge… */
  driftUp: 0.06,
  /** …and sink this far below it (a singer slumping in the chair). */
  driftDown: 0.14,
  /** The head may be this much smaller / bigger than the frame has it (a lean back / a lean in). */
  sizeMin: 0.76,
  sizeMax: 1.3,
} as const;

export type SeatState = 'settling' | 'gliding' | 'held';

/**
 * How a singer's frame behaves once set — their one switch, AUTOZOOM (Settings → Camera, the stage's Camera &
 * zoom sheet; 24 Nov: off by default, the owner's word): 'still' (AUTOZOOM off, the default): framed once and
 * left alone — stable and centred; it follows only a singer who has plainly moved somewhere else and stayed
 * there; 'voice' (AUTOZOOM on): pushed in on the singer's face while they sing — a close-up for the phrase, back
 * out to head and shoulders in the break (a director's push-in on the soloist) — and re-framed with a glide when
 * they have shifted in their chair; 'follow': the re-framing without the push-in (kept for a save that chose it).
 */
export type Framing = 'still' | 'follow' | 'voice';
export const FRAMINGS: readonly Framing[] = ['still', 'follow', 'voice'];

/** What a singer's picture is: them cut out of their room and placed on the stage, or their camera picture as it is, room and all. */
export type Picture = 'cutout' | 'camera';
export const PICTURES: readonly Picture[] = ['cutout', 'camera'];

/** 'still' (AUTOZOOM off): the margins a singer has to leave, and for how long, before the frame follows them at all. */
export const STILL = { reseatAfterMs: 6000, driftX: 0.3, driftUp: 0.16, driftDown: 0.34, sizeMin: 0.5, sizeMax: 2 } as const;

/**
 * The push-in on the voice — two frames, never a frame that breathes with every syllable: the singer heard
 * (the meter past `on` for `onMs`) brings the frame in to `max` on the face (`about`: the zoom is centred
 * this far down the frame, where the face is), eased over `inMs`; the singer quiet (the meter under `off`
 * for `holdMs` — a breath, the gap between two words, a rest of a bar are all shorter) lets it back out to
 * the held frame, eased over `outMs`. Between `off` and `on` nothing changes (hysteresis). The meter is the
 * engine's (0..1 over −60..0 dBFS of the voice after its effects): a sung phrase sits well over `on`, the
 * room between phrases well under `off`.
 */
export const VOICE_ZOOM = { max: 1.5, inMs: 600, outMs: 1100, about: 0.19, on: 0.56, off: 0.44, onMs: 150, holdMs: 1400, staleMs: 3000 } as const;

interface HeadSample {
  cx: number;
  top: number;
  w: number;
  h: number;
  at: number;
}

/** The head as a frame has it: centre (of the frame's width), top and height (of the frame's height). */
interface HeadPlace {
  hx: number;
  hy: number;
  hh: number;
}

const quantile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
};
const median = (xs: number[]): number => quantile(xs, 0.5);

/** Smooth in and out: the glide starts and ends at rest. */
const smooth = (t: number): number => t * t * (3 - 2 * t);

export class Seat {
  /** The frame held, or being glided to — null while the seat is settling (the whole camera frame is drawn). */
  target: FrameRect | null = null;
  /** How the frame behaves once set (`Framing`); changed at any time. */
  framing: Framing = 'still';
  /** Where `target` has the head (set from the median head the seat was set from). */
  private basis: HeadPlace | null = null;
  private from: FrameRect | null = null;
  private glideStart = 0;
  private samples: HeadSample[] = [];
  /**
   * The voice's push-in: whether the singer is heard right now (the meter's say, with its thresholds and hold),
   * when the meter last spoke, and the zoom (1 = the held frame) on its way from `zoomFrom` to `zoomTo`.
   */
  private singing = false;
  private loudSince = 0;
  private quietSince = 0;
  private voiceAt = 0;
  private zoomFrom = 1;
  private zoomTo = 1;
  private zoomStart = 0;
  private zoomNow = 1;

  constructor(
    private readonly srcW: number,
    private readonly srcH: number,
    readonly opts: typeof SEAT = SEAT,
  ) {}

  state(now: number): SeatState {
    if (!this.target) return 'settling';
    return this.from && now - this.glideStart < this.opts.glideMs ? 'gliding' : 'held';
  }

  /** Whether the crop is changing from frame to frame right now (a glide, or the voice's push-in on its way): the picture has to be redrawn. */
  moving(now: number): boolean {
    if (this.state(now) === 'gliding') return true;
    return this.zoomTarget(now) !== this.zoomTo || this.zoomNow !== this.zoomTo;
  }

  /**
   * How loud the singer is now (0..1 of the meter), told whenever the meter moves while the microphone is open:
   * past `on` for `onMs` they are singing; under `off` for `holdMs` they have stopped. A level in between changes
   * nothing — a phrase sung softly keeps the close-up, a breath never lets it go. The clocks run on their own
   * (`settle`): a meter that reads 0 and stays there is told once, and the hold still runs out.
   */
  voice(level: number, now = performance.now()): void {
    const l = Math.max(0, Math.min(1, level));
    this.voiceAt = now;
    if (l >= VOICE_ZOOM.on) {
      this.quietSince = 0;
      if (!this.loudSince) this.loudSince = now;
    } else if (l <= VOICE_ZOOM.off) {
      this.loudSince = 0;
      if (!this.quietSince) this.quietSince = now;
    } else {
      this.loudSince = 0;
      this.quietSince = 0;
    }
    this.settle(now);
  }

  /**
   * The voice's clocks: loud for `onMs` → singing; quiet for `holdMs` → not; a meter silent for `staleMs` (the
   * microphone closed, the song over) → not. Run with every meter reading and every frame drawn, so the hold ends
   * on time whether or not the meter speaks again.
   */
  private settle(now: number): void {
    if (!this.singing && this.loudSince && now - this.loudSince >= VOICE_ZOOM.onMs) this.singing = true;
    if (this.singing && this.quietSince && now - this.quietSince >= VOICE_ZOOM.holdMs) this.singing = false;
    if (this.voiceAt && now - this.voiceAt > VOICE_ZOOM.staleMs) {
      this.singing = false;
      this.loudSince = 0;
    }
  }

  /** Whether the singer is heard, as last settled (the tests, which keep their own clock). */
  get heard(): boolean {
    return this.singing;
  }

  /** Whether the singer is heard right now (the meter's say, its clocks run to `now`): support, the e2e. */
  heardAt(now = performance.now()): boolean {
    this.settle(now);
    return this.singing;
  }

  /** The zoom the voice asks for: the close-up while the singer is heard (the framing 'voice', a frame held, the meter alive), the held frame otherwise. */
  private zoomTarget(now: number): number {
    if (this.framing !== 'voice' || !this.target) return 1;
    this.settle(now);
    return this.singing ? VOICE_ZOOM.max : 1;
  }

  /** The margins and the hold for the framing chosen: 'still' (AUTOZOOM off) takes the wide ones, 'voice' and 'follow' the seat's own. */
  private margins(): { reseatAfterMs: number; driftX: number; driftUp: number; driftDown: number; sizeMin: number; sizeMax: number } {
    return this.framing === 'still' ? STILL : this.opts;
  }

  /**
   * A head measured now, as fractions of the camera frame (null: nobody found — nothing to learn; the
   * seat holds). Only a plausible measurement of a real cut-out belongs here, never a stand-in silhouette.
   */
  sample(head: PersonBox | null, now: number): void {
    if (!head) return;
    const o = this.opts;
    this.samples.push({ cx: head.x + head.w / 2, top: head.y, w: head.w, h: head.h, at: now });
    const window = this.target ? this.margins().reseatAfterMs : o.settleMs;
    this.samples = this.samples.filter((s) => now - s.at <= window / o.sustained); // a move that lasted `window` is `sustained` of what is kept
    if (this.samples.length < o.minSamples || now - this.samples[0]!.at < window) return;
    if (this.target && this.state(now) !== 'held') return;
    if (this.target) {
      const out = this.samples.filter((s) => this.beyond(s)).length;
      if (out < Math.ceil(o.sustained * this.samples.length)) return;
    }
    if (!this.agree()) return;
    this.seat(this.target ?? frameRect(this.srcW, this.srcH, 1), now);
  }

  /** Whether the window's measurements agree with each other (their middle half close together). */
  private agree(): boolean {
    const o = this.opts;
    const s = this.samples;
    const span = (xs: number[]) => quantile(xs, 0.75) - quantile(xs, 0.25);
    const hs = s.map((x) => x.h);
    return span(s.map((x) => x.cx)) <= o.agreePlace && span(s.map((x) => x.top)) <= o.agreePlace && span(hs) <= o.agreeSize * median(hs);
  }

  /** Set the frame from the window's median head and glide to it from `from`. */
  private seat(from: FrameRect, now: number): void {
    const s = this.samples;
    const head: PersonBox = { x: 0, y: median(s.map((x) => x.top)), w: median(s.map((x) => x.w)), h: median(s.map((x) => x.h)) };
    head.x = median(s.map((x) => x.cx)) - head.w / 2;
    const target = stageCrop(this.srcW, this.srcH, head);
    this.target = target;
    this.basis = this.place({ cx: head.x + head.w / 2, top: head.y, w: head.w, h: head.h, at: now }, target);
    this.from = from;
    this.glideStart = now;
    this.samples = [];
  }

  private place(s: HeadSample, f: FrameRect): HeadPlace {
    return { hx: (s.cx * this.srcW - f.sx) / f.sw, hy: (s.top * this.srcH - f.sy) / f.sh, hh: (s.h * this.srcH) / f.sh };
  }

  /** Whether a measured head sits beyond the margins of where the frame has it. */
  private beyond(s: HeadSample): boolean {
    const o = this.margins();
    const b = this.basis!;
    const p = this.place(s, this.target!);
    if (Math.abs(p.hx - b.hx) > o.driftX) return true;
    if (p.hy < b.hy - o.driftUp || p.hy > b.hy + o.driftDown) return true;
    const k = p.hh / b.hh;
    return k < o.sizeMin || k > o.sizeMax;
  }

  /**
   * The crop to draw now: the whole camera frame until the seat is set, the glide while it moves, the held
   * frame — pushed in on the face by the voice when the framing is 'voice' (eased in and out, never a jump).
   */
  crop(now: number): FrameRect {
    const t = this.target;
    if (!t) return frameRect(this.srcW, this.srcH, 1);
    const f = this.from;
    let r = t;
    if (f) {
      const k = (now - this.glideStart) / this.opts.glideMs;
      if (k >= 1) this.from = null;
      else {
        const e = smooth(Math.max(0, k));
        r = { ...t, sx: f.sx + (t.sx - f.sx) * e, sy: f.sy + (t.sy - f.sy) * e, sw: f.sw + (t.sw - f.sw) * e, sh: f.sh + (t.sh - f.sh) * e };
      }
    }
    return this.pushIn(r, now);
  }

  /**
   * The voice's push-in applied to a crop: the zoom on its way to what the voice asks (in over `inMs`, out over
   * `outMs`, starting and ending at rest — a new ask on the way starts a new glide from where the zoom is), the
   * crop shrunk about the face.
   */
  private pushIn(r: FrameRect, now: number): FrameRect {
    const target = this.zoomTarget(now);
    if (target !== this.zoomTo) {
      this.zoomFrom = this.zoomNow;
      this.zoomTo = target;
      this.zoomStart = now;
    }
    const dur = this.zoomTo > this.zoomFrom ? VOICE_ZOOM.inMs : VOICE_ZOOM.outMs;
    const k = Math.min(1, Math.max(0, (now - this.zoomStart) / dur));
    this.zoomNow = this.zoomFrom + (this.zoomTo - this.zoomFrom) * smooth(k);
    if (this.zoomNow === 1) return r;
    const sw = r.sw / this.zoomNow;
    const sh = r.sh / this.zoomNow;
    return { ...r, sx: r.sx + (r.sw - sw) / 2, sy: r.sy + (r.sh - sh) * VOICE_ZOOM.about, sw, sh };
  }
}

/**
 * Whether a head measurement is one of a person the stage can seat: not a few pixels (a model that
 * lost the figure keeps a fragment lit), and — unless the head fills the picture (a close-up, where
 * the shoulders are beyond the edges) — a head, not the figure itself measured as one.
 */
export function plausibleHead(m: PersonMeasure): boolean {
  if (m.head.w < 0.05) return false;
  return m.head.w >= 0.4 || m.head.w <= 0.85 * m.body.w;
}
