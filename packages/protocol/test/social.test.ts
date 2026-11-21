/** Social (social.ts): the clip's span kept within bounds, the caption, the networks' composers. */
import { describe, expect, it } from 'vitest';
import { CAPTION_MAX, CLIP_LIMITS, CLIP_MAX_SECONDS, clampClip, clipCaption, composerUrl, SOCIAL_NETWORKS, socialTitle } from '../src/social.ts';

describe('a clip', () => {
  it('is kept inside the performance, at least three seconds, at most the network allows', () => {
    expect(clampClip(1000, 6000, 20000)).toEqual({ fromMs: 1000, toMs: 6000 });
    expect(clampClip(6000, 1000, 20000)).toEqual({ fromMs: 1000, toMs: 6000 }); // the ends swapped
    expect(clampClip(5000, 5500, 20000)).toEqual({ fromMs: 5000, toMs: 8000 }); // too short: grown to three seconds
    expect(clampClip(19500, 19800, 20000)).toEqual({ fromMs: 17000, toMs: 20000 }); // at the end: grown backwards
    expect(clampClip(-5, 999_999, 20000)).toEqual({ fromMs: 0, toMs: 20000 });
    expect(clampClip(0, 200_000, 900_000, 140)).toEqual({ fromMs: 0, toMs: 140_000 }); // X's 140 s
    expect(clampClip(0, 900_000, 900_000)).toEqual({ fromMs: 0, toMs: CLIP_MAX_SECONDS * 1000 });
    expect(clampClip(0, 1000, 1000)).toEqual({ fromMs: 0, toMs: 1000 }); // a performance shorter than three seconds is all there is
    expect(clampClip(0.4, 5000.6, 20000)).toEqual({ fromMs: 0, toMs: 5001 });
  });
  it('has limits per network and a caption size', () => {
    for (const n of SOCIAL_NETWORKS) {
      expect(CLIP_LIMITS[n].maxSeconds).toBeGreaterThan(0);
      expect(CAPTION_MAX[n]).toBeGreaterThanOrEqual(280);
      expect(socialTitle[n].length).toBeGreaterThan(0);
    }
    expect(CLIP_LIMITS.x.maxSeconds).toBe(140);
    expect(CAPTION_MAX.x).toBe(280);
  });
  it('starts with a caption of the song, the singers and the link', () => {
    expect(clipCaption({ title: 'My Way' })).toBe('My Way · sung on SingersVoice');
    expect(clipCaption({ title: 'My Way', singers: ['Ann', 'Bo'], link: 'https://drive.google.com/x' })).toBe('My Way — Ann, Bo · sung on SingersVoice\nhttps://drive.google.com/x');
    expect(clipCaption({ title: 'My Way', singers: [], link: null })).toBe('My Way · sung on SingersVoice');
  });
  it("opens the network's own composer with the words (Instagram has none)", () => {
    expect(composerUrl('x', 'hi there', 'https://sv.test/p')).toBe('https://x.com/intent/post?text=hi%20there&url=https%3A%2F%2Fsv.test%2Fp');
    expect(composerUrl('x', 'hi', null)).toBe('https://x.com/intent/post?text=hi');
    expect(composerUrl('facebook', 'hi', 'https://sv.test/p')).toBe('https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fsv.test%2Fp');
    expect(composerUrl('facebook', 'hi', null)).toBeNull();
    expect(composerUrl('instagram', 'hi', 'https://sv.test/p')).toBeNull();
  });
});
