/**
 * Whether a camera's picture is moving at all — a camera frozen on one frame tells no other API: the track
 * says live, frames keep being presented (the same one), the model keeps answering (the same cut-out).
 * This reads a few small patches of every frame at the camera's own pixels (no scaling — a scaled copy
 * averages the sensor's noise away and two frames of a still room come out alike) and compares them with
 * the frame before: a real camera's frames are never byte-identical, however still the singer sits (the
 * sensor's noise alone sees to that); a frozen one's are, frame after frame — the clock counts once the
 * same picture has come SAME_FRAMES times in a row. A dark picture is left out (a lens covered, a room
 * with the lights off: flat black, noiseless — not frozen).
 *
 * Shared by the feed worker (feed.worker.ts) and the page's own pipeline (localFeed.ts).
 */

/** Patches of this many pixels a side, PATCHES of them across the frame. */
const PATCH = 16;
const PATCHES = 4;
/** A patch set whose pixels differ by less than this in all (sum of |Δ| over the bytes) is "the same" — a camera's noise runs far past it. */
const SAME_UNDER = 1;
/** Patches whose brightness never leaves this (0..255) are a dark picture: not judged. */
const DARK_UNDER = 12;
/**
 * The same picture this many frames in a row before the clock counts: a frozen camera presents its one frame over and
 * over, at its own rate; two frames alike taken seconds apart by a sampler that runs now and then (a device straining,
 * the model slow) prove nothing.
 */
const SAME_FRAMES = 3;

export class FrameStillness {
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private last: Uint8ClampedArray | null = null;
  /** When the picture was first seen unchanged (ms, performance.now()); 0 while it moves. */
  stillSince = 0;
  /** Frames alike in a row (the first of them counted), since stillSince. */
  sameFrames = 0;
  /** Frames compared so far (support). */
  frames = 0;

  constructor(private readonly make: () => CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null) {}

  /** The frame just taken (`w`×`h` of the source's own pixels), at `now`. */
  sample(source: CanvasImageSource, w: number, h: number, now: number): void {
    if (w < PATCH * 2 || h < PATCH * 2) return;
    if (!this.ctx) {
      this.ctx = this.make();
      if (!this.ctx) return;
    }
    const c = this.ctx;
    try {
      // Four patches: the middle, a third in from each side, three quarters down — where a singer and their room are.
      const spots: [number, number][] = [
        [w / 2, h / 2],
        [w / 3, h / 3],
        [(2 * w) / 3, h / 3],
        [w / 2, (3 * h) / 4],
      ];
      for (let k = 0; k < PATCHES; k++) {
        const [x, y] = spots[k]!;
        c.drawImage(source, Math.round(x - PATCH / 2), Math.round(y - PATCH / 2), PATCH, PATCH, k * PATCH, 0, PATCH, PATCH);
      }
      const data = c.getImageData(0, 0, PATCH * PATCHES, PATCH).data;
      this.frames++;
      const last = this.last;
      this.last = new Uint8ClampedArray(data);
      if (!last) return;
      let diff = 0;
      let bright = 0;
      for (let i = 0; i < data.length; i += 4) {
        diff += Math.abs(data[i]! - last[i]!) + Math.abs(data[i + 1]! - last[i + 1]!) + Math.abs(data[i + 2]! - last[i + 2]!);
        if (data[i]! > bright) bright = data[i]!;
        if (data[i + 1]! > bright) bright = data[i + 1]!;
        if (diff >= SAME_UNDER && bright >= DARK_UNDER) break;
      }
      if (diff >= SAME_UNDER || bright < DARK_UNDER) {
        this.stillSince = 0;
        this.sameFrames = 0;
      } else if (!this.stillSince) {
        this.stillSince = now;
        this.sameFrames = 2;
      } else this.sameFrames++;
    } catch {
      /* a lost context, a tainted source: nothing learned this frame */
    }
  }

  /** How long the picture has stood exactly still (ms) — the same frame SAME_FRAMES times over at least; 0 while it moves. */
  stillFor(now: number): number {
    return this.stillSince && this.sameFrames >= SAME_FRAMES ? now - this.stillSince : 0;
  }

  reset(): void {
    this.last = null;
    this.stillSince = 0;
    this.sameFrames = 0;
  }
}

/** The small canvas the patches are read from, on the page. */
export function pageStillnessContext(): CanvasRenderingContext2D | null {
  const c = document.createElement('canvas');
  c.width = PATCH * PATCHES;
  c.height = PATCH;
  return c.getContext('2d', { willReadFrequently: true });
}

/** …and in a worker. */
export function workerStillnessContext(): OffscreenCanvasRenderingContext2D | null {
  const c = new OffscreenCanvas(PATCH * PATCHES, PATCH);
  return c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
}
