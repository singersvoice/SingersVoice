/**
 * Backing-track player anchored to the AudioContext clock. `play(at)` schedules the start at an
 * exact context time (the local "kickstart"), so lyrics, the recorder and — in a meet — every other
 * device can line up on the same timeline. Tempo (0.5–1.5) keeps the key by compensating through
 * the pitch worklet; key shift (±6 st) goes through the same worklet.
 */
export class BackingPlayer {
  buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** A cued jump not yet reached (see `cue`). */
  private pending: { src: AudioBufferSourceNode; at: number; offsetMs: number; old: AudioBufferSourceNode | null } | null = null;
  readonly gain: GainNode;
  private pitch: AudioWorkletNode | null = null;
  private startAt = 0; // ctx time when source.start fired
  private startOffsetMs = 0; // track position at startAt
  private tempo = 1;
  private keyShift = 0;
  playing = false;
  onEnded: (() => void) | null = null;

  constructor(
    private ctx: AudioContext,
    destination: AudioNode,
    workletAvailable: boolean,
  ) {
    this.gain = ctx.createGain();
    if (workletAvailable) {
      try {
        this.pitch = new AudioWorkletNode(ctx, 'sv-pitch-shifter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        this.pitch.connect(this.gain);
      } catch {
        this.pitch = null;
      }
    }
    this.gain.connect(destination);
  }

  get durationMs(): number {
    return this.buffer ? this.buffer.duration * 1000 : 0;
  }

  async load(blob: Blob): Promise<AudioBuffer> {
    const data = await blob.arrayBuffer();
    this.buffer = await new Promise<AudioBuffer>((resolve, reject) => {
      const p = this.ctx.decodeAudioData(data, resolve, (e) => reject(e ?? new Error('Could not decode this audio file')));
      if (p && typeof (p as Promise<AudioBuffer>).then === 'function') (p as Promise<AudioBuffer>).then(resolve, reject);
    });
    return this.buffer;
  }

  setGain(v: number): void {
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setTempo(t: number): void {
    const was = this.playing ? this.positionMs() : null;
    this.tempo = Math.min(1.5, Math.max(0.5, t));
    if (this.source) {
      this.source.playbackRate.setValueAtTime(this.tempo, this.ctx.currentTime);
      if (was !== null) {
        this.startAt = this.ctx.currentTime;
        this.startOffsetMs = was;
      }
    }
    this.applyPitch();
  }

  setKeyShift(st: number): void {
    this.keyShift = Math.min(6, Math.max(-6, st));
    this.applyPitch();
  }

  private applyPitch(): void {
    const comp = -12 * Math.log2(this.tempo);
    this.pitch?.parameters.get('pitch')?.setValueAtTime(this.keyShift + comp, this.ctx.currentTime);
  }

  /** Start at `atCtxTime` (>= now) from `offsetMs`. Returns the context time used. */
  play(atCtxTime: number, offsetMs = 0): number {
    if (!this.buffer) throw new Error('No track loaded');
    this.stop(false);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.tempo;
    src.connect(this.pitch ?? this.gain);
    const when = Math.max(this.ctx.currentTime, atCtxTime);
    src.start(when, Math.max(0, offsetMs) / 1000);
    src.onended = () => {
      if (this.source === src) {
        this.playing = false;
        this.source = null;
        this.onEnded?.();
      }
    };
    this.source = src;
    this.startAt = when;
    this.startOffsetMs = offsetMs;
    this.playing = true;
    this.applyPitch();
    return when;
  }

  /**
   * A cued jump: keep playing until `atCtxTime`, then continue from `offsetMs` — seamless, sample-
   * accurate, the same instant on every device of a meet (a seek, a restart from the top). While
   * paused it is a plain seek that stays paused.
   */
  cue(atCtxTime: number, offsetMs: number): number {
    if (!this.buffer) throw new Error('No track loaded');
    const offset = Math.max(0, Math.min(this.durationMs, offsetMs));
    if (!this.playing) {
      this.startOffsetMs = offset;
      return this.ctx.currentTime;
    }
    const at = Math.max(this.ctx.currentTime, atCtxTime);
    const old = this.source;
    this.pending?.src.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.tempo;
    src.connect(this.pitch ?? this.gain);
    src.start(at, offset / 1000);
    src.onended = () => {
      if (this.source === src) {
        this.playing = false;
        this.source = null;
        this.onEnded?.();
      }
    };
    if (old) {
      old.onended = null; // the old source ending at the cue is not the song ending
      try {
        old.stop(at);
      } catch {
        /* not started */
      }
    }
    this.pending = { src, at, offsetMs: offset, old };
    this.applyPitch();
    return at;
  }

  /** A cued jump whose instant has passed becomes the current source. */
  private settle(): void {
    const p = this.pending;
    if (!p || this.ctx.currentTime < p.at) return;
    this.pending = null;
    p.old?.disconnect();
    this.source = p.src;
    this.startAt = p.at;
    this.startOffsetMs = p.offsetMs;
    this.playing = true;
  }

  /** Current position on the track timeline, ms (clamped to duration). Valid while playing or paused. */
  positionMs(): number {
    this.settle();
    if (!this.playing) return this.startOffsetMs;
    const elapsed = Math.max(0, this.ctx.currentTime - this.startAt);
    return Math.min(this.durationMs, this.startOffsetMs + elapsed * this.tempo * 1000);
  }

  /** The position the track will have (or had) at a context time, on the current (pre-cue) schedule. */
  positionAt(ctxTime: number): number {
    this.settle();
    if (!this.playing) return this.startOffsetMs;
    return Math.min(this.durationMs, this.startOffsetMs + Math.max(0, ctxTime - this.startAt) * this.tempo * 1000);
  }

  /** Context time the track's position 0 corresponds to (for recorder alignment). */
  originCtxTime(): number {
    this.settle();
    return this.startAt - this.startOffsetMs / 1000 / this.tempo;
  }

  pause(): void {
    this.settle();
    const pos = this.positionMs();
    this.stop(false);
    this.startOffsetMs = pos;
  }

  seek(ms: number): void {
    const wasPlaying = this.playing;
    this.stop(false);
    this.startOffsetMs = Math.max(0, Math.min(this.durationMs, ms));
    if (wasPlaying) this.play(this.ctx.currentTime, this.startOffsetMs);
  }

  stop(reset = true): void {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.src.onended = null;
      try {
        p.src.stop();
      } catch {
        /* not started */
      }
      p.src.disconnect();
    }
    if (this.source) {
      const s = this.source;
      this.source = null;
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
      s.disconnect();
    }
    this.playing = false;
    if (reset) this.startOffsetMs = 0;
  }

  dispose(): void {
    this.stop();
    this.pitch?.disconnect();
    this.gain.disconnect();
    this.buffer = null;
  }
}
