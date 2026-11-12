import { describe, expect, it } from 'vitest';
import { layoutStage } from '../src/video/stage.ts';

describe('virtual stage layout', () => {
  it('spreads N performers evenly, bottom-anchored, 3:4 tiles', () => {
    const tiles = layoutStage(1200, 800, 3);
    expect(tiles).toHaveLength(3);
    const centres = tiles.map((t) => t.x + t.w / 2);
    expect(centres.map((c) => Math.round(c))).toEqual([200, 600, 1000]);
    for (const t of tiles) {
      expect(t.w / t.h).toBeCloseTo(0.75, 2);
      expect(t.y + t.h).toBeLessThanOrEqual(800);
      expect(t.y + t.h).toBeGreaterThan(780); // standing on the floor
    }
  });

  it('user mode leaves the top of the frame to the lyrics; show mode fills it with the performers', () => {
    const stage = layoutStage(1600, 900, 2);
    const show = layoutStage(1600, 900, 2, 'show');
    expect(stage[0]!.h / 900).toBeLessThan(0.65);
    expect(show[0]!.h / 900).toBeGreaterThan(0.9);
    expect(show[0]!.h).toBeGreaterThan(stage[0]!.h * 1.4);
    // never wider than its slot, even with 10 on a phone
    const crowd = layoutStage(390, 844, 10, 'show');
    expect(crowd.every((t) => t.w <= 39 * 0.96 + 0.01)).toBe(true);
  });
});
