/**
 * The stage frame: every singer's head the same size at the same place in the frame their device
 * sends — so every stage draws every singer the same size — wherever they sit from their camera.
 */
import { describe, expect, it } from 'vitest';
import { boxOfMask, cropFactor, distanceNote, frameRect, measureMask, STAGE_FRAME, stageCrop, visiblePart, type PersonBox } from '../src/video/framing.ts';
import { coverRect } from '../src/video/segmenter.ts';

/** A grey mask w×h: bright where `person(x, y)`. */
const grey = (w: number, h: number, person: (x: number, y: number) => boolean) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[(y * w + x) * 4] = person(x, y) ? 255 : 0;
  return d;
};
/** A figure: a head (ellipse) on a neck on shoulders, scaled by `k` (1 = a head 24 px wide in a 120×160 probe), centred at `cx`, head top at `top`. */
const figure = (k: number, cx: number, top: number) => {
  const hw = 12 * k; // half the head width
  const hh = 16 * k; // half the head height
  const neckW = 7 * k;
  const neckLen = 7 * k;
  const shoulderW = 30 * k;
  const headCy = top + hh;
  const neckTop = headCy + hh * 0.85;
  const shoulderTop = neckTop + neckLen;
  return (x: number, y: number) => {
    if (((x - cx) / hw) ** 2 + ((y - headCy) / hh) ** 2 <= 1) return true;
    if (y >= neckTop && y < shoulderTop && Math.abs(x - cx) < neckW) return true;
    if (y >= shoulderTop && Math.abs(x - cx) < shoulderW) return true;
    return false;
  };
};

describe('measuring the singer in the mask', () => {
  it('finds the person: head top to the bottom of the body, the body width, not a stretched arm', () => {
    // A figure 20 wide standing in the middle of a 96×128 mask, one arm out to the side for a few rows.
    const box = boxOfMask(grey(96, 128, (x, y) => (y >= 30 && y < 120 && x >= 38 && x < 58) || (y >= 60 && y < 64 && x >= 58 && x < 90)), 96, 128)!;
    expect(box).not.toBeNull();
    expect(box.y * 128).toBeCloseTo(29, 0); // the head top (a pixel of margin)
    expect(box.w * 96).toBeCloseTo(22, 0); // the body (20 + margin), not the arm
    expect(box.x + box.w / 2).toBeCloseTo(0.5, 2);
    expect(boxOfMask(grey(96, 128, () => false), 96, 128)).toBeNull();
  });

  it('finds the head: crown to the neck, ear to ear — whether the singer is near (big) or far (small)', () => {
    for (const [k, top] of [
      [1, 20],
      [2, 10],
      [0.5, 40],
    ] as const) {
      const m = measureMask(grey(120, 160, figure(k, 60, top)), 120, 160)!;
      expect(m, `k=${k}`).not.toBeNull();
      expect(m.head.y * 160, `head top k=${k}`).toBeCloseTo(top, -0.5);
      expect(m.head.w * 120, `head width k=${k}`).toBeCloseTo(24 * k, -0.6); // ear to ear
      expect(m.head.h * 160, `head height k=${k}`).toBeGreaterThan(24 * k * 1.1 - 0.01); // taller than wide…
      expect(m.head.h * 160, `head height k=${k}`).toBeLessThan(24 * k * 1.6 + 0.01); // …but a head, not the whole figure
      expect(m.head.x + m.head.w / 2, `head centre k=${k}`).toBeCloseTo(0.5, 1);
      expect(m.body.w * 120, `body k=${k}`).toBeGreaterThan(24 * k * 2); // the shoulders are the body, not the head
    }
  });

  it('a head cut by the top of the frame, or a singer sitting to one side, is still found where it is', () => {
    const m = measureMask(grey(120, 160, figure(2, 36, -14)), 120, 160)!; // the crown is out of the picture
    expect(m.head.y).toBe(0);
    expect(m.head.x + m.head.w / 2).toBeCloseTo(36 / 120, 1);
    expect(m.head.h * 160).toBeGreaterThan(48 * 1.1 - 0.01); // never shorter than a head can be
  });
});

