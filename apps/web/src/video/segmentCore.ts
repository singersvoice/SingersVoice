/**
 * The person cut-out's arithmetic, shared by the segmenter on the page (`segmenter.ts`) and the one in
 * the feed worker (`feed.worker.ts`): the model's raw mask turned into a feathered alpha, the soft
 * silhouette that stands in for it, the centre crop a picture gets. Nothing here touches the DOM —
 * a 2D context of either kind (a canvas on the page, an OffscreenCanvas in a worker) will do.
 */

/** The model answers at 256×144 / 256×256: a 240×320 work canvas loses nothing and keeps the per-pixel pass cheap on phones. */
export const MASK_W = 240;
export const MASK_H = 320;
/** Frames to the model per second: a singer's movement at 15 is smooth, and the stage is not asked for more. */
export const TARGET_FPS = 15;
/** A frame the model has not answered in this long gets as long again; still no answer and the model counts as stuck. */
export const SEND_TIMEOUT_MS = 1500;
/** How long the silhouette stands in for a stuck model before the model is asked again. */
export const MODEL_RETRY_MS = 8000;

export type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const smoothStep = (e0: number, e1: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Turn the model's raw mask pixels into a white-with-alpha mask, in place. The legacy MediaPipe
 * solution returns the person probability either in the alpha channel or only as brightness with
 * alpha fully opaque (it differs by browser / GPU path), so use whichever channel actually varies,
 * normalise it and feather with a smoothstep. Returns 'unusable' only when the mask carries no
 * information at all (a broken readback); an empty mask (nobody in frame) is a valid answer and
 * leaves that spot on the stage empty rather than showing the real background.
 */
export function alphaFromMaskPixels(d: Uint8ClampedArray): { mode: 'adaptive-alpha' | 'adaptive-luma' | 'unusable'; coverage: number } {
  let minLuma = 255;
  let maxLuma = 0;
  let minAlpha = 255;
  let maxAlpha = 0;
  for (let i = 0; i < d.length; i += 4) {
    const luma = d[i]! * 0.2126 + d[i + 1]! * 0.7152 + d[i + 2]! * 0.0722;
    if (luma < minLuma) minLuma = luma;
    if (luma > maxLuma) maxLuma = luma;
    const a = d[i + 3]!;
    if (a < minAlpha) minAlpha = a;
    if (a > maxAlpha) maxAlpha = a;
  }
  const lumaRange = maxLuma - minLuma;
  const alphaRange = maxAlpha - minAlpha;
  const useAlpha = alphaRange > lumaRange && alphaRange > 8;
  const min = useAlpha ? minAlpha : minLuma;
  const range = useAlpha ? alphaRange : lumaRange;
  if (range < 6) return { mode: 'unusable', coverage: 0 };
  let visible = 0;
  for (let i = 0; i < d.length; i += 4) {
    const raw = useAlpha ? d[i + 3]! : d[i]! * 0.2126 + d[i + 1]! * 0.7152 + d[i + 2]! * 0.0722;
    const alpha = Math.round(smoothStep(0.18, 0.58, (raw - min) / range) * 255);
    if (alpha > 8) visible++;
    d[i] = 255;
    d[i + 1] = 255;
    d[i + 2] = 255;
    d[i + 3] = alpha;
  }
  const coverage = visible / (d.length / 4);
  return { mode: useAlpha ? 'adaptive-alpha' : 'adaptive-luma', coverage };
}

/** The head-and-shoulders silhouette with soft edges (the fallback when there is no usable mask), written into `d` (RGBA, w×h). */
export function fillSoftCenterMask(d: Uint8ClampedArray, w = MASK_W, h = MASK_H): void {
  const cx = w * 0.5;
  const cy = h * 0.48;
  const rx = w * 0.28;
  const ry = h * 0.46;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const torso = smoothStep(1.05, 0.52, Math.sqrt(dx * dx + dy * dy));
      const hx = (x - cx) / (w * 0.18);
      const hy = (y - h * 0.32) / (h * 0.22);
      const head = smoothStep(1.0, 0.42, Math.sqrt(hx * hx + hy * hy));
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = Math.round(Math.max(torso, head) * 230);
    }
  }
}

/** The part of a sw×sh picture that covers a w×h box (centre crop, the picture's proportions kept). */
export function coverRect(sw: number, sh: number, w: number, h: number): { sx: number; sy: number; sw: number; sh: number } {
  const sr = sw / sh;
  const dr = w / h;
  if (sr > dr) {
    const cw = sh * dr;
    return { sx: (sw - cw) / 2, sy: 0, sw: cw, sh };
  }
  const ch = sw / dr;
  return { sx: 0, sy: (sh - ch) / 2, sw, sh: ch };
}

/** The size of a picture source of any kind (a video, a bitmap, a canvas, a frame). */
export function sourceSize(source: CanvasImageSource): { w: number; h: number } {
  const el = source as { videoWidth?: number; videoHeight?: number; displayWidth?: number; displayHeight?: number; width?: number | SVGAnimatedLength; height?: number | SVGAnimatedLength };
  const w = el.videoWidth || el.displayWidth || (typeof el.width === 'number' ? el.width : 0) || 1;
  const h = el.videoHeight || el.displayHeight || (typeof el.height === 'number' ? el.height : 0) || 1;
  return { w, h };
}

/** Draw `source` covering a w×h box (centre crop). */
export function drawCover(c: Canvas2D, source: CanvasImageSource, w: number, h: number): void {
  const s = sourceSize(source);
  const r = coverRect(s.w, s.h, w, h);
  c.drawImage(source, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
