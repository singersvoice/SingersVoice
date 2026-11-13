/**
 * The publisher's browser as the broadcast encoder: the show canvas (1280×720) goes through
 * WebCodecs' VideoEncoder as H.264 (Annex B, a keyframe every two seconds, no B-frames — a
 * realtime encode), the show mix through AudioEncoder as AAC-LC (ADTS, 48 kHz stereo, 128 kbps),
 * and the two are cut at the keyframes into two-second MPEG-TS segments — what YouTube's HLS
 * ingestion and every HLS player take.
 *
 * Needs WebCodecs (Chrome, Edge, Safari 17+, Firefox 130+). AAC encoding comes from the platform:
 * Windows, macOS, iOS and Android have it; Chrome on Linux (and Firefox) do not — then the segments
 * carry video only, the in-house portal shows the picture and plays the stage mix for sound, and
 * YouTube (which needs AAC) is told so.
 */
import { LIVE_SEGMENT_S } from '@singersvoice/protocol';
import { splitAdts, TsMuxer, type MediaPacket } from './tsMuxer.ts';

export const LIVE_WIDTH = 1280;
export const LIVE_HEIGHT = 720;
export const LIVE_FPS = 30;
export const LIVE_VIDEO_BPS = 3_500_000;
export const LIVE_AUDIO_BPS = 128_000;
const AUDIO_RATE = 48000;
/** ADTS frames per audio PES. */
const ADTS_PER_PES = 4;
/** A cut waits this long for the audio that belongs before the keyframe, then goes without it. */
const CUT_GRACE_MS = 400;

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
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return { ok: false, videoCodec: null, audio: 'none', reason: 'This browser has no WebCodecs — broadcasting needs Chrome, Edge or Safari 17 (Firefox 130+).' };
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

export interface LiveSegment {
  seq: number;
  name: string;
  bytes: Uint8Array;
  durationMs: number;
  /** The segment carries an audio track. */
  audio: boolean;
}

export interface LiveEncoderOptions {
  canvas: HTMLCanvasElement;
  ctx: AudioContext;
  /** The mix to broadcast (the bus's limiter output). */
  source: AudioNode;
  onSegment: (seg: LiveSegment) => void;
  onError: (message: string) => void;
}

export class LiveEncoder {
  private video: VideoEncoder | null = null;
  private audio: AudioEncoder | null = null;
  private tap: AudioWorkletNode | null = null;
  private muxer: TsMuxer | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private cutTimer: ReturnType<typeof setTimeout> | undefined;
  private t0 = 0;
  private frames = 0;
  /** When the last keyframe was asked for (µs on the broadcast clock): the next comes LIVE_SEGMENT_S later, whatever the achieved frame rate. */
  private lastKeyUs = -Infinity;
  private packets: MediaPacket[] = [];
  private adtsRun: Uint8Array[] = [];
  private adtsRunTs = 0;
  private pendingCut: number | null = null;
  private segStartUs = 0;
  private seq = 0;
  private run = '';
  private running = false;
  private support: LiveSupport | null = null;
  /** Frames handed to the encoder / dropped because it was behind (for the status line). */
  stats = { encoded: 0, dropped: 0, segments: 0 };

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
    this.run = Date.now().toString(36);
    this.seq = 0;
    this.frames = 0;
    this.lastKeyUs = -Infinity;
    this.packets = [];
    this.pendingCut = null;
    this.muxer = new TsMuxer(support.audio === 'aac' ? 'aac' : 'none');
    this.t0 = ctx.currentTime;
    this.segStartUs = 0;

    const video = new VideoEncoder({
      output: (chunk) => this.onVideoChunk(chunk),
      error: (e) => this.fail(`Video encoder: ${e.message}`),
    });
    video.configure({ codec: support.videoCodec!, width: LIVE_WIDTH, height: LIVE_HEIGHT, bitrate: LIVE_VIDEO_BPS, framerate: LIVE_FPS, latencyMode: 'realtime', avc: { format: 'annexb' }, hardwareAcceleration: 'no-preference' });
    this.video = video;

