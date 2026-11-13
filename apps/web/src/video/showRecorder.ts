/**
 * The saved performance: a recording of the show — exactly the broadcast picture Publisher mode
 * shows (every singer on stage cut out over the stage background, huge, no lyrics) with the whole
 * mix as its sound (the backing track, this singer's vocal after FX, and every other singer's
 * vocal as it arrives over the mesh). It runs on a singer's device beside the live stage: its
 * own 1280×720 canvas, its own 'show' compositor over the same cut-outs the stage draws, its own
 * audio bus on the engine's context, one MediaRecorder.
 *
 * Time: the other singers' video and vocals arrive a quarter second late (the mesh), so this
 * device's own cut-out and vocal, and the backing track, are held back by the same lag — the
 * show view does the same with its backing track — and the recording's own timeline is simply
 * "the others' time". Nothing is ever played out loud: the vocals go to the recording only.
 */
import type { BackgroundItem, MixBatch } from '@singersvoice/protocol';
import type { AudioEngine } from '../audio/engine.ts';
import { MixBroadcaster } from '../audio/mixBroadcast.ts';
import { StageCompositor, type StagePerformer } from './stage.ts';

export const SHOW_WIDTH = 1280;
export const SHOW_HEIGHT = 720;
export const SHOW_FPS = 24;
/** How far behind the shared clock the other singers' video and vocals arrive: the local sources are held back to meet them. */
export const VOCAL_LAG_MS = 250;
/** The mix: every vocal a little up, the backing track a little under — the voice on top, as a karaoke performance should sound. */
export const VOCAL_IN_MIX = 1.41; // +3 dB
export const BACKING_IN_MIX = 0.79; // −2 dB

export interface ShowRecording {
  video: Blob;
  mimeType: string;
  /** The engine's clock when the recorder's first frame went in (see `lagMs` for what it shows). */
  startCtxTime: number;
  /** The picture at any moment shows this device's own sources this much earlier (they are held back to meet the others). */
  lagMs: number;
}

/**
 * The best MediaRecorder container for the show on this browser ('' = none): MP4 first — H.264 +
 * AAC where the browser has it (Windows / Mac / iOS), else H.264 + Opus — so a saved performance
 * plays anywhere a Drive link is opened; WebM only where MP4 is not on offer (Firefox).
 */
export function pickShowMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs="avc1.4D401F,mp4a.40.2"',
    'video/mp4;codecs=avc1,mp4a.40.2',
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

export const showSupported = (): boolean => pickShowMime() !== '' && typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;

/** A cut-out held back by a few frames: this device's singer as the others see them, in step with their vocal. */
class DelayedCanvas {
  readonly out = document.createElement('canvas');
  private ring: HTMLCanvasElement[] = [];
  private head = 0;

  constructor(
    private readonly src: HTMLCanvasElement,
    private readonly frames: number,
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
  private performers: StagePerformer[] = [];
  private delayed = new Map<string, DelayedCanvas>();
  private background: { item: BackgroundItem; src: string } | null = null;
  private bgImage: HTMLImageElement | null = null;
  private bgVideo: HTMLVideoElement | null = null;
  /** Remote vocals: each one feeds the mix (and a muted element, which some browsers need before a remote stream flows into WebAudio). */
  private vocals = new Map<string, { stream: MediaStream; el: HTMLAudioElement; node: MediaStreamAudioSourceNode | null }>();
  private audio: { ctx: AudioContext; dest: MediaStreamAudioDestinationNode; local: DelayNode; bus: GainNode; taps: AudioNode[]; backingLevel: GainNode; vocalLevel: GainNode; limiter: DynamicsCompressorNode } | null = null;
  /** The host's device: the mix goes out to the audience in one-second batches through this (null elsewhere). */
  broadcast: ((batch: MixBatch) => Promise<void>) | null = null;
  private broadcaster: MixBroadcaster | null = null;
  /** Batches sent to the audience so far in this song. */
  get broadcastSent(): number {
    return this.broadcaster?.sent ?? 0;
  }
  private mr: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startCtx: number | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private engine: AudioEngine | null = null;
  /** Running = drawing (from `start` until `stop`); recording = the MediaRecorder is on. */
  running = false;
  readonly width: number;
  readonly height: number;
  readonly lagMs = VOCAL_LAG_MS;

  constructor(width = SHOW_WIDTH, height = SHOW_HEIGHT) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.c2d = this.canvas.getContext('2d', { alpha: false })!;
    this.compositor.resize(width, height, 1);
  }

