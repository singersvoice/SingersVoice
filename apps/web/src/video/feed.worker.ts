/**
 * The camera pipeline off the page's main thread: everything between the camera's frames and (a) the
 * framed cut-out the stage draws for this singer and (b) the alpha-packed frames the other devices
 * receive runs here, in a worker — the person segmenter (MediaPipe Selfie Segmentation on an
 * OffscreenCanvas, its masks handed over as bitmaps, never read back through the CPU), the mask's
 * feathering, the stage frame (`framing.ts`), the exposure lift (`enhance.ts`), the bottom feather and
 * the packing. The page gets one bitmap per frame to draw (and, on browsers without a hand-fed video
 * track, the packed frame as a bitmap too); on Chrome / Edge the camera's frames arrive as a stream
 * of VideoFrames (MediaStreamTrackProcessor, transferred in) and the packed frames go straight down
 * the outgoing track (MediaStreamTrackGenerator's writable, transferred in), so the page's thread does
 * nothing per frame but one draw. The page's own segmenter (`segmenter.ts`) remains the fallback where
 * workers cannot run WebGL.
 *
 * The messages (see `feedWorker.ts` for the page's side):
 *   in:  init · stream (a ReadableStream of VideoFrames) · frame (one ImageBitmap) · sink (a WritableStream
 *        of VideoFrames for the packed frames) · pack (on / off) · peek (support: the canvases as they stand) · stop
 *   out: ready · mode · frame (the framed cut-out as a bitmap, the packed frame as a bitmap where there is no sink,
 *        and what was measured) · error (a model attempt failed) · fail (the page takes the pipeline back) · peek
 */
import { EXPOSURE_EVERY_MS, Exposure, personLuma } from './enhance.ts';
import { cropFactor, distanceNote, measureMask, plausibleHead, Seat, visiblePart, type Framing, type PersonMeasure, type Picture } from './framing.ts';
import { FrameStillness, workerStillnessContext } from './stillness.ts';
import { alphaFromMaskPixels, drawCover, fillSoftCenterMask, MASK_H, MASK_W, MODEL_RETRY_MS, SEND_TIMEOUT_MS, TARGET_FPS, withTimeout } from './segmentCore.ts';

export type FeedMode = 'loading' | 'model' | 'oval' | 'off';
export type MaskMode = 'adaptive-alpha' | 'adaptive-luma' | 'soft-center' | 'none';

export interface FeedInit {
  type: 'init';
  /** Where /mediapipe lives (the app's base URL). */
  base: string;
  /** The cut-out's own size. */
  width: number;
  height: number;
  /** The packed frame's size (the person's half). */
  packWidth: number;
  packHeight: number;
  /** The general model (0, computers) or the lighter landscape one (1, phones). */
  modelSelection: 0 | 1;
  /** Cut out with the model (true) or the soft silhouette only. */
  useModel: boolean;
  /** The singer's picture and framing choices (framing.ts) — changed while running with a `look` message. */
  picture?: Picture;
  framing?: Framing;
}
export interface FeedMeta {
  frame: number;
  fps: number;
  mode: FeedMode;
  maskMode: MaskMode;
  coverage: number;
  note: 'close' | 'far' | null;
  seatState: 'settling' | 'gliding' | 'held';
  gain: number;
  /** The last measurement of the singer, as a key (the page's stillness clock), or null. */
  measure: string | null;
  /** How long the camera's own pixels have stood exactly still (ms; stillness.ts): a frozen camera, past a few seconds. */
  stillMs: number;
  stalls: number;
}
export type FeedOut =
  | { type: 'mode'; mode: FeedMode }
  | { type: 'frame'; person: ImageBitmap; packed: ImageBitmap | null; meta: FeedMeta }
  | { type: 'error'; message: string }
  | { type: 'ready' }
  /** The worker cannot run the model here (no WebGL in a worker, a runtime that will not load): the page runs the pipeline itself. */
  | { type: 'fail'; why: string }
  | { type: 'peek'; person: ImageBitmap; mask: ImageBitmap; framed: ImageBitmap; framedMask: ImageBitmap; about: Record<string, unknown> };
export type FeedIn =
  | FeedInit
  | { type: 'stream'; readable: ReadableStream<VideoFrame> }
  | { type: 'frame'; bitmap: ImageBitmap }
  | { type: 'sink'; writable: WritableStream<VideoFrame> | null }
  | { type: 'pack'; on: boolean }
  /** The singer's choices (framing.ts), changed while running. */
  | { type: 'look'; picture: Picture; framing: Framing }
  /** How loud the singer is (0..1 of the meter), for the voice's push-in. */
  | { type: 'voice'; level: number }
  | { type: 'stop' }
  | { type: 'peek' };

