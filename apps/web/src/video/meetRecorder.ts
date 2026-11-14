/**
 * The film of a whole meet, on the host's device: the show picture (every singer on stage, cut
 * out over the stage background — exactly the broadcast picture, no lyrics) with the stage mix as
 * its sound (the track and every vocal in a song, the talk between songs), from the moment the
 * host stands on stage with the mic open until the meet is over. One MediaRecorder on the
 * ShowRecorder's canvas, with a tap on every mix bus that device builds; its ten-second pieces go
 * straight into the host's Google Drive as they come (`PerformanceStream`: a resumable upload),
 * so a two-hour meet never has to fit in memory and a tab that dies loses seconds, not the meet.
 * The finished film is a performance of the meet ("Full meet"), shared with everyone who was in it.
 */
import { signal } from '@preact/signals';
import { newId, type PerformanceManifest, type PerformanceSinger } from '@singersvoice/protocol';
import type { AudioEngine } from '../audio/engine.ts';
import { platformName } from '../lib/platform.ts';
import type { PerformanceStream, PerformanceSummary } from '../lib/storage/types.ts';
import { audioSettings } from '../state/settings.ts';
import { withProvider } from '../state/session.ts';
import { pickShowMime, SHOW_FPS, showSupported, type ShowRecorder } from './showRecorder.ts';

/** How often a piece of the film goes to the upload (and how much a dying tab can lose). */
const PIECE_MS = 10_000;
export const FILM_TITLE = 'Full meet';

export interface MeetFilmState {
  recording: boolean;
  /** Seconds recorded so far. */
  seconds: number;
  bytes: number;
  /** Bytes Drive (or the device) confirmed. */
  stored: number;
  /** Why it is not recording, or what is wrong on the way (the film carries on). */
  note: string | null;
  saved: PerformanceSummary | null;
}

export interface MeetFilmSpec {
  meetId: string;
  title: string;
  hostName: string;
  /** Who is on stage, asked when the film ends (the manifest names them). */
  singers: () => PerformanceSinger[];
}

export class MeetRecorder {
  readonly state = signal<MeetFilmState>({ recording: false, seconds: 0, bytes: 0, stored: 0, note: null, saved: null });
  private mr: MediaRecorder | null = null;
  private tap: GainNode | null = null;
  private stream: PerformanceStream | null = null;
  private manifest: PerformanceManifest | null = null;
  private startedAt = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private stopping: Promise<PerformanceSummary | null> | null = null;

  constructor(private readonly show: ShowRecorder) {}

  get recording(): boolean {
    return this.mr !== null;
  }

  /** The performance id of the film being made (null when none). */
  get performanceId(): string | null {
    return this.manifest?.performanceId ?? null;
  }

  private starting = false;

  /** Start the film (no-op while one runs or starts). The upload session is opened first: no Drive, no film. */
  async start(engine: AudioEngine, spec: MeetFilmSpec): Promise<void> {
    if (this.mr || this.stopping || this.starting) return;
    const mime = pickShowMime();
    if (!mime || !showSupported()) {
      this.state.value = { ...this.state.value, note: 'This browser cannot record video' };
      return;
    }
    this.starting = true;
    this.cancelled = false;
    try {
      await this.begin(engine, spec, mime);
    } finally {
      this.starting = false;
    }
  }
  /** `stop` came while the upload session was still being opened: the film is not started after all. */
  private cancelled = false;

