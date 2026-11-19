/**
 * Picture quality on the virtual stage — what each device can do for the singers' pictures:
 *
 * AT THE SOURCE (the singer's own device, `localFeed.ts`): the cut-out goes out larger. A 720p camera
 * gives a 3:4 crop of 540×720 real pixels; the packed frame other devices receive used to be
 * 320×426 — half the detail gone before it was sent — and stood blown up two to three times on a
 * show stage. Computers now send 640×852 (near 1:1 with the camera), phones 480×640 (a weak device,
 * three cores or fewer, the 320×426 it always did). The links to
 * the other singers' devices are scaled back down to the old size on the way (`singerLinkScale`:
 * their stage draws small tiles, and the uplink is shared), so the mesh costs what it did; the link
 * to a publisher (the show view, the Preview — the broadcast's source) gets the whole frame at a
 * higher bitrate. The exposure is lifted at the source too (`Exposure`): a singer in a dim room —
 * the usual case, a screen for a lamp — is brightened by a gain that follows the person's own
 * measured brightness, gently and smoothly, never past EXPOSURE_MAX_GAIN, with a little contrast
 * and colour on top; done once here, it reaches every stage, the show, the broadcast and the
 * recordings alike, and the singer sees exactly what the others get. The lift goes by the face: the
 * brighter quarter of the head's pixels (the head box the framing measures) — a dark shirt in a lit
 * room asks for nothing, a dim face for the lift.
 *
 * AT THE RECEIVER (`alphaPack.ts`, the unpacker's shader): a frame that still arrives small (an
 * older build, a phone, a link the browser scaled down) is upscaled bicubically (Catmull-Rom) rather
 * than bilinearly, and every frame is sharpened (an unsharp mask on the luminance, one texel wide,
 * SHARPEN strong) — the detail the codec softened, back. The stage draws the result with the
 * canvas's high-quality resampling.
 */

const cores = (): number => (typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 2) : 2);
/** A computer (four cores or more, not a phone or tablet): the bigger cut-out, the finer model. */
export const isComputer = (): boolean => cores() >= 4 && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
/** A weak device (three cores or fewer: an old phone) sends the frame as it always did — one more encoder's worth of pixels is not for it. */
export const isWeak = (): boolean => cores() <= 3;

/** The person's half of the alpha-packed frame sent to other devices (3:4): the size this device can afford. */
export function packSize(computer = isComputer(), weak = isWeak()): { width: number; height: number } {
  return weak ? { width: 320, height: 426 } : computer ? { width: 640, height: 852 } : { width: 480, height: 640 };
}
export const PACK_WIDTH = packSize().width;
export const PACK_HEIGHT = packSize().height;
/** What a link to another singer's device carries: the frame scaled down to about this wide (the size it always was). */
export const SINGER_LINK_WIDTH = 320;

/** How much a link to another singer scales the packed frame down by: to the singer-link width, and half as much again on a crowded stage. */
export function singerLinkScale(singers: number, packWidth = PACK_WIDTH): number {
  return Math.max(1, (packWidth / SINGER_LINK_WIDTH) * (singers > 6 ? 1.5 : 1));
}

// ---- exposure, at the source ----

/** The brightness the lift aims for (0..1) — of the brighter part of the face (its 75th percentile): lit as in daylight, not blown out. */
export const EXPOSURE_TARGET = 0.5;
/** The part of the person the lift goes by: the brighter quarter (a face is among the brightest of a person; the head box, when the model found one). */
export const EXPOSURE_PERCENTILE = 0.75;
/** The most a dim picture is brightened by (a gain beyond this blows the highlights and shows the noise). */
export const EXPOSURE_MAX_GAIN = 1.5;
/** The polish every picture gets: a touch more contrast and colour. */
export const POLISH_CONTRAST = 1.05;
export const POLISH_SATURATE = 1.08;
/** How often the person is measured for the lift (ms). */
export const EXPOSURE_EVERY_MS = 500;
/** The gain glides this much of the way to its target per frame (15 fps: settled in about half a second, never a jump). */
export const EXPOSURE_GLIDE = 0.15;