/** The feather of a close-up's bottom edge (`localFeed.ts` had these; the frame is framed here now). */
const FEATHER_BELOW = 0.62;
const FEATHER = 0.14;
const PROBE_W = 120;
const PROBE_H = 160;
const PROBE_EVERY_MS = 150;
const LUMA_W = 48;
const LUMA_H = 64;
const LOAD_TIMEOUT_MS = 30_000;

interface SegResults {
  image: CanvasImageSource & { close?: () => void };
  segmentationMask: CanvasImageSource & { close?: () => void };
}
interface Solution {
  setOptions(o: { modelSelection: 0 | 1; selfieMode: boolean }): void;
  onResults(cb: (r: SegResults) => void): void;
  send(i: { image: CanvasImageSource }): Promise<void>;
  initialize(): Promise<void>;
  /** The solution's core (minified `h`): its GL context (`K`) and its canvas (`m`) — put right after initialize (see acquire). */
  h?: { K?: unknown; m?: OffscreenCanvas };
}
type SolutionCtor = new (o: { locateFile: (f: string) => string }) => Solution;

const post = (m: FeedOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

const g = self as unknown as { importScripts?: (...urls: string[]) => void; Module?: unknown; SelfieSegmentation?: SolutionCtor };

interface EmscriptenGL {
  createContext(canvas: OffscreenCanvas, attrs?: Record<string, unknown>): number;
  __svVersioned?: boolean;
}

/**
 * Load the legacy solution in this worker. Its own worker path is half there in this version: it
 * `importScripts` every file it lists — the model's data files too, which no script loader takes —
 * asks its wasm for a GL context without saying which version (a name lost in its own minification),
 * so it gets WebGL 1, on which the model's GPU inference answers noise, and never keeps the context it
 * makes. So: scripts are fetched and evaluated here (a module worker has no importScripts; a sync
 * XMLHttpRequest in a worker is allowed), data files are skipped (the solution fetches its model by
 * itself), the wasm's `locateFile` is given, the context is asked for as WebGL 2 (the page's branch
 * gets that), and it is kept.
 */
async function acquire(base: string, modelSelection: 0 | 1): Promise<Solution> {
  const dir = `${base}mediapipe/`;
  if (!g.SelfieSegmentation) {
    const load = (url: string): void => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send();
      if (xhr.status !== 200) throw new Error(`segmentation runtime not found at ${url}`);
      (0, eval)(xhr.responseText);
    };
    g.importScripts = (...urls: string[]) => {
      for (const u of urls) if (!/\.(tflite|binarypb|data)(\?|$)/.test(u)) load(u);
    };
    // The wasm module is built onto this very object (`Module["GL"] = GL` lands here): its context maker is given the version.
    const mod: Record<string, unknown> = { locateFile: (f: string) => dir + f };
    let gl: EmscriptenGL | undefined;
    Object.defineProperty(mod, 'GL', {
      configurable: true,
      enumerable: true,
      get: () => gl,
      set: (v: EmscriptenGL | undefined) => {
        gl = v;
        if (!v || typeof v.createContext !== 'function' || v.__svVersioned) return;
        const orig = v.createContext.bind(v);
        v.createContext = (canvas, attrs) => orig(canvas, { ...(attrs ?? {}), majorVersion: (attrs?.majorVersion as number | undefined) || (typeof WebGL2RenderingContext !== 'undefined' ? 2 : 1) });
        v.__svVersioned = true;
      },
    });
    g.Module = mod;
    load(`${dir}selfie_segmentation.js`);
    if (!g.SelfieSegmentation) throw new Error('the segmentation runtime did not load');
  }
  const seg = new g.SelfieSegmentation({ locateFile: (f) => dir + f });
  seg.setOptions({ modelSelection, selfieMode: false });
  await withTimeout(seg.initialize(), LOAD_TIMEOUT_MS);
  const core = seg.h;
  if (core && !core.K && core.m) core.K = core.m.getContext('webgl2') ?? core.m.getContext('webgl');
  return seg;
}

