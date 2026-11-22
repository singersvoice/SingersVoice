/**
 * The show — exactly the broadcast picture Publisher mode shows (every singer on stage cut out over
 * the stage background, huge, no lyrics, the brand's animated mark in the top-right corner —
 * `brandMark.ts`) with the whole mix as its sound (the backing track, this singer's vocal after FX,
 * and every other singer's vocal as it arrives over the mesh). It runs on a singer's device beside
 * the stage: its own 1280×720 canvas, its own 'show' compositor over the same cut-outs the stage
 * draws, its own audio bus on the engine's context. In the Studio, `start`/`stop` record a take of
 * it (one MediaRecorder). In a live meet nothing is recorded per song: the host's device keeps the
 * bus running for the audience (`startTalk`) and the film of the meet (`meetRecorder.ts`) reads the
 * picture (`takeTrack`) and the mix (`setTap`) for the whole meet — one file, a chapter mark per song.
 *
 * Time: the other singers' video and vocals arrive a quarter second late (the mesh), so this
 * device's own cut-out and vocal, and the backing track, are held back by the same lag — the
 * show view does the same with its backing track — and the recording's own timeline is simply
 * "the others' time". Nothing is ever played out loud: the vocals go to the mix only.
 */
import type { BackgroundItem } from '@singersvoice/protocol';
import type { AudioEngine } from '../audio/engine.ts';
import { MixBroadcaster, type MixTarget } from '../audio/mixBroadcast.ts';
import { MixBus } from '../audio/mixBus.ts';
import { LAG_MAX_MS } from './align.ts';
import { BrandMark } from './brandMark.ts';
import { CanvasTrack, canvasTracks } from './canvasTrack.ts';
import { packSize, showBitrate, showSize } from './enhance.ts';
import { StageCompositor, type StagePerformer } from './stage.ts';

export { dbToGain, MIX_DB_MAX, MIX_DB_MIN } from '../audio/gain.ts';
export { safetyStage } from '../audio/dynamics.ts';

/** The show's size and rate on this device (enhance.ts: 1080p30 on a computer, 720p24 on a phone). */
export const SHOW_WIDTH = showSize().width;
export const SHOW_HEIGHT = showSize().height;
export const SHOW_FPS = showSize().fps;
/** How far behind the shared clock the other singers' video and vocals arrive: the local sources are held back to meet them. */
export const VOCAL_LAG_MS = 250;

export interface ShowRecording {
  video: Blob;
  mimeType: string;
  /** The engine's clock when the recorder's first frame went in (see `lagMs` for what it shows). */
  startCtxTime: number;
  /** The picture at any moment shows this device's own sources this much earlier (they are held back to meet the others). */
  lagMs: number;
  /** This singer's own cut-out, alpha-packed, recorded beside the show (join.ts): another singer's stage draws them from it. Null without a camera or where the browser cannot record it. */
  cutout: { video: Blob; mimeType: string; startCtxTime: number } | null;
}

/** The cut-out video's frame: the person over black on the left, the grey mask on the right (alphaPack.ts), at the packer's size (enhance.ts: 720×960 on a computer). */
export const CUTOUT_WIDTH = packSize().width;
export const CUTOUT_HEIGHT = packSize().height;
export const CUTOUT_FPS = 15;
/** The cut-out video's bitrate for its size: 600 kbps at 320×426, in proportion to the pixels above that. */
export const cutoutBitrate = (width: number, height: number): number => Math.round(600_000 * Math.max(1, (width * height) / (320 * 426)));

/** The best container for the cut-out video on this browser ('' = none): a video track alone, light to encode. */
export function pickCutoutMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/mp4;codecs="avc1.64002A"', 'video/mp4;codecs="avc1.42E01E"', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm'];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? '';
}

/**
 * The best MediaRecorder container for the show on this browser ('' = none): MP4 first — H.264 +
 * AAC where the browser has it (Windows / Mac / iOS), else H.264 + Opus — so a saved performance
 * plays anywhere a Drive link is opened; WebM only where MP4 is not on offer (Firefox).
 */
