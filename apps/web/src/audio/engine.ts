/**
 * AudioEngine: one AudioContext per session, worklets, mic input → VoxForge chain → recorder →
 * (optional) monitor, and the backing-track player. Created on a user gesture (iOS requirement).
 */
import { signal } from '@preact/signals';
import type { VoxForgeParams } from '@singersvoice/protocol';
import { hasAudioWorklet } from '../lib/platform.ts';
import { BackingPlayer } from './player.ts';
import { PcmRecorder } from './recorder.ts';
import { createVoxForgeChain, type VoxForgeChain } from './voxforge.ts';

export interface PitchReading {
  hz: number;
  midi: number;
  cents: number;
  clarity: number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(midi: number): string {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** Every AudioWorklet module the engine's context runs (the mix buses load the same files on theirs). */
export const WORKLET_MODULES = ['pitch-shifter.js', 'recorder.js', 'mix-tap.js', 'dynamics.js', 'leveler.js'] as const;

/** The leveller: a raw peak under this is room noise, not singing — never lifted; a gained peak under QUIET is lifted, over HOT pulled down. */
const LEVEL_SINGING = 0.02; // −34 dBFS
const LEVEL_QUIET = 0.125; // −18 dBFS
const LEVEL_HOT = 0.5; // −6 dBFS
const LEVEL_MAX_DB = 12;
const LEVEL_MIN_DB = -6;

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly workletAvailable: boolean;
  chain: VoxForgeChain | null = null;
  recorder: PcmRecorder | null = null;
  player: BackingPlayer | null = null;
  private monitor: GainNode;
  private vocalOut: MediaStreamAudioDestinationNode | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  readonly pitch = signal<PitchReading | null>(null);
  readonly micOpen = signal(false);
  readonly inputLabel = signal('');
  /** What the microphone really delivers: a Bluetooth headset's mic is phone-call quality (8–16 kHz) — the usual "bad audio". */
  readonly inputInfo = signal<{ label: string; sampleRate: number | null; channels: number | null; narrowband: boolean; echoCancellation: boolean } | null>(null);
  /** The automatic input level (dB) the leveller is applying right now. */
  readonly inputTrimDb = signal(0);
  /** Pre-chain trim ridden by the leveller: a quiet or distant voice is brought up, a hot one held back — musically, never pumping. */
  private trim: GainNode;
  private levelAnalyser: AnalyserNode | null = null;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private levelBuf = new Float32Array(2048);
  private levelPeaks: number[] = [];
  autoLevel = true;
  private ready: Promise<void>;

  constructor() {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.monitor = this.ctx.createGain();
    this.monitor.gain.value = 0;
    this.monitor.connect(this.master);
    this.trim = this.ctx.createGain();
    this.workletAvailable = hasAudioWorklet();
    this.ready = this.loadWorklets();
  }

  private async loadWorklets(): Promise<void> {
    if (!this.workletAvailable) return;
    const base = import.meta.env.BASE_URL;
    try {
      await Promise.all(WORKLET_MODULES.map((m) => this.ctx.audioWorklet.addModule(`${base}worklets/${m}`)));
    } catch (e) {
      console.warn('AudioWorklet modules failed to load; falling back to plain chain', e);
      (this as { workletAvailable: boolean }).workletAvailable = false;
    }
  }

  /** Must be called from a user gesture. */
  async resume(): Promise<void> {
    await this.ready;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (!this.player) this.player = new BackingPlayer(this.ctx, this.master, this.workletAvailable);
  }

  get outputLatencyMs(): number {
    const c = this.ctx as AudioContext & { outputLatency?: number };
    return ((c.outputLatency ?? 0) || c.baseLatency || 0) * 1000;
  }

  /**
   * Open the microphone. With `video` constraints the audio and video are requested in ONE
   * getUserMedia call (iOS Safari drops an earlier capture when a second one starts); the video
   * tracks are returned as their own MediaStream for the camera tile / recorder.
   */
  async openMic(opts: { deviceId?: string; echoCancellation?: boolean; video?: MediaTrackConstraints | false } = {}): Promise<MediaStream | null> {
    await this.resume();
    this.closeMic();
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        echoCancellation: opts.echoCancellation ?? false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: opts.video ?? false,
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (!opts.video) throw e;
      // Camera busy/denied: fall back to audio only so the take still happens.
      stream = await navigator.mediaDevices.getUserMedia({ ...constraints, video: false });
    }
    const videoTracks = stream.getVideoTracks();
    const videoStream = videoTracks.length ? new MediaStream(videoTracks) : null;
    this.micStream = new MediaStream(stream.getAudioTracks());
    const audioTrack = stream.getAudioTracks()[0];
    this.inputLabel.value = audioTrack?.label ?? 'Microphone';
    const st = audioTrack?.getSettings?.() ?? {};
    const sr = typeof st.sampleRate === 'number' ? st.sampleRate : null;
    this.inputInfo.value = { label: this.inputLabel.value, sampleRate: sr, channels: typeof st.channelCount === 'number' ? st.channelCount : null, narrowband: sr !== null && sr < 32000, echoCancellation: Boolean(st.echoCancellation) };
    this.micSource = this.ctx.createMediaStreamSource(stream);
    if (!this.chain) {
      this.chain = createVoxForgeChain(this.ctx, this.workletAvailable);
      this.chain.pitchNode?.port.addEventListener('message', (e: MessageEvent) => {
        const m = e.data as { type: string } & PitchReading;
        if (m.type === 'pitch') this.pitch.value = { hz: m.hz, midi: m.midi, cents: m.cents, clarity: m.clarity };
      });
      this.chain.pitchNode?.port.start();
      if (this.workletAvailable) {
        this.recorder = new PcmRecorder(this.ctx);
        this.chain.output.connect(this.recorder.node);
        this.recorder.node.connect(this.monitor);
      } else {
        this.chain.output.connect(this.monitor);
      }
    }
    this.micSource.connect(this.trim).connect(this.chain.input);
    this.startLeveller();
    this.micOpen.value = true;
    return videoStream;
  }

