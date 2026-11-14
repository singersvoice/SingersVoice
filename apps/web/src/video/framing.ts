/**
 * Stage framing = how much of the camera frame a singer's cut-out shows. The default, **chest**,
 * frames the singer itself — head to chest, like a news anchor — from where the person is in the
 * cut-out (the mask's bounding box), however near or far they sit. **Wide** is the whole camera
 * frame (the camera cannot see wider: for more room, move it back); **mid** and **close** are
 * fixed zooms (1.5× and 2.2×) aimed at the singer's head where one is found. **Auto** eases any of
 * them a fifth closer while this singer sings and back when they are silent, so whoever takes the
 * vocal is the one who comes closer — on every device, since the sender frames its own stream.
 * This framing IS the picture of the singer: every stage (`stage.ts`) draws the frame whole,
 * exactly as cropped here, the live stage small under the lyrics and the show big — nothing
 * downstream finds a person and zooms in on its own.
 */
export type ZoomPreset = 'chest' | 'wide' | 'mid' | 'close';

/** Crop factor per fixed preset (1 = the whole frame, 2.2 = the middle 45 % of it); chest is sized from the person instead. */
export const FRAMING: Record<ZoomPreset, { crop: number }> = {
  chest: { crop: 1 },
  wide: { crop: 1 },
  mid: { crop: 1.5 },
  close: { crop: 2.2 },
};

/** How much singing tightens a framing with Auto on: a fifth closer (the crop a fifth smaller). */
export const SING_TIGHTEN = 0.2;

/** The crop factor of a fixed preset, `sing` (0..1) closer when Auto has the singer singing. */
export const presetCrop = (p: ZoomPreset, sing = 0): number => FRAMING[p].crop * (1 + SING_TIGHTEN * Math.max(0, Math.min(1, sing)));

/** Where the person is in their cut-out frame, as fractions (0..1) of the frame. */
export interface PersonBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the person is in a mask (grey: bright = person), as fractions of w×h, or null when nobody
 * is there: top to bottom of the person pixels, and across, the body — the width most rows have
 * (the 80th percentile) around the median row centre — so an arm stretched out for a moment never
 * widens the framing or pulls it sideways.
 */
export function boxOfMask(data: Uint8ClampedArray, w: number, h: number, threshold = 100): PersonBox | null {
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
 * The chest framing: the crop is as wide as 1.35 bodies (shoulders at about three quarters of the
 * frame), in the frame's own proportions, with the top of the head a tenth of the way down — head
 * to chest, whatever the distance to the camera. Never past the camera frame (a singer already
 * close gets the whole frame), never tighter than a third of it (a singer far away is brought up
 * three times, not into a blur). Singing may tighten it by up to a fifth.
 */
export const CHEST = { widthOverBody: 1.35, headroom: 0.1, minCrop: 0.3, singTighten: 0.2 } as const;
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
 * Where to copy the cut-out from (a crop `crop` times smaller than the frame, around `origin`,
 * 0..100 %, clamped to the frame) and where to draw it: the whole canvas of the same size, so the
 * crop fills the frame that goes out.
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
 * A fixed zoom (mid / close) aimed at the singer: the crop is centred on the body and has the top
 * of the head a tenth of the way down, like the chest framing — so "close" is the face, wherever
 * the singer sits — and falls back to the crop around `origin` while nobody is found.
 */
export function fixedCrop(srcW: number, srcH: number, crop: number, person: PersonBox | null, origin: { x: number; y: number } = { x: 50, y: 42 }): FrameRect {
  if (!person) return frameRect(srcW, srcH, crop, origin);
  const k = Math.max(1, crop);
  const sw = srcW / k;
  const sh = srcH / k;
  const cx = (person.x + person.w / 2) * srcW;
  const headTop = person.y * srcH;
  const sx = Math.max(0, Math.min(srcW - sw, cx - sw / 2));
  const sy = Math.max(0, Math.min(srcH - sh, headTop - sh * CHEST.headroom));
  return { sx, sy, sw, sh, dx: 0, dy: 0, dw: srcW, dh: srcH };
}

/** The chest crop for a person at `box` in a `srcW`×`srcH` frame; `tighten` 0..1 is how much singing pulls it in. */
export function chestCrop(srcW: number, srcH: number, box: PersonBox, tighten = 0): FrameRect {
  const aspect = srcW / srcH;
  const bw = Math.max(1, box.w * srcW);
  let sw = bw * CHEST.widthOverBody * (1 - CHEST.singTighten * Math.max(0, Math.min(1, tighten)));
  let sh = sw / aspect;
  sh = Math.max(srcH * CHEST.minCrop, Math.min(srcH, sh));
  sw = sh * aspect;
  const cx = (box.x + box.w / 2) * srcW;
  const headTop = box.y * srcH;
  const sx = Math.max(0, Math.min(srcW - sw, cx - sw / 2));
  const sy = Math.max(0, Math.min(srcH - sh, headTop - sh * CHEST.headroom));
  return { sx, sy, sw, sh, dx: 0, dy: 0, dw: srcW, dh: srcH };
}

/** A crop only moves for a change bigger than this (fraction of the frame) — no breathing from mask noise. */
export const CROP_DEAD = 0.02;
/** How fast the crop follows a moved target (per ~66 ms frame). */
export const CROP_EASE = 0.12;

/** How quickly singing/silence moves the framing (per ~66 ms frame). */
export const ZOOM_EASE = 0.1;
/** Silence this long after the last loud frame eases the framing back out. */
export const SILENCE_HOLD_MS = 1400;
/** Mic level (0..1, from the recorder meter) that counts as singing. */
export const SING_LEVEL = 0.3;
