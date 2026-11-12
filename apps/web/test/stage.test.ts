import { describe, expect, it } from 'vitest';
import { boxOfAlpha, fitPerson, layoutStage, levelHeads, type PersonBox, type StageTile } from '../src/video/stage.ts';

/** A webcam bust shot: head and shoulders in the middle of the frame, cut by the frame's bottom edge. */
const BUST: PersonBox = { x: 0.34, y: 0.33, w: 0.32, h: 0.67 };
/** A singer the camera sees whole, feet included, standing a little back. */
const WHOLE: PersonBox = { x: 0.4, y: 0.2, w: 0.2, h: 0.7 };

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

describe('fitting a person into their slot', () => {
  const [solo] = layoutStage(1600, 900, 1, 'show') as [StageTile];

  it('a bust shot fills the show picture top to bottom — the camera cut on the bottom edge', () => {
    const fit = fitPerson(solo, 320, 426, BUST, 'show', 900);
    expect(fit.cut).toBe(true);
    expect(fit.cropped).toBe(false);
    expect(fit.y + fit.h).toBeCloseTo(900, 3); // sits on the picture's bottom edge like a TV shot
    expect(fit.y).toBeGreaterThan(solo.y); // headroom
    expect(fit.y).toBeLessThan(solo.y + solo.h * 0.05);
    expect(fit.h / 900).toBeGreaterThan(0.9); // as tall as the picture
    expect(fit.w).toBeLessThanOrEqual(solo.w); // never wider than the slot
    expect(fit.x + fit.w / 2).toBeCloseTo(solo.x + solo.w / 2, 5); // centred
    // ~3× what the old "fit the whole frame" drawing gave this bust (0.67 of a 3:4 tile 864 px tall)
    expect(fit.h).toBeGreaterThan(0.67 * 864 * 1.4);
  });

  it('a singer seen whole stands on the floor line, with a shadow', () => {
    const fit = fitPerson(solo, 320, 426, WHOLE, 'show', 900);
    expect(fit.cut).toBe(false);
    expect(fit.y + fit.h).toBeCloseTo(solo.y + solo.h, 5);
    expect(fit.h).toBeLessThanOrEqual(solo.h);
  });

  it('ten singers: every slot filled to its width, all the same size for the same shot', () => {
    const row = layoutStage(1920, 1080, 10, 'show');
    const fits = row.map((t) => fitPerson(t, 320, 426, BUST, 'show', 1080));
    for (const [i, f] of fits.entries()) {
      expect(f.scale).toBeCloseTo(fits[0]!.scale, 5);
      expect(f.w).toBeCloseTo(row[i]!.w * 0.94, 3); // width-limited: shoulder to shoulder across the stage
      expect(f.x).toBeGreaterThanOrEqual(row[i]!.x - 0.01);
      expect(f.x + f.w).toBeLessThanOrEqual(row[i]!.x + row[i]!.w + 0.01);
      expect(f.y + f.h).toBeCloseTo(1080, 3); // the cut edge on the bottom edge, one row
    }
  });

  it('heads line up across the row: a singer seen whole never towers over the bust shots', () => {
    const row = layoutStage(1280, 720, 10, 'show'); // narrow slots: the busts are width-limited, the slim whole-body singer is not
    const shots: PersonBox[] = [BUST, WHOLE, BUST, BUST, BUST, BUST, BUST, BUST, BUST, BUST];
    const fits = row.map((t, i) => fitPerson(t, 320, 426, shots[i]!, 'show', 720));
    const whole = fits[1]!;
    expect(whole.y).toBeLessThan(fits[0]!.y - 200); // before: head far above the others
    const before = { ...whole };
    levelHeads(fits, 720 * 0.02);
    expect(whole.y).toBeCloseTo(fits[0]!.y, 5); // level with the bust shots' heads
    expect(whole.y + whole.h).toBeCloseTo(before.y + before.h, 5); // feet stayed on the floor
    expect(whole.x + whole.w / 2).toBeCloseTo(before.x + before.w / 2, 5); // still centred in the slot
    expect(whole.scale).toBeLessThan(before.scale);
    for (const [i, f] of fits.entries()) {
      if (i === 1) continue;
      expect(f.scale).toBeCloseTo(fits[0]!.scale, 5); // the busts untouched (same shot, same slot width)
      expect(f.y).toBeCloseTo(fits[0]!.y, 5);
    }
  });

  it('levelling leaves a duet alone (nobody is clearly above the other) and a solo untouched', () => {
    const [a, b] = layoutStage(1280, 720, 2, 'show');
    const fits = [fitPerson(a!, 320, 426, BUST, 'show', 720), fitPerson(b!, 320, 426, WHOLE, 'show', 720)];
    const copy = fits.map((f) => ({ ...f }));
    levelHeads(fits, 720 * 0.02);
    expect(fits).toEqual(copy);
    const solo = [fitPerson(layoutStage(1280, 720, 1, 'show')[0]!, 320, 426, WHOLE, 'show', 720)];
    const soloCopy = [{ ...solo[0]! }];
    levelHeads(solo, 720 * 0.02);
    expect(solo).toEqual(soloCopy);
  });

  it('stage mode (lyrics above) keeps the person inside the lower tile, never cropped', () => {
    const [t] = layoutStage(1280, 720, 1) as [StageTile];
    const fit = fitPerson(t, 480, 640, BUST, 'stage', 720);
    expect(fit.cropped).toBe(false);
    expect(fit.y).toBeGreaterThanOrEqual(t.y);
    expect(fit.h).toBeGreaterThan(t.h * 0.9); // but still as big as the tile allows
  });

  it('with nobody found yet the whole frame is fitted, as before', () => {
    const fit = fitPerson(solo, 320, 426, { x: 0, y: 0, w: 1, h: 1 }, 'show', 900);
    expect(fit.w / fit.h).toBeCloseTo(320 / 426, 5);
    expect(fit.y + fit.h).toBeCloseTo(900, 3);
  });
});

