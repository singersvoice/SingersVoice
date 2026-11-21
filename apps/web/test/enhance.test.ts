/**
 * Picture quality (video/enhance.ts): the lift a dim picture gets (and none a bright one), measured on the
 * person alone and glided to; the packed frame's size and how a singer's link scales it; which frames the
 * receiver upscales.
 */
import { describe, expect, it } from 'vitest';
import { cameraSize, EXPOSURE_MAX_GAIN, EXPOSURE_TARGET, Exposure, exposureGain, PACK_HEIGHT, PACK_WIDTH, packSize, personLuma, showBitrate, showSize, SINGER_LINK_WIDTH, singerLinkScale, upscaleFor } from '../src/video/enhance.ts';

/** An RGBA sample of `n` pixels of one colour at one alpha. */
const pixels = (n: number, rgb: [number, number, number], alpha = 255): number[] => Array.from({ length: n }, () => [...rgb, alpha]).flat();

describe('the lift at the source', () => {
  it('a dim face is brightened towards the target, never past the ceiling; a bright one is left alone; nobody measured is no lift', () => {
    expect(exposureGain(0.2)).toBe(EXPOSURE_MAX_GAIN); // 0.5 / 0.2 would be 2.5: capped
    expect(exposureGain(0.4)).toBeCloseTo(EXPOSURE_TARGET / 0.4, 5);
    expect(exposureGain(0.5)).toBe(1);
    expect(exposureGain(0.8)).toBe(1);
    expect(exposureGain(0)).toBe(EXPOSURE_MAX_GAIN); // black is not divided by
    expect(exposureGain(null)).toBe(1);
    expect(exposureGain(Number.NaN)).toBe(1);
  });

  it('the person is measured by their mask alone — the brighter quarter of them, or of the head where it was found; the room behind them counts for nothing; too few pixels is nobody', () => {
    const skin: [number, number, number] = [141, 85, 36]; // 0.299·141 + 0.587·85 + 0.114·36 ≈ 96 → 0.377
    expect(personLuma(pixels(100, skin), 10, 10)).toBeCloseTo(0.377, 2);
    // Half the sample is a bright wall at alpha 0: ignored.
    expect(personLuma([...pixels(50, skin), ...pixels(50, [255, 255, 255], 0)], 10, 10)).toBeCloseTo(0.377, 2);
    // A dark shirt under the face: the brighter quarter is the face, so a lit face in dark clothes asks for nothing.
    const faceOverShirt = [...pixels(30, skin), ...pixels(70, [20, 20, 20])]; // rows 0–2 the face, rows 3–9 the shirt
    expect(personLuma(faceOverShirt, 10, 10)).toBeCloseTo(0.377, 2);
    // The head box, when there is one, is what is measured — even where the shirt is white.
    const faceOverWhite = [...pixels(30, skin), ...pixels(70, [250, 250, 250])];
    expect(personLuma(faceOverWhite, 10, 10)).toBeGreaterThan(0.9); // without a box: the shirt is the brighter part
    expect(personLuma(faceOverWhite, 10, 10, { x: 0, y: 0, w: 1, h: 0.3 }, 20)).toBeCloseTo(0.377, 2); // with the head box: the face
    expect(personLuma(faceOverWhite, 10, 10, { x: 0, y: 0, w: 0.1, h: 0.1 }, 20)).toBeGreaterThan(0.9); // a box too small to measure: the whole person
    expect(personLuma(pixels(10, skin), 10, 1)).toBeNull();
    expect(personLuma(pixels(100, skin, 20), 10, 10)).toBeNull(); // nearly transparent everywhere: nobody
  });

  it('the gain glides to each new measurement and says itself as a canvas filter — the polish alone when there is nothing to lift', () => {
    const e = new Exposure();
    expect(e.gain).toBe(1);
    expect(e.filter()).toBe('contrast(1.05) saturate(1.08)');
    e.sample(0.3); // target 1.5
    const first = e.step();
    expect(first).toBeGreaterThan(1);
    expect(first).toBeLessThan(1.5);
    for (let i = 0; i < 60; i++) e.step();
    expect(e.gain).toBe(1.5);
    expect(e.lift).toBe(50);
    expect(e.filter()).toBe('brightness(1.500) contrast(1.05) saturate(1.08)');
    e.sample(0.7); // bright now: the lift eases back to none, never a jump
    const down = e.step();
    expect(down).toBeLessThan(1.5);
    expect(down).toBeGreaterThan(1.3);
    for (let i = 0; i < 60; i++) e.step();
    expect(e.gain).toBe(1);
    expect(e.lift).toBe(0);
    e.sample(null); // nobody there: nothing to lift
    e.step();
    expect(e.filter()).toBe('contrast(1.05) saturate(1.08)');
  });
});

describe('the packed frame and the links', () => {
  it('goes out 3:4 at the size this device can afford — a computer 720 (the cut-out itself, 1:1), a phone 480, a weak device the 320 it always sent; a singer link scales it to the old width, half as much again on a crowded stage; a publisher link gets it whole', () => {
    expect(PACK_WIDTH / PACK_HEIGHT).toBeCloseTo(0.75, 1);
    expect([320, 480, 720]).toContain(PACK_WIDTH);
    expect(packSize(true, false)).toEqual({ width: 720, height: 960 });
    expect(packSize(false, false)).toEqual({ width: 480, height: 640 });
    expect(packSize(false, true)).toEqual({ width: 320, height: 426 });
    expect(packSize(true, true)).toEqual({ width: 320, height: 426 }); // (a computer with two cores is a weak one)
    expect(singerLinkScale(2, 720)).toBe(2.25); // 720 → 320
    expect(singerLinkScale(2, 480)).toBe(1.5); // 480 → 320
    expect(singerLinkScale(7, 720)).toBe(3.375);
    expect(singerLinkScale(1, SINGER_LINK_WIDTH)).toBe(1); // an older build's frame is not scaled below itself
    expect(singerLinkScale(1, 200)).toBe(1);
  });

  it('a frame that arrives small is upscaled twice over by the receiver; a full-size one is drawn as it is', () => {
    expect(upscaleFor(320)).toBe(2);
    expect(upscaleFor(400)).toBe(2);
    expect(upscaleFor(480)).toBe(1);
    expect(upscaleFor(720)).toBe(1);
  });

  it('the camera, the show and its bitrate follow the device: 1080p30 at 8 Mbps on a computer, 720p24 at 4.5 on a phone', () => {
    expect(cameraSize(true)).toEqual({ width: 1920, height: 1080 });
    expect(cameraSize(false)).toEqual({ width: 1280, height: 720 });
    expect(showSize(true, true)).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(showSize(true, false)).toEqual({ width: 1280, height: 720, fps: 24 }); // a computer without a hardware encoder: the software one keeps to 720p
    expect(showSize(false, true)).toEqual({ width: 1280, height: 720, fps: 24 });
    expect(showBitrate(1920, 1080)).toBe(8_000_000);
    expect(showBitrate(1280, 720)).toBe(4_500_000);
    expect(showBitrate(960, 540)).toBe(4_500_000);
    expect(showBitrate(1600, 900)).toBeGreaterThan(4_500_000);
    expect(showBitrate(1600, 900)).toBeLessThan(8_000_000);
  });
});
