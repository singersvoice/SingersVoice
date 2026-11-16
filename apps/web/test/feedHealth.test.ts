/**
 * The local feed watches the camera itself: the track's mute / ended events say so at once, and
 * frames that were flowing (the video's own frame callbacks) and then stop for FROZEN_AFTER seconds
 * (the page visible, the track claiming to be live) is a frozen camera — the one case every other
 * API calls healthy. A video that never presented frames is never judged by them.
 */
import { describe, expect, it, vi } from 'vitest';
import { FROZEN_AFTER, LocalFeed, type FeedHealth } from '../src/video/localFeed.ts';
import { fakeDom, FakeStream, FakeTrack } from './helpers/fakeDom.ts';

const dom = fakeDom();

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
