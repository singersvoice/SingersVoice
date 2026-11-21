/**
 * The film of a whole meet, on the host's device: the show picture (every singer on stage, cut
 * out over the stage background — exactly the broadcast picture, no lyrics) with the stage mix as
 * its sound (the track and every vocal in a song, the talk between songs), from the moment the
 * host stands on stage with the mic open until the meet is over. The same recorder films the
 * publisher's broadcast: in the show view the picture is the broadcast canvas and the sound is the
 * publisher bus (the backing track and every vocal, exactly what goes out), and the whole broadcast
 * lands in the publisher's own Drive as "Broadcast" — the footage of the show as it was streamed.
 *
 * The film is ONE file: it never stops, and never cuts, while it runs — a song's start, pause, stop
 * or restart only puts a chapter MARK on it (video/chapters.ts: one per song, a restart and a new
 * song each their own, one per pause, one for the stage between songs), kept in the manifest
 * (`chapters`: what and where, `startMs`) so a song is found in the film at once and the whole
 * evening plays through as one. The pieces go straight into Drive as they come (`PerformanceStream`:
 * one resumable upload, a piece every ten seconds), so a two-hour meet never has to fit in memory —
 * and a tab that dies mid-meet leaves an upload Drive completes with what it holds the next time
 * the host opens the app (`completeAsIs`), the marks up to then on it.
 */
import { signal } from '@preact/signals';
import { newId, type PerformanceChapter, type PerformanceManifest, type PerformanceSinger } from '@singersvoice/protocol';
import type { AudioEngine } from '../audio/engine.ts';
import type { PublisherBus } from '../broadcast/publisherBus.ts';
import { appBuild, platformName } from '../lib/platform.ts';
import type { PerformanceStream, PerformanceSummary } from '../lib/storage/types.ts';
import { audioSettings } from '../state/settings.ts';
import { withProvider } from '../state/session.ts';
import { CanvasTrack } from './canvasTrack.ts';
import type { ChapterCue } from './chapters.ts';
import { showBitrate } from './enhance.ts';
import { pickShowMime, showSupported, type ShowRecorder } from './showRecorder.ts';

/** How often a piece of the film goes to the upload (and how much a dying tab can lose). */
const PIECE_MS = 10_000;
/** A chapter that starts at a known instant (a kickstart) is marked this much ahead of it, so a jump to the mark lands before the first beat. */
export const CUT_LEAD_MS = 300;
/** The film's frame rate where the browser has no hardware H.264 (WebM, software): light on the stage's own device. */
const SOFT_FPS = 15;
export const FILM_TITLE = 'Full meet';
/** The publisher's footage of the broadcast, as it went out. */
export const BROADCAST_TITLE = 'Broadcast';

/** Where the film's sound comes from: an audio context and a way to route the sound into the recorder's destination. */
export interface FilmSound {
  ctx: AudioContext;
  /** Route the sound into `dest`; the function returned undoes it. */
  attach(dest: AudioNode): () => void;
}

/** The stage mix on the host's device: every mix bus the show builds (the song's, the talk between songs) through one tap. */
export const stageSound = (engine: AudioEngine, show: ShowRecorder): FilmSound => ({
  ctx: engine.ctx,
  attach: (dest) => {
    const tap = engine.ctx.createGain();
    tap.connect(dest);
    show.setTap(tap);
    return () => {
      show.setTap(null);
      tap.disconnect();
    };
  },
});

/** The publisher bus in the show view: the broadcast's own sound (the backing track and every singer's vocal, blended). */
export const busSound = (bus: PublisherBus): FilmSound => ({
  ctx: bus.ctx,
  attach: (dest) => {
    bus.output.connect(dest);
    return () => {
      try {
        bus.output.disconnect(dest);
      } catch {
        /* not connected */
      }
    };
  },
});

/** The film hears nothing when its sound has stayed under this (dBFS) — said on the film's line, so a silent film is never a surprise afterwards. */
export const FILM_SILENT_DB = -55;

/** What the film hears right now, for its line: its level, or that nothing reaches it (a silent film is said here, never found afterwards). */
export function filmSound(s: { level: number; heard: boolean; seconds: number }): string {
  if (s.level > FILM_SILENT_DB) return `sound ${Math.round(s.level)} dB`;
  return s.heard || s.seconds < 3 ? 'sound: quiet' : 'NO SOUND reaching the film';
}