class FeedPipeline {
  private seg: Solution | null = null;
  private mode: FeedMode = 'off';
  private maskMode: MaskMode = 'none';
  private coverage = 0;
  private busy = false;
  private running = false;
  private stalls = 0;
  private frame = 0;
  private fps = 0;
  private lastFrameAt = 0;
  private lastSentAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly person: OffscreenCanvas;
  private readonly personCtx: OffscreenCanvasRenderingContext2D;
  private readonly maskGrey: OffscreenCanvas;
  private readonly maskCtx: OffscreenCanvasRenderingContext2D;
  private readonly alphaMask: OffscreenCanvas;
  private readonly alphaCtx: OffscreenCanvasRenderingContext2D;
  private softMask: OffscreenCanvas | null = null;
  private readonly framed: OffscreenCanvas;
  private readonly framedCtx: OffscreenCanvasRenderingContext2D;
  private readonly framedMask: OffscreenCanvas;
  private readonly framedMaskCtx: OffscreenCanvasRenderingContext2D;
  private readonly packed: OffscreenCanvas;
  private readonly packedCtx: OffscreenCanvasRenderingContext2D;
  private readonly probe: OffscreenCanvasRenderingContext2D;
  private readonly luma: OffscreenCanvasRenderingContext2D;
  private lastProbe = 0;
  private lastProbedFrame = -1;
  private lastLuma = 0;
  private lastHead: PersonMeasure['head'] | null = null;
  private measureKey: string | null = null;
  private note: 'close' | 'far' | null = null;
  readonly seat: Seat;
  /** The singer cut out ('cutout') or their camera picture as it is ('camera'): the mask still finds them, for the frame alone. */
  picture: Picture = 'cutout';
  readonly exposure = new Exposure();
  private readonly canFilter: boolean;
  private packing = false;
  private writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
  private writing = false;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private pending: ImageBitmap | null = null;
  /** The camera's pixels against the frame before (a frozen camera presents the same ones). */
  private readonly stillness = new FrameStillness(workerStillnessContext);

  constructor(private readonly o: FeedInit) {
    const mk = (w: number, h: number, alpha: boolean, read = false) => {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d', { alpha, ...(read ? { willReadFrequently: true } : {}) }) as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) throw new Error('no 2D context in the worker');
      return [c, ctx] as const;
    };
    [this.person, this.personCtx] = mk(o.width, o.height, true);
    [this.maskGrey, this.maskCtx] = mk(o.width, o.height, false);
    [this.alphaMask, this.alphaCtx] = mk(MASK_W, MASK_H, true, true);
    [this.framed, this.framedCtx] = mk(o.width, o.height, true);
    [this.framedMask, this.framedMaskCtx] = mk(o.width, o.height, false);
    [this.packed, this.packedCtx] = mk(o.packWidth * 2, o.packHeight, false);
    this.probe = mk(PROBE_W, PROBE_H, false, true)[1];
    this.luma = mk(LUMA_W, LUMA_H, true, true)[1];
    this.seat = new Seat(o.width, o.height);
    this.setLook(o.picture ?? 'cutout', o.framing ?? 'follow');
    this.canFilter = typeof (this.framedCtx as { filter?: unknown }).filter === 'string';
    this.maskCtx.fillStyle = '#000';
    this.maskCtx.fillRect(0, 0, o.width, o.height);
  }

  async start(): Promise<void> {
    this.running = true;
    this.setMode(this.o.useModel ? 'loading' : 'oval');
    if (!this.o.useModel) return;
    // The model runs on WebGL: a worker without it (an older Safari) hands the pipeline back to the page, which has its own.
    let gl: unknown = null;
    try {
      const probe = new OffscreenCanvas(1, 1);
      gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
    } catch {
      gl = null;
    }
    if (!gl) {
      post({ type: 'fail', why: 'no WebGL in a worker here' });
      return;
    }
    let attempt = 0;
    while (this.running) {
      try {
        const seg = await acquire(this.o.base, this.o.modelSelection);
        if (!this.running) return;
        seg.onResults((r) => {
          if (this.mode === 'model') this.drawModel(r);
          else {
            r.image.close?.();
            r.segmentationMask.close?.();
          }
        });
        this.seg = seg;
        this.setMode('model');
        return;
      } catch (e) {
        attempt++;
        const why = e instanceof Error ? e.message : String(e);
        post({ type: 'error', message: `cut-out model: ${why} (attempt ${attempt})` });
        if (attempt >= 2) {
          // Twice is enough: whatever stops the model here (the runtime, the GL), the page's own pipeline gets its turn.
          post({ type: 'fail', why });
          return;
        }
        this.setMode('oval');
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        if (!this.running) return;
        this.setMode('loading');
      }
    }
  }

