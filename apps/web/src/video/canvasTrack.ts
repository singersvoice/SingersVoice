/**
 * A video track made from a canvas that keeps flowing while the tab is hidden.
 *
 * `canvas.captureStream()` hands out a frame only when the page renders one, and a hidden tab —
 * the host looking at the show view in another tab, a window covered by another, a minimised
 * browser — renders nothing: every recording and stream made from a canvas that way freezes on its
 * last frame while the sound goes on (a saved show with one picture and five minutes of song). So
 * wherever the browser has `MediaStreamTrackGenerator` (Chrome, Edge) the track is fed by hand:
 * the drawing loop (a timer — an audible tab keeps its timers running in the background) calls
 * `push()` after every frame it draws, and the canvas goes down the track as a VideoFrame. Where it
 * is not available the track is the canvas capture, as before.
 */

interface TrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame>;
}
interface TrackGeneratorCtor {
  new (init: { kind: 'video' | 'audio' }): TrackGenerator;
}

/** Whether this browser can make a track that flows while the tab is hidden. */
export const handFedTracks = (): boolean => typeof (globalThis as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator === 'function' && typeof (globalThis as { VideoFrame?: unknown }).VideoFrame === 'function';

/** Whether a canvas can be turned into a track at all (either way). */
export const canvasTracks = (): boolean => handFedTracks() || (typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype);

export class CanvasTrack {
  readonly track: MediaStreamTrack;
  /** true: the frames come from `push()`; false: the browser captures the canvas when it renders (the fallback). */
  readonly fed: boolean;
  private writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
  private busy = false;
  private stopped = false;
  /** Frames handed down the track so far (support / tests). */
  pushed = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    fps: number,
  ) {
    const Gen = (globalThis as { MediaStreamTrackGenerator?: TrackGeneratorCtor }).MediaStreamTrackGenerator;
    if (handFedTracks() && Gen) {
      const gen = new Gen({ kind: 'video' });
      this.writer = gen.writable.getWriter();
      this.track = gen;
      this.fed = true;
    } else {
      this.track = canvas.captureStream(fps).getVideoTracks()[0]!;
      this.fed = false;
    }
  }

  /** The canvas as it is now goes down the track (a frame still on its way is not queued behind: this one is dropped). */
  push(): void {
    if (!this.writer || this.stopped || this.busy) return;
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(this.canvas, { timestamp: Math.round(performance.now() * 1000) });
    } catch {
      return; // a canvas with no size yet, or a tainted one: nothing to send this tick
    }
    this.busy = true;
    this.pushed++;
    this.writer
      .write(frame)
      .catch(() => undefined)
      .finally(() => {
        this.busy = false;
      });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.track.stop();
    void this.writer?.close().catch(() => undefined);
    this.writer = null;
  }
}
