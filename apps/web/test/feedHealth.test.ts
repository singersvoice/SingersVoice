/**
 * The local feed watches the camera itself: the track's mute / ended events say so at once, and
 * frames that were flowing (the video's own frame callbacks) and then stop for FROZEN_AFTER seconds
 * (the page visible, the track claiming to be live) is a frozen camera — the one case every other
 * API calls healthy. A video that never presented frames is never judged by them.
 */
import { describe, expect, it, vi } from 'vitest';
import { FROZEN_AFTER, LocalFeed, PIXELS_STILL_AFTER, STILL_AFTER, type FeedHealth } from '../src/video/localFeed.ts';
import { fakeDom, FakeStream, FakeTrack } from './helpers/fakeDom.ts';

const dom = fakeDom();

/** A 120×160 probe mask with a figure (head on shoulders) centred at `cx`: what the feed's probe would read off the cut-out. */
function figureMask(cx: number): Uint8ClampedArray {
  const w = 120;
  const h = 160;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const head = ((x - cx) / 12) ** 2 + ((y - 36) / 16) ** 2 <= 1;
      const neck = y >= 50 && y < 58 && Math.abs(x - cx) < 7;
      const body = y >= 58 && Math.abs(x - cx) < 30;
      if (head || neck || body) d[(y * w + x) * 4] = 255;
    }
  return d;
}

