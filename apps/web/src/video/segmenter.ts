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
const MASK_W = 240;
const MASK_H = 320;

export const smoothStep = (e0: number, e1: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Turn the model's raw mask pixels into a white-with-alpha mask, in place. The legacy MediaPipe
 * solution returns the person probability either in the alpha channel or only as brightness with
 * alpha fully opaque (it differs by browser / GPU path), so use whichever channel actually varies,
 * normalise it and feather with a smoothstep. Returns 'unusable' only when the mask carries no
 * information at all (a broken readback); an empty mask (nobody in frame) is a valid answer and
 * leaves that spot on the stage empty rather than showing the real background.
 */
export function alphaFromMaskPixels(d: Uint8ClampedArray): { mode: 'adaptive-alpha' | 'adaptive-luma' | 'unusable'; coverage: number } {
  let minLuma = 255;
  let maxLuma = 0;
  let minAlpha = 255;
  let maxAlpha = 0;
  for (let i = 0; i < d.length; i += 4) {
    const luma = d[i]! * 0.2126 + d[i + 1]! * 0.7152 + d[i + 2]! * 0.0722;
    if (luma < minLuma) minLuma = luma;
    if (luma > maxLuma) maxLuma = luma;
    const a = d[i + 3]!;
    if (a < minAlpha) minAlpha = a;
    if (a > maxAlpha) maxAlpha = a;
  }
  const lumaRange = maxLuma - minLuma;
  const alphaRange = maxAlpha - minAlpha;
  const useAlpha = alphaRange > lumaRange && alphaRange > 8;
  const min = useAlpha ? minAlpha : minLuma;
  const range = useAlpha ? alphaRange : lumaRange;
  if (range < 6) return { mode: 'unusable', coverage: 0 };
  let visible = 0;
  for (let i = 0; i < d.length; i += 4) {
    const raw = useAlpha ? d[i + 3]! : d[i]! * 0.2126 + d[i + 1]! * 0.7152 + d[i + 2]! * 0.0722;
    const alpha = Math.round(smoothStep(0.18, 0.58, (raw - min) / range) * 255);
    if (alpha > 8) visible++;
    d[i] = 255;
    d[i + 1] = 255;
    d[i + 2] = 255;
    d[i + 3] = alpha;
  }
  const coverage = visible / (d.length / 4);
  return { mode: useAlpha ? 'adaptive-alpha' : 'adaptive-luma', coverage };
}

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
  /** Alpha mask built from the model output (white RGB, person = opaque), at the model's own resolution. */
  private alphaMask: HTMLCanvasElement;
  private alphaCtx: CanvasRenderingContext2D;
  private softMask: HTMLCanvasElement | null = null;
  /** Diagnostics (shown in the stage bar when something looks off). */
  maskMode: 'adaptive-alpha' | 'adaptive-luma' | 'soft-center' | 'none' = 'none';
  maskCoverage = 0;

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
    this.video = video;
    this.running = true;
    this.onModeChange = onModeChange ?? null;
    this.setMode(useModel && PersonSegmenter.supported() ? 'loading' : 'oval');
    this.loopOval();
    if (this.mode !== 'loading') return;
    let attempt = 0;
    while (this.running && this.video === video) {
      try {
        const base = await loadRuntime();
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
        return;
      } catch {
        attempt++;
        this.setMode('oval'); // keep showing the silhouette while we retry
        await new Promise((r) => setTimeout(r, Math.min(30_000, 3000 * attempt)));
        if (!this.running || this.video !== video) return;
        this.setMode('loading');
      }
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

  /**
   * Model result → person canvas + grey mask. The legacy solution hands the mask back either in the
   * alpha channel or only as brightness with alpha fully opaque (it differs by browser / GPU path), so
   * — like the original SingersVoice app — read a few pixels, use whichever channel actually varies,
   * normalise it and feather it with a smoothstep. Implausible coverage (nobody in frame, or the whole
   * frame "is" the person) falls back to a soft head-and-shoulders mask, never a rectangle.
   */
  private drawModel(r: SegResults): void {
    const mask = this.buildAlphaMask(r.segmentationMask);
    const c = this.ctx2d;
    const { width, height } = this.canvas;
    c.save();
    c.clearRect(0, 0, width, height);
    c.drawImage(r.image, 0, 0, width, height);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(mask, 0, 0, width, height);
    c.restore();
    this.updateMaskFromAlpha(mask);
    this.bump();
  }

  private buildAlphaMask(source: CanvasImageSource): HTMLCanvasElement {
    const ctx = this.alphaCtx;
    ctx.clearRect(0, 0, MASK_W, MASK_H);
    ctx.drawImage(source, 0, 0, MASK_W, MASK_H);
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
      const d = img.data;
      const cx = MASK_W * 0.5;
      const cy = MASK_H * 0.48;
      const rx = MASK_W * 0.28;
      const ry = MASK_H * 0.46;
      for (let y = 0; y < MASK_H; y++) {
        for (let x = 0; x < MASK_W; x++) {
          const i = (y * MASK_W + x) * 4;
          const dx = (x - cx) / rx;
          const dy = (y - cy) / ry;
          const torso = smoothStep(1.05, 0.52, Math.sqrt(dx * dx + dy * dy));
          const hx = (x - cx) / (MASK_W * 0.18);
          const hy = (y - MASK_H * 0.32) / (MASK_H * 0.22);
          const head = smoothStep(1.0, 0.42, Math.sqrt(hx * hx + hy * hy));
          d[i] = 255;
          d[i + 1] = 255;
          d[i + 2] = 255;
          d[i + 3] = Math.round(Math.max(torso, head) * 230);
        }
      }
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
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(mask, 0, 0, width, height);
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
