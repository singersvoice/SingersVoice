/**
 * Person cut-out (no rectangular tiles): MediaPipe Selfie Segmentation, lazy-loaded from a CDN only
 * when the singer turns "Cutout" on. Draws the camera frame masked to the person over a transparent
 * canvas so the stage background shows through. Falls back silently (plain video) if the model
 * cannot load (offline, blocked CDN, old device).
 */
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747';

interface SegResults {
  image: CanvasImageSource;
  segmentationMask: CanvasImageSource;
}
interface SelfieSegmentationLike {
  setOptions(o: { modelSelection: 0 | 1; selfieMode: boolean }): void;
  onResults(cb: (r: SegResults) => void): void;
  send(i: { image: HTMLVideoElement }): Promise<void>;
  close(): Promise<void> | void;
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if ((window as unknown as { SelfieSegmentation?: unknown }).SelfieSegmentation) return resolve();
    const s = document.createElement('script');
    s.src = `${CDN}/selfie_segmentation.js`;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Cutout model could not be loaded'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export class Cutout {
  private seg: SelfieSegmentationLike | null = null;
  private running = false;
  private raf = 0;
  private busy = false;
  readonly canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  ready = false;

  constructor(width = 480, height = 360) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx2d = this.canvas.getContext('2d', { alpha: true })!;
  }

  async start(video: HTMLVideoElement): Promise<void> {
    await loadScript();
    const Ctor = (window as unknown as { SelfieSegmentation: new (o: { locateFile: (f: string) => string }) => SelfieSegmentationLike }).SelfieSegmentation;
    this.seg = new Ctor({ locateFile: (f) => `${CDN}/${f}` });
    this.seg.setOptions({ modelSelection: 1, selfieMode: true });
    this.seg.onResults((r) => this.draw(r));
    this.running = true;
    this.ready = true;
    const loop = async () => {
      if (!this.running) return;
      if (!this.busy && video.readyState >= 2 && video.videoWidth) {
        this.busy = true;
        try {
          await this.seg?.send({ image: video });
        } catch {
          /* skip frame */
        }
        this.busy = false;
      }
      this.raf = requestAnimationFrame(() => void loop());
    };
    void loop();
  }

  private draw(r: SegResults): void {
    const c = this.ctx2d;
    const { width, height } = this.canvas;
    c.save();
    c.clearRect(0, 0, width, height);
    c.drawImage(r.segmentationMask, 0, 0, width, height);
    c.globalCompositeOperation = 'source-in';
    c.drawImage(r.image, 0, 0, width, height);
    c.restore();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    void this.seg?.close();
    this.seg = null;
    this.ready = false;
  }
}