  private setMode(m: FeedMode): void {
    if (this.mode === m) return;
    this.mode = m;
    post({ type: 'mode', mode: m });
  }

  /** The camera's frames as a stream (Chrome / Edge): read until the stream ends or another replaces it. */
  async consume(readable: ReadableStream<VideoFrame>): Promise<void> {
    void this.reader?.cancel().catch(() => undefined);
    const reader = readable.getReader();
    this.reader = reader;
    for (;;) {
      let r: ReadableStreamReadResult<VideoFrame>;
      try {
        r = await reader.read();
      } catch {
        break;
      }
      if (r.done) break;
      if (this.reader !== reader || !this.running) {
        r.value.close();
        if (this.reader !== reader) break;
        continue;
      }
      const frame = r.value;
      if (!this.wantFrame()) {
        frame.close();
        continue;
      }
      try {
        const bmp = await createImageBitmap(frame);
        frame.close();
        this.take(bmp);
      } catch {
        frame.close();
      }
    }
    if (this.reader === reader) this.reader = null;
  }

  /** Whether the next frame is wanted now (the model's pace, one frame at a time). */
  private wantFrame(): boolean {
    const now = performance.now();
    if (this.busy || now - this.lastSentAt < 1000 / TARGET_FPS - 4) return false;
    this.lastSentAt = now;
    return true;
  }

  /** One camera frame in (a bitmap this worker now owns). */
  take(bmp: ImageBitmap): void {
    if (!this.running) return bmp.close();
    this.stillness.sample(bmp, bmp.width, bmp.height, performance.now());
    if (this.mode === 'model' && this.seg) void this.sendToModel(bmp);
    else {
      this.drawOval(bmp);
      bmp.close();
    }
  }

  /** A frame straight from the page (no stream): paced like the stream's. */
  takePaced(bmp: ImageBitmap): void {
    if (!this.wantFrame()) return bmp.close();
    this.take(bmp);
  }

  private async sendToModel(bmp: ImageBitmap): Promise<void> {
    const seg = this.seg!;
    this.busy = true;
    this.sent = bmp;
    const answered = seg.send({ image: bmp }).then(
      () => true,
      () => true,
    );
    const timeout = () => new Promise<boolean>((r) => setTimeout(() => r(false), SEND_TIMEOUT_MS));
    let inTime = await Promise.race([answered, timeout()]);
    if (!inTime) inTime = await Promise.race([answered, timeout()]);
    if (this.sent === bmp) this.sent = null;
    bmp.close();
    if (!inTime) {
      // The model stopped answering: the silhouette stands in; the model is asked again once it answers or after a while.
      this.stalls++;
      this.busy = false;
      this.setMode('oval');
      clearTimeout(this.retryTimer);
      const again = () => {
        clearTimeout(this.retryTimer);
        if (this.running && this.seg && this.mode === 'oval') this.setMode('model');
      };
      this.retryTimer = setTimeout(again, MODEL_RETRY_MS);
      void answered.then(() => setTimeout(again, 0));
      return;
    }
    this.busy = false;
  }

  /** The camera frame the model is answering (drawn as the picture: the frame itself, not the model's copy of it, which the worker path hands back washed out). */
  private sent: ImageBitmap | null = null;

  private drawModel(r: SegResults): void {
    const mask = this.buildAlphaMask(r.segmentationMask);
    const c = this.personCtx;
    const { width, height } = this.o;
    c.save();
    c.clearRect(0, 0, width, height);
    drawCover(c, this.sent ?? r.image, width, height);
    if (this.picture === 'cutout') {
      c.globalCompositeOperation = 'destination-in';
      if (this.canFilter) c.filter = 'blur(1.2px)';
      c.drawImage(mask, 0, 0, width, height);
    }
    c.restore();
    this.updateMaskFromAlpha(mask);
    r.image.close?.();
    r.segmentationMask.close?.();
    this.bump();
    this.frameOut();
  }

  private buildAlphaMask(source: CanvasImageSource): OffscreenCanvas {
    const ctx = this.alphaCtx;
    ctx.clearRect(0, 0, MASK_W, MASK_H);
    drawCover(ctx, source, MASK_W, MASK_H);
    const img = ctx.getImageData(0, 0, MASK_W, MASK_H);
    const r = alphaFromMaskPixels(img.data);
    if (r.mode === 'unusable') return this.softCenterMask();
    ctx.putImageData(img, 0, 0);
    this.maskMode = r.mode;
    this.coverage = r.coverage;
    return this.alphaMask;
  }