export function pickShowMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  // H.264 High profile, level 4.2 (1080p60 room) first, Main next, the Baseline last: the same bitrate buys a cleaner picture.
  const candidates = [
    'video/mp4;codecs="avc1.64002A,mp4a.40.2"',
    'video/mp4;codecs="avc1.4D402A,mp4a.40.2"',
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs="avc1.4D401F,mp4a.40.2"',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs="avc1.64002A,opus"',
    'video/mp4;codecs="avc1.42E01E,opus"',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? '';
}

export const showSupported = (): boolean => pickShowMime() !== '' && canvasTracks();

/** A cut-out held back by a few frames: this device's singer as the others see them, in step with their vocal. */
class DelayedCanvas {
  readonly out = document.createElement('canvas');
  private ring: HTMLCanvasElement[] = [];
  private head = 0;

  constructor(
    private readonly src: HTMLCanvasElement,
    /** How many frames back; a change takes effect on the next tick (the ring is remade). */
    public frames: number,
  ) {}

  tick(): void {
    const w = this.src.width;
    const h = this.src.height;
    if (!w || !h) return;
    if (this.ring.length !== this.frames + 1 || this.ring[0]!.width !== w || this.ring[0]!.height !== h) {
      this.ring = Array.from({ length: this.frames + 1 }, () => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      });
      this.out.width = w;
      this.out.height = h;
      this.head = 0;
    }
    const slot = this.ring[this.head]!;
    const sc = slot.getContext('2d')!;
    sc.clearRect(0, 0, w, h);
    sc.drawImage(this.src, 0, 0);
    this.head = (this.head + 1) % this.ring.length; // now the oldest frame
    const oc = this.out.getContext('2d')!;
    oc.clearRect(0, 0, w, h);
    oc.drawImage(this.ring[this.head]!, 0, 0);
  }
}

export class ShowRecorder {
  readonly canvas: HTMLCanvasElement;
  private readonly c2d: CanvasRenderingContext2D;
  private readonly compositor = new StageCompositor('show');
  /** The brand's mark over every frame (the recording, the film, the broadcast carry it). */
  readonly mark = new BrandMark();
  private performers: StagePerformer[] = [];
  private delayed = new Map<string, DelayedCanvas>();
  private background: { item: BackgroundItem; src: string } | null = null;
  private bgImage: HTMLImageElement | null = null;
  private bgVideo: HTMLVideoElement | null = null;
  /** Remote vocals: each one feeds the mix (and a muted element, which some browsers need before a remote stream flows into WebAudio). */
  private vocals = new Map<string, { stream: MediaStream; el: HTMLAudioElement; node: MediaStreamAudioSourceNode | null }>();
  private audio: { ctx: AudioContext; dest: MediaStreamAudioDestinationNode; bus: MixBus; localTrack: DelayNode; localVocal: DelayNode; taps: { node: AudioNode; to: AudioNode }[] } | null = null;
  /** The host's device: the mix goes out to the audience in one-second batches, to this (the meet's mix route and this device's resume token; null elsewhere). */
  broadcast: (() => MixTarget | null) | null = null;
  /** Whether anybody is listening to the mix right now (the service's word): no listener, no encoding, nothing sent. */
  broadcastWanted: (() => boolean) | null = null;
  private broadcaster: MixBroadcaster | null = null;
  /** Batches sent to the audience so far in this song. */
  get broadcastSent(): number {
    return this.broadcaster?.sent ?? 0;
  }
  private mr: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  /** The engine's clock at the recorder's `onstart`, then at the first frame pushed after it (the file's frame 0 — what the offsets are measured from). */
  private startCtx: number | null = null;
  private firstFrameWanted = false;
  /** This singer's live cut-out and its mask (the local feed's canvases), recorded alpha-packed beside the show while a camera is on. */
  private cutoutSource: { person: HTMLCanvasElement; mask: HTMLCanvasElement } | null = null;
  private cutout: { mr: MediaRecorder; track: CanvasTrack; canvas: HTMLCanvasElement; c2d: CanvasRenderingContext2D; chunks: Blob[]; startCtx: number | null; firstFrameWanted: boolean; lastFrameAt: number } | null = null;
  /** The cut-out beside the show: set by a stage whose singer may be joined later (the Studio); null records the show alone. */
  setCutoutSource(src: { person: HTMLCanvasElement; mask: HTMLCanvasElement } | null): void {
    this.cutoutSource = src;
  }
  /** A cut-out is being recorded beside the show (tests). */
  get recordingCutout(): boolean {
    return this.cutout !== null;
  }
  /** Every track made from the picture (the recording's, the film's): each drawn frame is pushed down all of them, visible tab or not. */
  private readonly tracks = new Set<CanvasTrack>();
  private recTrack: CanvasTrack | null = null;
  /** A track of the picture for another recorder (the film of the meet): fed with every frame drawn here until `releaseTrack`. */
  takeTrack(fps = this.fps): CanvasTrack {
    const t = new CanvasTrack(this.canvas, fps);
    this.tracks.add(t);
    return t;
  }
  releaseTrack(t: CanvasTrack): void {
    this.tracks.delete(t);
    t.stop();
  }
  private timer: ReturnType<typeof setInterval> | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private engine: AudioEngine | null = null;
  /** Running = drawing (from `start` until `stop`); recording = the MediaRecorder is on. */
  running = false;
  readonly width: number;
  readonly height: number;
  /** How far this device's own sources are held back to meet the others (align.ts sets it per song; VOCAL_LAG_MS at least). */
  private lag = VOCAL_LAG_MS;
  get lagMs(): number {
    return this.lag;
  }
  /**
   * The lag for the coming song (align.ts): the own voice and picture wait this long, the track this plus the round
   * trip. Set at the count-in, never while a take is being recorded (a delay that moves mid-song bends the sound).
   */
  setLag(ms: number): void {
    const v = Math.max(VOCAL_LAG_MS, Math.round(ms));
    if (v === this.lag || this.recording) return;
    this.lag = v;
    const frames = Math.max(1, Math.round((v / 1000) * this.fps));
    for (const d of this.delayed.values()) d.frames = frames;
    if (this.audio && this.engine) {
      const lagS = v / 1000;
      this.audio.localVocal.delayTime.value = lagS;
      this.audio.localTrack.delayTime.value = lagS + this.engine.roundTripMs / 1000;
    }
  }