describe('finding the person in a cut-out', () => {
  const rgba = (w: number, h: number, opaque: (x: number, y: number) => boolean) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[(y * w + x) * 4 + 3] = opaque(x, y) ? 255 : 0;
    return d;
  };

  it('is the bounding box of the opaque pixels, with a pixel of margin', () => {
    const box = boxOfAlpha(rgba(100, 100, (x, y) => x >= 30 && x < 70 && y >= 40), 100, 100)!;
    expect(box.x).toBeCloseTo(0.29, 5);
    expect(box.w).toBeCloseTo(0.42, 5);
    expect(box.y).toBeCloseTo(0.39, 5);
    expect(box.y + box.h).toBeCloseTo(1, 5); // reaches the bottom edge: cut by the camera
  });

  it('an arm stretched out neither shrinks the person nor pulls them sideways', () => {
    const torso = (x: number, y: number) => x >= 30 && x < 70 && y >= 40;
    const arm = (x: number, y: number) => y >= 50 && y < 56 && x >= 10 && x < 95; // one long arm, mostly to the right
    const plain = boxOfAlpha(rgba(100, 100, torso), 100, 100)!;
    const waving = boxOfAlpha(rgba(100, 100, (x, y) => torso(x, y) || arm(x, y)), 100, 100)!;
    expect(waving.w).toBeCloseTo(plain.w, 5);
    expect(waving.x + waving.w / 2).toBeCloseTo(plain.x + plain.w / 2, 5);
    expect(waving.y).toBeCloseTo(plain.y, 5);
  });

  it('ignores an empty frame and a few stray pixels', () => {
    expect(boxOfAlpha(rgba(100, 100, () => false), 100, 100)).toBeNull();
    expect(boxOfAlpha(rgba(100, 100, (x, y) => x === 5 && y === 5), 100, 100)).toBeNull();
  });

  it('honours the alpha threshold (soft fringes count, codec noise does not)', () => {
    const d = rgba(10, 10, () => false);
    d[(5 * 10 + 5) * 4 + 3] = 30; // below the threshold
    expect(boxOfAlpha(d, 10, 10)).toBeNull();
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) d[(y * 10 + x) * 4 + 3] = 60;
    expect(boxOfAlpha(d, 10, 10)).not.toBeNull();
  });
});
