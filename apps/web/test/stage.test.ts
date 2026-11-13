import { describe, expect, it } from 'vitest';
import { fitPerson, layoutStage, type StageTile } from '../src/video/stage.ts';

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

  it('show mode: ten singers make one even row of full-height slots', () => {
    const row = layoutStage(1920, 1080, 10, 'show');
    expect(row).toHaveLength(10);
    const centres = row.map((t) => t.x + t.w / 2);
    for (let i = 0; i < 10; i++) expect(centres[i]).toBeCloseTo(96 + 192 * i, 5); // evenly spanned
    for (const t of row) {
      expect(t.h).toBeCloseTo(row[0]!.h, 5); // all the same height — the whole frame
      expect(t.h / 1080).toBeGreaterThan(0.9);
      expect(t.y + t.h).toBeCloseTo(row[0]!.y + row[0]!.h, 5); // one floor line
    }
  });
});

describe('fitting a frame into its slot — the singer\'s own framing, everywhere', () => {
  const [solo] = layoutStage(1600, 900, 1, 'show') as [StageTile];

  it('show mode: the whole frame, as tall as the picture allows, its bottom edge on the picture\'s bottom edge', () => {
    const fit = fitPerson(solo, 720, 960, 'show', 900);
    expect(fit.w / fit.h).toBeCloseTo(720 / 960, 5); // the frame as the singer\'s own camera framed it
    expect(fit.y + fit.h).toBeCloseTo(900, 3); // the camera\'s cut edge on the picture\'s bottom edge like a TV shot
    expect(fit.y).toBeGreaterThan(solo.y); // headroom
    expect(fit.y).toBeLessThan(solo.y + solo.h * 0.05);
    expect(fit.h / 900).toBeGreaterThan(0.85); // as tall as the picture
    expect(fit.w).toBeLessThanOrEqual(solo.w); // never wider than the slot
    expect(fit.x + fit.w / 2).toBeCloseTo(solo.x + solo.w / 2, 5); // centred
  });

  it('the same frame keeps the same proportions on the live stage (small, under the lyrics) and in the show (big)', () => {
    const [stageTile] = layoutStage(1280, 720, 1) as [StageTile];
    const [showTile] = layoutStage(1280, 720, 1, 'show') as [StageTile];
    const small = fitPerson(stageTile, 720, 960, 'stage', 720);
    const big = fitPerson(showTile, 720, 960, 'show', 720);
    expect(small.w / small.h).toBeCloseTo(big.w / big.h, 5); // what the singer sees is what the audience gets
    expect(big.h).toBeGreaterThan(small.h * 1.4); // only bigger
    expect(small.y + small.h).toBeCloseTo(720, 3);
    expect(big.y + big.h).toBeCloseTo(720, 3);
    // and nothing in the frame is zoomed: the scale is the frame\'s, whatever is in it
    expect(big.scale).toBeCloseTo(big.h / 960, 6);
  });

  it('ten singers: one even row, every frame as wide as its slot, all the same size', () => {
    const row = layoutStage(1920, 1080, 10, 'show');
    const fits = row.map((t) => fitPerson(t, 720, 960, 'show', 1080));
    for (const [i, f] of fits.entries()) {
      expect(f.scale).toBeCloseTo(fits[0]!.scale, 5);
      expect(f.w).toBeCloseTo(row[i]!.w * 0.94, 3); // width-limited: shoulder to shoulder across the stage
      expect(f.w / f.h).toBeCloseTo(0.75, 5);
      expect(f.x).toBeGreaterThanOrEqual(row[i]!.x - 0.01);
      expect(f.x + f.w).toBeLessThanOrEqual(row[i]!.x + row[i]!.w + 0.01);
      expect(f.y + f.h).toBeCloseTo(1080, 3); // one row on the bottom edge
    }
  });

  it('a frame that arrived small (a weak link) is not blown up into a blur', () => {
    const fit = fitPerson(solo, 180, 240, 'show', 900);
    expect(fit.scale).toBeLessThanOrEqual(2.5 * (900 / 720) + 1e-9);
    expect(fit.w / fit.h).toBeCloseTo(0.75, 5);
  });

  it('performer mode (lyrics above) draws the whole camera frame small in the lower tile — no zoom', () => {
    const [t] = layoutStage(1280, 720, 1) as [StageTile];
    expect(t.h / 720).toBeLessThan(0.5); // the lyrics own the top half and more
    const fit = fitPerson(t, 480, 640, 'stage', 720);
    expect(fit.w / fit.h).toBeCloseTo(480 / 640, 5); // the frame as the singer\'s own camera framed it
    expect(fit.h).toBeLessThanOrEqual(t.h + 720 * 0.015 + 0.01);
    expect(fit.y + fit.h).toBeCloseTo(720, 3); // the camera\'s cut edge on the bottom edge
  });
});