export interface MeetFilmState {
  recording: boolean;
  /** Seconds recorded so far (the whole film). */
  seconds: number;
  bytes: number;
  /** Bytes Drive (or the device) confirmed. */
  stored: number;
  /** Why it is not recording, or what is wrong on the way (the film carries on). */
  note: string | null;
  /** The film, once saved (one file). */
  saved: PerformanceSummary | null;
  /** The sound reaching the film over the last second (dBFS; -100 when none), and whether it has heard any since it started. */
  level: number;
  heard: boolean;
  /** The chapter the film is in: its number, what it is, how long so far. */
  chapter: { index: number; kind: PerformanceChapter['kind']; title: string; seconds: number } | null;
  /** Chapter marks on the film so far. */
  chapters: number;
}

export interface MeetFilmSpec {
  meetId: string;
  title: string;
  hostName: string;
  /** Who is on stage, asked as the film ends (its manifest names everyone who stood on it). */
  singers: () => PerformanceSinger[];
  /** What the film is called in the performances list ("Full meet" unless said otherwise) and the note on it. */
  film?: { title: string; notes: string };
  /** The film, once it is in Drive (registered with the meet by the caller), with its chapter marks. */
  onSaved?: (saved: PerformanceSummary, chapters: PerformanceChapter[]) => void;
}

const idleState = (): MeetFilmState => ({ recording: false, seconds: 0, bytes: 0, stored: 0, note: null, saved: null, level: -100, heard: false, chapter: null, chapters: 0 });

/** The film being written: its recorder, its upload (opened as the recorder starts), its manifest with the marks so far. */
interface Chunk {
  manifest: PerformanceManifest;
  mr: MediaRecorder;
  startedAt: number;
  /** The upload, once Drive opened it; pieces that came before wait in `pending`. */
  stream: PerformanceStream | null;
  pending: Blob[];
  bytes: number;
  /** The upload could not be opened: the film is not being saved (said on the line). */
  failed: string | null;
  ended: boolean;
  /** The chapter marks so far, the last one being the chapter the film is in. */
  marks: ChapterCue[];
}

export class MeetRecorder {
  readonly state = signal<MeetFilmState>(idleState());
  /** The media every chapter's recorder records: the picture's track and the sound's destination. */
  private media: MediaStream | null = null;
  private mime = '';
  private soft = false;
  /** Undoes the sound's routing into the recorder. */
  private detach: (() => void) | null = null;
  private spec: MeetFilmSpec | null = null;
  private sound: FilmSound | null = null;
  private eventId = '';
  private filmStartedAt = 0;
  private current: Chunk | null = null;
  private totalBytes = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private stopping: Promise<PerformanceSummary | null> | null = null;
  /** The mark the stage asked for, waiting for its instant. */
  private scheduled: { cue: ChapterCue; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The chapter the stage last asked for (`cue`), applied when the film starts if it is not running yet. */
  private wanted: ChapterCue | null = null;

  constructor(private readonly show: ShowRecorder) {}

  get recording(): boolean {
    return this.current !== null;
  }

  /** The performance id of the film being made (null when none). */
  get performanceId(): string | null {
    return this.current?.manifest.performanceId ?? null;
  }

  /** The filming's id (the manifest's `chapters` carry it). */
  get filmEventId(): string {
    return this.eventId;
  }

  /** The chapter marks on the film so far. */
  get marks(): PerformanceChapter[] {
    return this.current?.manifest.chapters ?? [];
  }

  private starting = false;

  /** Start the film (no-op while one runs or starts). The first chapter is the one the stage calls for now (`cue`), else the stage between songs. */
  async start(sound: FilmSound, spec: MeetFilmSpec, first?: ChapterCue): Promise<void> {
    if (this.current || this.stopping || this.starting) return;
    const mime = pickShowMime();
    if (!mime || !showSupported()) {
      this.state.value = { ...this.state.value, note: 'This browser cannot record video' };
      return;
    }
    this.starting = true;
    this.cancelled = false;
    try {
      await this.begin(sound, spec, mime, first ?? this.wanted ?? { kind: 'stage', title: 'On stage', key: 'stage:0', at: Date.now(), trackId: '', trackTitle: '', songEpoch: 0 });
    } finally {
      this.starting = false;
    }
  }
  /** `stop` came while the first upload was being opened: the film is not started after all. */
  private cancelled = false;

  private async begin(sound: FilmSound, spec: MeetFilmSpec, mime: string, first: ChapterCue): Promise<void> {
    // The picture: the show canvas, drawn for the whole meet. The sound: whatever `sound` routes in (the stage mix, the publisher bus).
    this.show.keepDrawing = true;
    this.show.startDrawing();
    const dest = sound.ctx.createMediaStreamDestination();
    // The sound comes in through one inlet: into the recorder, and past a meter that says on the film's line what it hears.
    const inlet = sound.ctx.createGain();
    const meter = sound.ctx.createAnalyser();
    meter.fftSize = 2048;
    inlet.connect(dest);
    inlet.connect(meter);
    const detachSound = sound.attach(inlet);
    const detach = () => {
      detachSound();
      inlet.disconnect();
      meter.disconnect();
    };
    this.meter = meter;
    // H.264 in MP4 is hardware-encoded wherever it is offered (Windows, Mac, iOS, Android): the film is the full
    // show at its size and rate (1080p30 on a computer, 720p24 on a phone — enhance.ts). A browser that only offers WebM encodes in software — the film then runs lighter
    // (960×540, 15 fps, drawn from the show canvas) so the stage itself never slows down.
    const soft = !mime.includes('mp4');
    // The picture's track is fed frame by frame (CanvasTrack): the film goes on while the host's tab is hidden.
    const track = soft ? this.scaledSource() : this.show.takeTrack(this.show.fps);
    this.track = track;
    this.media = new MediaStream([track.track, ...dest.stream.getAudioTracks()]);
    this.mime = mime;
    this.soft = soft;
    this.detach = detach;
    this.spec = spec;
    this.sound = sound;
    this.eventId = newId('film-');
    this.filmStartedAt = Date.now();
    this.totalBytes = 0;
    this.state.value = { ...idleState(), recording: true };
    this.peak = -100;
    const started = await this.startChunk(first);
    if (!started || this.cancelled) {
      await this.endChunk(this.current);
      this.current = null;
      this.teardown();
      if (started) this.state.value = { ...this.state.value, recording: false };
      return;
    }
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(), 1000);
    clearInterval(this.metering);
    this.metering = setInterval(() => this.sampleLevel(), 100);
  }