  get recording(): boolean {
    return this.mr?.state === 'recording' || this.mr?.state === 'paused';
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

  /** The same performers the stage draws; this device's own cut-out is held back by the lag. */
  setPerformers(list: StagePerformer[]): void {
    const ids = new Set(list.map((p) => p.id));
    for (const id of [...this.delayed.keys()]) if (!ids.has(id)) this.delayed.delete(id);
    const frames = Math.max(1, Math.round((this.lagMs / 1000) * SHOW_FPS));
    this.performers = list.map((p) => {
      if (!p.isMe || p.source.kind !== 'person') return p;
      let d = this.delayed.get(p.id);
      if (!d) {
        d = new DelayedCanvas(p.source.canvas, frames);
        this.delayed.set(p.id, d);
      }
      const src = p.source;
      return { ...p, label: p.label.replace(/^You\b/, this.youLabel ?? 'You'), source: { kind: 'person', canvas: d.out, version: src.version } };
    });
    this.compositor.setPerformers(this.performers);
  }

  /** The recording names this device's singer like everyone else ("You" is for the screen). */
  youLabel: string | null = null;

  /** Another singer's vocal arrived (stream) or went away (null). */
  setVocal(id: string, stream: MediaStream | null): void {
    const had = this.vocals.get(id);
    if (had && had.stream === stream) return;
    if (had) {
      had.node?.disconnect();
      had.el.srcObject = null;
      had.el.remove();
      this.vocals.delete(id);
    }
    if (!stream) return;
    const el = document.createElement('audio');
    el.muted = true; // never heard here — Solo foldback; it only keeps the stream flowing for the mix
    el.autoplay = true;
    el.style.display = 'none';
    el.srcObject = stream;
    document.body.appendChild(el);
    void el.play().catch(() => undefined);
    const entry = { stream, el, node: null as MediaStreamAudioSourceNode | null };
    this.vocals.set(id, entry);
    if (this.audio) this.plugVocal(entry);
  }

  private plugVocal(v: { stream: MediaStream; node: MediaStreamAudioSourceNode | null }): void {
    if (!this.audio || v.node) return;
    try {
      v.node = this.audio.ctx.createMediaStreamSource(v.stream);
      const level = this.audio.ctx.createGain();
      level.gain.value = VOCAL_IN_MIX;
      v.node.connect(level).connect(this.audio.bus);
    } catch {
      v.node = null;
    }
  }

  /**
   * Start drawing now and recording at `atCtxTime` (the song's kickstart on the engine's clock), so
   * the first frames are already in step when the music starts.
   */
  start(engine: AudioEngine, atCtxTime: number): void {
    if (this.running) return;
    this.running = true;
    this.engine = engine;
    this.buildAudio(engine);
    this.chunks = [];
    this.startCtx = null;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.frame(), 1000 / SHOW_FPS);
    this.frame();
    const mime = pickShowMime();
    if (!mime || !this.audio) return;
    const stream = new MediaStream([...this.canvas.captureStream(SHOW_FPS).getVideoTracks(), ...this.audio.dest.stream.getAudioTracks()]);
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 192_000 });
    } catch {
      return;
    }
    mr.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    mr.onstart = () => {
      this.startCtx = engine.ctx.currentTime;
    };
    this.mr = mr;
    const inMs = Math.max(0, (atCtxTime - engine.ctx.currentTime) * 1000);
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => {
      try {
        if (mr.state === 'inactive') mr.start(1000);
      } catch {
        this.mr = null;
      }
    }, inMs);
  }

  pause(): void {
    try {
      if (this.mr?.state === 'recording') this.mr.pause();
    } catch {
      /* ignore */
    }
  }

  resume(): void {
    try {
      if (this.mr?.state === 'paused') this.mr.resume();
    } catch {
      /* ignore */
    }
  }

  /** Stop recording and drawing; resolves with the show, or null when nothing was recorded. */
  async stop(): Promise<ShowRecording | null> {
    clearTimeout(this.startTimer);
    const mr = this.mr;
    this.mr = null;
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
      if (video.size && this.startCtx !== null) out = { video, mimeType: mr.mimeType, startCtxTime: this.startCtx, lagMs: this.lagMs };
    }
    this.chunks = [];
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
    this.tearDownAudio();
    return out;
  }

  dispose(): void {
    void this.stop();
    for (const id of [...this.vocals.keys()]) this.setVocal(id, null);
    this.bgVideo?.pause();
    this.bgVideo = null;
    this.compositor.stop();
  }

  // ---- the mix: backing track + own vocal (held back by the lag) + every other singer's vocal, through a limiter ----

  private buildAudio(engine: AudioEngine): void {
    if (this.audio) return;
    const ctx = engine.ctx;
    const dest = ctx.createMediaStreamDestination();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    const bus = ctx.createGain();
    bus.gain.value = 0.85; // headroom: several vocals plus the track sum before the limiter
    bus.connect(limiter).connect(dest);
    const local = ctx.createDelay(1);
    local.delayTime.value = this.lagMs / 1000;
    local.connect(bus);
    const taps: AudioNode[] = [];
    // The voice sits on top of the track: the backing a little under, every vocal a little up.
    const backingLevel = ctx.createGain();
    backingLevel.gain.value = BACKING_IN_MIX;
    backingLevel.connect(local);
    const vocalLevel = ctx.createGain();
    vocalLevel.gain.value = VOCAL_IN_MIX;
    vocalLevel.connect(local);
    const player = engine.player;
    if (player) {
      player.gain.connect(backingLevel);
      taps.push(player.gain);
    }
    const vocal = engine.recorder?.node ?? engine.chain?.output ?? null;
    if (vocal) {
      vocal.connect(vocalLevel);
      taps.push(vocal);
    }
    this.audio = { ctx, dest, local, bus, taps, backingLevel, vocalLevel, limiter };
    for (const v of this.vocals.values()) this.plugVocal(v);
    // The audience hears this very mix: the host's device sends it out a second at a time (WebCodecs/Opus).
    if (this.broadcast) {
      const send = this.broadcast;
      const lagS = this.lagMs / 1000;
      this.broadcaster = new MixBroadcaster(ctx, send, (t) => engine.player?.positionAt(t - lagS) ?? 0);
      this.broadcaster.start(limiter);
    }
  }

  private tearDownAudio(): void {
    this.broadcaster?.stop();
    this.broadcaster = null;
    const a = this.audio;
    if (!a) return;
    for (const t of a.taps) {
      for (const target of [a.backingLevel, a.vocalLevel]) {
        try {
          t.disconnect(target);
        } catch {
          /* not connected there */
        }
      }
    }
    a.backingLevel.disconnect();
    a.vocalLevel.disconnect();
    for (const v of this.vocals.values()) {
      v.node?.disconnect();
      v.node = null;
    }
    a.local.disconnect();
    a.bus.disconnect();
    this.audio = null;
  }

  // ---- the picture: background, then the show compositor's transparent stage ----

  private frame(): void {
    const c = this.c2d;
    const W = this.width;
    const H = this.height;
    try {
      this.drawBackground(c, W, H);
      for (const d of this.delayed.values()) d.tick();
      this.compositor.draw();
      c.drawImage(this.compositor.canvas, 0, 0, W, H);
    } catch (e) {
      console.warn('show frame', e); // one bad frame never stops the recording
    }
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
