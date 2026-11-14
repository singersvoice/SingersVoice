import { describe, expect, it } from 'vitest';
import { boxOfMask, CHEST, chestCrop, fixedCrop, FRAMING, frameRect, presetCrop, SING_TIGHTEN, type PersonBox } from '../src/video/framing.ts';
import { coverRect } from '../src/video/segmenter.ts';

describe('stage framing', () => {
  it('wide shows the whole frame; mid and close are real zooms (1.5×, 2.2×) — the crop always fills the frame sent', () => {
    const wide = frameRect(480, 640, presetCrop('wide'));
    expect([wide.sx, wide.sy, wide.sw, wide.sh]).toEqual([0, 0, 480, 640]); // no crop
    expect([wide.dx, wide.dy, wide.dw, wide.dh]).toEqual([0, 0, 480, 640]); // full resolution out
    expect(FRAMING.mid.crop).toBe(1.5);
    expect(FRAMING.close.crop).toBe(2.2);
    const close = frameRect(480, 640, presetCrop('close'));
    expect(close.sw).toBeCloseTo(480 / 2.2, 5);
    expect(close.sh).toBeCloseTo(640 / 2.2, 5);
    expect([close.dx, close.dy, close.dw, close.dh]).toEqual([0, 0, 480, 640]); // nobody stands small in their own frame
  });
  it('crops around the face origin and clamps to the frame', () => {
    const r = frameRect(480, 640, 2.2, { x: 90, y: 10 });
    expect(r.sx + r.sw).toBeLessThanOrEqual(480);
    expect(r.sy).toBe(0);
    const l = frameRect(480, 640, 2.2, { x: 5, y: 95 });
    expect(l.sx).toBe(0);
    expect(l.sy + l.sh).toBeLessThanOrEqual(640);
    expect(frameRect(480, 640, 0.5).sw).toBe(480); // never wider than the camera sees
  });
  it('Auto tightens the chosen framing a fifth while singing — it never turns Wide into Close', () => {
    expect(presetCrop('wide', 1)).toBeCloseTo(1 * (1 + SING_TIGHTEN), 6);
    expect(presetCrop('mid', 1)).toBeCloseTo(1.5 * (1 + SING_TIGHTEN), 6);
    expect(presetCrop('close', 0.5)).toBeCloseTo(2.2 * (1 + SING_TIGHTEN / 2), 6);
    expect(presetCrop('wide', 1)).toBeLessThan(presetCrop('mid', 0));
    expect(presetCrop('close', 2)).toBe(presetCrop('close', 1));
  });
  it('mid and close aim at the singer: centred on the body with the head a tenth down, wherever they sit', () => {
    const person: PersonBox = { x: 0.6, y: 0.3, w: 0.2, h: 0.6 }; // standing right of centre, head 30 % down
    const r = fixedCrop(480, 640, 2.2, person);
    expect(r.sw).toBeCloseTo(480 / 2.2, 5);
    expect(r.sx + r.sw / 2).toBeCloseTo(0.7 * 480, 3); // on the body
    expect(r.sy).toBeCloseTo(0.3 * 640 - r.sh * CHEST.headroom, 3); // the head a tenth down
    const edge = fixedCrop(480, 640, 2.2, { x: 0.9, y: 0.02, w: 0.1, h: 0.5 });
    expect(edge.sx + edge.sw).toBeLessThanOrEqual(480 + 0.01); // never past the frame
    expect(edge.sy).toBe(0);
    expect(fixedCrop(480, 640, 1.5, null, { x: 50, y: 42 })).toEqual(frameRect(480, 640, 1.5, { x: 50, y: 42 })); // nobody found: around the origin
  });
  it('the camera picture is centre-cropped to the cut-out, never stretched: a 16:9 webcam loses its sides, a 9:16 phone its top and bottom', () => {
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

describe('chest framing — the default: head to chest, from wherever the singer sits', () => {
  const grey = (w: number, h: number, person: (x: number, y: number) => boolean) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[(y * w + x) * 4] = person(x, y) ? 255 : 0;
    return d;
  };

  it('finds the person in a mask: head top to the bottom of the body, the body width, not a stretched arm', () => {
    // A figure 20 wide standing in the middle of a 96×128 mask, one arm out to the side for a few rows.
    const box = boxOfMask(grey(96, 128, (x, y) => (y >= 30 && y < 120 && x >= 38 && x < 58) || (y >= 60 && y < 64 && x >= 58 && x < 90)), 96, 128)!;
    expect(box).not.toBeNull();
    expect(box.y * 128).toBeCloseTo(29, 0); // the head top (a pixel of margin)
    expect(box.w * 96).toBeCloseTo(22, 0); // the body (20 + margin), not the arm
    expect(box.x + box.w / 2).toBeCloseTo(0.5, 2);
    expect(boxOfMask(grey(96, 128, () => false), 96, 128)).toBeNull();
  });

  it('a singer sitting back is brought up to head-and-chest: the crop is 1.35 bodies wide with the head a tenth down', () => {
    const far: PersonBox = { x: 0.44, y: 0.3, w: 0.12, h: 0.55 }; // small, standing in the middle of a 720×960 frame
    const r = chestCrop(720, 960, far);
    expect(r.sw / r.sh).toBeCloseTo(0.75, 5); // the frame's own proportions
    expect(r.sh).toBeGreaterThanOrEqual(960 * CHEST.minCrop - 0.01); // never tighter than a third of the frame
    expect(r.sw).toBeLessThan(720 * 0.5); // a third of the frame: the figure now fills a good part of it
    expect(r.sx + r.sw / 2).toBeCloseTo(0.5 * 720, 0); // centred on the body
    // the head sits a tenth down from the top of the crop (or the crop top is the frame top)
    expect(r.sy).toBeCloseTo(Math.max(0, 0.3 * 960 - r.sh * CHEST.headroom), 3);
    expect(r.dw).toBe(720); // the crop fills the frame that goes out
  });

  it('a singer already close gets the whole frame — the camera cannot zoom out', () => {
    const close: PersonBox = { x: 0.1, y: 0.05, w: 0.8, h: 0.95 };
    const r = chestCrop(720, 960, close);
    expect(r.sw).toBe(720);
    expect(r.sh).toBe(960);
    expect(r.sx).toBe(0);
    expect(r.sy).toBe(0);
  });

  it('singing tightens the chest framing by up to a fifth, and the crop stays inside the frame', () => {
    const mid: PersonBox = { x: 0.3, y: 0.2, w: 0.4, h: 0.8 };
    const still = chestCrop(720, 960, mid, 0);
    const singing = chestCrop(720, 960, mid, 1);
    expect(singing.sw).toBeCloseTo(still.sw * (1 - CHEST.singTighten), 3);
    for (const r of [still, singing]) {
      expect(r.sx).toBeGreaterThanOrEqual(0);
      expect(r.sy).toBeGreaterThanOrEqual(0);
      expect(r.sx + r.sw).toBeLessThanOrEqual(720 + 0.01);
      expect(r.sy + r.sh).toBeLessThanOrEqual(960 + 0.01);
    }
    // a singer at the edge of the frame: the crop slides, never leaves the frame
    const edge = chestCrop(720, 960, { x: 0.85, y: 0.4, w: 0.15, h: 0.6 });
    expect(edge.sx + edge.sw).toBeLessThanOrEqual(720 + 0.01);
  });
});
