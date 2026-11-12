/** Sample-accurate PCM capture through the 'sv-recorder' worklet, with a level meter. */
import { signal } from '@preact/signals';
import { concatFloat32, encodeWav } from '../lib/wav.ts';

export interface Take {
  pcm: Float32Array;
  sampleRate: number;
  /** AudioContext time of the first captured frame. */
  startCtxTime: number;
  frames: number;
  wav: Blob;
}

export class PcmRecorder {
  readonly node: AudioWorkletNode;
  readonly level = signal(0);
  /** Captured audio in order; a number is a run of silent frames (a jump forward on the track timeline). */
  private chunks: (Float32Array | number)[] = [];
  private startCtxTime = 0;
  private startedResolve: ((t: number) => void) | null = null;
  private stoppedResolve: ((frames: number) => void) | null = null;
  recording = false;

  constructor(private ctx: AudioContext) {
    this.node = new AudioWorkletNode(ctx, 'sv-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; data?: Float32Array; contextTime?: number; frames?: number; peak?: number };
      switch (m.type) {
        case 'chunk':
          if (m.data) this.chunks.push(m.data);
          break;
        case 'gap':
          if (m.frames) this.chunks.push(m.frames);
          break;
        case 'truncate':
          this.truncate(m.frames ?? 0);
          break;
        case 'started':
          this.startCtxTime = m.contextTime ?? ctx.currentTime;
          this.startedResolve?.(this.startCtxTime);
          this.startedResolve = null;
          break;
        case 'stopped':
          this.stoppedResolve?.(m.frames ?? 0);
          this.stoppedResolve = null;
          break;
        case 'level': {
          const peak = m.peak ?? 0;
          // Smooth-ish meter in dBFS → 0..1
          const db = 20 * Math.log10(Math.max(1e-5, peak));
          this.level.value = Math.max(0, Math.min(1, (db + 60) / 60));
          break;
        }
      }
    };
  }

  /** Begin capturing; resolves with the context time of the first frame. */
  start(): Promise<number> {
    this.chunks = [];
    this.recording = true;
    return new Promise((resolve) => {
      this.startedResolve = resolve;
      this.node.port.postMessage({ type: 'start' });
    });
  }

  /** Drop frames from `atCtxTime` (default now) until `resume`; the take stays on the track timeline. */
  pause(atCtxTime?: number): void {
    if (!this.recording) return;
    this.node.port.postMessage({ type: 'pause', at: atCtxTime ?? this.ctx.currentTime });
  }

  resume(atCtxTime?: number): void {
    if (!this.recording) return;
    this.node.port.postMessage({ type: 'resume', at: atCtxTime ?? this.ctx.currentTime });
  }

  /**
   * The song jumped on its timeline at `atCtxTime` by `deltaMs` (a seek, a restart from the top):
   * the take stays on the track timeline — forward, the skipped part is silence; backward, the part
   * about to be sung again replaces what was recorded there. `deltaMs` is in recording time (track
   * ms ÷ tempo).
   */
  seek(atCtxTime: number, deltaMs: number): void {
    if (!this.recording) return;
    const frames = Math.round((deltaMs / 1000) * this.ctx.sampleRate);
    if (!frames) return;
    this.node.port.postMessage({ type: 'seek', at: atCtxTime, frames });
  }

  /** Keep only the first `frames` captured frames (a jump backward). */
  private truncate(frames: number): void {
    this.chunks = truncateCaptured(this.chunks, frames);
  }

  async stop(): Promise<Take> {
    if (!this.recording) throw new Error('Not recording');
    this.recording = false;
    const frames = await new Promise<number>((resolve) => {
      this.stoppedResolve = resolve;
      this.node.port.postMessage({ type: 'stop' });
    });
    const pcm = concatFloat32(this.chunks.map((c) => (typeof c === 'number' ? new Float32Array(c) : c)));
    this.chunks = [];
    const wav = encodeWav([pcm], this.ctx.sampleRate);
    return { pcm, sampleRate: this.ctx.sampleRate, startCtxTime: this.startCtxTime, frames, wav };
  }

  dispose(): void {
    this.node.port.onmessage = null;
    this.node.disconnect();
  }
}

/** Pure: the captured parts (audio, or a count of silent frames) cut to the first `frames` frames. */
export function truncateCaptured(parts: (Float32Array | number)[], frames: number): (Float32Array | number)[] {
  let kept = 0;
  const out: (Float32Array | number)[] = [];
  for (const c of parts) {
    const len = typeof c === 'number' ? c : c.length;
    if (kept + len <= frames) {
      out.push(c);
      kept += len;
      continue;
    }
    const room = frames - kept;
    if (room > 0) out.push(typeof c === 'number' ? room : c.subarray(0, room));
    break;
  }
  return out;
}

/** Pure: total frames of the captured parts, silence included. */
export function capturedFrames(parts: (Float32Array | number)[]): number {
  return parts.reduce<number>((n, c) => n + (typeof c === 'number' ? c : c.length), 0);
}
