import { describe, expect, it } from 'vitest';
import { FRAMING, frameRect, framingAt, presetLevel } from '../src/video/framing.ts';

describe('stage framing', () => {
  it('wide shows the whole frame standing small; close crops in and fills the tile', () => {
    const wide = frameRect(480, 640, presetLevel('wide'));
    expect([wide.sx, wide.sy, wide.sw, wide.sh]).toEqual([0, 0, 480, 640]); // no crop
    expect(wide.dh / 640).toBeCloseTo(FRAMING.wide.scale, 5);
    expect(wide.dy + wide.dh).toBe(640); // feet on the floor
    expect(wide.dx).toBeCloseTo((480 - wide.dw) / 2, 5); // centred
    const close = frameRect(480, 640, presetLevel('close'));
    expect(close.sw).toBeCloseTo(480 / FRAMING.close.crop, 5);
    expect(close.dh).toBe(640);
    expect(close.dw).toBe(480);
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
