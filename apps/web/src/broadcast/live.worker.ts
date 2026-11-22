/**
 * The broadcast encoder off the page's main thread: the AAC encoder fed straight from the mix tap's port (the
 * AudioWorklet posts its 20 ms blocks here, never through the page), the H.264 encoder fed with the frames the
 * page hands over, the segments assembled (liveCore.ts: the sound is the clock, the picture best effort), muxed
 * (tsMuxer.ts) and delivered to the service (PUT, with retries) — all here. A page whose main thread stalls under
 * a crowded stage (seven singers' pictures to decode, unpack and draw, the film to write, the audience's mix to
 * send) used to stall the encoder with it: the sound's blocks piled up and went out late, some landing in the
 * segment after theirs with earlier stamps (a click, a hole), the segments waited for frames that never came,
 * the stream broke. Now the page can stall for seconds and the stream carries on: every note goes out on time,
 * the last picture is held until frames come again.
 *
 * Messages in (liveEncoder.ts is the page's side):
 *   start      — the codecs, the size and rates, the run, where to send (the service's URL and the sign-in headers), the job
 *   audioPort  — the MessagePort the worklet posts its blocks to (transferred)
 *   frame      — one VideoFrame of the show (transferred), stamped on the broadcast clock by the page
 *   auth       — the sign-in headers again (the token renewed)
 *   stop
 * Messages out: state (what the sender knows: segments, kbps, YouTube's and the relay's word), stats (the encoders'
 * health, once a second), error (an encoder failed: the page stops the broadcast), ended (the job is over on the
 * service's side, or the sign-in lapsed).
 */
import { AUDIO_RATE, LiveCore, type CoreSegment } from './liveCore.ts';
import type { SenderState } from './senderState.ts';
import { foldJob, initialSenderState } from './senderState.ts';
import { splitAdts, TsMuxer } from './tsMuxer.ts';
import { LinearResampler } from '../audio/resample.ts';

export interface LiveStartMessage {
  type: 'start';
  videoCodec: string;
  audio: 'aac' | 'none';
  width: number;
  height: number;
  fps: number;
  videoBps: number;
  audioBps: number;
  segmentUs: number;
  run: string;
  controlUrl: string;
  headers: Record<string, string>;
  jobId: string;
}
export interface LiveStats {
  encoded: number;
  dropped: number;
  held: number;
  lateVideo: number;
  /** Frames encoded over the last second. */
  fps: number;
  audioQueue: number;
  videoQueue: number;
  audioBlocks: number;
  segments: number;
  /** Segments waiting to be sent. */
  queued: number;
}
export type LiveWorkerIn = LiveStartMessage | { type: 't0'; t0: number } | { type: 'audioPort'; port: MessagePort } | { type: 'frame'; frame: VideoFrame } | { type: 'auth'; headers: Record<string, string> } | { type: 'stop' };
export type LiveWorkerOut = { type: 'state'; state: SenderState } | { type: 'stats'; stats: LiveStats } | { type: 'error'; message: string } | { type: 'ended'; state: 'ended' | 'error'; message: string };

const MAX_QUEUE = 6; // six seconds of backlog at most: beyond that the viewer is better served by skipping ahead
const RETRIES = 3;
/** A frame given to the encoder while this many wait in it is dropped instead (latency never piles up). */
const MAX_VIDEO_QUEUE = 4;
const TICK_MS = 250;

const post = (m: LiveWorkerOut, transfer?: Transferable[]) => (self as unknown as Worker).postMessage(m, transfer ?? []);

class LiveWorker {
  private video: VideoEncoder | null = null;
  private audio: AudioEncoder | null = null;
  private core: LiveCore | null = null;
  private muxer: TsMuxer | null = null;
  private opts: LiveStartMessage | null = null;
  private headers: Record<string, string> = {};
  private audioPort: MessagePort | null = null;
  private resamplers: [LinearResampler, LinearResampler] | null = null;
  /** The last picture handed over, kept to be encoded again as a keyframe when the page's frames stop. */
  private held: VideoFrame | null = null;
  private nextKeyUs = 0;
  /** The stamp of the last frame given to the encoder: a frame the page hands over late, stamped before it (the page stalled; a picture was held meanwhile), is left out — an encoder takes its frames in order. */
  private lastTs = -1;
  private wallBase = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stats = { encoded: 0, dropped: 0, audioBlocks: 0, windowEncoded: 0, windowSince: 0, fps: 0 };
  // ---- the sender ----
  private queue: CoreSegment[] = [];
  private sending = false;
  private state: SenderState = initialSenderState();
  private recent: { at: number; bytes: number; ms: number }[] = [];

  private wallUs(): number {
    return Math.round((performance.now() - this.wallBase) * 1000);
  }