describe('LocalFeed health', () => {
  it('reports the track muted and ended, and back to ok', () => {
    const feed = new LocalFeed();
    const seen: FeedHealth[] = [];
    feed.onHealth = (h) => seen.push(h);
    const track = new FakeTrack();
    feed.attach(new FakeStream([track]) as unknown as MediaStream, false);
    track.fire('mute');
    track.fire('unmute');
    track.fire('ended');
    expect(seen).toEqual(['muted', 'ok', 'ended']);
    feed.dispose();
  });

  /** A camera that presents `fps` frames a second for `seconds`, on the fake clock. */
  const flow = async (seconds: number, fps = 15) => {
    for (let i = 0; i < seconds * fps; i++) {
      dom.current.video.frame();
      await vi.advanceTimersByTimeAsync(1000 / fps);
    }
  };

  it('calls a camera whose frames stop frozen, and ok again when they flow', async () => {
    vi.useFakeTimers();
    try {
      const feed = new LocalFeed();
      const seen: FeedHealth[] = [];
      feed.onHealth = (h) => seen.push(h);
      const track = new FakeTrack();
      feed.attach(new FakeStream([track]) as unknown as MediaStream, false);
      await flow(FROZEN_AFTER + 3); // a live camera: never frozen
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000 * (FROZEN_AFTER + 1)); // the frames stop
      expect(seen).toEqual(['frozen']);
      expect(feed.health).toBe('frozen');
      await flow(2); // they flow again
      expect(seen).toEqual(['frozen', 'ok']);
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never judges a camera whose frames never flowed, a hidden page or a muted track', async () => {
    vi.useFakeTimers();
    try {
      const feed = new LocalFeed();
      const seen: FeedHealth[] = [];
      feed.onHealth = (h) => seen.push(h);
      const track = new FakeTrack();
      feed.attach(new FakeStream([track]) as unknown as MediaStream, false);
      await vi.advanceTimersByTimeAsync(1000 * (FROZEN_AFTER + 3)); // no frame callback ever: not this browser's way of telling
      expect(seen).toEqual([]);
      await flow(2);
      dom.current.document.visibilityState = 'hidden';
      await vi.advanceTimersByTimeAsync(1000 * (FROZEN_AFTER + 2));
      expect(seen).toEqual([]);
      dom.current.document.visibilityState = 'visible';
      dom.current.document.dispatchEvent(new Event('visibilitychange'));
      track.muted = true;
      await vi.advanceTimersByTimeAsync(1000 * (FROZEN_AFTER + 2));
      expect(seen).toEqual([]);
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Frames flow and the model answers with a new cut-out every 150 ms; what the probe reads off it is `mask(t)`
   * (the same mask every time: a camera presenting one picture over and over).
   */
  const present = async (feed: LocalFeed, seconds: number, mask: (t: number) => Uint8ClampedArray) => {
    const t0 = Date.now();
    let nextCut = 0;
    while (Date.now() - t0 < seconds * 1000) {
      const t = Date.now() - t0;
      if (t >= nextCut) {
        for (const c of dom.current.contexts) c.pixels = mask(t);
        feed.segmenter.frame++;
        nextCut += 150;
      }
      dom.current.video.frame();
      await vi.advanceTimersByTimeAsync(50);
    }
  };

  it('calls a camera whose pixels stand exactly still frozen within PIXELS_STILL_AFTER seconds (frames flowing all the while), and ok once they move — a dark picture never', async () => {
    vi.useFakeTimers();
    try {
      const feed = new LocalFeed();
      const seen: FeedHealth[] = [];
      feed.onHealth = (h) => seen.push(h);
      feed.attach(new FakeStream([new FakeTrack()]) as unknown as MediaStream, false);
      feed.segmenter.mode = 'model';
      const live = dom.current.video.pixels;
      await present(feed, 2, (t) => figureMask(60 + (Math.floor(t / 150) % 2 ? 1 : 0)));
      expect(seen).toEqual([]);
      const frozenPixels = live();
      dom.current.video.pixels = () => frozenPixels; // the camera presents the same frame over and over (the model still answers: the same cut-out)
      await present(feed, PIXELS_STILL_AFTER + 1.5, () => figureMask(60));
      expect(seen).toEqual(['frozen']);
      expect(feed.cameraLine).toMatch(/picture still \d+ s/);
      dom.current.video.pixels = live; // it moves again
      await present(feed, 3, (t) => figureMask(60 + (Math.floor(t / 150) % 2 ? 1 : 0)));
      expect(seen).toEqual(['frozen', 'ok']);
      // A lens covered: flat black, noiseless — not a frozen camera.
      const dark = new Uint8ClampedArray(64 * 16 * 4);
      dom.current.video.pixels = () => dark;
      await present(feed, PIXELS_STILL_AFTER + 3, () => new Uint8ClampedArray(120 * 160 * 4));
      expect(seen).toEqual(['frozen', 'ok']);
      dom.current.video.pixels = live;
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls a camera that keeps presenting the same picture frozen — the model measuring the singer exactly the same for STILL_AFTER seconds — and ok once it moves', async () => {
    vi.useFakeTimers();
    try {
      const feed = new LocalFeed();
      const seen: FeedHealth[] = [];
      feed.onHealth = (h) => seen.push(h);
      feed.attach(new FakeStream([new FakeTrack()]) as unknown as MediaStream, false);
      feed.segmenter.mode = 'model'; // the cut-outs are the model's (the stand-in silhouette never counts)
      const still = figureMask(60);
      await present(feed, STILL_AFTER - 2, () => still);
      expect(seen).toEqual([]); // not yet
      await present(feed, 4, () => still);
      expect(seen).toEqual(['frozen']);
      await present(feed, 3, (t) => figureMask(60 + (Math.floor(t / 150) % 2 ? 2 : -2))); // the singer moves again
      expect(seen).toEqual(['frozen', 'ok']);
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a singer who moves even a little, the silhouette, or nobody in the picture is never called frozen', async () => {
    vi.useFakeTimers();
    try {
      const feed = new LocalFeed();
      const seen: FeedHealth[] = [];
      feed.onHealth = (h) => seen.push(h);
      feed.attach(new FakeStream([new FakeTrack()]) as unknown as MediaStream, false);
      feed.segmenter.mode = 'model';
      await present(feed, STILL_AFTER + 5, (t) => figureMask(Math.floor(t / 150) % 2 ? 61 : 60)); // a pixel of sway
      expect(seen).toEqual([]);
      feed.segmenter.mode = 'oval';
      await present(feed, STILL_AFTER + 5, () => figureMask(60)); // the same silhouette every time: not the model's word
      expect(seen).toEqual([]);
      feed.segmenter.mode = 'model';
      await present(feed, STILL_AFTER + 5, () => new Uint8ClampedArray(120 * 160 * 4)); // nobody there: nothing to measure
      expect(seen).toEqual([]);
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a new camera starts with a clean slate', async () => {
    vi.useFakeTimers();
    try {
      const feed = new LocalFeed();
      const seen: FeedHealth[] = [];
      feed.onHealth = (h) => seen.push(h);
      const track = new FakeTrack();
      feed.attach(new FakeStream([track]) as unknown as MediaStream, false);
      await flow(2);
      await vi.advanceTimersByTimeAsync(1000 * (FROZEN_AFTER + 1));
      expect(seen).toEqual(['frozen']);
      const track2 = new FakeTrack();
      feed.attach(new FakeStream([track2]) as unknown as MediaStream, false);
      expect(feed.health).toBe('ok');
      expect(seen).toEqual(['frozen', 'ok']);
      track.fire('ended'); // the old track's events no longer count
      expect(feed.health).toBe('ok');
      await vi.advanceTimersByTimeAsync(1000 * (FROZEN_AFTER + 1)); // the new camera has not presented a frame yet: not judged
      expect(feed.health).toBe('ok');
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