/** The gain a picture whose person averages `meanLuma` gets: 1 when bright enough, up to the ceiling when dim; 1 when nobody is measured. */
export function exposureGain(meanLuma: number | null): number {
  if (meanLuma === null || !Number.isFinite(meanLuma)) return 1;
  return Math.min(EXPOSURE_MAX_GAIN, Math.max(1, EXPOSURE_TARGET / Math.max(0.08, meanLuma)));
}

/** A region of a sample, as fractions of its width and height (the head box the framing measures, `framing.ts`). */
export interface LumaBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The brightness of the person in an RGBA sample (Rec. 601 luma, 0..1): the 75th percentile of the pixels in `box`
 * (the head, when the model found one — the face is what matters, whatever they wear) or, without one (or with too
 * few person pixels in it), of the whole person, each pixel weighted by its alpha (the cut-out's mask: the room
 * behind them counts for nothing). Null when fewer than `minPixels` pixels are (mostly) person — nobody there.
 */
export function personLuma(data: Uint8ClampedArray | number[], w: number, h: number, box: LumaBox | null = null, minPixels = 40): number | null {
  const inBox = box ? { x0: Math.floor(box.x * w), x1: Math.ceil((box.x + box.w) * w), y0: Math.floor(box.y * h), y1: Math.ceil((box.y + box.h) * h) } : null;
  const collect = (region: typeof inBox): { l: number; a: number }[] => {
    const out: { l: number; a: number }[] = [];
    for (let y = 0; y < h; y++) {
      if (region && (y < region.y0 || y >= region.y1)) continue;
      for (let x = 0; x < w; x++) {
        if (region && (x < region.x0 || x >= region.x1)) continue;
        const i = (y * w + x) * 4;
        const a = (data[i + 3] ?? 0) / 255;
        if (a < 0.25) continue;
        out.push({ l: (0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!) / 255, a });
      }
    }
    return out;
  };
  let px = inBox ? collect(inBox) : [];
  if (px.length < minPixels) px = collect(null);
  if (px.length < minPixels) return null;
  px.sort((p, q) => p.l - q.l);
  const total = px.reduce((s, p) => s + p.a, 0);
  let acc = 0;
  for (const p of px) {
    acc += p.a;
    if (acc >= total * EXPOSURE_PERCENTILE) return p.l;
  }
  return px[px.length - 1]!.l;
}

/** The lift of one singer's picture: measured now and then, glided to frame by frame, said as a canvas filter. */
export class Exposure {
  gain = 1;
  private target = 1;

  /** A new measurement of the person (null: nobody there — the lift eases back to none). */
  sample(meanLuma: number | null): void {
    this.target = exposureGain(meanLuma);
  }

  /** One frame on: the gain a step nearer its target. */
  step(): number {
    this.gain += (this.target - this.gain) * EXPOSURE_GLIDE;
    if (Math.abs(this.gain - this.target) < 0.002) this.gain = this.target;
    return this.gain;
  }

  /** The lift as a percentage ("+23%"), 0 when none. */
  get lift(): number {
    return Math.round((this.gain - 1) * 100);
  }

  /** The canvas filter for the picture as it stands: the polish, and the gain when there is one. */
  filter(): string {
    const polish = `contrast(${POLISH_CONTRAST}) saturate(${POLISH_SATURATE})`;
    return this.gain > 1.005 ? `brightness(${this.gain.toFixed(3)}) ${polish}` : polish;
  }
}

// ---- the receiver ----

/** A frame narrower than this (the old size, a phone's, a link scaled down) is drawn through the bicubic upscaler at twice its size. */
export const UPSCALE_BELOW = 400;
export const upscaleFor = (srcWidth: number): number => (srcWidth <= UPSCALE_BELOW ? 2 : 1);
/** The unsharp mask's strength (0: none; 1: the full detail added back). */
export const SHARPEN = 0.5;
