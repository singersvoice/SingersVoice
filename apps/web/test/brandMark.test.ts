/**
 * The brand on every recording (video/brandMark.ts): the show recorder draws the animated mark — the
 * app's own small loop — in the top-right corner of every frame, a rounded tile an eighth of the
 * picture tall, so the saved performance, the film of a meet and the broadcast all carry it; the
 * loop is drawn once it plays, and a frame before it is ready carries no half-made tile.
 */
import { describe, expect, it } from 'vitest';
import { fakeDom } from './helpers/fakeDom.ts';

const dom = fakeDom();
const { BrandMark, MARK_ALPHA, markPlace } = await import('../src/video/brandMark.ts');
const { ShowRecorder } = await import('../src/video/showRecorder.ts');

describe('the brand mark on the picture', () => {
  it('sits in the top-right corner, an eighth of the height, 16:9, with rounded corners', () => {
    expect(markPlace(1280, 720)).toEqual({ x: 1111, y: 16, w: 153, h: 86, r: 12 });
    expect(markPlace(1920, 1080)).toEqual({ x: 1665, y: 24, w: 231, h: 130, r: 18 });
    expect(MARK_ALPHA).toBeGreaterThan(0.6);
    expect(MARK_ALPHA).toBeLessThan(0.9);
  });

  it('is drawn on every frame the show recorder makes: the loop inside rounded corners, faint, with a shadow', () => {
    const show = new ShowRecorder();
    show.startDrawing();
    show.stopDrawing();
    expect(show.mark.drawn).toBe(1);
    const picture = dom.current.contexts.find((c) => c.calls.includes('drawImage(3)'))!;
    expect(picture).toBeDefined();
    const video = dom.current.video;
    expect(video.muted).toBe(true);
    const tile = dom.current.contexts.at(-1)!;
    expect(tile.calls).toEqual(['clearRect(4)', 'save(0)', 'beginPath(0)', 'moveTo(2)', 'arcTo(5)', 'arcTo(5)', 'arcTo(5)', 'arcTo(5)', 'closePath(0)', 'clip(0)', 'drawImage(5)', 'restore(0)']);
    // The picture: the stage (the compositor's canvas, scaled) and then the tile at its corner.
    const draws = picture.calls.filter((c) => c.startsWith('drawImage'));
    expect(draws.slice(-2)).toEqual(['drawImage(5)', 'drawImage(3)']);
    expect(picture.globalAlpha).toBe(MARK_ALPHA);
    expect(picture.shadowBlur).toBe(22);
    show.dispose();
  });

  it('draws nothing until the loop (or its still) can be drawn — never a blank tile', () => {
    dom.current.video.readyState = 0;
    const mark = new BrandMark();
    const c = dom.current.contexts[0] ?? (document.createElement('canvas').getContext('2d') as unknown as (typeof dom.current.contexts)[number]);
    mark.draw(c as unknown as CanvasRenderingContext2D, 1280, 720);
    expect(mark.drawn).toBe(0);
    dom.current.video.readyState = 4;
    mark.draw(c as unknown as CanvasRenderingContext2D, 1280, 720);
    expect(mark.drawn).toBe(1);
    mark.dispose();
  });
});
