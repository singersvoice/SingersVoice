/**
 * AudioEngine: one AudioContext per session, worklets, mic input → VoxForge chain → recorder →
 * (optional) monitor, and the backing-track player. Created on a user gesture (iOS requirement).
 */
import { signal } from '@preact/signals';
import type { VoxForgeParams } from '@singersvoice/protocol';
import { hasAudioWorklet, isIOS } from '../lib/platform.ts';
import { leveler, MONITOR_RIDER } from './mixBus.ts';
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
export const WORKLET_MODULES = ['pitch-shifter.js', 'recorder.js', 'mix-tap.js', 'mix-out.js', 'dynamics.js', 'shaper.js', 'leveler.js', 'gate.js', 'ducker.js'] as const;

/** Every stream in the app runs at 48 kHz (Opus, AAC, the mix): the context asks for it, so nothing is resampled block by block on the way. */
export const ENGINE_RATE = 48000;

/** The leveller: a raw peak under this is room noise, not singing — never lifted; a gained peak under QUIET is lifted, over HOT pulled down. */
const LEVEL_SINGING = 0.02; // −34 dBFS
const LEVEL_QUIET = 0.125; // −18 dBFS
const LEVEL_HOT = 0.5; // −6 dBFS
const LEVEL_MAX_DB = 12;
const LEVEL_MIN_DB = -6;
/** The voice watch: the processed voice under this RMS (−80 dBFS) while the raw microphone peaks over LEVEL_SINGING is silence… */
const VOICE_SILENT_RMS = 1e-4;
/** …and this many readings in a row (100 ms each) of it, the processed voice is given up for the raw microphone. */
const VOICE_SILENT_READINGS = 30;

