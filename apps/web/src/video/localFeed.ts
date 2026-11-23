/**
 * My own camera on the virtual stage: a hidden <video> for the camera stream, the person segmenter
 * that cuts me out of it, the stage frame (`framing.ts`: my head the standard size at the standard
 * place, so I am the same size as everyone else on every stage) set once and held by the seat —
 * never steered after my every sway — and applied to the cut-out, and — in a live meet — the alpha
 * packer that turns the framed cut-out into the stream other performers receive. One instance per
 * stage session.
 *
 * The work runs in a worker wherever it can (`feed.worker.ts`, `feedWorker.ts`): the model, the
 * feathering, the framing, the lift and the packing happen off this thread, which only draws the
 * framed cut-out it is handed (one bitmap a frame) — so the stage, the lyrics and every tap stay
 * quick on a phone. Where a worker cannot do that (no OffscreenCanvas, no WebGL in workers), the same
 * pipeline runs here, as it always did.
 */
import { AlphaPacker } from './alphaPack.ts';
import { EXPOSURE_EVERY_MS, Exposure, isComputer, PACK_HEIGHT, PACK_WIDTH, personLuma } from './enhance.ts';
import { FeedWorkerLink, feedWorkerSupported, type FeedMeta } from './feedWorker.ts';
import { cropFactor, distanceNote, measureMask, plausibleHead, Seat, visiblePart, type Framing, type PersonMeasure, type Picture, type SeatState } from './framing.ts';
import { PersonSegmenter, type SegmenterMode } from './segmenter.ts';
import type { PerformerSource } from './stage.ts';

/** Tests and support: `localStorage['sv.feedWorker'] = '0'` keeps the pipeline on the page. */
const workerWanted = (): boolean => {
  try {
    return localStorage.getItem('sv.feedWorker') !== '0';
  } catch {
    return true;
  }
};

/** The cut-out's own size: computers work at 720×960 so a singer standing full-height in a 720p show is drawn near 1:1; phones at 480×640. */
const COMPUTER = isComputer();
const W = COMPUTER ? 720 : 480;
const H = COMPUTER ? 960 : 640;
/** The exposure probe: the person's brightness is read off a sample this size (enhance.ts). */
const LUMA_W = 48;
const LUMA_H = 64;
/** The person probe: the mask at this size, measured on every new cut-out but at most this often (the head of a singer sitting back is still a dozen pixels wide). */
const PROBE_W = 120;
const PROBE_H = 160;
const PROBE_EVERY_MS = 150;
/** The camera's own health: frames that were flowing and then stop for this many seconds (the page visible all the while) is a frozen camera. */
export const FROZEN_AFTER = 5;
/** Frames that must have flowed before their stopping means anything (a video that never fires frame callbacks is not judged by them). */
const FLOWING_FRAMES = 10;
/**
 * A camera that keeps presenting the same picture is frozen as much as one whose frames stop: the model's
 * measurement of the singer (head and body, to the probe pixel) identical across new cut-outs for this many
 * seconds. A real person, however still, never measures exactly the same for that long — the mask's own edge
 * moves — and a camera pointed at nobody measures nothing, so neither is ever called frozen.
 */
export const STILL_AFTER = 15;

/** What the camera is doing: live, muted by the browser, ended (the browser took it away), or frozen on one picture. */
export type FeedHealth = 'ok' | 'muted' | 'ended' | 'frozen';

/** A camera picture whose bottom edge lands above this much of the frame (the riser hides the rest) gets its bottom feathered… */
const FEATHER_BELOW = 0.62;
/** …over this much of its height. */
const FEATHER = 0.14;

