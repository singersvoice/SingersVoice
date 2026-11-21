/**
 * The page's end of the feed worker (`feed.worker.ts`): starts it, hands it the camera's frames — as a
 * stream of VideoFrames where the browser has MediaStreamTrackProcessor (Chrome, Edge), else one
 * bitmap at a time — and gets back, per frame, the framed cut-out to draw and what was measured. Where
 * the browser has hand-fed video tracks, the outgoing track's writable goes to the worker too, so the
 * packed frames never touch this thread.
 */
import type { FeedIn, FeedInit, FeedMeta, FeedMode, FeedOut } from './feed.worker.ts';
import type { Framing, Picture } from './framing.ts';

export type { FeedMeta, FeedMode } from './feed.worker.ts';

interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readonly readable: ReadableStream<VideoFrame> };
}

/** The camera's frames as a stream, where the browser gives one (the worker reads it; this thread never sees a frame). */
export const trackStreams = (): boolean => typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === 'function';

/** Whether the pipeline can run in a worker here at all: a worker with a 2D OffscreenCanvas and bitmaps. */
export function feedWorkerSupported(): boolean {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return false;
  try {
    return new OffscreenCanvas(1, 1).getContext('2d') !== null;
  } catch {
    return false;
  }
}

export class FeedWorkerLink {
  private worker: Worker | null = null;
  onFrame: ((person: ImageBitmap, packed: ImageBitmap | null, meta: FeedMeta) => void) | null = null;
  onMode: ((m: FeedMode) => void) | null = null;
  /** The worker could not do its work (the page falls back to its own segmenter). */
  onFail: ((why: string) => void) | null = null;
  /** The worker's model failed to load (said once per attempt). */
  onModelError: ((why: string) => void) | null = null;

  start(init: Omit<FeedInit, 'type'>): void {
    this.stop();
    let w: Worker;
    try {
      w = new Worker(new URL('./feed.worker.ts', import.meta.url), { type: 'module', name: 'sv-feed' });
    } catch (e) {
      this.onFail?.(e instanceof Error ? e.message : String(e));
      return;
    }
    this.worker = w;
    w.onerror = (e) => this.onFail?.(e.message || 'the feed worker failed');
    w.onmessage = (e: MessageEvent<FeedOut>) => {
      const m = e.data;
      if (m.type === 'frame') {
        if (this.onFrame) this.onFrame(m.person, m.packed, m.meta);
        else {
          m.person.close();
          m.packed?.close();
        }
      } else if (m.type === 'mode') this.onMode?.(m.mode);
      else if (m.type === 'error') this.onModelError?.(m.message);
      else if (m.type === 'fail') this.onFail?.(m.why);
      else if (m.type === 'peek') {
        const p = this.peeks.shift();
        if (p) p({ person: m.person, mask: m.mask, framed: m.framed, framedMask: m.framedMask, about: m.about });
        else for (const b of [m.person, m.mask, m.framed, m.framedMask]) b.close();
      }
    };
    this.send({ type: 'init', ...init });
  }

  private send(m: FeedIn, transfer: Transferable[] = []): void {
    this.worker?.postMessage(m, transfer);
  }

  /** The camera's frames as a stream (the processor is made here, where the track lives; the stream goes over). Null: not possible here. */
  stream(track: MediaStreamTrack): boolean {
    const Proc = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
    if (!Proc) return false;
    try {
      const readable = new Proc({ track, maxBufferSize: 2 }).readable;
      this.send({ type: 'stream', readable }, [readable as unknown as Transferable]);
      return true;
    } catch {
      return false;
    }
  }

  frame(bitmap: ImageBitmap): void {
    this.send({ type: 'frame', bitmap }, [bitmap]);
  }

  sink(writable: WritableStream<VideoFrame> | null): void {
    this.send({ type: 'sink', writable }, writable ? [writable as unknown as Transferable] : []);
  }

  pack(on: boolean): void {
    this.send({ type: 'pack', on });
  }

  /** The singer's picture and framing choices (framing.ts), while running. */
  look(picture: Picture, framing: Framing): void {
    this.send({ type: 'look', picture, framing });
  }

  /** How loud the singer is now (0..1 of the meter): the voice's push-in. */
  voice(level: number): void {
    this.send({ type: 'voice', level });
  }

  private peeks: ((r: { person: ImageBitmap; mask: ImageBitmap; framed: ImageBitmap; framedMask: ImageBitmap; about: Record<string, unknown> }) => void)[] = [];
  /** Support / tests: the worker's canvases as they stand, and what it measured. */
  peek(): Promise<{ person: ImageBitmap; mask: ImageBitmap; framed: ImageBitmap; framedMask: ImageBitmap; about: Record<string, unknown> }> {
    return new Promise((resolve) => {
      this.peeks.push(resolve);
      this.send({ type: 'peek' });
    });
  }

  get running(): boolean {
    return this.worker !== null;
  }

  stop(): void {
    const w = this.worker;
    if (!w) return;
    this.worker = null;
    w.onmessage = null;
    w.onerror = null;
    // The worker puts its frames down first (the camera's stream cancelled, the bitmap on its way closed): a worker
    // terminated mid-frame leaves a VideoFrame open, which the browser counts as a stall waiting to happen.
    w.postMessage({ type: 'stop' } satisfies FeedIn);
    setTimeout(() => w.terminate(), 300);
  }
}
