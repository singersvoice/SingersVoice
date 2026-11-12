/**
 * Stage framing = how much of the camera frame a singer's cut-out shows (crop) and how large it
 * stands on the stage (scale). Three levels: wide (the whole frame, standing small — the default,
 * like a wide shot of a stage), mid and close. Vocal-driven auto zoom eases from the chosen level
 * towards "close" while this singer sings and back when they are silent, so whoever takes the
 * vocal is the one who comes closer — on every device, since the sender frames its own stream.
 */
export type ZoomPreset = 'wide' | 'mid' | 'close';

/** Crop factor (1 = whole frame) and on-stage scale (fraction of the tile height) per level. */
export const FRAMING: Record<ZoomPreset, { crop: number; scale: number }> = {
  wide: { crop: 1, scale: 0.72 },
  mid: { crop: 1.2, scale: 0.88 },
  close: { crop: 1.45, scale: 1 },
};

/** Continuous framing value: 0 = wide, 1 = close (presets map to 0 / 0.5 / 1). */
export const presetLevel = (p: ZoomPreset): number => (p === 'wide' ? 0 : p === 'mid' ? 0.5 : 1);

export function framingAt(level: number): { crop: number; scale: number } {
  const t = Math.max(0, Math.min(1, level));
  return { crop: FRAMING.wide.crop + (FRAMING.close.crop - FRAMING.wide.crop) * t, scale: FRAMING.wide.scale + (FRAMING.close.scale - FRAMING.wide.scale) * t };
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
 * Where to copy the cut-out from (crop window around `origin`, 0..100 %) and where to draw it in a
 * canvas of the same size: scaled by `scale`, bottom-anchored and centred, so a singer "stands" on
 * the stage floor at every level.
 */
export function frameRect(srcW: number, srcH: number, level: number, origin: { x: number; y: number } = { x: 50, y: 42 }): FrameRect {
  const { crop, scale } = framingAt(level);
  const sw = srcW / crop;
  const sh = srcH / crop;
  const sx = Math.max(0, Math.min(srcW - sw, (srcW * origin.x) / 100 - sw / 2));
  const sy = Math.max(0, Math.min(srcH - sh, (srcH * origin.y) / 100 - sh / 2));
  const dw = srcW * scale;
  const dh = srcH * scale;
  return { sx, sy, sw, sh, dx: (srcW - dw) / 2, dy: srcH - dh, dw, dh };
}

/** How quickly singing/silence moves the framing (per ~66 ms frame). */
export const ZOOM_EASE = 0.1;
/** Silence this long after the last loud frame eases the framing back out. */
export const SILENCE_HOLD_MS = 1400;
/** Mic level (0..1, from the recorder meter) that counts as singing. */
export const SING_LEVEL = 0.3;