  /**
   * The stage calls for a chapter (video/chapters.ts): the same key as the chapter the film is in
   * changes nothing; a new one puts a mark on the film at the chapter's instant (a kickstart a moment
   * ahead, a cued pause) or right away when that instant has passed.
   */
  cue(c: ChapterCue): void {
    this.wanted = c;
    if (!this.current) return;
    const inChapter = this.current.marks[this.current.marks.length - 1];
    if (inChapter?.key === c.key || this.scheduled?.cue.key === c.key) return;
    if (this.scheduled) clearTimeout(this.scheduled.timer);
    const wait = Math.max(0, c.at - CUT_LEAD_MS - Date.now());
    const timer = setTimeout(() => {
      this.scheduled = null;
      this.mark(c);
    }, wait);
    this.scheduled = { cue: c, timer };
  }

  /** The mark itself: on the film's clock now, in the manifest (the upload remembers it: an interrupted film keeps its marks). */
  private mark(c: ChapterCue, at = Date.now()): void {
    const chunk = this.current;
    if (!chunk || chunk.ended) return;
    const last = chunk.marks[chunk.marks.length - 1];
    if (last?.key === c.key) return;
    chunk.marks.push(c);
    const index = chunk.marks.length;
    const chapter: PerformanceChapter = { eventId: this.eventId, eventTitle: this.spec?.film?.title ?? FILM_TITLE, index, kind: c.kind, trackId: c.trackId, trackTitle: c.trackTitle, songEpoch: c.songEpoch, startedAt: new Date(at).toISOString(), startMs: Math.max(0, at - chunk.startedAt), ...(c.kind === 'song' && c.songMs ? { songMs: c.songMs } : {}) };
    chunk.manifest = { ...chunk.manifest, chapters: [...(chunk.manifest.chapters ?? []), chapter], singers: this.spec?.singers() ?? chunk.manifest.singers };
    chunk.stream?.update(chunk.manifest);
    this.state.value = { ...this.state.value, chapter: { index, kind: c.kind, title: c.title, seconds: 0 }, chapters: index };
  }

  /** The film's manifest: a show of the whole meet (or broadcast), its chapter marks added as the stage goes. */
  private filmManifest(startedAt: number): PerformanceManifest {
    const spec = this.spec!;
    const a = audioSettings.peek();
    const ext = this.mime.includes('mp4') ? 'mp4' : 'webm';
    return {
      schema: 'singersvoice.performance.v2',
      performanceId: newId('perf-'),
      mode: 'live',
      state: 'kept',
      kind: 'show',
      meetTitle: spec.title,
      hostName: spec.hostName,
      singers: spec.singers(),
      chapters: [],
      createdAt: new Date(startedAt).toISOString(),
      expiresAt: null,
      trackId: '',
      trackTitle: spec.film?.title ?? FILM_TITLE,
      trackArtist: '',
      singerSlot: 1,
      meetId: spec.meetId,
      durationMs: 0,
      timeline: { startedAtEpochMs: startedAt, vocalOffsetMs: 0, videoOffsetMs: 0, latencyCompMs: 0, sampleRate: this.sound?.ctx.sampleRate ?? 48000 },
      playback: { tempo: a.tempo, keyShift: a.keyShift, backingGain: a.backingGain },
      fx: a.params,
      device: { userAgent: navigator.userAgent, platform: platformName, headphones: null, build: appBuild },
      files: [{ name: `video.${ext}`, mimeType: this.mime, size: 0, sha256: '' }],
      notes: spec.film?.notes ?? 'The whole meet, as the audience saw and heard it — a chapter mark per song, pause and stretch of stage.',
    };
  }

