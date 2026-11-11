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

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly workletAvailable: boolean;
  chain: VoxForgeChain | null = null;
  recorder: PcmRecorder | null = null;
  player: BackingPlayer | null = null;
  private monitor: GainNode;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  readonly pitch = signal<PitchReading | null>(null);
  readonly micOpen = signal(false);
  readonly inputLabel = signal('');
  private ready: Promise<void>;

  constructor() {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.monitor = this.ctx.createGain();
    this.monitor.gain.value = 0;
    this.monitor.connect(this.master);
    this.workletAvailable = hasAudioWorklet();
    this.ready = this.loadWorklets();
  }

  private async loadWorklets(): Promise<void> {
    if (!this.workletAvailable) return;
    const base = import.meta.env.BASE_URL;
    try {
      await Promise.all([this.ctx.audioWorklet.addModule(`${base}worklets/pitch-shifter.js`), this.ctx.audioWorklet.addModule(`${base}worklets/recorder.js`)]);
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

  async openMic(opts: { deviceId?: string; echoCancellation?: boolean } = {}): Promise<void> {
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
      video: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.micStream = stream;
    this.inputLabel.value = stream.getAudioTracks()[0]?.label ?? 'Microphone';
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
    this.micSource.connect(this.chain.input);
    this.micOpen.value = true;
  }

  closeMic(): void {
    this.micSource?.disconnect();
    this.micSource = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.micOpen.value = false;
    this.pitch.value = null;
  }

  applyFx(p: VoxForgeParams): void {
    this.chain?.apply(p);
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
