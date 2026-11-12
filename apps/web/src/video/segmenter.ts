/**
 * Person segmentation for the virtual stage: MediaPipe Selfie Segmentation (bundled under
 * /mediapipe, CDN as a fallback), run at ~15 fps on the local camera. Produces a "person canvas"
 * (RGBA, transparent background, feathered edge) that the stage compositor draws over the stage
 * background and the alpha packer sends to the other performers.
 *
 * If the model cannot load (old device, blocked network before first cache) the segmenter falls
 * back to an oval vignette so the singer still appears blended into the stage, never as a box.
 */
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747';
const LOCAL = `${import.meta.env.BASE_URL}mediapipe`;
const TARGET_FPS = 15;
const LOAD_TIMEOUT_MS = 20_000;

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

export class PersonSegmenter {
  /** Person over transparent background, feathered edge. */
  readonly canvas: HTMLCanvasElement;
  /** Grayscale alpha (white = person) — what the alpha packer sends to other performers. */
  readonly maskCanvas: HTMLCanvasElement;
  mode: SegmenterMode = 'loading';
  /** Increments on every new frame (compositor redraws only when it changed). */
  frame = 0;
  fps = 0;
  private seg: SelfieSegmentationLike | null = null;
  private video: HTMLVideoElement | null = null;
  private running = false;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ctx2d: CanvasRenderingContext2D;
  private maskCtx: CanvasRenderingContext2D;
  private lastFrameAt = 0;
  private onModeChange: ((m: SegmenterMode) => void) | null = null;

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
  }

  static supported(): boolean {
    return typeof WebAssembly === 'object';
  }

  /** Start on a playing <video>. `useModel=false` goes straight to the oval fallback (battery saver). */
  async start(video: HTMLVideoElement, useModel = true, onModeChange?: (m: SegmenterMode) => void): Promise<void> {
    this.stop();
    this.video = video;
    this.running = true;
    this.onModeChange = onModeChange ?? null;
    if (!useModel || !PersonSegmenter.supported()) {
      this.setMode('oval');
      this.loopOval();
      return;
    }
    this.setMode('loading');
    this.loopOval(); // show something immediately while the model loads
    try {
      const base = await withTimeout(loadRuntime(), LOAD_TIMEOUT_MS);
      if (!this.running || this.video !== video) return;
      const Ctor = (window as unknown as { SelfieSegmentation: SegCtor }).SelfieSegmentation;
      const seg = new Ctor({ locateFile: (f) => `${base}/${f}` });
      seg.setOptions({ modelSelection: 1, selfieMode: false });
      seg.onResults((r) => this.drawModel(r));
      if (seg.initialize) await withTimeout(seg.initialize(), LOAD_TIMEOUT_MS);
      if (!this.running || this.video !== video) {
        void seg.close();
        return;
      }
      this.seg = seg;
      clearTimeout(this.timer);
      this.setMode('model');
      this.loopModel();
    } catch {
      if (this.running) this.setMode('oval');
    }
  }

  private setMode(m: SegmenterMode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.onModeChange?.(m);
  }

  private loopModel(): void {
    const step = async () => {
      if (!this.running || !this.seg || !this.video) return;
      const v = this.video;
      if (!this.busy && v.readyState >= 2 && v.videoWidth) {
        this.busy = true;
        try {
          await this.seg.send({ image: v });
        } catch {
          /* skip frame */
        }
        this.busy = false;
      }
      this.timer = setTimeout(() => void step(), 1000 / TARGET_FPS);
    };
    void step();
  }

  private loopOval(): void {
    clearTimeout(this.timer);
    const step = () => {
      if (!this.running || this.mode === 'model' || !this.video) return;
      if (this.video.readyState >= 2 && this.video.videoWidth) this.drawOval(this.video);
      this.timer = setTimeout(step, 1000 / TARGET_FPS);
    };
    step();
  }

  /** Model result → person canvas (image masked by the feathered segmentation) + grayscale mask. */
  private drawModel(r: SegResults): void {
    const c = this.ctx2d;
    const { width, height } = this.canvas;
    c.save();
    c.clearRect(0, 0, width, height);
    c.filter = 'blur(1.5px)';
    c.drawImage(r.segmentationMask, 0, 0, width, height);
    c.filter = 'none';
    c.globalCompositeOperation = 'source-in';
    c.drawImage(r.image, 0, 0, width, height);
    c.restore();
    this.updateMaskFromCanvas();
    this.bump();
  }

  /** Fallback: the camera frame through a soft oval, so the singer still blends with the stage. */
  private drawOval(video: HTMLVideoElement): void {
    const c = this.ctx2d;
    const { width, height } = this.canvas;
    c.save();
    c.clearRect(0, 0, width, height);
    const g = c.createRadialGradient(width / 2, height * 0.42, Math.min(width, height) * 0.18, width / 2, height * 0.5, Math.min(width, height) * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.75, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, width, height);
    c.globalCompositeOperation = 'source-in';
    drawCover(c, video, width, height);
    c.restore();
    this.updateMaskFromCanvas();
    this.bump();
  }

  /** Grayscale mask = alpha of the person canvas (white fill ∩ person, over black). */
  private updateMaskFromCanvas(): void {
    const m = this.maskCtx;
    const { width, height } = this.maskCanvas;
    m.save();
    m.globalCompositeOperation = 'source-over';
    m.fillStyle = '#000';
    m.fillRect(0, 0, width, height);
    m.globalCompositeOperation = 'lighter';
    // Draw white where the person is: a white rect masked by the person's alpha.
    m.drawImage(whiteThrough(this.canvas), 0, 0);
    m.restore();
  }

  private bump(): void {
    const now = performance.now();
    if (this.lastFrameAt) this.fps = this.fps * 0.9 + (1000 / Math.max(1, now - this.lastFrameAt)) * 0.1;
    this.lastFrameAt = now;
    this.frame++;
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    const s = this.seg;
    this.seg = null;
    if (s) void Promise.resolve(s.close()).catch(() => undefined);
    this.video = null;
    this.setMode('off');
  }
}

/** Draw `source` covering a w×h box (centre crop). */
export function drawCover(c: CanvasRenderingContext2D, source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement, w: number, h: number): void {
  const sw = (source as HTMLVideoElement).videoWidth || (source as HTMLCanvasElement).width || 1;
  const sh = (source as HTMLVideoElement).videoHeight || (source as HTMLCanvasElement).height || 1;
  const sr = sw / sh;
  const dr = w / h;
  let sx = 0;
  let sy = 0;
  let cw = sw;
  let ch = sh;
  if (sr > dr) {
    cw = sh * dr;
    sx = (sw - cw) / 2;
  } else {
    ch = sw / dr;
    sy = (sh - ch) / 2;
  }
  c.drawImage(source, sx, sy, cw, ch, 0, 0, w, h);
}

let scratchCanvas: HTMLCanvasElement | null = null;
/** A canvas that is white wherever `person` is opaque (its alpha preserved). */
function whiteThrough(person: HTMLCanvasElement): HTMLCanvasElement {
  if (!scratchCanvas || scratchCanvas.width !== person.width || scratchCanvas.height !== person.height) {
    scratchCanvas = document.createElement('canvas');
    scratchCanvas.width = person.width;
    scratchCanvas.height = person.height;
  }
  const c = scratchCanvas.getContext('2d')!;
  c.save();
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
  c.fillStyle = '#fff';
  c.fillRect(0, 0, scratchCanvas.width, scratchCanvas.height);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(person, 0, 0);
  c.restore();
  return scratchCanvas;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