  start(m: LiveStartMessage): void {
    if (this.running) return;
    this.opts = m;
    this.headers = m.headers;
    this.running = true;
    this.wallBase = performance.now();
    this.nextKeyUs = 0;
    this.muxer = new TsMuxer(m.audio === 'aac' ? 'aac' : 'none');
    this.core = new LiveCore({ audio: m.audio === 'aac', segmentUs: m.segmentUs, run: m.run, onSegment: (s) => this.onSegment(s) });
    const video = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.core?.videoChunk(chunk.timestamp, chunk.type === 'key', data);
      },
      error: (e) => this.fail(`Video encoder: ${e.message}`),
    });
    video.configure({ codec: m.videoCodec, width: m.width, height: m.height, bitrate: m.videoBps, framerate: m.fps, latencyMode: 'realtime', avc: { format: 'annexb' }, hardwareAcceleration: 'no-preference' });
    this.video = video;
    if (m.audio === 'aac') {
      const audio = new AudioEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          this.core?.audioChunk(chunk.timestamp, splitAdts(data), this.wallUs());
        },
        error: (e) => this.fail(`Audio encoder: ${e.message}`),
      });
      audio.configure({ codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: m.audioBps, aac: { format: 'adts' } } as AudioEncoderConfig);
      this.audio = audio;
    }
    this.state = { ...initialSenderState(), state: 'sending', startedAt: Date.now(), audio: m.audio === 'aac' };
    post({ type: 'state', state: this.state });
    this.stats.windowSince = performance.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.statsTimer = setInterval(() => this.postStats(), 1000);
  }

  takeAudioPort(port: MessagePort): void {
    this.audioPort = port;
    port.onmessage = (e: MessageEvent<{ type: string; data: Float32Array<ArrayBuffer>; frames: number; contextTime: number; sampleRate: number; t0?: number }>) => this.onBlock(e.data);
    port.start?.();
  }

  /** The broadcast clock's origin on the audio clock (the page says it with the first frame's stamp; the worklet's blocks carry the audio clock). */
  private t0 = 0;
  setT0(t0: number): void {
    this.t0 = t0;
  }

  private onBlock(m: { type: string; data: Float32Array<ArrayBuffer>; frames: number; contextTime: number; sampleRate: number }): void {
    const a = this.audio;
    if (m.type !== 'block' || !a || a.state !== 'configured' || !this.running) return;
    this.stats.audioBlocks++;
    // Every block goes in, whatever the encoder's backlog: the AAC encoder stamps its output by counting samples from the
    // first block, so a block left out would move every later sound earlier than its picture for good.
    const timestamp = Math.max(0, Math.round((m.contextTime - this.t0) * 1e6));
    let data: Float32Array<ArrayBuffer> = m.data;
    let frames = m.frames;
    if (m.sampleRate !== AUDIO_RATE) {
      if (!this.resamplers || this.resamplers[0]!.from !== m.sampleRate) this.resamplers = [new LinearResampler(m.sampleRate, AUDIO_RATE), new LinearResampler(m.sampleRate, AUDIO_RATE)];
      const l = this.resamplers[0]!.push(m.data.subarray(0, frames));
      const r = this.resamplers[1]!.push(m.data.subarray(frames, frames * 2));
      frames = Math.min(l.length, r.length);
      data = new Float32Array(new ArrayBuffer(frames * 2 * 4));
      data.set(l.subarray(0, frames), 0);
      data.set(r.subarray(0, frames), frames);
    }
    try {
      a.encode(new AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: frames, numberOfChannels: 2, timestamp, data }));
    } catch (e) {
      console.warn('live audio encode', e);
    }
  }

  /** One frame of the show from the page, stamped on the broadcast clock; encoded now, or dropped when the encoder is behind — and kept as the picture to hold. */
  frame(frame: VideoFrame): void {
    const v = this.video;
    if (!v || !this.running || v.state !== 'configured') {
      frame.close();
      return;
    }
    this.held?.close();
    this.held = frame.clone();
    const ts = frame.timestamp;
    if (v.encodeQueueSize > MAX_VIDEO_QUEUE || ts <= this.lastTs) {
      this.stats.dropped++;
      frame.close();
      return; // the encoder is behind, or the frame is older than one already in: skipped rather than piled up or out of order
    }
    const keyFrame = ts >= this.nextKeyUs;
    if (keyFrame) this.nextKeyUs = ts + (this.opts?.segmentUs ?? 1e6);
    try {
      v.encode(frame, { keyFrame });
      this.lastTs = ts;
      this.stats.encoded++;
      this.stats.windowEncoded++;
    } catch (e) {
      this.fail(`Video encode: ${String(e)}`);
    } finally {
      frame.close();
    }
  }

  /** Every TICK_MS: segments whose span is complete go out; a picture that stopped is held — the last frame encoded again as a keyframe where the sound is. */
  private tick(): void {
    const core = this.core;
    const v = this.video;
    if (!core || !this.running) return;
    const ask = core.tick(this.wallUs());
    if (ask !== null && v && v.state === 'configured') {
      const held = this.held;
      if (!held) return;
      if (ask <= this.lastTs) return;
      try {
        const again = new VideoFrame(held, { timestamp: ask });
        this.nextKeyUs = ask + (this.opts?.segmentUs ?? 1e6);
        v.encode(again, { keyFrame: true });
        again.close();
        this.lastTs = ask;
        this.stats.encoded++;
      } catch (e) {
        console.warn('live: the held picture could not be encoded again', e);
      }
    }
  }

  private postStats(): void {
    const now = performance.now();
    const dt = (now - this.stats.windowSince) / 1000;
    if (dt > 0) this.stats.fps = Math.round(this.stats.windowEncoded / dt);
    this.stats.windowEncoded = 0;
    this.stats.windowSince = now;
    const core = this.core;
    post({ type: 'stats', stats: { encoded: this.stats.encoded, dropped: this.stats.dropped, held: core?.stats.held ?? 0, lateVideo: core?.stats.lateVideo ?? 0, fps: this.stats.fps, audioQueue: this.audio?.encodeQueueSize ?? 0, videoQueue: this.video?.encodeQueueSize ?? 0, audioBlocks: this.stats.audioBlocks, segments: core?.stats.segments ?? 0, queued: this.queue.length } });
  }

  private onSegment(seg: CoreSegment): void {
    if (!this.running) return;
    this.queue.push(seg);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE); // stay live: drop what is already old
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.running && this.queue.length) {
        const seg = this.queue.shift()!;
        await this.send(seg);
      }
    } finally {
      this.sending = false;
    }
  }

  private async send(seg: CoreSegment): Promise<void> {
    const o = this.opts;
    const muxer = this.muxer;
    if (!o || !muxer) return;
    const { bytes } = muxer.muxSegment(seg.packets, 1e6 / o.fps);
    const url = `${o.controlUrl}/publishing/jobs/${encodeURIComponent(o.jobId)}/live/${seg.name}?seq=${seg.seq}&dur=${seg.durationMs}&audio=${seg.audio ? 1 : 0}`;
    for (let attempt = 0; attempt <= RETRIES && this.running; attempt++) {
      let status = 0;
      let text = '';
      try {
        const r = await fetch(url, { method: 'PUT', headers: { ...this.headers, 'Content-Type': 'video/MP2T' }, body: bytes as unknown as BodyInit });
        status = r.status;
        text = await r.text();
        if (r.ok) {
          const job = (JSON.parse(text) as { job?: unknown }).job as Parameters<typeof foldJob>[1] | undefined;
          const now = Date.now();
          this.recent.push({ at: now, bytes: bytes.length, ms: seg.durationMs });
          this.recent = this.recent.filter((x) => now - x.at < 12_000);
          const sumMs = this.recent.reduce((n, x) => n + x.ms, 0);
          const sumBytes = this.recent.reduce((n, x) => n + x.bytes, 0);
          this.state = foldJob({ ...this.state, state: 'live', segments: this.state.segments + 1, bytes: this.state.bytes + bytes.length, kbps: sumMs ? Math.round((sumBytes * 8) / sumMs) : 0, lastAt: now, audio: seg.audio }, job ?? null);
          post({ type: 'state', state: this.state });
          return;
        }
      } catch (e) {
        text = e instanceof Error ? e.message : String(e);
      }
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* not JSON */
      }
      if (status === 409 || status === 404) return this.end('ended', message); // the job is over on the service's side
      if (status === 401 || status === 403) return this.end('error', message);
      if (status === 400) {
        console.warn('segment refused', message); // this one segment: skip it
        return;
      }
      if (attempt === RETRIES) {
        this.state = { ...this.state, error: `Could not deliver a segment (${message || `HTTP ${status}` || 'no answer'})` };
        post({ type: 'state', state: this.state });
        return;
      }
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }

  private end(state: 'ended' | 'error', message: string): void {
    this.queue = [];
    this.state = { ...this.state, state, error: state === 'error' ? message : this.state.error };
    post({ type: 'state', state: this.state });
    post({ type: 'ended', state, message });
    this.stop();
  }

  private fail(message: string): void {
    if (!this.running) return;
    post({ type: 'error', message });
    this.stop();
  }

  setHeaders(h: Record<string, string>): void {
    this.headers = h;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    clearInterval(this.statsTimer);
    this.audioPort?.close();
    this.audioPort = null;
    this.held?.close();
    this.held = null;
    for (const enc of [this.video, this.audio]) {
      try {
        if (enc && enc.state !== 'closed') enc.close();
      } catch {
        /* closed */
      }
    }
    this.video = null;
    this.audio = null;
    this.queue = [];
    if (this.state.state !== 'error' && this.state.state !== 'ended') {
      this.state = { ...this.state, state: 'ended' };
      post({ type: 'state', state: this.state });
    }
  }
}

const live = new LiveWorker();
self.onmessage = (e: MessageEvent<LiveWorkerIn>) => {
  const m = e.data;
  switch (m.type) {
    case 'start':
      live.start(m);
      break;
    case 'audioPort':
      live.takeAudioPort(m.port);
      break;
    case 't0':
      live.setT0(m.t0);
      break;
    case 'frame':
      live.frame(m.frame);
      break;
    case 'auth':
      live.setHeaders(m.headers);
      break;
    case 'stop':
      live.stop();
      break;
  }
};