  /** Frames a second the picture is drawn and recorded at. */
  readonly fps: number;

  constructor(width = SHOW_WIDTH, height = SHOW_HEIGHT, fps = SHOW_FPS) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.c2d = this.canvas.getContext('2d', { alpha: false })!;
    this.compositor.resize(width, height, 1);
  }

  get recording(): boolean {
    return this.mr?.state === 'recording' || this.mr?.state === 'paused';
  }

  /** The background being drawn (its id; '' for none). */
  get backgroundId(): string {
    return this.background?.item.id ?? '';
  }

  /** The stage background behind the singers (same-origin image or looping video, as the show view draws it). */
  setBackground(item: BackgroundItem | null | undefined, src: string): void {
    if (!item || !src) {
      this.background = null;
      return;
    }
    if (this.background?.src === src) return;
    this.background = { item, src };
    this.bgVideo?.pause();
    this.bgVideo = null;
    this.bgImage = null;
    if (item.kind === 'video') {
      const v = document.createElement('video');
      v.src = src;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = 'auto';
      void v.play().catch(() => undefined);
      this.bgVideo = v;
    } else {
      const img = new Image();
      img.src = src;
      this.bgImage = img;
    }
  }

  /**
   * The same performers the stage draws; this device's own cut-out is held back by the lag. Nobody is
   * drawn mirrored here: the screen shows a singer their own front camera as a mirror (what every phone
   * does), but what is recorded, filmed and streamed is the stage as the audience sees it — writing on a
   * shirt reads the right way round, a raised right hand is the right hand.
   */
  setPerformers(list: StagePerformer[]): void {
    const ids = new Set(list.map((p) => p.id));
    for (const id of [...this.delayed.keys()]) if (!ids.has(id)) this.delayed.delete(id);
    const frames = Math.max(1, Math.round((this.lagMs / 1000) * this.fps));
    this.performers = list.map((p) => {
      if (!p.isMe || p.source.kind !== 'person') return { ...p, mirror: false };
      let d = this.delayed.get(p.id);
      if (!d) {
        d = new DelayedCanvas(p.source.canvas, frames);
        this.delayed.set(p.id, d);
      }
      const src = p.source;
      return { ...p, mirror: false, label: p.label.replace(/^You\b/, this.youLabel ?? 'You'), source: { kind: 'person', canvas: d.out, version: src.version } };
    });
    this.compositor.setPerformers(this.performers);
  }

  /** What the recording draws (tests: nobody mirrored, this device's singer behind the lag). */
  get drawnPerformers(): readonly StagePerformer[] {
    return this.performers;
  }

  /** The recording names this device's singer like everyone else ("You" is for the screen). */
  youLabel: string | null = null;

  /**
   * Talk-back: between songs the singers on stage hear each other (the vocals that arrive play
   * here); from the countdown to the end of the song they do not — Solo foldback, so latency
   * never pulls a duet apart. The vocals feed the mix (the recording, the audience) either way.
   */
  private hearOthers = false;
  setHearOthers(hear: boolean): void {
    if (this.hearOthers === hear) return;
    this.hearOthers = hear;
    for (const v of this.vocals.values()) {
      v.el.muted = !hear;
      if (hear) void v.el.play().catch(() => undefined);
    }
  }
  get hearingOthers(): boolean {
    return this.hearOthers;
  }

  /** Another singer's vocal arrived (stream) or went away (null). */
  setVocal(id: string, stream: MediaStream | null): void {
    const had = this.vocals.get(id);
    if (had && had.stream === stream) return;
    if (had) {
      this.audio?.bus.removeVocal(id);
      had.node?.disconnect();
      had.el.srcObject = null;
      had.el.remove();
      this.vocals.delete(id);
    }
    if (!stream) return;
    const el = document.createElement('audio');
    el.muted = !this.hearOthers; // heard only between songs (talk-back); during the song it only keeps the stream flowing for the mix
    el.autoplay = true;
    el.dataset.svVocal = id;
    el.style.display = 'none';
    el.srcObject = stream;
    document.body.appendChild(el);
    void el.play().catch(() => undefined);
    const entry = { stream, el, node: null as MediaStreamAudioSourceNode | null };
    this.vocals.set(id, entry);
    if (this.audio) this.plugVocal(id, entry);
  }

  private plugVocal(id: string, v: { stream: MediaStream; node: MediaStreamAudioSourceNode | null }): void {
    if (!this.audio || v.node) return;
    try {
      v.node = this.audio.ctx.createMediaStreamSource(v.stream);
      this.audio.bus.addVocal(id, v.node);
    } catch {
      v.node = null;
    }
  }

  /** Someone reads the canvas for the whole meet (the film of the meet, `MeetRecorder`): the picture is drawn between songs too, and `stop` leaves it running. */
  keepDrawing = false;

  private ensureDrawing(fps = this.fps): void {
    this.running = true;
    if (this.timer) return;
    this.timer = setInterval(() => this.frame(), 1000 / fps);
    this.frame();
  }

  /** Draw the picture only (the publisher's broadcast encoder, the film of the meet read the canvas); no recorder, no audio bus. */
  startDrawing(fps = this.fps): void {
    this.ensureDrawing(fps);
  }

  stopDrawing(): void {
    if (this.mr || this.keepDrawing) return; // a recording is running: stop() ends it; the film of the meet: its own stop
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * A listener on the mix for the whole meet (the film of the meet): every bus this device builds
   * — the song's, the talk between songs — feeds it, so the film hears everything the audience hears.
   */
  private tap: AudioNode | null = null;
  setTap(node: AudioNode | null): void {
    if (this.tap && this.audio) {
      try {
        this.audio.bus.output.disconnect(this.tap);
      } catch {
        /* not connected */
      }
    }
    this.tap = node;
    if (node && this.audio) this.audio.bus.output.connect(node);
  }

  /**
   * The mix without a recording: on the host's device between songs, so the audience keeps
   * hearing the stage (the singers talking) — the bus and the relay run; `start` then records
   * through the same bus when the song begins, and `stop` tears it down (call again after).
   */
  private talkWanted = false;
  startTalk(engine: AudioEngine): void {
    this.engine = engine;
    this.talkWanted = true;
    this.buildAudio(engine);
  }

  /** Tear the talk mix down (the singer left the stage); a running recording is left alone. */
  stopTalk(): void {
    this.talkWanted = false;
    if (this.mr) return;
    this.tearDownAudio();
  }

  /** The mix bus (talk or recording) is up on this device. */
  get mixing(): boolean {
    return this.audio !== null;
  }

  /** What each source brings to this device's mix right now (the track, every voice by id — 'me' is this singer), or null without a bus. */
  mixLevels(): { track: number; vocals: Record<string, number> } | null {
    return this.audio?.bus.levels() ?? null;
  }

  /**
   * Start drawing now (if not already — the picture may be running for the film of the meet) and
   * recording now too, ahead of `atCtxTime` (the song's kickstart on the engine's clock): a recorder
   * takes a moment to start, and one started at the kickstart loses the first beat to it — so it
   * starts at once, the few seconds of stage before the music go in, and the first frame's clock
   * (`startCtxTime`, before the kickstart) gives the show's exact place on the song, as the vocal
   * recorder's does for the voice.
   */
  start(engine: AudioEngine, atCtxTime: number): void {
    void atCtxTime; // the kickstart is still the song's origin for the offsets; the recording need not wait for it
    if (this.mr) return; // a song is being recorded already
    this.engine = engine;
    this.buildAudio(engine);
    this.chunks = [];
    this.startCtx = null;
    this.ensureDrawing();
    const mime = pickShowMime();
    if (!mime || !this.audio) return;
    const recTrack = this.takeTrack();
    const stream = new MediaStream([recTrack.track, ...this.audio.dest.stream.getAudioTracks()]);
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: showBitrate(this.width, this.height), audioBitsPerSecond: 192_000 });
    } catch {
      this.releaseTrack(recTrack);
      return;
    }
    this.recTrack = recTrack;
    mr.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    mr.onstart = () => {
      this.startCtx = engine.ctx.currentTime;
      this.firstFrameWanted = true; // the next frame drawn is the file's frame 0: its clock is the exact one
    };
    this.mr = mr;
    const cut = this.cutoutSource ? this.startCutout(engine) : null;
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => {
      try {
        if (mr.state === 'inactive') mr.start(1000);
      } catch {
        this.mr = null;
      }
      try {
        if (cut && cut.mr.state === 'inactive') cut.mr.start(1000);
      } catch {
        this.dropCutout();
      }
    }, 0);
  }

  /** The cut-out's recorder: the packed frame fed from `frame()` at the cut-out's own rate, started with the show's. */
  private startCutout(engine: AudioEngine): NonNullable<ShowRecorder['cutout']> | null {
    const mime = pickCutoutMime();
    if (!mime) return null;
    const canvas = document.createElement('canvas');
    canvas.width = CUTOUT_WIDTH * 2;
    canvas.height = CUTOUT_HEIGHT;
    const c2d = canvas.getContext('2d', { alpha: false });
    if (!c2d) return null;
    c2d.fillStyle = '#000';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    const track = new CanvasTrack(canvas, CUTOUT_FPS);
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(new MediaStream([track.track]), { mimeType: mime, videoBitsPerSecond: cutoutBitrate(CUTOUT_WIDTH, CUTOUT_HEIGHT) });
    } catch {
      track.stop();
      return null;
    }
    const cut: NonNullable<ShowRecorder['cutout']> = { mr, track, canvas, c2d, chunks: [], startCtx: null, firstFrameWanted: false, lastFrameAt: 0 };
    mr.ondataavailable = (e) => e.data.size && cut.chunks.push(e.data);
    mr.onstart = () => {
      cut.startCtx = engine.ctx.currentTime;
      cut.firstFrameWanted = true;
    };
    this.cutout = cut;
    return cut;
  }

  private dropCutout(): void {
    const cut = this.cutout;
    this.cutout = null;
    if (!cut) return;
    try {
      if (cut.mr.state !== 'inactive') cut.mr.stop();
    } catch {
      /* already stopped */
    }
    cut.track.stop();
  }

  /** The packed cut-out frame — person left, mask right — at the cut-out's own rate, down its track. */
  private cutoutFrame(now: number): void {
    const cut = this.cutout;
    const src = this.cutoutSource;
    if (!cut || !src) return;
    if (now - cut.lastFrameAt < 1000 / CUTOUT_FPS - 2) return;
    cut.lastFrameAt = now;
    const c = cut.c2d;
    c.fillStyle = '#000';
    c.fillRect(0, 0, CUTOUT_WIDTH * 2, CUTOUT_HEIGHT);
    if (src.person.width && src.person.height) {
      c.drawImage(src.person, 0, 0, CUTOUT_WIDTH, CUTOUT_HEIGHT);
      c.drawImage(src.mask, CUTOUT_WIDTH, 0, CUTOUT_WIDTH, CUTOUT_HEIGHT);
    }
    if (cut.firstFrameWanted && this.engine) {
      cut.firstFrameWanted = false;
      cut.startCtx = this.engine.ctx.currentTime;
    }
    cut.track.push();
  }

  pause(): void {
    try {
      if (this.mr?.state === 'recording') this.mr.pause();
      if (this.cutout?.mr.state === 'recording') this.cutout.mr.pause();
    } catch {
      /* ignore */
    }
  }

  resume(): void {
    try {
      if (this.mr?.state === 'paused') this.mr.resume();
      if (this.cutout?.mr.state === 'paused') this.cutout.mr.resume();
    } catch {
      /* ignore */
    }
  }

  /** Stop recording and drawing; resolves with the show, or null when nothing was recorded. */
  async stop(): Promise<ShowRecording | null> {
    clearTimeout(this.startTimer);
    const mr = this.mr;
    this.mr = null;
    this.firstFrameWanted = false;
    let out: ShowRecording | null = null;
    if (mr && mr.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        mr.onstop = () => resolve();
        try {
          mr.stop();
        } catch {
          resolve();
        }
      });
      const video = new Blob(this.chunks, { type: mr.mimeType });
      if (video.size && this.startCtx !== null) out = { video, mimeType: mr.mimeType, startCtxTime: this.startCtx, lagMs: this.lagMs, cutout: null };
    }
    // The cut-out beside it, stopped the same way; a cut-out without a show is nothing.
    const cut = this.cutout;
    this.cutout = null;
    if (cut) {
      if (cut.mr.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          cut.mr.onstop = () => resolve();
          try {
            cut.mr.stop();
          } catch {
            resolve();
          }
        });
      }
      cut.track.stop();
      const video = new Blob(cut.chunks, { type: cut.mr.mimeType });
      if (out && video.size && cut.startCtx !== null) out.cutout = { video, mimeType: cut.mr.mimeType, startCtxTime: cut.startCtx };
    }
    if (this.recTrack) {
      this.releaseTrack(this.recTrack);
      this.recTrack = null;
    }
    this.chunks = [];
    if (!this.keepDrawing) {
      this.running = false;
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.tearDownAudio();
    if (this.talkWanted && this.engine) this.buildAudio(this.engine); // the stage talk goes on for the audience
    return out;
  }

  dispose(): void {
    void this.stop();
    this.dropCutout();
    for (const id of [...this.vocals.keys()]) this.setVocal(id, null);
    this.bgVideo?.pause();
    this.bgVideo = null;
    this.compositor.stop();
    this.mark.dispose();
  }

  // ---- the mix: backing track + own vocal (held back by the lag) + every other singer's vocal, through the shared bus ----

  /** The balance this device mixes at (dB) — the singer's Track / Vocal controls; applied live. */
  setBalance(trackDb: number, vocalDb: number): void {
    this.balance = { trackDb, vocalDb };
    this.audio?.bus.setBalance(trackDb, vocalDb);
  }
  private balance = { trackDb: 0, vocalDb: 0 };

  private buildAudio(engine: AudioEngine): void {
    if (this.audio) return;
    const ctx = engine.ctx;
    const dest = ctx.createMediaStreamDestination();
    const bus = new MixBus(ctx, engine.workletAvailable);
    bus.setBalance(this.balance.trackDb, this.balance.vocalDb);
    bus.output.connect(dest);
    if (this.tap) bus.output.connect(this.tap); // the film of the meet hears this bus too
    const lagS = this.lagMs / 1000;
    // This device's own sources wait for the others; the track also waits the round trip the singer
    // sings against (speakers out, microphone in, the chain), so the voice lands on the beat it was sung to.
    // (The others are each held back by what they are early by, in their link's jitter buffer — align.ts.)
    const localTrack = ctx.createDelay(LAG_MAX_MS / 1000 + 1);
    localTrack.delayTime.value = lagS + engine.roundTripMs / 1000;
    localTrack.connect(bus.backingIn);
    const localVocal = ctx.createDelay(LAG_MAX_MS / 1000 + 1);
    localVocal.delayTime.value = lagS;
    const taps: { node: AudioNode; to: AudioNode }[] = [];
    const player = engine.player;
    if (player) {
      player.out.connect(localTrack); // the track at its mix level — never the singer's listening level
      taps.push({ node: player.out, to: localTrack });
    }
    // My voice as it leaves the engine (after the FX; the raw microphone when the engine had to give the FX up).
    const vocal = engine.voice;
    vocal.connect(localVocal);
    taps.push({ node: vocal, to: localVocal });
    bus.addVocal('me', localVocal);
    this.audio = { ctx, dest, bus, localTrack, localVocal, taps };
    for (const [id, v] of this.vocals) this.plugVocal(id, v);
    // The audience hears this very mix: the host's device sends it out a second at a time (WebCodecs/Opus).
    if (this.broadcast) {
      // The Worker labels every block with the track's position at that instant, from the schedule it is told every quarter second (the player's own arithmetic, the mix's lag taken off).
      const schedule = () => {
        const p = engine.player;
        if (!p) return null;
        const now = ctx.currentTime;
        return { ctxTime: now, posMs: Math.max(0, p.positionAt(now - this.lagMs / 1000)), playing: p.playing, tempo: p.tempoRate, durationMs: p.durationMs };
      };
      this.broadcaster = new MixBroadcaster(ctx, this.broadcast, schedule, this.broadcastWanted ?? (() => true));
      this.broadcaster.start(bus.output);
    }
  }

  private tearDownAudio(): void {
    this.broadcaster?.stop();
    this.broadcaster = null;
    const a = this.audio;
    if (!a) return;
    for (const t of a.taps) {
      try {
        t.node.disconnect(t.to);
      } catch {
        /* not connected there */
      }
    }
    for (const v of this.vocals.values()) {
      v.node?.disconnect();
      v.node = null;
    }
    a.localTrack.disconnect();
    a.localVocal.disconnect();
    a.bus.dispose();
    this.audio = null;
  }

  // ---- the picture: background, then the show compositor's transparent stage, then the brand's mark ----

  private frame(): void {
    const c = this.c2d;
    const W = this.width;
    const H = this.height;
    try {
      this.drawBackground(c, W, H);
      for (const d of this.delayed.values()) d.tick();
      this.compositor.draw();
      c.drawImage(this.compositor.canvas, 0, 0, W, H);
      this.mark.draw(c, W, H);
      if (this.cutout) this.cutoutFrame(Date.now());
    } catch (e) {
      console.warn('show frame', e); // one bad frame never stops the recording
    }
    if (this.firstFrameWanted && this.engine) {
      this.firstFrameWanted = false;
      this.startCtx = this.engine.ctx.currentTime;
    }
    for (const t of this.tracks) t.push(); // the frame goes down every track by hand: a hidden tab records and streams on
  }

  private drawBackground(c: CanvasRenderingContext2D, W: number, H: number): void {
    c.fillStyle = '#0b0418';
    c.fillRect(0, 0, W, H);
    const img = this.bgImage && this.bgImage.complete && this.bgImage.naturalWidth ? this.bgImage : null;
    const vid = this.bgVideo && this.bgVideo.readyState >= 2 && this.bgVideo.videoWidth ? this.bgVideo : null;
    const src = img ?? vid;
    if (!src) return;
    const sw = img ? img.naturalWidth : vid!.videoWidth;
    const sh = img ? img.naturalHeight : vid!.videoHeight;
    const s = Math.max(W / sw, H / sh); // cover
    const dw = sw * s;
    const dh = sh * s;
    c.save();
    c.filter = 'brightness(0.6) saturate(1.05)'; // as the show view shows it
    c.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    c.restore();
  }
}
