import { describe, expect, it } from 'vitest';
import { boxOfMask, CHEST, chestCrop, FRAMING, frameRect, framingAt, presetLevel, type PersonBox } from '../src/video/framing.ts';

describe('stage framing', () => {
  it('wide shows the whole frame; close crops in around the face — the crop always fills the frame sent', () => {
    const wide = frameRect(480, 640, presetLevel('wide'));
    expect([wide.sx, wide.sy, wide.sw, wide.sh]).toEqual([0, 0, 480, 640]); // no crop
    expect([wide.dx, wide.dy, wide.dw, wide.dh]).toEqual([0, 0, 480, 640]); // full resolution out
    const close = frameRect(480, 640, presetLevel('close'));
    expect(close.sw).toBeCloseTo(480 / FRAMING.close.crop, 5);
    expect(close.sh).toBeCloseTo(640 / FRAMING.close.crop, 5);
    expect([close.dx, close.dy, close.dw, close.dh]).toEqual([0, 0, 480, 640]); // nobody stands small in their own frame
  });
  it('crops around the face origin and clamps to the frame', () => {
    const r = frameRect(480, 640, 1, { x: 90, y: 10 });
    expect(r.sx + r.sw).toBeLessThanOrEqual(480);
    expect(r.sy).toBe(0);
    const l = frameRect(480, 640, 1, { x: 5, y: 95 });
    expect(l.sx).toBe(0);
    expect(l.sy + l.sh).toBeLessThanOrEqual(640);
  });
  it('interpolates smoothly between wide and close', () => {
    const mid = framingAt(0.5);
    expect(mid.crop).toBeGreaterThan(FRAMING.wide.crop);
    expect(mid.crop).toBeLessThan(FRAMING.close.crop);
    expect(framingAt(-1)).toEqual(framingAt(0));
    expect(framingAt(2)).toEqual(framingAt(1));
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
