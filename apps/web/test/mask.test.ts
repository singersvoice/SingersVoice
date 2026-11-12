import { describe, expect, it } from 'vitest';
import { alphaFromMaskPixels } from '../src/video/segmenter.ts';

/** A w×h mask with a centred "person" blob; `where` says which channel carries the probability. */
function mask(w: number, h: number, where: 'alpha' | 'luma' | 'flat'): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dx = (x - w / 2) / (w * 0.22);
      const dy = (y - h / 2) / (h * 0.35);
      const p = Math.max(0, Math.min(1, 1.4 - Math.sqrt(dx * dx + dy * dy))); // 1 inside, fading out
      const v = Math.round(p * 255);
      if (where === 'alpha') {
        d[i] = d[i + 1] = d[i + 2] = 0;
        d[i + 3] = v;
      } else if (where === 'luma') {
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255; // the "white rectangle" case: alpha is opaque everywhere
      } else {
        d[i] = d[i + 1] = d[i + 2] = 200;
        d[i + 3] = 255;
      }
    }
  return d;
}

const stats = (d: Uint8ClampedArray, w: number, h: number) => {
  const a = (x: number, y: number) => d[(y * w + x) * 4 + 3]!;
  return { centre: a(w >> 1, h >> 1), corner: a(2, 2), edge: a(w >> 1, 3) };
};

describe('adaptive person mask (ported from the original SingersVoice app)', () => {
  it('uses the alpha channel when the model answers with alpha', () => {
    const d = mask(240, 320, 'alpha');
    const r = alphaFromMaskPixels(d);
    expect(r.mode).toBe('adaptive-alpha');
    const s = stats(d, 240, 320);
    expect(s.centre).toBe(255);
    expect(s.corner).toBe(0);
    expect(r.coverage).toBeGreaterThan(0.1);
    expect(r.coverage).toBeLessThan(0.9);
  });

  it('uses brightness when alpha is fully opaque (the case that showed a white rectangle)', () => {
    const d = mask(240, 320, 'luma');
    const r = alphaFromMaskPixels(d);
    expect(r.mode).toBe('adaptive-luma');
    const s = stats(d, 240, 320);
    expect(s.centre).toBe(255);
    expect(s.corner).toBe(0); // the real background is gone
    expect(s.edge).toBe(0);
    // RGB is white so compositing over black gives grey = alpha for the packed stream
    expect(d[0]).toBe(255);
    expect(d[1]).toBe(255);
    expect(d[2]).toBe(255);
  });

  it('reports an unusable mask only when it carries no information; nobody in frame is a valid, empty mask', () => {
    expect(alphaFromMaskPixels(mask(240, 320, 'flat')).mode).toBe('unusable');
    const d = mask(240, 320, 'alpha');
    for (let i = 3; i < d.length; i += 4) d[i] = i % 4000 === 3 ? 255 : 0; // a few stray pixels
    const r = alphaFromMaskPixels(d);
    expect(r.mode).toBe('adaptive-alpha');
    expect(r.coverage).toBeLessThan(0.01); // the stage spot stays empty — never the real background
  });
});
