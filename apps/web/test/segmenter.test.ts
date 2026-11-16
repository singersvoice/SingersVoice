/**
 * The person segmenter never leaves a singer frozen: a model that stops answering is given up on
 * after two late frames, the silhouette takes over (the picture keeps moving), and the model is back
 * the moment it answers again; a new camera under the segmenter is never blocked by a frame the
 * old one still owes.
 */
import { describe, expect, it, vi } from 'vitest';
import { _resetSharedModel, MODEL_RETRY_MS, PersonSegmenter, SEND_TIMEOUT_MS } from '../src/video/segmenter.ts';
import { fakeDom } from './helpers/fakeDom.ts';

const dom = fakeDom();

/** A stand-in for the MediaPipe solution: every send() answers at once, unless the test holds it. */
function fakeModel() {
  const state = { held: null as null | (() => void), sends: 0, results: null as null | ((r: { image: unknown; segmentationMask: unknown }) => void), answer: true };
  const mask = { width: 256, height: 256 };
  class SelfieSegmentation {
    setOptions(): void {}
    onResults(cb: (r: { image: unknown; segmentationMask: unknown }) => void): void {
      state.results = cb;
    }
    send(i: { image: unknown }): Promise<void> {
      state.sends++;
      if (!state.answer) return new Promise<void>((resolve) => (state.held = resolve));
      state.results?.({ image: i.image, segmentationMask: mask });
      return Promise.resolve();
    }
    close(): void {}
  }
  (globalThis as unknown as { window: Record<string, unknown> }).window.SelfieSegmentation = SelfieSegmentation;
  _resetSharedModel();
  return state;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('PersonSegmenter', () => {
  it('hands the silhouette the picture when the model stops answering, and the model takes over again when it does', async () => {
    vi.useFakeTimers();
    try {
      const model = fakeModel();
      // the mask has to look like a person (some pixels in, some out) or the segmenter uses its soft mask — either is fine here
      const seg = new PersonSegmenter(480, 640);
      const modes: string[] = [];
      void seg.start(dom.current.video as unknown as HTMLVideoElement, true, (m) => modes.push(m));
      await flush();
      await vi.advanceTimersByTimeAsync(200);
      expect(seg.mode).toBe('model');
      const framesWithModel = seg.frame;
      expect(framesWithModel).toBeGreaterThan(0);

      // the model goes quiet: the next frames are never answered
      model.answer = false;
      const sendsBefore = model.sends;
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS * 2 + 400);
      expect(seg.mode).toBe('oval');
      expect(seg.stalls).toBe(1);
      expect(model.sends - sendsBefore).toBe(1); // one frame out, no more piled on a stuck model
      // …and the silhouette keeps the picture moving meanwhile
      const framesAtStall = seg.frame;
      await vi.advanceTimersByTimeAsync(500);
      expect(seg.frame).toBeGreaterThan(framesAtStall);

      // the model answers after all: it is back
      model.answer = true;
      model.held?.();
      await flush();
      await vi.advanceTimersByTimeAsync(200);
      expect(seg.mode).toBe('model');
      expect(modes).toEqual(['loading', 'model', 'oval', 'model']);
      seg.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks a silent model again after MODEL_RETRY_MS', async () => {
    vi.useFakeTimers();
    try {
      const model = fakeModel();
      const seg = new PersonSegmenter(480, 640);
      void seg.start(dom.current.video as unknown as HTMLVideoElement, true);
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      model.answer = false;
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS * 2 + 400);
      expect(seg.mode).toBe('oval');
      const sends = model.sends;
      await vi.advanceTimersByTimeAsync(MODEL_RETRY_MS - 1000);
      expect(model.sends).toBe(sends); // nothing sent while the silhouette stands in
      model.answer = true;
      await vi.advanceTimersByTimeAsync(1500);
      expect(seg.mode).toBe('model');
      expect(model.sends).toBeGreaterThan(sends);
      seg.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a new camera is never blocked by a frame the old one still owes', async () => {
    vi.useFakeTimers();
    try {
      const model = fakeModel();
      const seg = new PersonSegmenter(480, 640);
      void seg.start(dom.current.video as unknown as HTMLVideoElement, true);
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      model.answer = false;
      await vi.advanceTimersByTimeAsync(100); // one frame is out and will never be answered
      expect(model.held).not.toBeNull();
      // the camera is swapped (iOS re-captures the camera with the mic): a new start, the model answering again
      model.answer = true;
      const video2 = { ...dom.current.video };
      void seg.start(video2 as unknown as HTMLVideoElement, true);
      await flush();
      await vi.advanceTimersByTimeAsync(300);
      expect(seg.mode).toBe('model');
      expect(seg.frame).toBeGreaterThan(1);
      const frames = seg.frame;
      await vi.advanceTimersByTimeAsync(300);
      expect(seg.frame).toBeGreaterThan(frames); // frames keep coming on the new camera
      expect(seg.stalls).toBe(0);
      seg.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
