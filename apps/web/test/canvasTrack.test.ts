/**
 * A canvas track that flows while the tab is hidden: fed by hand through MediaStreamTrackGenerator
 * where the browser has it (every drawn frame pushed, never queued behind a slow one), the canvas
 * capture elsewhere.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasTrack, canvasTracks, handFedTracks } from '../src/video/canvasTrack.ts';

const g = globalThis as Record<string, unknown>;
const saved = { gen: g.MediaStreamTrackGenerator, vf: g.VideoFrame, canvas: g.HTMLCanvasElement, perf: g.performance };

afterEach(() => {
  g.MediaStreamTrackGenerator = saved.gen;
  g.VideoFrame = saved.vf;
  g.HTMLCanvasElement = saved.canvas;
  g.performance = saved.perf;
});

/** A stand-in generator whose sink resolves each write when the test says so. */
function fakeGenerator() {
  const written: unknown[] = [];
  let release: (() => void) | null = null;
  const sink = {
    write: (f: unknown) =>
      new Promise<void>((resolve) => {
        written.push(f);
        release = resolve;
      }),
    close: () => Promise.resolve(),
  };
  class Gen {
    kind = 'video';
    stopped = false;
    readonly writable = new WritableStream(sink);
    constructor(public init: { kind: string }) {}
    stop() {
      this.stopped = true;
    }
  }
  return { Gen, written, release: () => release?.() };
}

describe('CanvasTrack', () => {
  it('feeds the track by hand where the browser can: one VideoFrame per push, a frame still on its way drops the next', async () => {
    const { Gen, written, release } = fakeGenerator();
    g.MediaStreamTrackGenerator = Gen;
    const frames: { src: unknown; timestamp: number; closed: boolean }[] = [];
    g.VideoFrame = class {
      closed = false;
      constructor(
        public src: unknown,
        public init: { timestamp: number },
      ) {
        frames.push({ src, timestamp: init.timestamp, closed: false });
      }
      close() {
        this.closed = true;
      }
    };
    g.performance = { now: () => 1234.5 };
    expect(handFedTracks()).toBe(true);
    expect(canvasTracks()).toBe(true);
    const canvas = { width: 320, height: 240 } as unknown as HTMLCanvasElement;
    const t = new CanvasTrack(canvas, 24);
    expect(t.fed).toBe(true);
    expect((t.track as unknown as { init: { kind: string } }).init.kind).toBe('video');
    t.push();
    t.push(); // the first write has not been taken yet: this frame is dropped, not queued
    expect(t.pushed).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.src).toBe(canvas);
    expect(frames[0]!.timestamp).toBe(1_234_500); // microseconds
    await Promise.resolve();
    expect(written).toHaveLength(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    t.push();
    expect(t.pushed).toBe(2);
    t.stop();
    expect((t.track as unknown as { stopped: boolean }).stopped).toBe(true);
    t.push();
    expect(t.pushed).toBe(2); // nothing after stop
  });

  it('falls back to the canvas capture where there is no generator', () => {
    g.MediaStreamTrackGenerator = undefined;
    g.VideoFrame = undefined;
    const stopped = vi.fn();
    const captureStream = vi.fn(() => ({ getVideoTracks: () => [{ stop: stopped }] }));
    g.HTMLCanvasElement = class {
      captureStream() {
        return captureStream();
      }
    };
    expect(handFedTracks()).toBe(false);
    expect(canvasTracks()).toBe(true);
    const canvas = { captureStream } as unknown as HTMLCanvasElement;
    const t = new CanvasTrack(canvas, 15);
    expect(t.fed).toBe(false);
    expect(captureStream).toHaveBeenCalledWith(15);
    t.push(); // nothing to do: the browser captures when it renders
    expect(t.pushed).toBe(0);
    t.stop();
    expect(stopped).toHaveBeenCalled();
  });
});
