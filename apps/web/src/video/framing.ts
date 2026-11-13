/**
 * Stage framing = how much of the camera frame a singer's cut-out shows: three levels — wide (the
 * whole frame; the default), mid and close (cropped in around the face) — and a vocal-driven auto
 * zoom that eases from the chosen level towards "close" while this singer sings and back when they
 * are silent, so whoever takes the vocal is the one who comes closer — on every device, since the
 * sender frames its own stream. This framing IS the picture of the singer: every stage (`stage.ts`)
 * draws the frame whole, exactly as cropped here, the live stage small under the lyrics and the
 * show big — nothing downstream finds a person and zooms in on its own.
 */
export type ZoomPreset = 'wide' | 'mid' | 'close';

/** Crop factor per level (1 = the whole frame). */
export const FRAMING: Record<ZoomPreset, { crop: number }> = {
  wide: { crop: 1 },
  mid: { crop: 1.2 },
  close: { crop: 1.45 },
};

/** Continuous framing value: 0 = wide, 1 = close (presets map to 0 / 0.5 / 1). */
export const presetLevel = (p: ZoomPreset): number => (p === 'wide' ? 0 : p === 'mid' ? 0.5 : 1);

export function framingAt(level: number): { crop: number } {
  const t = Math.max(0, Math.min(1, level));
  return { crop: FRAMING.wide.crop + (FRAMING.close.crop - FRAMING.wide.crop) * t };
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
 * Where to copy the cut-out from (crop window around `origin`, 0..100 %, clamped to the frame) and
 * where to draw it: the whole canvas of the same size, so the crop fills the frame that goes out.
 */
export function frameRect(srcW: number, srcH: number, level: number, origin: { x: number; y: number } = { x: 50, y: 42 }): FrameRect {
  const { crop } = framingAt(level);
  const sw = srcW / crop;
  const sh = srcH / crop;
  const sx = Math.max(0, Math.min(srcW - sw, (srcW * origin.x) / 100 - sw / 2));
  const sy = Math.max(0, Math.min(srcH - sh, (srcH * origin.y) / 100 - sh / 2));
  return { sx, sy, sw, sh, dx: 0, dy: 0, dw: srcW, dh: srcH };
}

/** How quickly singing/silence moves the framing (per ~66 ms frame). */
export const ZOOM_EASE = 0.1;
/** Silence this long after the last loud frame eases the framing back out. */
export const SILENCE_HOLD_MS = 1400;
/** Mic level (0..1, from the recorder meter) that counts as singing. */
export const SING_LEVEL = 0.3;