    if (support.audio === 'aac') {
      const audio = new AudioEncoder({
        output: (chunk) => this.onAudioChunk(chunk),
        error: (e) => this.fail(`Audio encoder: ${e.message}`),
      });
      audio.configure({ codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: LIVE_AUDIO_BPS, aac: { format: 'adts' } } as AudioEncoderConfig);
      this.audio = audio;
      try {
        const tap = new AudioWorkletNode(ctx, 'sv-mix-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers', processorOptions: { channels: 2 } });
        tap.port.onmessage = (e: MessageEvent<{ type: string; data: Float32Array<ArrayBuffer>; frames: number; contextTime: number; sampleRate: number }>) => this.onBlock(e.data);
        source.connect(tap);
        this.tap = tap;
      } catch (e) {
        this.fail(`The audio tap could not start: ${String(e)}`);
      }
    }
    this.fps = LIVE_FPS;
    this.window = { encoded: 0, dropped: 0, since: performance.now() };
    this.timer = setInterval(() => this.grabFrame(), 1000 / this.fps);
    return support;
  }

  private fail(message: string): void {
    if (!this.running) return;
    this.opts.onError(message);
    this.stop();
  }

  /** The grab rate backs off (30 → 15 fps) when the encoder keeps falling behind — a slow machine sends fewer frames, never a later picture. */
  private fps = LIVE_FPS;
  private window = { encoded: 0, dropped: 0, since: 0 };

  private grabFrame(): void {
    const v = this.video;
    if (!v || !this.running || v.state !== 'configured') return;
    const now = performance.now();
    if (now - this.window.since > 2000) {
      if (this.window.dropped > this.window.encoded && this.fps > 15) {
        this.fps = 15;
        clearInterval(this.timer);
        this.timer = setInterval(() => this.grabFrame(), 1000 / this.fps);
      }
      this.window = { encoded: 0, dropped: 0, since: now };
    }
    if (v.encodeQueueSize > 4) {
      this.stats.dropped++;
      this.window.dropped++;
      return; // the encoder is behind: skip this frame rather than pile up latency
    }
    this.window.encoded++;
    const timestamp = Math.round((this.opts.ctx.currentTime - this.t0) * 1e6);
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(this.opts.canvas, { timestamp });
    } catch {
      return;
    }
    const keyFrame = timestamp - this.lastKeyUs >= LIVE_SEGMENT_S * 1e6 - 1000;
    if (keyFrame) this.lastKeyUs = timestamp;
    try {
      v.encode(frame, { keyFrame });
      this.frames++;
      this.stats.encoded++;
    } catch (e) {
      this.fail(`Video encode: ${String(e)}`);
    } finally {
      frame.close();
    }
  }

  private onBlock(m: { type: string; data: Float32Array<ArrayBuffer>; frames: number; contextTime: number; sampleRate: number }): void {
    const a = this.audio;
    if (m.type !== 'block' || !a || a.state !== 'configured' || !this.running) return;
    const timestamp = Math.max(0, Math.round((m.contextTime - this.t0) * 1e6));
    let data: Float32Array<ArrayBuffer> = m.data;
    let frames = m.frames;
    if (m.sampleRate !== AUDIO_RATE) {
      const out = resamplePlanar(m.data, frames, 2, m.sampleRate, AUDIO_RATE);
      data = out.data;
      frames = out.frames;
    }
    try {
      a.encode(new AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: frames, numberOfChannels: 2, timestamp, data }));
    } catch (e) {
      console.warn('live audio encode', e);
    }
  }

  private onVideoChunk(chunk: EncodedVideoChunk): void {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const key = chunk.type === 'key';
    if (key && this.packets.some((p) => p.kind === 'video')) this.scheduleCut(chunk.timestamp);
    this.packets.push({ kind: 'video', ts: chunk.timestamp, key, data });
    this.maybeCut();
  }

  private onAudioChunk(chunk: EncodedAudioChunk): void {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    // One chunk is one ADTS frame; a few go into each PES.
    if (!this.adtsRun.length) this.adtsRunTs = chunk.timestamp;
    this.adtsRun.push(...splitAdts(data));
    if (this.adtsRun.length >= ADTS_PER_PES) this.flushAdts();
    this.maybeCut();
  }

  private flushAdts(): void {
    if (!this.adtsRun.length) return;
    const len = this.adtsRun.reduce((n, f) => n + f.length, 0);
    const data = new Uint8Array(len);
    let o = 0;
    for (const f of this.adtsRun) {
      data.set(f, o);
      o += f.length;
    }
    this.packets.push({ kind: 'audio', ts: this.adtsRunTs, key: false, data });
    this.adtsRun = [];
  }

  /** A keyframe arrived: everything before it is a segment, once the audio for that span is in. */
  private scheduleCut(keyTs: number): void {
    this.pendingCut = keyTs;
    clearTimeout(this.cutTimer);
    this.cutTimer = setTimeout(() => this.cut(), CUT_GRACE_MS);
  }

  private maybeCut(): void {
    if (this.pendingCut === null) return;
    if (!this.hasAudio) return this.cut();
    const lastAudio = this.packets.filter((p) => p.kind === 'audio').pop()?.ts ?? -1;
    const runTs = this.adtsRun.length ? this.adtsRunTs : -1;
    if (Math.max(lastAudio, runTs) >= this.pendingCut) this.cut();
  }

  private cut(): void {
    const keyTs = this.pendingCut;
    if (keyTs === null || !this.muxer) return;
    this.pendingCut = null;
    clearTimeout(this.cutTimer);
    // Audio packets straddling the cut go with the segment they start in.
    if (this.adtsRun.length && this.adtsRunTs < keyTs) this.flushAdts();
    const seg = this.packets.filter((p) => p.ts < keyTs);
    this.packets = this.packets.filter((p) => p.ts >= keyTs);
    if (!seg.some((p) => p.kind === 'video')) return;
    const { bytes, durationS } = this.muxer.muxSegment(seg, 1e6 / LIVE_FPS);
    this.segStartUs = keyTs;
    const s: LiveSegment = { seq: this.seq, name: `sv${this.run}-${this.seq}.ts`, bytes, durationMs: Math.round(durationS * 1000), audio: this.hasAudio };
    this.seq++;
    this.stats.segments++;
    this.opts.onSegment(s);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    clearTimeout(this.cutTimer);
    this.timer = undefined;
    try {
      this.tap?.disconnect();
    } catch {
      /* gone */
    }
    this.tap = null;
    const v = this.video;
    const a = this.audio;
    this.video = null;
    this.audio = null;
    for (const enc of [v, a]) {
      try {
        if (enc && enc.state !== 'closed') enc.close();
      } catch {
        /* closed */
      }
    }
    this.packets = [];
    this.adtsRun = [];
    this.pendingCut = null;
  }
}

/** Linear resampling of a planar stereo block (only when the context does not run at 48 kHz). */
function resamplePlanar(input: Float32Array, frames: number, channels: number, from: number, to: number): { data: Float32Array<ArrayBuffer>; frames: number } {
  const n = Math.round((frames * to) / from);
  const out = new Float32Array(new ArrayBuffer(n * channels * 4));
  const step = from / to;
  for (let c = 0; c < channels; c++) {
    const base = c * frames;
    const ob = c * n;
    for (let i = 0; i < n; i++) {
      const x = i * step;
      const i0 = Math.floor(x);
      const i1 = Math.min(frames - 1, i0 + 1);
      const f = x - i0;
      out[ob + i] = input[base + i0]! * (1 - f) + input[base + i1]! * f;
    }
  }
  return { data: out, frames: n };
}
