/**
 * Picture quality on the virtual stage — what each device can do for the singers' pictures:
 *
 * AT THE SOURCE (the singer's own device, `localFeed.ts`): the camera is asked for 1080p on a computer
 * (a 3:4 crop of 810×1080 real pixels; 720p on a phone, where the pipeline has to stay light), the
 * cut-out is made at 720×960 there and goes out at that size, 1:1 — no resampling between the model
 * and the packed frame; the frame other devices receive used to be 320×426 — half the detail gone
 * before it was sent — and stood blown up two to three times on a show stage. Phones send 480×640
 * (a weak device, three cores or fewer, the 320×426 it always did). The show itself (the saved
 * performance, the film of a meet) is 1080p30 on a computer, 720p24 on a phone (`showSize`), at a
 * bitrate for the size (`showBitrate`), in H.264 High or Main profile where the browser encodes it
 * (`showRecorder.ts`), the baseline it used to ask for last. The links to
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

/** The person's half of the alpha-packed frame sent to other devices (3:4): the size this device can afford — the cut-out's own size, 1:1. */
export function packSize(computer = isComputer(), weak = isWeak()): { width: number; height: number } {
  return weak ? { width: 320, height: 426 } : computer ? { width: 720, height: 960 } : { width: 480, height: 640 };
}
/** What the camera is asked for: 1080p on a computer (the cut-out's pixels are real ones), 720p on a phone (the pipeline stays light). */
export function cameraSize(computer = isComputer()): { width: number; height: number } {
  return computer ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
}
/** Whether this browser records H.264 in MP4 — which it offers only with a platform (hardware) encoder: Windows, Mac, iOS, Android; not Linux. */
export function hardwareShow(): boolean {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return false;
  return ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs="avc1.42E01E,opus"', 'video/mp4;codecs=avc1'].some((m) => MediaRecorder.isTypeSupported(m));
}
/**
 * The show — the saved performance, the film of a meet: 1080p30 on a computer with a hardware encoder (a
 * software encoder at 1080p would take the stage's own frames), 720p24 on a phone or without one.
 */
export function showSize(computer = isComputer(), hardware = hardwareShow()): { width: number; height: number; fps: number } {
  return computer && hardware ? { width: 1920, height: 1080, fps: 30 } : { width: 1280, height: 720, fps: 24 };
}
/** The bitrate a show of this size is recorded at: 8 Mbps for 1080p, 4.5 for 720p (what the platforms ask of an upload at that size), in proportion between. */
export function showBitrate(width: number, height: number): number {
  const px = width * height;
  if (px >= 1920 * 1080) return 8_000_000;
  if (px <= 1280 * 720) return 4_500_000;
  return Math.round(4_500_000 + ((px - 1280 * 720) / (1920 * 1080 - 1280 * 720)) * 3_500_000);
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
