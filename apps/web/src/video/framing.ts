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

/** The neck is this much narrower than the head; the shoulders this much wider. */
const NECK = 0.62;
const SHOULDERS = 1.4;

/**
 * Where the person is in a mask (grey: bright = person), as fractions of w×h, or null when nobody
 * is there: top to bottom of the person pixels, and across, the body — the width most rows have
 * (the 80th percentile) around the median row centre — so an arm stretched out for a moment never
 * widens the framing or pulls it sideways.
 */
export function boxOfMask(data: Uint8ClampedArray, w: number, h: number, threshold = 100): PersonBox | null {
  return measureMask(data, w, h, threshold)?.body ?? null;
}

/**
 * The person and their head in a mask. The body as `boxOfMask` has it; the head from the top of the
 * figure down its middle: its width grows from the crown, tops out at the ears, and the head ends
 * where the figure narrows to the neck (or, with hair down to the shoulders, where it widens to
 * them); when neither shows, a head is as tall as 1.35 of its width. The head is always between 1.1
 * and 1.6 times as tall as it is wide — a measurement outside that is brought into it.
 */
export function measureMask(data: Uint8ClampedArray, w: number, h: number, threshold = 100): PersonMeasure | null {
  const rows: { l: number; r: number }[] = new Array(h);
  const widths: number[] = [];
  const centres: number[] = [];
  let y0 = -1;
  let y1 = -1;
  let area = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let l = -1;
    let r = -1;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4]! > threshold) {
        if (l < 0) l = x;
        r = x;
      }
    }
    rows[y] = { l, r };
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
  const body: PersonBox = { x: (cx - bw / 2) / w, y: Math.max(0, y0 - 1) / h, w: bw / w, h: (Math.min(h - 1, y1 + 1) - Math.max(0, y0 - 1) + 1) / h };

  // The head: the figure's middle column band, from the top down.
  const bandL = cx - bw * 0.6;
  const bandR = cx + bw * 0.6;
  const core = (y: number): { l: number; r: number } | null => {
    const row = y * w * 4;
    let l = -1;
    let r = -1;
    for (let x = Math.max(0, Math.floor(bandL)); x < Math.min(w, Math.ceil(bandR)); x++) {
      if (data[row + x * 4]! > threshold) {
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
    if (cw > headW) headW = cw;
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

/** A crop only moves for a change bigger than this (fraction of the frame) — no breathing from mask noise. */
export const CROP_DEAD = 0.02;
/** How fast the crop follows a moved target (per ~66 ms frame). */
export const CROP_EASE = 0.12;