  private async begin(engine: AudioEngine, spec: MeetFilmSpec, mime: string): Promise<void> {
    const createdAt = new Date().toISOString();
    const a = audioSettings.peek();
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const manifest: PerformanceManifest = {
      schema: 'singersvoice.performance.v2',
      performanceId: newId('perf-'),
      mode: 'live',
      state: 'kept',
      kind: 'show',
      meetTitle: spec.title,
      hostName: spec.hostName,
      singers: spec.singers(),
      createdAt,
      expiresAt: null,
      trackId: '',
      trackTitle: FILM_TITLE,
      trackArtist: '',
      singerSlot: 1,
      meetId: spec.meetId,
      durationMs: 0,
      timeline: { startedAtEpochMs: Date.now(), vocalOffsetMs: 0, videoOffsetMs: 0, latencyCompMs: 0, sampleRate: engine.ctx.sampleRate },
      playback: { tempo: a.tempo, keyShift: a.keyShift, backingGain: a.backingGain },
      fx: a.params,
      device: { userAgent: navigator.userAgent, platform: platformName, headphones: null },
      files: [{ name: `video.${ext}`, mimeType: mime, size: 0, sha256: '' }],
      notes: 'The whole meet, as the audience saw and heard it.',
    };
    let stream: PerformanceStream;
    try {
      stream = await withProvider((p) => p.beginPerformanceStream(manifest, mime));
    } catch (e) {
      this.state.value = { ...this.state.value, note: `The film of the meet could not start: ${e instanceof Error ? e.message : String(e)}` };
      return;
    }
    if (this.mr || this.stopping || this.cancelled) {
      void stream.abort();
      return;
    }
    // The picture: the show canvas, drawn for the whole meet. The sound: every mix bus, through one tap.
    this.show.keepDrawing = true;
    this.show.startDrawing();
    const tap = engine.ctx.createGain();
    const dest = engine.ctx.createMediaStreamDestination();
    tap.connect(dest);
    this.show.setTap(tap);
    const media = new MediaStream([...this.show.canvas.captureStream(SHOW_FPS).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(media, { mimeType: mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 160_000 });
    } catch (e) {
      this.show.setTap(null);
      this.show.keepDrawing = false;
      void stream.abort();
      this.state.value = { ...this.state.value, note: `This browser cannot record the meet: ${e instanceof Error ? e.message : String(e)}` };
      return;
    }
    this.tap = tap;
    this.stream = stream;
    this.manifest = manifest;
    this.mr = mr;
    this.startedAt = Date.now();
    mr.ondataavailable = (e) => {
      if (!e.data.size || !this.stream) return;
      this.stream.push(e.data, { durationMs: Date.now() - this.startedAt });
      this.tick();
    };
    mr.onerror = () => {
      this.state.value = { ...this.state.value, note: 'The recorder stopped with an error' };
    };
    try {
      mr.start(PIECE_MS);
    } catch (e) {
      this.mr = null;
      this.show.setTap(null);
      this.show.keepDrawing = false;
      void stream.abort();
      this.state.value = { ...this.state.value, note: `The recorder did not start: ${e instanceof Error ? e.message : String(e)}` };
      return;
    }
    this.state.value = { recording: true, seconds: 0, bytes: 0, stored: 0, note: null, saved: null };
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    const s = this.stream;
    this.state.value = { ...this.state.value, seconds: Math.floor((Date.now() - this.startedAt) / 1000), bytes: s?.bytes ?? 0, stored: s?.stored ?? 0, note: s?.error ?? null };
  }

  /**
   * End the film: the recorder's last piece goes out, the upload completes with the total, the
   * performance is listed. Resolves with it (null when nothing was recorded or it could not be saved).
   */
  stop(): Promise<PerformanceSummary | null> {
    if (this.stopping) return this.stopping;
    if (this.starting) this.cancelled = true;
    const mr = this.mr;
    const stream = this.stream;
    if (!mr || !stream) return Promise.resolve(null);
    this.stopping = (async () => {
      clearInterval(this.ticker);
      this.ticker = undefined;
      const durationMs = Date.now() - this.startedAt;
      if (mr.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          mr.onstop = () => resolve();
          try {
            mr.stop(); // the last piece arrives through ondataavailable before onstop
          } catch {
            resolve();
          }
        });
      }
      this.mr = null;
      this.show.setTap(null);
      this.tap?.disconnect();
      this.tap = null;
      this.show.keepDrawing = false;
      this.show.stopDrawing();
      this.stream = null;
      let saved: PerformanceSummary | null = null;
      try {
        saved = await stream.finish({ durationMs });
        this.state.value = { ...this.state.value, recording: false, seconds: Math.floor(durationMs / 1000), bytes: stream.bytes, stored: stream.stored, note: null, saved };
      } catch (e) {
        this.state.value = { ...this.state.value, recording: false, note: `The film of the meet was not saved: ${e instanceof Error ? e.message : String(e)}` };
      }
      this.manifest = null;
      this.stopping = null;
      return saved;
    })();
    return this.stopping;
  }

  dispose(): void {
    void this.stop();
  }
}