describe('the stage frame — one framing for everyone', () => {
  it('puts the head at the standard size and place, from a singer sitting back (brought up) or close (brought back)', () => {
    const far: PersonBox = { x: 0.46, y: 0.3, w: 0.08, h: 0.1 }; // a small head in a 720×960 frame
    const r = stageCrop(720, 960, far);
    expect(r.sw / r.sh).toBeCloseTo(0.75, 5); // the frame's own proportions
    expect(r.sh).toBeCloseTo((0.1 * 960) / STAGE_FRAME.headHeight, 3); // the head 22 % of the frame
    expect(r.sy).toBeCloseTo(0.3 * 960 - r.sh * STAGE_FRAME.headroom, 3); // the top of the head 8 % down
    expect(r.sx + r.sw / 2).toBeCloseTo(0.5 * 720, 3); // centred on the head
    expect([r.dx, r.dy, r.dw, r.dh]).toEqual([0, 0, 720, 960]); // the crop fills the frame that goes out
    const close: PersonBox = { x: 0.2, y: 0.05, w: 0.6, h: 0.5 }; // a head half the frame tall
    const c = stageCrop(720, 960, close);
    expect(c.sh).toBeCloseTo((0.5 * 960) / STAGE_FRAME.headHeight, 3); // bigger than the camera frame: the singer is brought back
    expect(c.sh).toBeGreaterThan(960);
    expect(c.sx).toBeLessThan(0); // transparent room either side of what the camera saw
    expect(c.sx + c.sw / 2).toBeCloseTo(360, 3);
    expect(c.sy).toBeLessThanOrEqual(0);
    expect(c.sy + c.sh).toBeGreaterThanOrEqual(960); // the whole camera picture stays inside the frame
    // the same head size on both: that is the point
    expect(far.h * 960 / r.sh).toBeCloseTo(close.h * 960 / c.sh, 6);
  });

  it('never brings a singer up more than 3.3× or back more than 2.4×, and slides inside the frame rather than pad it', () => {
    const tiny = stageCrop(720, 960, { x: 0.48, y: 0.4, w: 0.02, h: 0.03 });
    expect(tiny.sh).toBeCloseTo(960 * STAGE_FRAME.minCrop, 5);
    expect(tiny.sx).toBeGreaterThanOrEqual(0);
    expect(tiny.sx + tiny.sw).toBeLessThanOrEqual(720 + 0.01);
    const huge = stageCrop(720, 960, { x: 0, y: 0, w: 1, h: 1 });
    expect(huge.sh).toBeCloseTo(960 * STAGE_FRAME.maxOut, 5);
    const edge = stageCrop(720, 960, { x: 0.86, y: 0.02, w: 0.12, h: 0.16 }); // a head in the top-right corner, brought up 1.4×
    expect(edge.sx + edge.sw).toBeLessThanOrEqual(720 + 0.01); // slid left, not padded
    expect(edge.sy).toBe(0);
  });

  it('says when to sit back or come closer, once the frame has to reach well past the camera or bring the singer up a lot', () => {
    expect(distanceNote(cropFactor(stageCrop(720, 960, { x: 0.4, y: 0.1, w: 0.2, h: 0.22 }), 960))).toBeNull(); // the standard: nothing to say
    expect(distanceNote(cropFactor(stageCrop(720, 960, { x: 0.2, y: 0.05, w: 0.6, h: 0.5 }), 960))).toBe('close');
    expect(distanceNote(cropFactor(stageCrop(720, 960, { x: 0.47, y: 0.4, w: 0.05, h: 0.07 }), 960))).toBe('far');
    expect(distanceNote(1.1)).toBeNull();
  });

  it('the part of a padded crop the camera saw lands where it belongs in the frame', () => {
    const c = stageCrop(720, 960, { x: 0.2, y: 0.05, w: 0.6, h: 0.5 });
    const v = visiblePart(c, 720, 960)!;
    expect([v.sx, v.sy, v.sw, v.sh]).toEqual([0, 0, 720, 960]); // the whole camera picture
    const k = 720 / c.sw;
    expect(v.dw).toBeCloseTo(720 * k, 5); // smaller in the frame: brought back
    expect(v.dx).toBeCloseTo(-c.sx * k, 5);
    expect(v.dx + v.dw / 2).toBeCloseTo(360, 3); // centred
    expect(visiblePart({ sx: 800, sy: 0, sw: 100, sh: 100, dx: 0, dy: 0, dw: 100, dh: 100 }, 720, 960)).toBeNull();
    const inside = frameRect(480, 640, 1);
    expect(visiblePart(inside, 480, 640)).toEqual(inside); // a crop inside the frame is itself
  });

  it('the whole camera frame until a person is found; the camera picture is centre-cropped to the cut-out, never stretched', () => {
    const wide = frameRect(480, 640, 1);
    expect([wide.sx, wide.sy, wide.sw, wide.sh]).toEqual([0, 0, 480, 640]);
    expect(frameRect(480, 640, 0.5).sw).toBe(480); // never wider than the camera sees by itself
    const web = coverRect(1280, 720, 480, 640);
    expect(web.sh).toBe(720);
    expect(web.sw).toBeCloseTo(540, 5);
    expect(web.sx).toBeCloseTo(370, 5);
    const phone = coverRect(720, 1280, 480, 640);
    expect(phone.sw).toBe(720);
    expect(phone.sh).toBeCloseTo(960, 5);
    expect(phone.sy).toBeCloseTo(160, 5);
    expect(coverRect(480, 640, 480, 640)).toEqual({ sx: 0, sy: 0, sw: 480, sh: 640 });
  });
});