  private softCenterMask(): OffscreenCanvas {
    if (!this.softMask) {
      const cv = new OffscreenCanvas(MASK_W, MASK_H);
      const sc = cv.getContext('2d')!;
      const img = sc.createImageData(MASK_W, MASK_H);
      fillSoftCenterMask(img.data, MASK_W, MASK_H);
      sc.putImageData(img, 0, 0);
      this.softMask = cv;
    }
    this.maskMode = 'soft-center';
    return this.softMask;
  }

  private drawOval(bmp: ImageBitmap): void {
    const mask = this.softCenterMask();
    const c = this.personCtx;
    const { width, height } = this.o;
    c.save();
    c.clearRect(0, 0, width, height);
    drawCover(c, bmp, width, height);
    if (this.picture === 'cutout') {
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(mask, 0, 0, width, height);
    }
    c.restore();
    this.updateMaskFromAlpha(mask);
    this.bump();
    this.frameOut();
  }

  private updateMaskFromAlpha(mask: OffscreenCanvas): void {
    const m = this.maskCtx;
    const { width, height } = this.o;
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

  /** The person (and their head) in the mask, measured on a small probe — once per new cut-out, at most every PROBE_EVERY_MS. */
  private measure(now: number): void {
    if (this.frame === this.lastProbedFrame || now - this.lastProbe < PROBE_EVERY_MS) return;
    this.lastProbedFrame = this.frame;
    this.lastProbe = now;
    let found: PersonMeasure | null;
    try {
      this.probe.drawImage(this.maskGrey, 0, 0, PROBE_W, PROBE_H);
      found = measureMask(this.probe.getImageData(0, 0, PROBE_W, PROBE_H).data, PROBE_W, PROBE_H);
    } catch {
      return;
    }
    this.measureKey = found && this.mode === 'model' ? [found.head.x, found.head.y, found.head.w, found.head.h, found.body.x, found.body.y, found.body.w, found.body.h].join(',') : null;
    const trusted = this.mode === 'model' && this.maskMode !== 'soft-center';
    this.lastHead = trusted && found && plausibleHead(found) ? found.head : null;
    this.seat.sample(this.lastHead, now);
    const t = this.seat.target;
    this.note = t ? distanceNote(cropFactor(t, this.o.height)) : null;
  }

  private measureLuma(now: number): void {
    if (!this.canFilter || now - this.lastLuma < EXPOSURE_EVERY_MS) return;
    this.lastLuma = now;
    try {
      this.luma.clearRect(0, 0, LUMA_W, LUMA_H);
      this.luma.drawImage(this.person, 0, 0, LUMA_W, LUMA_H);
      this.exposure.sample(personLuma(this.luma.getImageData(0, 0, LUMA_W, LUMA_H).data, LUMA_W, LUMA_H, this.lastHead));
    } catch {
      /* a lost context: the lift stays where it is */
    }
  }

  /** The framed cut-out (the seat's crop, lifted, feathered) and the packed frame, out to the page and the track. */
  private frameOut(): void {
    const now = performance.now();
    this.measure(now);
    this.measureLuma(now);
    const gain = this.exposure.step();
    const { width: W, height: H } = this.o;
    const r = visiblePart(this.seat.crop(now), W, H);
    const c = this.framedCtx;
    const m = this.framedMaskCtx;
    c.clearRect(0, 0, W, H);
    m.fillStyle = '#000';
    m.fillRect(0, 0, W, H);
    if (r) {
      if (this.canFilter) c.filter = this.exposure.filter();
      c.drawImage(this.person, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
      if (this.canFilter) c.filter = 'none';
      if (this.picture === 'camera') {
        // The camera picture as it is: opaque wherever the camera saw (the mask is the frame's measurement, not the picture's).
        m.fillStyle = '#fff';
        m.fillRect(r.dx, r.dy, r.dw, r.dh);
      } else {
        m.drawImage(this.maskGrey, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
        const bottom = r.dy + r.dh;
        if (bottom < H * FEATHER_BELOW) {
          const from = bottom - r.dh * FEATHER;
          feather(c, r.dx, r.dw, from, bottom, 'destination-out');
          feather(m, r.dx, r.dw, from, bottom, 'multiply');
        }
      }
    }
    let packedBitmap: ImageBitmap | null = null;
    if (this.packing) {
      const pc = this.packedCtx;
      const { packWidth: pw, packHeight: ph } = this.o;
      pc.fillStyle = '#000';
      pc.fillRect(0, 0, pw * 2, ph);
      pc.drawImage(this.framed, 0, 0, pw, ph);
      pc.drawImage(this.framedMask, pw, 0, pw, ph);
      if (this.writer) this.pushPacked();
      else packedBitmap = this.packed.transferToImageBitmap();
    }
    const person = this.framed.transferToImageBitmap();
    const meta: FeedMeta = { frame: this.frame, fps: this.fps, mode: this.mode, maskMode: this.maskMode, coverage: this.coverage, note: this.note, seatState: this.seat.state(now), gain, measure: this.measureKey, stillMs: this.stillness.stillFor(now), stalls: this.stalls };
    post({ type: 'frame', person, packed: packedBitmap, meta }, packedBitmap ? [person, packedBitmap] : [person]);
  }

  /** The packed frame down the outgoing track (a frame still on its way is not queued behind: this one is dropped). */
  private pushPacked(): void {
    if (!this.writer || this.writing) return;
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(this.packed, { timestamp: Math.round(performance.now() * 1000) });
    } catch {
      return;
    }
    this.writing = true;
    this.writer
      .write(frame)
      .catch(() => undefined)
      .finally(() => {
        frame.close(); // the track took its copy; a frame left open stalls the capture
        this.writing = false;
      });
  }

  async peek(): Promise<void> {
    const [person, mask, framed, framedMask] = await Promise.all([createImageBitmap(this.person), createImageBitmap(this.maskGrey), createImageBitmap(this.framed), createImageBitmap(this.framedMask)]);
    const seat = this.seat as unknown as { samples: unknown[]; target: unknown };
    post({ type: 'peek', person, mask, framed, framedMask, about: { head: this.lastHead, measure: this.measureKey, mode: this.mode, maskMode: this.maskMode, seatSamples: seat.samples.length, seatTarget: seat.target, frame: this.frame, probed: this.lastProbedFrame } }, [person, mask, framed, framedMask]);
  }

  setSink(writable: WritableStream<VideoFrame> | null): void {
    void this.writer?.close().catch(() => undefined);
    this.writer = writable ? writable.getWriter() : null;
    this.writing = false;
  }

  setPacking(on: boolean): void {
    this.packing = on;
  }

  /** The singer's picture and framing choices, changed while running (the model keeps going). */
  setLook(picture: Picture, framing: Framing): void {
    this.picture = picture;
    this.seat.framing = framing;
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.retryTimer);
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    this.setSink(null);
    this.pending?.close();
    this.pending = null;
    this.setMode('off');
  }
}

/** Fade the bottom of the drawn camera region: on the colour canvas by erasing (destination-out), on the grey mask by darkening (multiply). */
function feather(c: OffscreenCanvasRenderingContext2D, x: number, w: number, from: number, to: number, op: GlobalCompositeOperation): void {
  const g = c.createLinearGradient(0, from, 0, to);
  if (op === 'destination-out') {
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
  } else {
    g.addColorStop(0, '#fff');
    g.addColorStop(1, '#000');
  }
  c.save();
  c.globalCompositeOperation = op;
  c.fillStyle = g;
  c.fillRect(x, from, w, to - from + 1);
  c.restore();
}

let pipeline: FeedPipeline | null = null;

self.onmessage = (e: MessageEvent<FeedIn>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init':
        pipeline?.stop();
        pipeline = new FeedPipeline(m);
        post({ type: 'ready' });
        void pipeline.start();
        break;
      case 'stream':
        void pipeline?.consume(m.readable);
        break;
      case 'frame':
        if (pipeline) pipeline.takePaced(m.bitmap);
        else m.bitmap.close();
        break;
      case 'sink':
        pipeline?.setSink(m.writable);
        break;
      case 'pack':
        pipeline?.setPacking(m.on);
        break;
      case 'look':
        pipeline?.setLook(m.picture, m.framing);
        break;
      case 'voice':
        pipeline?.seat.voice(m.level);
        break;
      case 'peek':
        // Support / tests: the pipeline's canvases as they stand (what the model gave, the grey mask, the framed cut-out and its mask).
        if (pipeline) void pipeline.peek();
        break;
      case 'stop':
        pipeline?.stop();
        pipeline = null;
        break;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
