/**
 * The publisher's browser as the broadcast encoder — the page's side of it. The show canvas (1280×720) is
 * handed over frame by frame to a Worker (live.worker.ts) that runs WebCodecs' VideoEncoder (H.264, Annex B,
 * a keyframe every second, no B-frames — a realtime encode) and AudioEncoder (AAC-LC, ADTS, 48 kHz stereo,
 * 128 kbps), cuts the two into one-second MPEG-TS segments (LIVE_SEGMENT_S) and delivers them to the service
 * — what YouTube's HLS ingestion, the RTMP relay and every HLS player take. The sound reaches the Worker
 * straight from the mix tap (an AudioWorklet posting 20 ms blocks to the Worker's own port), so nothing the
 * page does — a stage of seven to decode, unpack and draw; the film; the audience's mix — ever costs a block
 * or delays one: the sound is the broadcast's clock, the picture best effort (liveCore.ts). What this page
 * does per frame is one `VideoFrame` of the canvas, transferred.
 *
 * Needs WebCodecs (Chrome, Edge, Safari 17+, Firefox 130+). AAC encoding comes from the platform:
 * Windows, macOS, iOS and Android have it; Chrome on Linux (and Firefox) do not — then the segments
 * carry video only, the in-house portal shows the picture and plays the stage mix for sound, and
 * YouTube (which needs AAC) is told so.
 */
import { signal } from '@preact/signals';
import { LIVE_SEGMENT_S } from '@singersvoice/protocol';
import type { LiveStats, LiveWorkerIn, LiveWorkerOut } from './live.worker.ts';
import { initialSenderState, type SenderState } from './senderState.ts';

export const LIVE_WIDTH = 1280;
export const LIVE_HEIGHT = 720;
export const LIVE_FPS = 30;
export const LIVE_VIDEO_BPS = 4_500_000;
export const LIVE_AUDIO_BPS = 128_000;
const AUDIO_RATE = 48000;
/** The sign-in headers are looked at this often; a token renewed reaches the Worker (which sends with them). */
const AUTH_REFRESH_MS = 15_000;

export interface LiveSupport {
  ok: boolean;
  videoCodec: string | null;
  /** 'aac' when the browser can encode AAC, 'none' when the broadcast will be video only. */
  audio: 'aac' | 'none';
  reason: string;
}

/** What this browser can do, checked once (the answer is cached). */
let supportPromise: Promise<LiveSupport> | null = null;
export function liveSupport(): Promise<LiveSupport> {
  supportPromise ??= (async () => {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined' || typeof Worker === 'undefined') return { ok: false, videoCodec: null, audio: 'none', reason: 'This browser has no WebCodecs — broadcasting needs Chrome, Edge or Safari 17 (Firefox 130+).' };
    let videoCodec: string | null = null;
    for (const codec of ['avc1.4d401f', 'avc1.42e01f', 'avc1.42001f']) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec, width: LIVE_WIDTH, height: LIVE_HEIGHT, bitrate: LIVE_VIDEO_BPS, framerate: LIVE_FPS, latencyMode: 'realtime', avc: { format: 'annexb' } });
        if (r.supported) {
          videoCodec = codec;
          break;
        }
      } catch {
        /* next */
      }
    }
    if (!videoCodec) return { ok: false, videoCodec: null, audio: 'none', reason: 'This browser cannot encode H.264 video.' };
    let audio: 'aac' | 'none' = 'none';
    if (typeof AudioEncoder !== 'undefined') {
      try {
        const r = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: LIVE_AUDIO_BPS, aac: { format: 'adts' } } as AudioEncoderConfig);
        if (r.supported) audio = 'aac';
      } catch {
        /* no AAC here */
      }
    }
    return { ok: true, videoCodec, audio, reason: audio === 'aac' ? '' : 'This browser cannot encode AAC audio (Chrome on Linux, Firefox): the broadcast goes out as video only — YouTube needs AAC; use Chrome or Edge on Windows or Mac for sound.' };
  })();
  return supportPromise;
}

export interface LiveEncoderOptions {
  canvas: HTMLCanvasElement;
  ctx: AudioContext;
  /** The mix to broadcast (the bus's limiter output). */
  source: AudioNode;
  /** The job the segments belong to. */
  jobId: string;
  /** The service's URL, and the sign-in headers (read again every so often: a renewed token reaches the Worker, which sends). */
  controlUrl: string;
  headers: () => Record<string, string>;
  onError: (message: string) => void;
}

export class LiveEncoder {
  private worker: Worker | null = null;
  private tap: AudioWorkletNode | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private authTimer: ReturnType<typeof setInterval> | undefined;
  private t0 = 0;
  private running = false;
  private support: LiveSupport | null = null;
  private lastHeaders = '';
  /** The delivery as the Worker reports it (segments, kbps, YouTube's and the relay's word). */
  readonly state = signal<SenderState>(initialSenderState());
  /** The encoders' health as the Worker reports it once a second: frames encoded, dropped, held (the picture stalled), the achieved frame rate, the queues. */
  stats: LiveStats = { encoded: 0, dropped: 0, held: 0, lateVideo: 0, fps: 0, audioQueue: 0, videoQueue: 0, audioBlocks: 0, segments: 0, queued: 0 };

