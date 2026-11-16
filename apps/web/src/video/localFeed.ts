/**
 * My own camera on the virtual stage: a hidden <video> for the camera stream, the person segmenter
 * that cuts me out of it, the stage frame (`framing.ts`: my head the standard size at the standard
 * place, so I am the same size as everyone else on every stage) set once and held by the seat —
 * never steered after my every sway — and applied to the cut-out, and — in a live meet — the alpha
 * packer that turns the framed cut-out into the stream other performers receive. One instance per
 * stage session.
 */
import { AlphaPacker } from './alphaPack.ts';
import { cropFactor, distanceNote, measureMask, plausibleHead, Seat, visiblePart, type PersonMeasure, type SeatState } from './framing.ts';
import { PersonSegmenter, type SegmenterMode } from './segmenter.ts';
import type { PerformerSource } from './stage.ts';

/** The cut-out's own size: computers work at 720×960 so a singer standing full-height in a 720p show is drawn near 1:1; phones at 480×640. */
const COMPUTER = typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 2) >= 4 && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const W = COMPUTER ? 720 : 480;
const H = COMPUTER ? 960 : 640;
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

export class LocalFeed {
  readonly video: HTMLVideoElement;
  readonly segmenter = new PersonSegmenter(W, H);
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
  /** The stage frame, set from the measured head and held (`framing.ts`). */
  readonly seat = new Seat(W, H);
  private probe: CanvasRenderingContext2D | null = null;
  private lastProbe = 0;
  private lastProbedSeg = -1;
  /** Increments on every framed frame (compositor redraws only when it changed). */
  frame = 0;

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
  }

  /** Point the feed at a camera stream (or null to go dark). */
  attach(stream: MediaStream | null, useModel = true): void {
    if (stream === this.stream && stream && useModel === this.useModel) return;
    this.stream = stream;
    this.useModel = useModel;
    this.segmenter.stop();
    clearInterval(this.timer);
    this.unwatch();
    if (!stream) {
      this.video.srcObject = null;
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
    void this.segmenter.start(this.video, useModel, (m) => {
      this.mode = m;
      this.onMode?.(m);
    });
    this.timer = setInterval(() => this.tick(), 1000 / 15);
  }

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
    if (!found || this.segmenter.mode !== 'model') {
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
    if (this.segmenter.frame === this.lastProbedSeg || now - this.lastProbe < PROBE_EVERY_MS) return undefined;
    this.lastProbedSeg = this.segmenter.frame;
    this.lastProbe = now;
    if (!this.probe) {
      const pc = document.createElement('canvas');
      pc.width = PROBE_W;
      pc.height = PROBE_H;
      this.probe = pc.getContext('2d', { willReadFrequently: true });
      if (!this.probe) return undefined;
    }
    try {
      this.probe.drawImage(this.segmenter.maskCanvas, 0, 0, PROBE_W, PROBE_H);
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
    const trusted = this.segmenter.mode === 'model' && this.segmenter.maskMode !== 'soft-center';
    this.seat.sample(trusted && found && plausibleHead(found) ? found.head : null, now);
    const t = this.seat.target;
    const note = t ? distanceNote(cropFactor(t, H)) : null;
    if (note !== this.note) {
      this.note = note;
      this.onNote?.(note);
    }
  }

  /** Where the seat is: settling (the whole camera frame goes out), gliding to a new frame, or held. */
  get seatState(): SeatState {
    return this.seat.state(performance.now());
  }

  private tick(): void {
    const now = performance.now();
    this.measure(now);
    if (this.segmenter.frame === this.lastSeg && this.seat.state(now) !== 'gliding') return; // nothing new to draw
    this.lastSeg = this.segmenter.frame;
    const r = visiblePart(this.seat.crop(now), W, H); // the crop may reach past the camera picture: that part stays transparent
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    const m = this.maskCtx;
    m.fillStyle = '#000';
    m.fillRect(0, 0, W, H);
    if (r) {
      c.drawImage(this.segmenter.canvas, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
      m.drawImage(this.segmenter.maskCanvas, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
      // A camera that sees little of the singer (close up) ends above the stage's riser: its bottom edge is
      // feathered, so the figure fades out instead of ending in a straight cut across the chest.
      const bottom = r.dy + r.dh;
      if (bottom < H * FEATHER_BELOW) {
        const from = bottom - r.dh * FEATHER;
        feather(c, r.dx, r.dw, from, bottom, 'destination-out');
        feather(m, r.dx, r.dw, from, bottom, 'multiply');
      }
    }
    this.frame++;
  }

  get source(): PerformerSource {
    return this.stream ? { kind: 'person', canvas: this.canvas, version: () => this.frame } : { kind: 'none' };
  }

  /** The alpha-packed outgoing stream (created on first use). */
  packedStream(): MediaStream {
    if (!this.packer) this.packer = new AlphaPacker(320, 426);
    return this.packer.start(this.canvas, this.maskCanvas, 15);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.unwatch();
    this.onHealth = null;
    this.segmenter.stop();
    this.packer?.stop();
    this.packer = null;
    this.video.onpause = null;
    this.video.srcObject = null;
    this.video.remove();
    this.stream = null;
  }
}
