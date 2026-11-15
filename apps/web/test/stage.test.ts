import { describe, expect, it } from 'vitest';
import { ARC_LIFT, arcLift, fitPerson, floorAt, HEADROOM, layoutStage, RISER_COVER, riserBand, riserTop, type StageTile } from '../src/video/stage.ts';

describe('virtual stage layout — one row of equal slots on a shallow arc, like a row of chairs', () => {
  it('spreads N performers evenly, 3:4 slots of one size, each on the row\'s floor behind the riser', () => {
    const tiles = layoutStage(1200, 800, 3);
    expect(tiles).toHaveLength(3);
    const centres = tiles.map((t) => t.x + t.w / 2);
    expect(centres.map((c) => Math.round(c))).toEqual([200, 600, 1000]);
    const band = riserBand(800, tiles[0]!.h, 'stage');
    expect(band).toBeCloseTo(800 * 0.09, 5); // performer mode: a slim riser under the lyrics
    for (const t of tiles) {
      expect(t.w / t.h).toBeCloseTo(0.75, 2);
      expect(t.w).toBeCloseTo(tiles[0]!.w, 6); // one size
      expect(t.h).toBeCloseTo(tiles[0]!.h, 6);
      const cx = t.x + t.w / 2;
      expect(t.y + t.h).toBeCloseTo(riserTop(1200, 800, cx, t.h, 'stage') + t.h * RISER_COVER, 5); // the lower 40 % behind the riser (and below the picture)
      expect(t.y + t.h * (1 - RISER_COVER)).toBeLessThanOrEqual(800 - band + 0.01); // head and shoulders above the riser's edge
    }
  });

  it('the row curves: the middle slot nearest (lowest), the ends up the picture by the arc lift — the same size all along', () => {
    const row = layoutStage(1920, 1080, 5, 'show');
    const floors = row.map((t) => t.y + t.h);
    const h = row[0]!.h;
    expect(floors[2]).toBeCloseTo(floorAt(1920, 1080, 960, h, 'show'), 5);
    expect(floors[2]).toBeCloseTo(1080 - riserBand(1080, h, 'show') + h * RISER_COVER, 5); // the middle: no lift
    expect(floors[0]).toBeLessThan(floors[1]!);
    expect(floors[1]).toBeLessThan(floors[2]!);
    expect(floors[0]).toBeCloseTo(floors[4]!, 5); // symmetric
    expect(floors[2]! - floors[0]!).toBeLessThan(1080 * ARC_LIFT.show); // the end slot's centre is inside the ends of the arc
    expect(floors[2]! - floors[0]!).toBeGreaterThan(1080 * ARC_LIFT.show * 0.5);
    for (const t of row) expect(t.h).toBeCloseTo(h, 6);
    expect(arcLift(1920, 1080, 1920, 'show')).toBeCloseTo(1080 * ARC_LIFT.show, 5); // the very edge: the full lift
    expect(arcLift(1920, 1080, 960, 'show')).toBe(0);
  });

  it('show mode: the heads start near the top with one or two singers; a crowd of ten sits lower rather than behind a wall', () => {
    const [duo] = layoutStage(1920, 1080, 2, 'show') as [StageTile];
    expect(duo.y).toBeCloseTo(1080 * 0.08 - arcLift(1920, 1080, duo.x + duo.w / 2, 'show'), 3); // the slot (the head a little into it) from near the top, lifted a little on the arc
    expect(riserBand(1080, duo.h, 'show')).toBeCloseTo(1080 - 1080 * 0.08 - duo.h * (1 - RISER_COVER), 5); // the riser takes the rest
    const ten = layoutStage(1920, 1080, 10, 'show');
    expect(riserBand(1080, ten[0]!.h, 'show')).toBeCloseTo(1080 * 0.4, 5); // capped: a riser, not a wall
    expect(ten[4]!.y).toBeGreaterThan(1080 * 0.3); // so the small slots sit lower
    expect(riserBand(1080, 10, 'show')).toBeCloseTo(1080 * 0.4, 5);
    expect(riserBand(1080, 10_000, 'show')).toBeCloseTo(1080 * 0.09, 5); // never slimmer than the names need
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

  it('show mode: ten singers make one even row of slots of one size', () => {
    const row = layoutStage(1920, 1080, 10, 'show');
    expect(row).toHaveLength(10);
    const centres = row.map((t) => t.x + t.w / 2);
    for (let i = 0; i < 10; i++) expect(centres[i]).toBeCloseTo(96 + 192 * i, 5); // evenly spanned
    for (const t of row) {
      expect(t.h).toBeCloseTo(row[0]!.h, 5); // all the same size
      expect(t.w).toBeCloseTo(row[0]!.w, 5);
      expect(t.w).toBeCloseTo(192 * 0.94, 3); // shoulder to shoulder across the stage
    }
  });

  it('the riser hides the lower part of every slot — the same share of each, following the arc', () => {
    const row = layoutStage(1920, 1080, 3, 'show');
    for (const t of row) {
      const cx = t.x + t.w / 2;
      const top = riserTop(1920, 1080, cx, t.h, 'show');
      expect(top).toBeCloseTo(t.y + t.h * (1 - RISER_COVER), 5); // 40 % of the slot behind the riser
      expect(top).toBeGreaterThan(t.y + t.h * 0.5); // head and shoulders above it
      expect(top).toBeLessThan(1080); // the riser's edge is in the picture
    }
    expect(riserTop(1920, 1080, 0, row[0]!.h, 'show')).toBeLessThan(riserTop(1920, 1080, 960, row[0]!.h, 'show')); // up at the ends
  });
});

describe('fitting a frame into its slot — the stage frame, drawn whole, everywhere', () => {
  const [solo] = layoutStage(1600, 900, 1, 'show') as [StageTile];

  it('show mode: the whole frame, bigger than the picture is tall, its bottom edge on the slot\'s floor below the riser', () => {
    const fit = fitPerson(solo, 720, 960, 'show', 900);
    expect(fit.w / fit.h).toBeCloseTo(720 / 960, 5); // the frame as the singer's device framed it
    expect(fit.y + fit.h).toBeCloseTo(solo.y + solo.h, 3); // on the slot's floor (below the picture: the riser hides that part)
    expect(fit.y).toBeCloseTo(solo.y + solo.h * HEADROOM, 3); // the headroom, then the frame as tall as the slot allows
    expect(fit.h / 900).toBeGreaterThan(1); // taller than the picture: the singer stands big
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
    expect(small.y + small.h).toBeCloseTo(stageTile.y + stageTile.h, 3);
    expect(big.y + big.h).toBeCloseTo(showTile.y + showTile.h, 3);
    // and nothing in the frame is zoomed: the scale is the frame's, whatever is in it
    expect(big.scale).toBeCloseTo(big.h / 960, 6);
  });

  it('ten singers: one even row, every frame as wide as its slot, all the same size — a phone\'s frame as big as a computer\'s', () => {
    const row = layoutStage(1920, 1080, 10, 'show');
    const fits = row.map((t, i) => (i % 2 ? fitPerson(t, 480, 640, 'show', 1080) : fitPerson(t, 720, 960, 'show', 1080)));
    for (const [i, f] of fits.entries()) {
      expect(f.w).toBeCloseTo(fits[0]!.w, 3); // the same drawn size whatever the frame's pixels
      expect(f.h).toBeCloseTo(fits[0]!.h, 3);
      expect(f.h).toBeCloseTo(row[i]!.h * (1 - HEADROOM), 3); // as tall as the slot under its headroom: shoulder to shoulder across the stage
      expect(f.w).toBeLessThanOrEqual(row[i]!.w + 0.01);
      expect(f.w / f.h).toBeCloseTo(0.75, 5);
      expect(f.x).toBeGreaterThanOrEqual(row[i]!.x - 0.01);
      expect(f.x + f.w).toBeLessThanOrEqual(row[i]!.x + row[i]!.w + 0.01);
      expect(f.y + f.h).toBeCloseTo(row[i]!.y + row[i]!.h, 3); // on the slot's floor, along the arc
    }
  });

  it('a frame that arrived tiny (a weak link) is not blown up into a blur', () => {
    const fit = fitPerson(solo, 90, 120, 'show', 900);
    expect(fit.scale).toBeLessThanOrEqual(4.5 * (900 / 720) + 1e-9);
    expect(fit.w / fit.h).toBeCloseTo(0.75, 5);
    const usual = fitPerson(solo, 320, 426, 'show', 900); // the packed stream's size is never capped
    expect(usual.h).toBeGreaterThan(solo.h * 0.9);
  });

  it('performer mode (lyrics above) draws the whole frame small in the lower slot — no zoom', () => {
    const [t] = layoutStage(1280, 720, 1) as [StageTile];
    expect(t.h / 720).toBeLessThanOrEqual(0.5); // the lyrics own the top half and more
    expect(t.y / 720).toBeGreaterThan(0.6); // the slot sits in the lower part
    const fit = fitPerson(t, 480, 640, 'stage', 720);
    expect(fit.w / fit.h).toBeCloseTo(480 / 640, 5); // the frame as the singer's device framed it
    expect(fit.h).toBeLessThanOrEqual(t.h + 0.01);
    expect(fit.y + fit.h).toBeCloseTo(t.y + t.h, 3); // on the slot's floor
  });
});