  constructor(private readonly opts: LiveEncoderOptions) {}

  get hasAudio(): boolean {
    return this.support?.audio === 'aac';
  }

  async start(): Promise<LiveSupport> {
    const support = await liveSupport();
    this.support = support;
    if (!support.ok || this.running) return support;
    const { canvas, ctx, source } = this.opts;
    this.running = true;
    this.t0 = ctx.currentTime;
    const worker = new Worker(new URL('./live.worker.ts', import.meta.url), { type: 'module', name: 'sv-live' });
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<LiveWorkerOut>) => this.onMessage(e.data);
    worker.onerror = (e) => this.fail(`The broadcast encoder failed: ${e.message}`);
    const send = (m: LiveWorkerIn, transfer?: Transferable[]) => worker.postMessage(m, transfer ?? []);
    send({ type: 't0', t0: this.t0 });
    if (support.audio === 'aac') {
      try {
        // The tap posts its blocks to the Worker's own port: the sound never waits for this page.
        const tap = new AudioWorkletNode(ctx, 'sv-mix-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers', processorOptions: { channels: 2 } });
        const channel = new MessageChannel();
        tap.port.postMessage({ type: 'port', port: channel.port1 }, [channel.port1]);
        send({ type: 'audioPort', port: channel.port2 }, [channel.port2]);
        source.connect(tap);
        this.tap = tap;
      } catch (e) {
        this.fail(`The audio tap could not start: ${String(e)}`);
        return support;
      }
    }
    this.lastHeaders = JSON.stringify(this.opts.headers());
    send({ type: 'start', videoCodec: support.videoCodec!, audio: support.audio, width: LIVE_WIDTH, height: LIVE_HEIGHT, fps: LIVE_FPS, videoBps: LIVE_VIDEO_BPS, audioBps: LIVE_AUDIO_BPS, segmentUs: LIVE_SEGMENT_S * 1e6, run: Date.now().toString(36), controlUrl: this.opts.controlUrl, headers: this.opts.headers(), jobId: this.opts.jobId });
    this.fps = LIVE_FPS;
    this.window = { since: performance.now(), dropped: 0 };
    this.timer = setInterval(() => this.grabFrame(canvas), 1000 / this.fps);
    this.authTimer = setInterval(() => {
      const headers = this.opts.headers();
      const h = JSON.stringify(headers);
      if (h !== this.lastHeaders) {
        this.lastHeaders = h;
        send({ type: 'auth', headers });
      }
    }, AUTH_REFRESH_MS);
    return support;
  }

  private onMessage(m: LiveWorkerOut): void {
    switch (m.type) {
      case 'state':
        this.state.value = m.state;
        break;
      case 'stats':
        this.stats = m.stats;
        break;
      case 'error':
        this.fail(m.message);
        break;
      case 'ended':
        this.stop();
        break;
    }
  }

  private fail(message: string): void {
    if (!this.running) return;
    this.opts.onError(message);
    this.stop();
  }

  /** The grab rate backs off (30 → 15 fps) when the Worker keeps dropping frames — a slow machine sends fewer frames, never a later picture. */
  private fps = LIVE_FPS;
  private window = { since: 0, dropped: 0 };

  private grabFrame(canvas: HTMLCanvasElement): void {
    const w = this.worker;
    if (!w || !this.running) return;
    const now = performance.now();
    if (now - this.window.since > 2000) {
      if (this.stats.dropped - this.window.dropped > this.fps && this.fps > 15) {
        this.fps = 15;
        clearInterval(this.timer);
        this.timer = setInterval(() => this.grabFrame(canvas), 1000 / this.fps);
      }
      this.window = { since: now, dropped: this.stats.dropped };
    }
    if (this.stats.videoQueue > 4) return; // the encoder is behind: no frame rather than a pile of them
    const timestamp = Math.round((this.opts.ctx.currentTime - this.t0) * 1e6);
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(canvas, { timestamp });
    } catch {
      return;
    }
    try {
      w.postMessage({ type: 'frame', frame } satisfies LiveWorkerIn, [frame]);
    } catch {
      frame.close();
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    clearInterval(this.authTimer);
    this.timer = undefined;
    try {
      this.tap?.disconnect();
    } catch {
      /* gone */
    }
    this.tap = null;
    const w = this.worker;
    this.worker = null;
    if (w) {
      try {
        w.postMessage({ type: 'stop' } satisfies LiveWorkerIn);
      } catch {
        /* gone */
      }
      setTimeout(() => w.terminate(), 1500); // the last segment on its way out first
    }
    if (this.state.value.state !== 'error' && this.state.value.state !== 'ended') this.state.value = { ...this.state.value, state: 'ended' };
  }
}
