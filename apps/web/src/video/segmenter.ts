/**
 * Person segmentation for the virtual stage: MediaPipe Selfie Segmentation (bundled under
 * /mediapipe, CDN as a fallback), run at ~15 fps on the local camera. Produces a "person canvas"
 * (RGBA, transparent background, feathered edge) that the stage compositor draws over the stage
 * background and the alpha packer sends to the other performers.
 *
 * If the model cannot load (old device, blocked network before first cache) the segmenter falls
 * back to an oval vignette so the singer still appears blended into the stage, never as a box.
 */
import type { Picture } from './framing.ts';
import { alphaFromMaskPixels, drawCover, fillSoftCenterMask, MASK_H, MASK_W, MODEL_RETRY_MS, SEND_TIMEOUT_MS, TARGET_FPS, withTimeout } from './segmentCore.ts';

export { alphaFromMaskPixels, coverRect, drawCover, MODEL_RETRY_MS, SEND_TIMEOUT_MS, smoothStep } from './segmentCore.ts';

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747';
const LOCAL = `${import.meta.env.BASE_URL}mediapipe`;
const LOAD_TIMEOUT_MS = 20_000;
/** After the graphics failed the model (no WebGL context to be had), the silhouette stands in this long before the model is tried again. */
const GPU_RETRY_MS = 30_000;

/**
 * The model draws through WebGL; when the browser has no context to give it (too many on the page, a GPU process
 * gone, a tab the browser starved) MediaPipe's runtime calls `alert()` — "Failed to create WebGL canvas context
 * when passing video frame" — once per frame, a modal over the stage every 60 ms. Here that call is taken away
 * from it before it is ever loaded: the message goes to the console and `gpuFailedAt` marks the moment, the
 * segmenter draws the silhouette and asks the model again later; any other alert passes through untouched.
 */
let gpuFailedAt = 0;
let alertGuarded = false;
function guardAlert(): void {
  if (alertGuarded || typeof window === 'undefined' || typeof window.alert !== 'function') return;
  alertGuarded = true;
  const native = window.alert.bind(window);
  window.alert = (message?: unknown) => {
    if (/WebGL canvas context/i.test(String(message))) {
      gpuFailedAt = Date.now();
      console.warn('segmentation:', String(message), '— the soft silhouette stands in');
      return;
    }
    native(message);
  };
}

/** Whether the browser can give the model a WebGL context right now (the model never finds out the hard way). */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    (gl.getExtension?.('WEBGL_lose_context') as { loseContext?: () => void } | null)?.loseContext?.(); // give the context back at once: the probe must not be one more context the page keeps
    return true;
  } catch {
    return false;
  }
}

/** When the graphics last failed the model (0: never), for the stage's word on soft-focus mode. */
export const gpuFailedAtMs = (): number => gpuFailedAt;

interface SegResults {
  image: CanvasImageSource;
  segmentationMask: CanvasImageSource;
}
interface SelfieSegmentationLike {
  setOptions(o: { modelSelection: 0 | 1; selfieMode: boolean }): void;
  onResults(cb: (r: SegResults) => void): void;
  send(i: { image: HTMLVideoElement }): Promise<void>;
  initialize?(): Promise<void>;
  close(): Promise<void> | void;
}
type SegCtor = new (o: { locateFile: (f: string) => string }) => SelfieSegmentationLike;