  closeMic(): void {
    this.stopLeveller();
    this.micSource?.disconnect();
    this.micSource = null;
    this.trim.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.micOpen.value = false;
    this.inputInfo.value = null;
    this.pitch.value = null;
  }

  /**
   * The leveller: the raw mic (no browser AGC — that chops a singing voice) is watched 10× a second;
   * when the loudest moment of the last two seconds is singing (over −34 dBFS raw) yet sits under
   * −18 dBFS the trim rises 1 dB every third reading (to +12 dB); when it goes past −6 dBFS it drops
   * 2 dB at once (to −6 dB). Slow up, fast down: a voice is brought up to a healthy level and never
   * clipped, with no pumping — and room noise between phrases is never lifted.
   */
  private startLeveller(): void {
    this.stopLeveller();
    if (!this.micSource) return;
    const an = this.ctx.createAnalyser();
    an.fftSize = 2048;
    this.micSource.connect(an);
    this.levelAnalyser = an;
    this.levelPeaks = [];
    let db = this.inputTrimDb.value;
    let low = 0;
    this.levelTimer = setInterval(() => {
      if (!this.autoLevel || !this.levelAnalyser) return;
      this.levelAnalyser.getFloatTimeDomainData(this.levelBuf);
      let peak = 0;
      for (let i = 0; i < this.levelBuf.length; i++) {
        const v = Math.abs(this.levelBuf[i]!);
        if (v > peak) peak = v;
      }
      this.levelPeaks.push(peak);
      if (this.levelPeaks.length > 20) this.levelPeaks.shift();
      const recent = Math.max(...this.levelPeaks);
      const gained = recent * Math.pow(10, db / 20);
      let next = db;
      if (gained > LEVEL_HOT) {
        next = Math.max(LEVEL_MIN_DB, db - 2);
        low = 0;
      } else if (recent > LEVEL_SINGING && gained < LEVEL_QUIET && this.levelPeaks.length >= 20) {
        // Quiet singing (not room noise between phrases — that stays where it is): up a dB every few readings.
        if (++low >= 3) {
          next = Math.min(LEVEL_MAX_DB, db + 1);
          low = 0;
        }
      } else low = 0;
      if (next !== db) {
        db = next;
        this.trim.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.1);
        this.inputTrimDb.value = db;
      }
    }, 100);
  }

  private stopLeveller(): void {
    clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    this.levelAnalyser?.disconnect();
    this.levelAnalyser = null;
  }

  applyFx(p: VoxForgeParams): void {
    this.chain?.apply(p);
  }

  /**
   * The vocal as the singer hears it (after the VoxForge chain), as a MediaStream — what a
   * Publishing show view receives to blend with the backing track. Singers never get this from
   * each other (Solo foldback); only publisher links carry it. Null until the mic chain exists.
   */
  vocalStream(): MediaStream | null {
    if (!this.chain) return null;
    if (!this.vocalOut) {
      this.vocalOut = this.ctx.createMediaStreamDestination();
      (this.recorder?.node ?? this.chain.output).connect(this.vocalOut);
    }
    return this.vocalOut.stream;
  }

  /** Hear yourself (with FX). Off by default on phones to avoid speaker feedback. */
  setMonitor(on: boolean, gain = 0.9): void {
    this.monitor.gain.setTargetAtTime(on ? gain : 0, this.ctx.currentTime, 0.03);
  }

  async listInputs(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  async close(): Promise<void> {
    this.closeMic();
    this.vocalOut?.disconnect();
    this.vocalOut = null;
    this.recorder?.dispose();
    this.chain?.dispose();
    this.player?.dispose();
    this.recorder = null;
    this.chain = null;
    this.player = null;
    try {
      await this.ctx.close();
    } catch {
      /* already closed */
    }
  }
}

let shared: AudioEngine | null = null;
/** Lazily create the shared engine (call from a user gesture the first time). */
export function getEngine(): AudioEngine {
  if (!shared || shared.ctx.state === 'closed') shared = new AudioEngine();
  return shared;
}