  /**
   * The film's recorder starts on the media now, its upload is opened beside it, and the first chapter
   * is marked at its start. Resolves once the recorder is running (false when it could not start).
   */
  private async startChunk(first: ChapterCue): Promise<boolean> {
    if (!this.media || !this.spec) return false;
    const startedAt = Date.now();
    const manifest = this.filmManifest(startedAt);
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(this.media, { mimeType: this.mime, videoBitsPerSecond: this.soft ? 1_600_000 : showBitrate(this.show.width, this.show.height), audioBitsPerSecond: 160_000 });
    } catch (e) {
      this.state.value = { ...this.state.value, note: `This browser cannot record the meet: ${e instanceof Error ? e.message : String(e)}` };
      return false;
    }
    const chunk: Chunk = { manifest, mr, startedAt, stream: null, pending: [], bytes: 0, failed: null, ended: false, marks: [] };
    mr.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunk.bytes += e.data.size;
      this.totalBytes += e.data.size;
      if (chunk.stream) chunk.stream.push(e.data, { durationMs: Date.now() - chunk.startedAt });
      else if (!chunk.failed) chunk.pending.push(e.data);
      this.tick();
    };
    mr.onerror = () => {
      this.state.value = { ...this.state.value, note: 'The film\'s recorder stopped with an error' };
    };
    const running = new Promise<boolean>((resolve) => {
      mr.onstart = () => resolve(true);
      try {
        mr.start(PIECE_MS);
      } catch (e) {
        this.state.value = { ...this.state.value, note: `The recorder did not start: ${e instanceof Error ? e.message : String(e)}` };
        resolve(false);
      }
    });
    // The upload is opened while the recorder starts; pieces that come first wait for it.
    void withProvider((p) => p.beginPerformanceStream(manifest, this.mime))
      .then((stream) => {
        chunk.stream = stream;
        stream.update(chunk.manifest); // the marks made in the meantime
        for (const b of chunk.pending) stream.push(b, { durationMs: Date.now() - chunk.startedAt });
        chunk.pending = [];
        if (chunk.ended) void this.finishChunk(chunk);
      })
      .catch((e) => {
        chunk.failed = e instanceof Error ? e.message : String(e);
        chunk.pending = [];
        this.state.value = { ...this.state.value, note: `The film is not being saved: ${chunk.failed}` };
      });
    const ok = await running;
    if (!ok) return false;
    this.current = chunk;
    this.state.value = { ...this.state.value, note: null };
    this.mark(first, startedAt);
    // A cue that came while the recorder was starting (the stage moved on in the meantime) is not lost: it is marked now.
    if (this.wanted && this.wanted.key !== first.key) this.cue(this.wanted);
    return true;
  }

  /** The film's recorder stops; its upload completes once the last piece is in. */
  private endChunk(chunk: Chunk | null): Promise<void> {
    if (!chunk || chunk.ended) return Promise.resolve();
    chunk.ended = true;
    return (async () => {
      if (chunk.mr.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          chunk.mr.onstop = () => resolve();
          try {
            chunk.mr.stop(); // the last piece arrives through ondataavailable before onstop
          } catch {
            resolve();
          }
        });
      }
      if (chunk.stream) await this.finishChunk(chunk);
      // else: the upload is still being opened — `finishChunk` runs when it is; or it failed, and there is nothing to finish.
    })();
  }

  private finished = new WeakSet<Chunk>();
  private async finishChunk(chunk: Chunk): Promise<void> {
    const stream = chunk.stream;
    if (!stream || this.finished.has(chunk)) return;
    this.finished.add(chunk);
    const durationMs = Date.now() - chunk.startedAt;
    chunk.manifest = { ...chunk.manifest, singers: this.spec?.singers() ?? chunk.manifest.singers };
    stream.update(chunk.manifest);
    try {
      const saved = await stream.finish({ durationMs });
      this.state.value = { ...this.state.value, saved, stored: stream.stored };
      this.spec?.onSaved?.(saved, chunk.manifest.chapters ?? []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/nothing was recorded/i.test(msg)) this.state.value = { ...this.state.value, note: `The film was not saved: ${msg}` };
    }
  }

  private meter: AnalyserNode | null = null;
  private metering: ReturnType<typeof setInterval> | undefined;
  private meterBuf = new Float32Array(2048);
  /** The loudest 100 ms block since the last tick (dBFS). */
  private peak = -100;

  /** Ten times a second: the level of the sound reaching the film; the loudest block is what the line shows each second. */
  private sampleLevel(): void {
    const m = this.meter;
    if (!m) return;
    m.getFloatTimeDomainData(this.meterBuf);
    let sum = 0;
    for (let i = 0; i < this.meterBuf.length; i++) sum += this.meterBuf[i]! * this.meterBuf[i]!;
    const db = 20 * Math.log10(Math.sqrt(sum / this.meterBuf.length) + 1e-5);
    if (db > this.peak) this.peak = db;
  }

  /** The picture's track: the show's own (full size) or the scaled copy's; released when the film ends. */
  private track: CanvasTrack | null = null;
  /** The lighter picture for software encoders: the show canvas scaled to 960×540, a few times a second, down its own track. */
  private scaled: { canvas: HTMLCanvasElement; track: CanvasTrack; timer: ReturnType<typeof setInterval> } | null = null;
  private scaledSource(): CanvasTrack {
    this.stopScaling();
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const c = canvas.getContext('2d', { alpha: false })!;
    const track = new CanvasTrack(canvas, SOFT_FPS);
    const draw = () => {
      c.drawImage(this.show.canvas, 0, 0, canvas.width, canvas.height);
      track.push();
    };
    draw();
    this.scaled = { canvas, track, timer: setInterval(draw, 1000 / SOFT_FPS) };
    return track;
  }
  private stopScaling(): void {
    if (this.track) {
      if (this.scaled?.track === this.track) this.track.stop();
      else this.show.releaseTrack(this.track);
      this.track = null;
    }
    if (!this.scaled) return;
    clearInterval(this.scaled.timer);
    this.scaled.track.stop();
    this.scaled = null;
  }

  private tick(): void {
    const c = this.current;
    const level = Math.max(-100, this.peak);
    this.peak = -100;
    const stored = c?.stream?.stored ?? this.state.value.stored;
    const error = c?.stream?.error ?? c?.failed ?? null;
    const s = this.state.value;
    const inChapter = c?.marks[c.marks.length - 1];
    const chapterAt = c && inChapter ? c.startedAt + (c.manifest.chapters?.[c.marks.length - 1]?.startMs ?? 0) : 0;
    this.state.value = { ...s, seconds: Math.floor((Date.now() - this.filmStartedAt) / 1000), bytes: this.totalBytes, stored, note: error ?? (s.note && /not being saved|was not saved|stopped with an error/.test(s.note) ? s.note : null), level, heard: s.heard || level > FILM_SILENT_DB, chapter: c && inChapter ? { index: c.marks.length, kind: inChapter.kind, title: inChapter.title, seconds: Math.floor((Date.now() - chapterAt) / 1000) } : s.chapter };
  }

  /**
   * End the film: the recorder stops, the upload completes with the final manifest (every mark, everyone
   * who stood on stage). Resolves with the film saved (null when nothing was recorded or it could not be saved).
   */
  stop(): Promise<PerformanceSummary | null> {
    if (this.stopping) return this.stopping;
    if (this.starting) this.cancelled = true;
    const current = this.current;
    if (!current) return Promise.resolve(null);
    this.stopping = (async () => {
      if (this.scheduled) clearTimeout(this.scheduled.timer);
      this.scheduled = null;
      clearInterval(this.ticker);
      this.ticker = undefined;
      clearInterval(this.metering);
      this.metering = undefined;
      this.meter = null;
      this.current = null;
      await this.endChunk(current);
      this.teardown();
      const saved = this.state.value.saved;
      this.state.value = { ...this.state.value, recording: false, chapter: null };
      this.stopping = null;
      return saved;
    })();
    return this.stopping;
  }

  private teardown(): void {
    this.detach?.();
    this.detach = null;
    this.stopScaling(); // the picture's track goes with the recorder
    this.media?.getTracks().forEach((t) => t.stop());
    this.media = null;
    this.show.keepDrawing = false;
    this.show.stopDrawing();
    this.spec = null;
    this.sound = null;
  }

  dispose(): void {
    void this.stop();
  }
}
