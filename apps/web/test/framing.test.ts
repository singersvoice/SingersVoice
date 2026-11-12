import { describe, expect, it } from 'vitest';
import { FRAMING, frameRect, framingAt, presetLevel } from '../src/video/framing.ts';

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
