/** The clip maker's sizes and names (lib/clip.ts); the recording itself runs in the browser (tools/ci/social-e2e.mjs). */
import { describe, expect, it } from 'vitest';
import { clipExt, clipMime, clipSize } from '../src/lib/clip.ts';

describe('a clip', () => {
  it('keeps the source size up to 1280 wide, even numbers, 720p when the size is unknown', () => {
    expect(clipSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(clipSize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(clipSize(720, 960)).toEqual({ width: 720, height: 960 });
    expect(clipSize(641, 481)).toEqual({ width: 642, height: 482 }); // rounded to even
    expect(clipSize(0, 0)).toEqual({ width: 1280, height: 720 });
    expect(clipSize(3840, 2160, 1920)).toEqual({ width: 1920, height: 1080 });
  });
  it('is named by its container', () => {
    expect(clipExt('video/mp4;codecs="avc1.42E01E,mp4a.40.2"')).toBe('mp4');
    expect(clipExt('video/webm;codecs=vp9,opus')).toBe('webm');
    expect(clipExt('')).toBe('webm');
  });
  it('writes nothing where there is no recorder (node)', () => {
    expect(clipMime()).toBe('');
  });
});