let scriptPromise: Promise<string> | null = null;
/** Load selfie_segmentation.js from the app's own /mediapipe folder, else the CDN. Resolves with the asset base. */
function loadRuntime(): Promise<string> {
  if (scriptPromise) return scriptPromise;
  const w = window as unknown as { SelfieSegmentation?: SegCtor; __svSegBase?: string };
  if (w.SelfieSegmentation) return (scriptPromise = Promise.resolve(w.__svSegBase ?? LOCAL));
  const tryBase = (base: string) =>
    new Promise<string>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${base}/selfie_segmentation.js`;
      s.async = true;
      if (base === CDN) s.crossOrigin = 'anonymous';
      s.onload = () => {
        w.__svSegBase = base;
        resolve(base);
      };
      s.onerror = () => {
        s.remove();
        reject(new Error(`segmentation runtime not found at ${base}`));
      };
      document.head.appendChild(s);
    });
  scriptPromise = tryBase(LOCAL).catch(() => tryBase(CDN));
  scriptPromise.catch(() => {
    scriptPromise = null;
  });
  return scriptPromise;
}

export type SegmenterMode = 'loading' | 'model' | 'oval' | 'off';

/**
 * One model instance per page, created once and never closed: the solution's WASM module can only
 * be instantiated once per page — a second `new SelfieSegmentation()` (a camera re-opened, a second
 * stage in the same tab) aborts inside Emscripten ("Module.arguments has been replaced…") and so
 * would every retry. Whoever starts last owns the results callback.
 */
let sharedSeg: SelfieSegmentationLike | null = null;
let sharedSegPromise: Promise<SelfieSegmentationLike> | null = null;
function acquireModel(): Promise<SelfieSegmentationLike> {
  if (sharedSeg) return Promise.resolve(sharedSeg);
  if (sharedSegPromise) return sharedSegPromise;
  sharedSegPromise = (async () => {
    guardAlert();
    if (!webglAvailable()) throw new Error('no WebGL context for the segmentation model');
    const base = await loadRuntime();
    const Ctor = (window as unknown as { SelfieSegmentation: SegCtor }).SelfieSegmentation;
    const seg = new Ctor({ locateFile: (f) => `${base}/${f}` });
    // The general model (256×256) draws a cleaner edge than the landscape one (256×144) and costs about twice the
    // CPU: computers get it, phones keep the lighter one.
    seg.setOptions({ modelSelection: (navigator.hardwareConcurrency ?? 2) >= 4 && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 0 : 1, selfieMode: false });
    if (seg.initialize) await withTimeout(seg.initialize(), LOAD_TIMEOUT_MS);
    sharedSeg = seg;
    return seg;
  })();
  sharedSegPromise.catch(() => {
    sharedSegPromise = null; // a failed load (offline, timeout) is retried by the next start()
  });
  return sharedSegPromise;
}

/** Tests only: forget the page's model so the next start() makes a new one. */
export function _resetSharedModel(): void {
  sharedSeg = null;
  sharedSegPromise = null;
}

export class PersonSegmenter {
  /** Person over transparent background, feathered edge. */
  readonly canvas: HTMLCanvasElement;
  /** Grayscale alpha (white = person) — what the alpha packer sends to other performers. */
  readonly maskCanvas: HTMLCanvasElement;
  mode: SegmenterMode = 'loading';
  /** Increments on every new frame (compositor redraws only when it changed). */
  frame = 0;
  fps = 0;
  /** Times the model stopped answering and the silhouette stood in (support / tests). */
  stalls = 0;
  private seg: SelfieSegmentationLike | null = null;
  private video: HTMLVideoElement | null = null;
  private running = false;
  private busy = false;
  /** Bumped by every start()/stop(): a loop, a late answer or a timer from an earlier run sees it and steps aside. */
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private ctx2d: CanvasRenderingContext2D;
  private maskCtx: CanvasRenderingContext2D;
  private lastFrameAt = 0;
  private onModeChange: ((m: SegmenterMode) => void) | null = null;
  /** Alpha mask built from the model output (white RGB, person = opaque), at the model's own resolution. */
  private alphaMask: HTMLCanvasElement;
  private alphaCtx: CanvasRenderingContext2D;
  private softMask: HTMLCanvasElement | null = null;
  /** Diagnostics (shown in the stage bar when something looks off). */
  maskMode: 'adaptive-alpha' | 'adaptive-luma' | 'soft-center' | 'none' = 'none';
  maskCoverage = 0;
  /**
   * The singer cut out of their room ('cutout'), or their camera picture as it is ('camera': the canvas
   * opaque; the mask canvas still says where the person is, for the stage frame's measurement alone).
   */
  picture: Picture = 'cutout';

  constructor(
    readonly width = 480,
    readonly height = 640,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx2d = this.canvas.getContext('2d', { alpha: true })!;
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = width;
    this.maskCanvas.height = height;
    this.maskCtx = this.maskCanvas.getContext('2d', { alpha: false })!;
    // The selfie model answers at 256×144 / 256×256: a 240×320 work canvas loses nothing and keeps
    // the per-pixel pass cheap on phones (77k pixels per frame).
    this.alphaMask = document.createElement('canvas');
    this.alphaMask.width = MASK_W;
    this.alphaMask.height = MASK_H;
    this.alphaCtx = this.alphaMask.getContext('2d', { willReadFrequently: true })!;
  }

  static supported(): boolean {
    return typeof WebAssembly === 'object';
  }

  /**
   * Start on a playing <video>. The soft silhouette shows at once; the model takes over the moment it
   * is ready (first visit downloads ~6 MB, cached afterwards) and loading is retried until it works —
   * the singer is never left in a rectangle, and never permanently in the fallback either.
   */
  async start(video: HTMLVideoElement, useModel = true, onModeChange?: (m: SegmenterMode) => void): Promise<void> {
    this.stop();
    const gen = ++this.gen;
    this.video = video;
    this.running = true;
    this.busy = false; // a frame still out from an earlier run is not waited for
    this.onModeChange = onModeChange ?? null;
    this.setMode(useModel && PersonSegmenter.supported() ? 'loading' : 'oval');
    this.loopOval(gen);
    if (this.mode !== 'loading') return;
    let attempt = 0;
    while (this.running && this.gen === gen) {
      try {
        const seg = await acquireModel();
        if (!this.running || this.gen !== gen) return;
        seg.onResults((r) => {
          if (this.gen === gen && this.mode === 'model') this.drawModel(r); // never a late answer over the silhouette, or one for a camera since replaced
        });
        this.seg = seg;
        clearTimeout(this.timer);
        this.setMode('model');
        this.loopModel(gen);
        return;
      } catch {
        attempt++;
        this.setMode('oval'); // keep showing the silhouette while we retry
        await new Promise((r) => setTimeout(r, Math.min(30_000, 3000 * attempt)));
        if (!this.running || this.gen !== gen) return;
        this.setMode('loading');
      }
    }
  }

  private setMode(m: SegmenterMode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.onModeChange?.(m);
  }

  /**
   * Frames to the model, one at a time, at the target rate. A model that stops answering (it happens: a camera
   * swapped under it on an iPad, a lost GPU context) would otherwise leave the singer frozen on the last cut-out for
   * everyone — so a frame not answered in SEND_TIMEOUT_MS gets as long again, and if it is still out the silhouette
   * takes over (the singer keeps moving) until the model answers or MODEL_RETRY_MS have passed.
   */
  private loopModel(gen: number): void {
    const timeout = () => new Promise<boolean>((r) => setTimeout(() => r(false), SEND_TIMEOUT_MS));
    const step = async () => {
      if (!this.running || this.gen !== gen || this.mode !== 'model' || !this.seg || !this.video) return;
      // The graphics failed the model a moment ago (its runtime said so through the alert it no longer gets to show):
      // the silhouette stands in, and the model is asked again once the context can be had.
      if (gpuFailedAt && Date.now() - gpuFailedAt < GPU_RETRY_MS) {
        this.gpuDown(gen);
        return;
      }
      const v = this.video;
      if (!this.busy && v.readyState >= 2 && v.videoWidth) {
        this.busy = true;
        const answered = this.seg.send({ image: v }).then(
          () => true,
          () => true, // a refused frame is an answer too: the next one goes
        );
        let inTime = await Promise.race([answered, timeout()]);
        if (!inTime) inTime = await Promise.race([answered, timeout()]);
        if (this.gen !== gen) return;
        if (!inTime) {
          this.modelStuck(gen, answered);
          return;
        }
        this.busy = false;
      }
      this.timer = setTimeout(() => void step(), 1000 / TARGET_FPS);
    };
    void step();
  }

  /** No WebGL context for the model: the silhouette stands in, and the model is tried again once a context can be had. */
  private gpuDown(gen: number): void {
    this.stalls++;
    this.busy = false;
    this.setMode('oval');
    this.loopOval(gen);
    clearTimeout(this.retryTimer);
    const again = () => {
      clearTimeout(this.retryTimer);
      if (!this.running || this.gen !== gen || !this.seg || this.mode !== 'oval') return;
      if (!webglAvailable()) {
        this.retryTimer = setTimeout(again, GPU_RETRY_MS);
        return;
      }
      gpuFailedAt = 0;
      this.setMode('model');
      this.loopModel(gen);
    };
    this.retryTimer = setTimeout(again, GPU_RETRY_MS);
  }

  /** The model stopped answering: the silhouette stands in, and the model is asked again once it answers or after MODEL_RETRY_MS. */
  private modelStuck(gen: number, pending: Promise<boolean>): void {
    this.stalls++;
    this.busy = false;
    this.setMode('oval');
    this.loopOval(gen);
    clearTimeout(this.retryTimer);
    const again = () => {
      clearTimeout(this.retryTimer);
      if (!this.running || this.gen !== gen || !this.seg || this.mode !== 'oval') return;
      this.setMode('model');
      this.loopModel(gen);
    };
    this.retryTimer = setTimeout(again, MODEL_RETRY_MS);
    void pending.then(() => setTimeout(again, 0));
  }

  private loopOval(gen: number): void {
    clearTimeout(this.timer);
    const step = () => {
      if (!this.running || this.gen !== gen || this.mode === 'model' || !this.video) return;
      if (this.video.readyState >= 2 && this.video.videoWidth) this.drawOval(this.video);
      this.timer = setTimeout(step, 1000 / TARGET_FPS);
    };
    step();
  }

  /**
   * Model result → person canvas + grey mask. The legacy solution hands the mask back either in the
   * alpha channel or only as brightness with alpha fully opaque (it differs by browser / GPU path), so
   * — like the original SingersVoice app — read a few pixels, use whichever channel actually varies,
   * normalise it and feather it with a smoothstep. Implausible coverage (nobody in frame, or the whole
   * frame "is" the person) falls back to a soft head-and-shoulders mask, never a rectangle.
   */
  private drawModel(r: SegResults): void {
    if (!this.running || !this.seg) return; // a frame answered after stop()
    const mask = this.buildAlphaMask(r.segmentationMask);
    const c = this.ctx2d;
    const { width, height } = this.canvas;
    c.save();
    c.clearRect(0, 0, width, height);
    drawCover(c, r.image, width, height); // the camera picture centre-cropped to the cut-out's 3:4 — never stretched
    if (this.picture === 'cutout') {
      c.globalCompositeOperation = 'destination-in';
      c.filter = 'blur(1.2px)'; // the mask's staircase (it is a fraction of the picture's size) becomes a soft edge
      c.drawImage(mask, 0, 0, width, height);
    }
    c.restore();
    this.updateMaskFromAlpha(mask);
    this.bump();
  }

  private buildAlphaMask(source: CanvasImageSource): HTMLCanvasElement {
    const ctx = this.alphaCtx;
    ctx.clearRect(0, 0, MASK_W, MASK_H);
    drawCover(ctx, source, MASK_W, MASK_H); // the same centre crop as the picture, so the mask lands on the person
    const img = ctx.getImageData(0, 0, MASK_W, MASK_H);
    const r = alphaFromMaskPixels(img.data);
    if (r.mode === 'unusable') return this.softCenterMask();
    ctx.putImageData(img, 0, 0);
    this.maskMode = r.mode;
    this.maskCoverage = r.coverage;
    return this.alphaMask;
  }

  /** Head-and-shoulders silhouette with soft edges (the original app's fallback when the mask is unusable). */
  private softCenterMask(): HTMLCanvasElement {
    if (!this.softMask) {
      const cv = document.createElement('canvas');
      cv.width = MASK_W;
      cv.height = MASK_H;
      const sc = cv.getContext('2d')!;
      const img = sc.createImageData(MASK_W, MASK_H);
      fillSoftCenterMask(img.data, MASK_W, MASK_H);
      sc.putImageData(img, 0, 0);
      this.softMask = cv;
    }
    this.maskMode = 'soft-center';
    return this.softMask;
  }

  /** Fallback without a model: the camera frame through the soft head-and-shoulders mask. */
  private drawOval(video: HTMLVideoElement): void {
    const mask = this.softCenterMask();
    const c = this.ctx2d;
    const { width, height } = this.canvas;
    c.save();
    c.clearRect(0, 0, width, height);
    drawCover(c, video, width, height);
    if (this.picture === 'cutout') {
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(mask, 0, 0, width, height);
    }
    c.restore();
    this.updateMaskFromAlpha(mask);
    this.bump();
  }

  /** Grey mask for the alpha packer: the white-with-alpha mask over black → grey = alpha. */
  private updateMaskFromAlpha(mask: HTMLCanvasElement): void {
    const m = this.maskCtx;
    const { width, height } = this.maskCanvas;
    m.fillStyle = '#000';
    m.fillRect(0, 0, width, height);
    m.drawImage(mask, 0, 0, width, height);
  }

  private bump(): void {
    const now = performance.now();
    if (this.lastFrameAt) this.fps = this.fps * 0.9 + (1000 / Math.max(1, now - this.lastFrameAt)) * 0.1;
    this.lastFrameAt = now;
    this.frame++;
  }

  stop(): void {
    this.running = false;
    this.gen++;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.busy = false;
    this.seg = null; // the shared model stays alive for the next start (see acquireModel)
    this.video = null;
    this.setMode('off');
  }
}