/** Fade the bottom of the drawn camera region: on the colour canvas by erasing (destination-out), on the grey mask by darkening (multiply). */
function feather(c: CanvasRenderingContext2D, x: number, w: number, from: number, to: number, op: GlobalCompositeOperation): void {
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

/** What the page reads of the cut-out's making when it happens in the worker (the same names as the page's own segmenter). */
class SegmenterFacade {
  mode: SegmenterMode = 'off';
  maskMode: 'adaptive-alpha' | 'adaptive-luma' | 'soft-center' | 'none' = 'none';
  maskCoverage = 0;
  frame = 0;
  fps = 0;
  stalls = 0;
}

export class LocalFeed {
  readonly video: HTMLVideoElement;
  /** The page's own segmenter (the fallback), or, in worker mode, what the worker reports of it. */
  readonly segmenter: PersonSegmenter | SegmenterFacade;
  private readonly own: PersonSegmenter;
  private readonly facade = new SegmenterFacade();
  /** The worker that runs the pipeline off this thread (null: the page does it). */
  private link: FeedWorkerLink | null = null;
  private workerOn = false;
  /** Frames handed to the worker one at a time (no track stream here): at most this many on their way. */
  private inflight = 0;
  private streamed = false;
  private packedStreamRemote: { stream: MediaStream; writable: WritableStream<VideoFrame> | null } | null = null;
  /** Where the cut-out is made: in the worker, or on the page. */
  get pipeline(): 'worker' | 'page' {
    return this.workerOn ? 'worker' : 'page';
  }
  /** The framed cut-out: what the stage draws for me and what other performers receive. */
  readonly canvas: HTMLCanvasElement;
  readonly maskCanvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private maskCtx: CanvasRenderingContext2D;
  private packer: AlphaPacker | null = null;
  private stream: MediaStream | null = null;
  private useModel = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSeg = -1;
  private lastGain = 1;
  mode: SegmenterMode = 'off';
  onMode: ((m: SegmenterMode) => void) | null = null;
  /**
   * What this singer should do about their distance to the camera: 'close' — the stage frame had to
   * reach well past the camera picture (sit back: the stage can only show what the camera sees);
   * 'far' — they are small in the picture (come closer); null — fine.
   */
  note: 'close' | 'far' | null = null;
  onNote: ((n: 'close' | 'far' | null) => void) | null = null;
  /**
   * The camera's health, watched: the track's own mute/ended events (iOS ends a capture when another
   * starts; a browser mutes one it interrupted) and the video's own frame callbacks — frames that
   * were flowing and then stop for FROZEN_AFTER seconds while the page is visible is a camera frozen
   * on one picture (the singer with their arms crossed, forever), which looks alive to every other
   * API. The room restarts the camera on anything but 'ok'.
   */
  health: FeedHealth = 'ok';
  onHealth: ((h: FeedHealth) => void) | null = null;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private watched: MediaStreamTrack | null = null;
  /** Bumped by every watch()/unwatch(): a frame callback from an earlier camera steps aside. */
  private watchGen = 0;
  private framesSeen = 0;
  private lastFrameAt = 0;
  private visibleSince = 0;
  /** The last measurement of the singer (as a key) and since when it has not changed (0: it changes). */
  private lastMeasure: string | null = null;
  private stillSince = 0;
  /** Frames the camera presented in the last second (0 where the browser gives no frame callbacks), for the strip's camera line. */
  cameraFps = 0;
  private framesAtSample = 0;
  /** The stage frame, set from the measured head and held (`framing.ts`). */
  readonly seat = new Seat(W, H);
  /** The singer's picture: cut out of their room, or the camera picture as it is (framing.ts). */
  picture: Picture = 'cutout';
  private probe: CanvasRenderingContext2D | null = null;
  private lastProbe = 0;
  private lastProbedSeg = -1;
  /** Increments on every framed frame (compositor redraws only when it changed). */
  frame = 0;
  /** The lift of my picture (enhance.ts): the person's brightness measured now and then, the gain glided to every frame. */
  readonly exposure = new Exposure();
  /** The width of the packed frame this device sends (enhance.ts) — for the stage strip and the e2e. */
  readonly packWidth = PACK_WIDTH;
  private lumaProbe: CanvasRenderingContext2D | null = null;
  private lastLuma = 0;
  /** The head as last measured by the model (fractions of the cut-out), the lift's region. */
  private lastHead: PersonMeasure['head'] | null = null;
  /** Whether this browser's canvas can apply a filter while drawing (Safari's cannot: the picture goes out as the camera gives it). */
  private readonly canFilter: boolean;

  constructor() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('aria-hidden', 'true');
    v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    this.video = v;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = W;
    this.maskCanvas.height = H;
    this.maskCtx = this.maskCanvas.getContext('2d', { alpha: false })!;
    this.maskCtx.fillStyle = '#000';
    this.maskCtx.fillRect(0, 0, W, H);
    this.canFilter = typeof (this.ctx as { filter?: unknown }).filter === 'string';
    this.own = new PersonSegmenter(W, H);
    this.workerOn = feedWorkerSupported() && workerWanted();
    this.segmenter = this.workerOn ? this.facade : this.own;
  }

  /** Point the feed at a camera stream (or null to go dark). */
  attach(stream: MediaStream | null, useModel = true): void {
    if (stream === this.stream && stream && useModel === this.useModel) return;
    this.stream = stream;
    this.useModel = useModel;
    this.own.stop();
    clearInterval(this.timer);
    this.unwatch();
    if (!stream) {
      this.video.srcObject = null;
      this.link?.stop();
      this.link = null;
      this.workerInit = '';
      this.streamed = false;
      this.inflight = 0;
      this.packedStreamRemote = null;
      this.setMode('off');
      return;
    }
    this.watch(stream.getVideoTracks()[0] ?? null);
    // The hidden camera <video> lives on the body for the feed's whole life: a media element taken
    // out of the document (a view swapping its stage container) is paused by the browser, and a
    // paused camera means a frozen cut-out for everyone else.
    if (!this.video.isConnected) document.body.appendChild(this.video);
    this.video.onpause = () => {
      if (this.stream && this.video.srcObject) void this.video.play().catch(() => undefined);
    };
    this.video.srcObject = stream;
    void this.video.play().catch(() => undefined);
    if (this.workerOn) this.startWorker(stream, useModel);
    else this.startOnPage(useModel);
  }

  private setMode(m: SegmenterMode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.onMode?.(m);
  }

  /** The pipeline on this thread (the fallback): the page's own segmenter and the tick that frames its cut-out. */
  private startOnPage(useModel: boolean): void {
    void this.own.start(this.video, useModel, (m) => this.setMode(m));
    this.timer = setInterval(() => this.tick(), 1000 / 15);
  }

  /** What the running worker was started with: another camera stream with the same wants is handed to it, the model kept. */
  private workerInit = '';

  /** The pipeline in the worker: the camera's frames go over (as a stream, or one by one), the framed cut-out comes back. */
  private startWorker(stream: MediaStream, useModel: boolean): void {
    const link = this.link ?? new FeedWorkerLink();
    this.link = link;
    const init = { base: import.meta.env.BASE_URL, width: W, height: H, packWidth: PACK_WIDTH, packHeight: PACK_HEIGHT, modelSelection: (COMPUTER ? 0 : 1) as 0 | 1, useModel };
    const initKey = JSON.stringify(init);
    const keep = link.running && this.workerInit === initKey;
    const look = { picture: this.picture, framing: this.seat.framing };
    if (!keep) {
      this.facade.mode = useModel ? 'loading' : 'oval';
      this.setMode(this.facade.mode);
    }
    link.onMode = (m) => {
      this.facade.mode = m;
      this.setMode(m);
    };
    link.onFrame = (person, packed, meta) => this.takeFrame(person, packed, meta);
    link.onModelError = (why) => console.warn('feed worker:', why);
    link.onFail = (why) => {
      if (this.link !== link) return;
      // The worker cannot do it here: the page does, as it always did (the same cut-out, on this thread).
      console.warn('feed worker failed, the page takes over:', why);
      clearInterval(this.timer);
      this.workerOn = false;
      (this as { segmenter: PersonSegmenter | SegmenterFacade }).segmenter = this.own;
      link.stop();
      this.link = null;
      this.workerInit = '';
      this.streamed = false;
      this.inflight = 0;
      if (this.packedStreamRemote && this.packer) {
        // The outgoing track was the worker's: it ends (a moment after the worker, so nothing on its way is dropped unclosed), and the next packedStream() makes the page's own (the stage asks again).
        this.packer.stopLater();
        this.packedStreamRemote = null;
        this.onPackedLost?.();
      }
      if (this.stream) this.startOnPage(this.useModel);
    };
    // Whoever sends my picture asks packedStream() again after every attach (as with the page's own packer): the packing stops meanwhile.
    this.packedStreamRemote = null;
    if (keep) {
      link.pack(false);
      link.sink(null);
    } else {
      link.start({ ...init, ...look });
      this.workerInit = initKey;
    }
    if (this.link !== link) return; // failed on the spot: the page has taken over
    clearInterval(this.timer);
    const track = stream.getVideoTracks()[0];
    this.streamed = Boolean(track) && link.stream(track!);
    this.inflight = 0;
    if (!this.streamed) this.timer = setInterval(() => this.feedWorkerFrame(), 1000 / 15); // no track streams here (Safari): a bitmap at a time
  }

  /** The worker's outgoing track ended (the page took over): whoever holds the packed stream asks for it again. */
  onPackedLost: (() => void) | null = null;

  /** The singer's choices (Settings → Camera, the stage's Picture sheet): their picture and how the frame behaves — live, whichever pipeline runs. */
  setLook(picture: Picture, framing: Framing): void {
    this.picture = picture;
    this.own.picture = picture;
    this.seat.framing = framing;
    this.link?.look(picture, framing);
    this.lastSeg = -1; // the next tick redraws, choice or no new frame
  }

  /** How loud the singer is now (0..1 of the meter) — the frame's push-in while the framing is 'voice' (framing.ts). */
  voice(level: number): void {
    if (this.seat.framing !== 'voice') return;
    this.seat.voice(level);
    this.link?.voice(level);
  }

  /** One camera frame to the worker, as a bitmap (where the camera cannot be read as a stream). */
  private feedWorkerFrame(): void {
    const link = this.link;
    if (!link || this.inflight >= 2 || this.video.readyState < 2 || !this.video.videoWidth) return;
    this.inflight++;
    createImageBitmap(this.video).then(
      (bmp) => {
        if (this.link === link) link.frame(bmp);
        else bmp.close();
      },
      () => undefined,
    );
  }

  /** The worker's framed cut-out for this frame: drawn, and what it measured taken over. */
  private takeFrame(person: ImageBitmap, packed: ImageBitmap | null, meta: FeedMeta): void {
    if (this.inflight > 0) this.inflight--;
    try {
      this.ctx.clearRect(0, 0, W, H);
      this.ctx.drawImage(person, 0, 0, W, H);
      // The grey mask (what the Studio packs beside a take's cut-out) from the cut-out's own alpha: white where the person is, black elsewhere.
      const m = this.maskCtx;
      m.globalCompositeOperation = 'source-over';
      m.fillStyle = '#fff';
      m.fillRect(0, 0, W, H);
      m.globalCompositeOperation = 'destination-in';
      m.drawImage(person, 0, 0, W, H);
      m.globalCompositeOperation = 'destination-over';
      m.fillStyle = '#000';
      m.fillRect(0, 0, W, H);
      m.globalCompositeOperation = 'source-over';
    } finally {
      person.close();
    }
    if (packed) {
      if (this.packer && this.packedStreamRemote && !this.packedStreamRemote.writable) this.packer.pushBitmap(packed);
      else packed.close();
    }
    this.facade.frame = meta.frame;
    this.facade.fps = meta.fps;
    this.facade.maskMode = meta.maskMode;
    this.facade.maskCoverage = meta.coverage;
    this.facade.stalls = meta.stalls;
    this.exposure.gain = meta.gain;
    this.workerSeatState = meta.seatState;
    if (meta.note !== this.note) {
      this.note = meta.note;
      this.onNote?.(meta.note);
    }
    // The stillness clock (a camera presenting the same picture over and over) runs on the worker's measurements.
    const now = performance.now();
    if (meta.measure === null) {
      this.lastMeasure = null;
      this.stillSince = 0;
    } else if (meta.measure === this.lastMeasure) {
      if (!this.stillSince) this.stillSince = now;
    } else {
      this.lastMeasure = meta.measure;
      this.stillSince = 0;
    }
    this.frame++;
  }

  private workerSeatState: SeatState = 'settling';

  private setHealth(h: FeedHealth): void {
    if (this.health === h) return;
    this.health = h;
    this.onHealth?.(h);
  }

  private readonly onTrackMute = () => this.setHealth('muted');
  private readonly onTrackUnmute = () => this.setHealth('ok');
  private readonly onTrackEnded = () => this.setHealth('ended');

  private readonly onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.visibleSince = performance.now();
  };

  private watch(track: MediaStreamTrack | null): void {
    this.watchGen++;
    this.framesSeen = 0;
    this.framesAtSample = 0;
    this.cameraFps = 0;
    this.lastFrameAt = 0;
    this.lastMeasure = null;
    this.stillSince = 0;
    this.visibleSince = performance.now();
    this.setHealth(track ? (track.readyState === 'ended' ? 'ended' : track.muted ? 'muted' : 'ok') : 'ok');
    if (!track) return;
    this.watched = track;
    track.addEventListener('mute', this.onTrackMute);
    track.addEventListener('unmute', this.onTrackUnmute);
    track.addEventListener('ended', this.onTrackEnded);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    this.armFrameCallback(this.watchGen);
    this.healthTimer = setInterval(() => this.sampleHealth(), 1000);
  }

  private unwatch(): void {
    this.watchGen++;
    clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    const t = this.watched;
    if (t) {
      t.removeEventListener('mute', this.onTrackMute);
      t.removeEventListener('unmute', this.onTrackUnmute);
      t.removeEventListener('ended', this.onTrackEnded);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.watched = null;
  }

  /** One callback per frame the video presents (requestVideoFrameCallback, where the browser has it): the proof that frames flow. */
  private armFrameCallback(gen: number): void {
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    v.requestVideoFrameCallback(() => {
      if (gen !== this.watchGen) return;
      this.framesSeen++;
      this.lastFrameAt = performance.now();
      this.armFrameCallback(gen);
    });
  }

  /**
   * Once a second: frames that were flowing (FLOWING_FRAMES of them at least) and have stopped for FROZEN_AFTER seconds — the
   * page visible all the while, the track calling itself live and unmuted — is a frozen camera, and so is one whose
   * picture has not changed for STILL_AFTER seconds (the model measuring the singer exactly the same, cut-out after
   * cut-out); frames flowing again, or the picture moving again, is 'ok'.
   */
  private sampleHealth(): void {
    this.cameraFps = Math.max(0, this.framesSeen - this.framesAtSample);
    this.framesAtSample = this.framesSeen;
    const t = this.watched;
    if (!t || t.readyState !== 'live' || t.muted) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return; // a hidden page presents no frames
    const now = performance.now();
    const flowed = this.framesSeen >= FLOWING_FRAMES;
    const stopped = flowed && now - Math.max(this.lastFrameAt, this.visibleSince) >= FROZEN_AFTER * 1000;
    const still = this.stillSince > 0 && now - this.stillSince >= STILL_AFTER * 1000;
    if (stopped || still) this.setHealth('frozen');
    else if (this.health === 'frozen' && (!flowed || now - this.lastFrameAt < 1500)) this.setHealth('ok');
  }

  /** The measurement just made, against the last: the same one again starts (or continues) the stillness clock. */
  private noteStillness(found: PersonMeasure | null, now: number): void {
    if (!found || this.own.mode !== 'model') {
      this.lastMeasure = null;
      this.stillSince = 0;
      return;
    }
    const key = [found.head.x, found.head.y, found.head.w, found.head.h, found.body.x, found.body.y, found.body.w, found.body.h].join(',');
    if (key === this.lastMeasure) {
      if (!this.stillSince) this.stillSince = now;
    } else {
      this.lastMeasure = key;
      this.stillSince = 0;
    }
  }

  /**
   * The person (and their head) in the mask, measured on a small probe — once per new cut-out, at most every
   * PROBE_EVERY_MS: undefined when there is nothing new to measure, null when nobody is there.
   */
  private probePerson(now: number): PersonMeasure | null | undefined {
    if (this.own.frame === this.lastProbedSeg || now - this.lastProbe < PROBE_EVERY_MS) return undefined;
    this.lastProbedSeg = this.own.frame;
    this.lastProbe = now;
    if (!this.probe) {
      const pc = document.createElement('canvas');
      pc.width = PROBE_W;
      pc.height = PROBE_H;
      this.probe = pc.getContext('2d', { willReadFrequently: true });
      if (!this.probe) return undefined;
    }
    try {
      this.probe.drawImage(this.own.maskCanvas, 0, 0, PROBE_W, PROBE_H);
      return measureMask(this.probe.getImageData(0, 0, PROBE_W, PROBE_H).data, PROBE_W, PROBE_H);
    } catch {
      return undefined; // a lost context: nothing to learn this time
    }
  }

  /**
   * One measurement to the seat: only a real cut-out's (the model's, with a plausible person in it —
   * never the stand-in silhouette, never a fragment of a figure the model lost) — and to the stillness
   * clock (a camera presenting the same picture over and over). The distance note (sit back / come
   * closer) follows the frame the seat holds.
   */
  private measure(now: number): void {
    const found = this.probePerson(now);
    if (found === undefined) return;
    this.noteStillness(found, now);
    const trusted = this.own.mode === 'model' && this.own.maskMode !== 'soft-center';
    this.lastHead = trusted && found && plausibleHead(found) ? found.head : null;
    this.seat.sample(this.lastHead, now);
    const t = this.seat.target;
    const note = t ? distanceNote(cropFactor(t, H)) : null;
    if (note !== this.note) {
      this.note = note;
      this.onNote?.(note);
    }
  }

  /** Where the seat is: settling (the whole camera frame goes out), gliding to a new frame, or held. */
  get seatState(): SeatState {
    return this.workerOn ? this.workerSeatState : this.seat.state(performance.now());
  }

  /** What the camera is doing, in words for the stage strip: its frame rate (or that the browser tells no frames), the cut-out, the lift of the picture, and how long it has stood still. */
  get cameraLine(): string {
    const model = this.segmenter.mode === 'model' ? 'model' : this.segmenter.mode === 'oval' ? 'silhouette' : this.segmenter.mode === 'loading' ? 'loading' : 'off';
    const cut = `${this.picture === 'camera' ? `camera picture (${model})` : `cut-out ${model}`}${this.workerOn ? ' (worker)' : ''} · frame ${this.seat.framing === 'follow' ? 'follows' : this.seat.framing === 'voice' ? 'on the voice' : 'still'}`;
    const frames = this.framesSeen > 0 ? `camera ${this.cameraFps} fps` : 'camera (frames not told)';
    const lift = this.exposure.lift >= 3 ? ` · lifted +${this.exposure.lift}%` : '';
    const still = this.stillSince ? ` · picture still ${Math.round((performance.now() - this.stillSince) / 1000)} s` : '';
    return `${frames} · ${cut}${lift}${still}`;
  }

  /**
   * The person's brightness — the face's, where the model found the head — read off a small sample of the cut-out every
   * EXPOSURE_EVERY_MS (weighted by its mask, so the room behind them counts for nothing): the exposure's next target.
   */
  private measureLuma(now: number): void {
    if (!this.canFilter || now - this.lastLuma < EXPOSURE_EVERY_MS) return;
    this.lastLuma = now;
    if (!this.lumaProbe) {
      const lc = document.createElement('canvas');
      lc.width = LUMA_W;
      lc.height = LUMA_H;
      this.lumaProbe = lc.getContext('2d', { willReadFrequently: true });
      if (!this.lumaProbe) return;
    }
    try {
      this.lumaProbe.clearRect(0, 0, LUMA_W, LUMA_H);
      this.lumaProbe.drawImage(this.own.canvas, 0, 0, LUMA_W, LUMA_H);
      this.exposure.sample(personLuma(this.lumaProbe.getImageData(0, 0, LUMA_W, LUMA_H).data, LUMA_W, LUMA_H, this.lastHead));
    } catch {
      /* a lost context: the lift stays where it is */
    }
  }

  private tick(): void {
    const now = performance.now();
    this.measure(now);
    this.measureLuma(now);
    const gain = this.exposure.step();
    if (this.own.frame === this.lastSeg && !this.seat.moving(now) && gain === this.lastGain) return; // nothing new to draw
    this.lastSeg = this.own.frame;
    this.lastGain = gain;
    const r = visiblePart(this.seat.crop(now), W, H); // the crop may reach past the camera picture: that part stays transparent
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    const m = this.maskCtx;
    m.fillStyle = '#000';
    m.fillRect(0, 0, W, H);
    if (r) {
      // The picture goes out lifted and polished (enhance.ts) — the one place, so every stage, the show and the recordings get the same picture I see.
      if (this.canFilter) c.filter = this.exposure.filter();
      c.drawImage(this.own.canvas, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
      if (this.canFilter) c.filter = 'none';
      if (this.picture === 'camera') {
        // The camera picture as it is: opaque wherever the camera saw (the mask is the frame's measurement, not the picture's).
        m.fillStyle = '#fff';
        m.fillRect(r.dx, r.dy, r.dw, r.dh);
      } else {
        m.drawImage(this.own.maskCanvas, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
        // A camera that sees little of the singer (close up) ends above the stage's riser: its bottom edge is
        // feathered, so the figure fades out instead of ending in a straight cut across the chest.
        const bottom = r.dy + r.dh;
        if (bottom < H * FEATHER_BELOW) {
          const from = bottom - r.dh * FEATHER;
          feather(c, r.dx, r.dw, from, bottom, 'destination-out');
          feather(m, r.dx, r.dw, from, bottom, 'multiply');
        }
      }
    }
    this.frame++;
  }

  get source(): PerformerSource {
    return this.stream ? { kind: 'person', canvas: this.canvas, version: () => this.frame } : { kind: 'none' };
  }

  /** The alpha-packed outgoing stream (created on first use): the frame at its full size (enhance.ts) — each link scales it as it needs. */
  packedStream(): MediaStream {
    if (!this.packer) this.packer = new AlphaPacker(PACK_WIDTH, PACK_HEIGHT);
    if (this.workerOn && this.link) {
      // The worker packs: straight down the track where the browser hand-feeds tracks, else as bitmaps drawn into the packer's canvas.
      this.packedStreamRemote = this.packer.startRemote(15);
      this.link.sink(this.packedStreamRemote.writable);
      this.link.pack(true);
      return this.packedStreamRemote.stream;
    }
    this.packedStreamRemote = null;
    return this.packer.start(this.canvas, this.maskCanvas, 15);
  }

  /** Support / tests: the worker's canvases as they stand (null when the page runs the pipeline). */
  peek(): Promise<{ person: ImageBitmap; mask: ImageBitmap; framed: ImageBitmap; framedMask: ImageBitmap; about: Record<string, unknown> } | null> {
    return this.link ? this.link.peek() : Promise.resolve(null);
  }

  /** The outgoing stream is no longer wanted (off stage, camera off): the packing stops (the worker's too — its writer closed first, its track a moment later, so no frame on its way is dropped unclosed). */
  stopPacking(): void {
    this.link?.pack(false);
    this.link?.sink(null);
    if (this.packedStreamRemote) this.packer?.stopLater();
    else this.packer?.stop();
    this.packedStreamRemote = null;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.unwatch();
    this.onHealth = null;
    this.own.stop();
    this.link?.stop();
    this.link = null;
    if (this.packedStreamRemote) this.packer?.stopLater();
    else this.packer?.stop();
    this.packedStreamRemote = null;
    this.packer = null;
    this.video.onpause = null;
    this.video.srcObject = null;
    this.video.remove();
    this.stream = null;
  }
}