/** Where the measured device round trip lives on this device. */
const LATENCY_KEY = 'sv.audio.rtt';
export interface MeasuredLatency {
  ms: number;
  /** The microphone it was measured with (its label), '' when unknown. */
  input: string;
  how: 'sync-check' | 'take';
  at: string;
}
export function readMeasuredLatency(): MeasuredLatency | null {
  try {
    const raw = localStorage.getItem(LATENCY_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<MeasuredLatency>;
    if (typeof m.ms !== 'number' || !Number.isFinite(m.ms) || m.ms < 0 || m.ms > 1500) return null;
    return { ms: m.ms, input: typeof m.input === 'string' ? m.input : '', how: m.how === 'take' ? 'take' : 'sync-check', at: typeof m.at === 'string' ? m.at : '' };
  } catch {
    return null;
  }
}
export function writeMeasuredLatency(m: MeasuredLatency | null): void {
  try {
    if (m) localStorage.setItem(LATENCY_KEY, JSON.stringify(m));
    else localStorage.removeItem(LATENCY_KEY);
  } catch {
    /* no storage: the browser's figures it is */
  }
}

/**
 * The microphone's constraints, the same wherever it is captured (here, or with the camera on iOS — capture.ts): no
 * browser processing but the echo cancellation asked for, and the shortest capture buffer the device can do
 * (`latency`: an ideal, never a refusal — a browser that can run its capture in 128-frame blocks instead of 10 ms
 * ones does, and the singer hears themselves that much sooner; PERFORMER MODE).
 */
export function micConstraints(deviceId: string | undefined, echoCancellation: boolean): MediaTrackConstraints {
  // `latency` is in the Media Capture spec and honoured by Chrome and Safari; TypeScript's DOM types leave it out.
  return { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation, noiseSuppression: false, autoGainControl: false, channelCount: 1, latency: { ideal: MIC_LATENCY_IDEAL_S } } as MediaTrackConstraints;
}
/** The capture buffer asked for (s): 128 frames at 48 kHz. */
export const MIC_LATENCY_IDEAL_S = 128 / ENGINE_RATE;

const hasLiveAudio = (s: MediaStream): boolean => s.getAudioTracks().some((t) => t.readyState === 'live');

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly workletAvailable: boolean;
  chain: VoxForgeChain | null = null;
  recorder: PcmRecorder | null = null;
  player: BackingPlayer | null = null;
  /**
   * The voice as it leaves the engine — after the FX chain (and the take recorder, which passes it
   * through): the one node the mesh, the stage mix and the monitor take it from. Watched: a voice that
   * stays silent while the microphone is sung into (a browser's audio worklet gone wrong — a singer
   * once reached nobody's mix for a whole meet) is replaced by the raw microphone, and `voiceFallback`
   * says so.
   */
  readonly voice: GainNode;
  readonly voiceFallback = signal<string | null>(null);
  private voiceMeter: AnalyserNode | null = null;
  private voiceBuf = new Float32Array(2048);
  private voiceSilentFor = 0;
  private monitor: GainNode;
  private vocalOut: MediaStreamAudioDestinationNode | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  /**
   * The instrument: a second input beside the microphone (a guitar, keys, a violin on a USB interface),
   * its own capture, summed into the singer's sound where the take recorder listens — so it goes wherever
   * the voice goes (the take, the other singers, the stage mix, the film, the broadcast) — but never through
   * the vocal effects or the leveller. Mono: an interface's stereo pair is folded together.
   */
  private instStream: MediaStream | null = null;
  private instSource: MediaStreamAudioSourceNode | null = null;
  private instGain: GainNode;
  readonly instrumentInfo = signal<{ label: string; sampleRate: number | null; channels: number | null } | null>(null);
  readonly instrumentError = signal<string | null>(null);
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
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive', sampleRate: ENGINE_RATE });
    } catch {
      ctx = new Ctor({ latencyHint: 'interactive' }); // a browser that cannot run at 48 kHz: its own rate, and the block resamplers do the rest
    }
    this.ctx = ctx;
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.monitor = this.ctx.createGain();
    this.monitor.gain.value = 0;
    this.monitor.connect(this.master);
    this.voice = this.ctx.createGain();
    this.voice.connect(this.monitor);
    this.trim = this.ctx.createGain();
    this.instGain = this.ctx.createGain();
    this.instGain.channelCount = 1;
    this.instGain.channelCountMode = 'explicit';
    this.instGain.channelInterpretation = 'speakers';
    this.workletAvailable = hasAudioWorklet();
    this.ready = this.loadWorklets();
  }

  private async loadWorklets(): Promise<void> {
    if (!this.workletAvailable) return;
    const base = import.meta.env.BASE_URL;
    try {
      await Promise.all(WORKLET_MODULES.map((m) => this.ctx.audioWorklet.addModule(`${base}worklets/${m}`)));
      this.rideMonitor();
    } catch (e) {
      console.warn('AudioWorklet modules failed to load; falling back to plain chain', e);
      (this as { workletAvailable: boolean }).workletAvailable = false;
    }
  }

  /**
   * PERFORMER MODE — the singer's own ears: the same rider the mix bus puts on every voice sits between the voice
   * and the monitor, but to the performer level (mixBus.ts MONITOR_RIDER: loudness.ts PERFORMER_MONITOR, about half as
   * loud as the published voice, plus the singer's own "Your voice in your ears" offset — `setMonitorLevel`), over
   * the backing track at their own listening level (player.ts `gain`). A quiet microphone is as present in the
   * headphones as a loud one; what the recording and the audience get (PUBLISH MODE, the bus) is set apart.
   */
  private monitorRider: AudioWorkletNode | null = null;
  private monitorDb = 0;
  /** What the monitor's rider puts out right now (K-weighted dB: its input's level plus its gain), four times a second; null without the rider. Support, the e2e. */
  monitorOutDb: number | null = null;

  private rideMonitor(): void {
    const rider = leveler(this.ctx, MONITOR_RIDER);
    if (!rider) return;
    try {
      this.voice.disconnect(this.monitor);
    } catch {
      /* not connected */
    }
    this.voice.connect(rider).connect(this.monitor);
    rider.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; levelDb?: number; gainDb?: number };
      if (m.type === 'level' && typeof m.levelDb === 'number' && typeof m.gainDb === 'number') this.monitorOutDb = m.levelDb + m.gainDb;
    };
    this.monitorRider = rider;
    this.setMonitorLevel(this.monitorDb);
  }

  /** The singer's own voice in their ears, relative to the performer level (dB; 0 is the mode's own: about half as loud as in the recording). */
  setMonitorLevel(db: number): void {
    this.monitorDb = Math.max(-24, Math.min(24, Number.isFinite(db) ? db : 0));
    this.monitorRider?.parameters.get('target')?.setTargetAtTime(Math.min(0, MONITOR_RIDER.target + this.monitorDb), this.ctx.currentTime, 0.05);
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

  /** How late the microphone's sound reaches the graph (ms): the track's own figure where the browser gives one, else the context's base latency. */
  get inputLatencyMs(): number {
    const st = this.micStream?.getAudioTracks()[0]?.getSettings?.() as { latency?: number } | undefined;
    const fromTrack = typeof st?.latency === 'number' && st.latency > 0 && st.latency < 0.5 ? st.latency : 0;
    return (fromTrack || this.ctx.baseLatency || 0.01) * 1000;
  }

  /**
   * The whole round trip a singer sings against (ms): the track reaches their ears `outputLatencyMs`
   * late, their voice reaches the graph `inputLatencyMs` late and leaves the chain `chain latency`
   * later still (and the pitch stage's hold while it corrects) — the voice lands this far behind the
   * track in the graph, so a recording holds the track back by this much to put them together. The
   * device's part (speakers out, microphone in) is what the browser reports — unless it has been
   * measured on this device with this microphone (`measuredDeviceMs`: the sync check in Settings, or a
   * take whose microphone heard the track), which is the truth: Bluetooth headphones and many phones add
   * 100 ms and more that no browser reports.
   */
  get roundTripMs(): number {
    return this.deviceLatencyMs + this.chainLatencyMs;
  }

  /** The chain's own hold on the voice (ms): its stages' lookaheads, and the pitch stage's while it works. */
  get chainLatencyMs(): number {
    if (!this.chain) return 0;
    return (this.chain.latencyFrames / this.ctx.sampleRate) * 1000 + this.chain.pitchDelayMs;
  }

  /** Speakers out and microphone in (ms): measured on this device when it has been, else the browser's figures. */
  get deviceLatencyMs(): number {
    const measured = this.measuredDeviceMs;
    return measured ?? this.outputLatencyMs + this.inputLatencyMs;
  }

  /** The measured device round trip for the microphone in use (ms), or null when none has been measured for it. */
  get measuredDeviceMs(): number | null {
    const m = readMeasuredLatency();
    if (!m) return null;
    if (m.input && this.inputLabel.value && m.input !== this.inputLabel.value) return null; // another microphone: another figure
    return m.ms;
  }

  /** Remember the device's round trip as measured (ms), for the microphone in use: every later take and mix on this device uses it. */
  rememberDeviceLatency(ms: number, how: 'sync-check' | 'take'): void {
    writeMeasuredLatency({ ms: Math.round(ms), input: this.inputLabel.value, how, at: new Date().toISOString() });
  }

  /**
   * Open the microphone. With `video` constraints the audio and video are requested in ONE
   * getUserMedia call (iOS Safari drops an earlier capture when a second one starts); the video
   * tracks are returned as their own MediaStream for the camera tile / recorder. With `adopt`, a
   * stream captured elsewhere that carries a live microphone track (the camera's, captured with the
   * microphone — capture.ts) is used as it is: no new capture, so no new prompt (the video stays the
   * caller's: null is returned for it). A microphone parked between songs (`parkMic`) is taken back
   * the same way when the same microphone with the same processing is asked for.
   */
  async openMic(opts: { deviceId?: string; echoCancellation?: boolean; video?: MediaTrackConstraints | false; adopt?: MediaStream | null } = {}): Promise<MediaStream | null> {
    await this.resume();
    const parked = this.parked;
    this.parked = null;
    this.closeMic();
    this.aecBase = opts.echoCancellation ?? false;
    this.micDeviceId = opts.deviceId;
    const constraints: MediaStreamConstraints = { audio: micConstraints(opts.deviceId, this.aecBase || this.talkback), video: opts.video ?? false };
    let stream: MediaStream;
    let adopted = false;
    if (opts.adopt && hasLiveAudio(opts.adopt)) {
      stream = opts.adopt;
      adopted = true;
      if (parked && parked.stream !== stream) parked.stream.getAudioTracks().forEach((t) => t.stop());
    } else if (parked && hasLiveAudio(parked.stream) && parked.deviceId === opts.deviceId && parked.aec === (this.aecBase || this.talkback)) {
      stream = parked.stream;
      adopted = true;
    } else {
      parked?.stream.getAudioTracks().forEach((t) => t.stop());
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        if (!opts.video) throw e;
        // Camera busy/denied: fall back to audio only so the take still happens.
        stream = await navigator.mediaDevices.getUserMedia({ ...constraints, video: false });
      }
    }
    stream.getAudioTracks().forEach((t) => (t.enabled = true)); // a parked track is muted while it waits
    const videoTracks = adopted ? [] : stream.getVideoTracks();
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
      }
    }
    // The processed voice feeds `voice` (a connection already there is left as it is); a fallback from an earlier camera is undone.
    (this.recorder?.node ?? this.chain.output).connect(this.voice);
    this.voiceFallback.value = null;
    this.voiceSilentFor = 0;
    this.micSource.connect(this.trim).connect(this.chain.input);
    this.startLeveller();
    this.micOpen.value = true;
    // Talk-back may have been switched while the capture was on its way: the track is brought to the setting now wanted.
    this.aecSwap = this.aecSwap.then(() => this.applyAec()).catch(() => undefined);
    return videoStream;
  }

  closeMic(): void {
    this.leaveMic();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.parked?.stream.getAudioTracks().forEach((t) => t.stop());
    this.parked = null;
  }

  /** A microphone parked between songs (`parkMic`), waiting for the next opening. */
  private parked: { stream: MediaStream; deviceId: string | undefined; aec: boolean } | null = null;

  /**
   * The microphone between songs, on a device that keeps one capture per page (iPhone, iPad — a new capture
   * would ask again, and end the camera): the capture stays, muted, nothing processed, and the next `openMic`
   * for the same microphone takes it back without a prompt. `closeMic` lets it go for good (leaving the stage).
   */
  parkMic(): void {
    const stream = this.micStream;
    const deviceId = this.micDeviceId;
    const aec = this.aecBase || this.talkback;
    this.leaveMic();
    this.micStream = null;
    if (!stream) return;
    stream.getAudioTracks().forEach((t) => (t.enabled = false));
    this.parked = { stream, deviceId, aec };
  }

  /** Whether a microphone waits parked (support, the stage's word). */
  get micParked(): boolean {
    return this.parked !== null && hasLiveAudio(this.parked.stream);
  }

  /** The graph side of closing the microphone: the source off the chain, the leveller and the instrument stopped, the signals cleared. */
  private leaveMic(): void {
    this.stopLeveller();
    this.closeInstrument();
    this.micSource?.disconnect();
    this.micSource = null;
    this.trim.disconnect();
    this.micOpen.value = false;
    this.inputInfo.value = null;
    this.pitch.value = null;
  }

  /**
   * Open the instrument input (after the microphone: it joins the voice where the take recorder listens, so a
   * take holds voice and instrument together; without the worklet it lands on the voice bus itself). A line
   * input: no echo cancellation, no noise suppression, no automatic gain — the level is `gainDb`, set by the singer.
   */
  async openInstrument(opts: { deviceId: string; gainDb?: number }): Promise<void> {
    await this.resume();
    this.closeInstrument();
    this.instrumentError.value = null;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: opts.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    } catch (e) {
      this.instrumentError.value = e instanceof Error && e.name === 'OverconstrainedError' ? 'The instrument input is not plugged in (pick it again once it is).' : e instanceof Error ? e.message : String(e);
      throw e;
    }
    this.instStream = new MediaStream(stream.getAudioTracks());
    const t = this.instStream.getAudioTracks()[0];
    const st = t?.getSettings?.() ?? {};
    this.instrumentInfo.value = { label: t?.label ?? 'Instrument', sampleRate: typeof st.sampleRate === 'number' ? st.sampleRate : null, channels: typeof st.channelCount === 'number' ? st.channelCount : null };
    this.instSource = this.ctx.createMediaStreamSource(this.instStream);
    this.setInstrumentGain(opts.gainDb ?? 0);
    this.instSource.connect(this.instGain).connect(this.recorder?.node ?? this.voice);
    t?.addEventListener('ended', () => {
      if (this.instStream?.getAudioTracks()[0] === t) {
        this.closeInstrument();
        this.instrumentError.value = 'The instrument input was unplugged.';
      }
    });
  }

  /** The raw microphone (after the leveller's trim, before the chain) into `node` — the sync check records it there. */
  tapRaw(node: AudioNode): void {
    this.trim.connect(node);
  }
  untapRaw(node: AudioNode): void {
    try {
      this.trim.disconnect(node);
    } catch {
      /* not connected */
    }
  }

  /** The instrument's level (dB, −24…+24), changed on the spot. */
  setInstrumentGain(db: number): void {
    this.instGain.gain.setTargetAtTime(Math.pow(10, Math.max(-24, Math.min(24, db)) / 20), this.ctx.currentTime, 0.03);
  }

  closeInstrument(): void {
    this.instSource?.disconnect();
    this.instSource = null;
    this.instGain.disconnect();
    this.instStream?.getTracks().forEach((t) => t.stop());
    this.instStream = null;
    this.instrumentInfo.value = null;
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
    if (!this.voiceMeter) {
      this.voiceMeter = this.ctx.createAnalyser();
      this.voiceMeter.fftSize = 2048;
      this.voice.connect(this.voiceMeter);
    }
    let db = this.inputTrimDb.value;
    let low = 0;
    this.levelTimer = setInterval(() => {
      if (!this.levelAnalyser) return;
      this.levelAnalyser.getFloatTimeDomainData(this.levelBuf);
      let peak = 0;
      for (let i = 0; i < this.levelBuf.length; i++) {
        const v = Math.abs(this.levelBuf[i]!);
        if (v > peak) peak = v;
      }
      this.watchVoice(peak);
      if (!this.autoLevel) return;
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
    this.voiceSilentFor = 0;
  }

  /**
   * Ten times a second, beside the leveller: the microphone is being sung into (a raw peak over the singing
   * floor) yet nothing comes out of the voice — for VOICE_SILENT_READINGS in a row — and the processed voice
   * is given up: the raw microphone (through the trim) goes out instead, so the singer reaches the mix,
   * the mesh and the take with a plain voice rather than none. Said on the mic line (`voiceFallback`).
   */
  private watchVoice(rawPeak: number): void {
    if (this.voiceFallback.value || !this.voiceMeter || !this.chain) return;
    this.voiceMeter.getFloatTimeDomainData(this.voiceBuf);
    let sum = 0;
    for (let i = 0; i < this.voiceBuf.length; i++) sum += this.voiceBuf[i]! * this.voiceBuf[i]!;
    const voiceRms = Math.sqrt(sum / this.voiceBuf.length);
    if (rawPeak > LEVEL_SINGING && voiceRms < VOICE_SILENT_RMS) this.voiceSilentFor++;
    else this.voiceSilentFor = 0;
    if (this.voiceSilentFor < VOICE_SILENT_READINGS) return;
    const processed = this.recorder?.node ?? this.chain.output;
    try {
      processed.disconnect(this.voice);
    } catch {
      /* not connected */
    }
    this.trim.connect(this.voice);
    this.voiceFallback.value = 'Voice effects are off: the browser stopped processing your voice, so it goes out plain (reopen the mic to try the effects again)';
    console.warn('voice: the processed voice stayed silent while the microphone was sung into — the raw microphone goes out instead');
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
      this.voice.connect(this.vocalOut);
    }
    return this.vocalOut.stream;
  }

  private monitorWanted = { on: false, gain: 1 };
  private monitorMuted = false;

  /** Hear yourself (with FX, at the mix's vocal level — `rideMonitor`). Off by default on phones to avoid speaker feedback. */
  setMonitor(on: boolean, gain = 1): void {
    this.monitorWanted = { on, gain };
    this.monitor.gain.setTargetAtTime(on && !this.monitorMuted ? gain : 0, this.ctx.currentTime, 0.03);
  }

  /** The monitor held off while something else carries the voice to the ears (the sound preview, through its own bus); `setMonitor` is remembered meanwhile and back when released. */
  muteMonitor(muted: boolean): void {
    this.monitorMuted = muted;
    this.setMonitor(this.monitorWanted.on, this.monitorWanted.gain);
  }

  /** The singer's own choice of echo cancellation ("I'm on speakers"): on for the whole time the mic is open. */
  private aecBase = false;
  private talkback = false;
  private micDeviceId: string | undefined;
  /** One change of the microphone's processing at a time (a talk-back switch on its way is not overtaken by the next). */
  private aecSwap: Promise<void> = Promise.resolve();
  /**
   * Talk-back is on (between songs, and while the song is paused, the singers on stage hear each other through
   * this device's speakers): the browser's echo cancellation takes those voices back out of this microphone, so
   * nobody hears themselves come back, and no loop builds up between two phones on speakers. For the song it is
   * off again (unless the singer keeps it on), as echo cancellation chews at a singing voice over a backing track.
   * The track is asked to change in place (`applyConstraints` — Firefox does it); where the browser answers and
   * changes nothing (Chrome, Safari) the microphone is captured again with the new setting and swapped in under
   * the chain, the new capture connected before the old one is let go, so the voice never breaks — except on
   * iOS, which keeps one capture per page (a second would end the camera): there the setting waits for the next
   * opening of the microphone, and a singer on speakers ticks "I'm on speakers", which keeps it on throughout.
   */
  setTalkback(on: boolean): void {
    if (this.talkback === on) return;
    this.talkback = on;
    this.aecSwap = this.aecSwap.then(() => this.applyAec()).catch(() => undefined);
  }

  private async applyAec(): Promise<void> {
    const track = this.micStream?.getAudioTracks()[0];
    if (!track) return;
    const want = this.aecBase || this.talkback;
    const aecOf = (t: MediaStreamTrack) => Boolean((t.getSettings?.() as { echoCancellation?: boolean } | undefined)?.echoCancellation);
    if (aecOf(track) === want) return;
    if (typeof track.applyConstraints === 'function') {
      await track.applyConstraints({ echoCancellation: want }).catch(() => undefined);
      if (aecOf(track) === want) {
        this.noteInput(track);
        return;
      }
    }
    if (isIOS || this.micStream?.getAudioTracks()[0] !== track) return;
    // A fresh capture with the setting, swapped in: connected first, then the old one let go.
    let fresh: MediaStream;
    try {
      fresh = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(this.micDeviceId, want), video: false });
    } catch {
      return; // the device would not open again: the voice goes on as it was
    }
    if (this.micStream?.getAudioTracks()[0] !== track || !this.micSource) {
      fresh.getTracks().forEach((t) => t.stop()); // the mic was closed or re-opened meanwhile
      return;
    }
    const source = this.ctx.createMediaStreamSource(fresh);
    source.connect(this.trim);
    if (this.levelAnalyser) source.connect(this.levelAnalyser); // the leveller keeps listening to the voice, not to a silent old source
    this.micSource.disconnect();
    this.micStream.getTracks().forEach((t) => t.stop());
    this.micSource = source;
    this.micStream = new MediaStream(fresh.getAudioTracks());
    this.noteInput(fresh.getAudioTracks()[0]!);
  }

  /** The mic line follows the track as it stands now (its echo cancellation, its rate). */
  private noteInput(track: MediaStreamTrack): void {
    const st = (track.getSettings?.() ?? {}) as { sampleRate?: number; channelCount?: number; echoCancellation?: boolean };
    const info = this.inputInfo.value;
    if (info) this.inputInfo.value = { ...info, sampleRate: typeof st.sampleRate === 'number' ? st.sampleRate : info.sampleRate, channels: typeof st.channelCount === 'number' ? st.channelCount : info.channels, echoCancellation: Boolean(st.echoCancellation) };
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
