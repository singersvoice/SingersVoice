/**
 * The film of a whole meet, on the host's device: the show picture (every singer on stage, cut
 * out over the stage background — exactly the broadcast picture, no lyrics) with the stage mix as
 * its sound (the track and every vocal in a song, the talk between songs), from the moment the
 * host stands on stage with the mic open until the meet is over. The same recorder films the
 * publisher's broadcast: in the show view the picture is the broadcast canvas and the sound is the
 * publisher bus (the backing track and every vocal, exactly what goes out), and the whole broadcast
 * lands in the publisher's own Drive as "Broadcast" — the footage of the show as it was streamed.
 *
 * The film never stops while it runs — a song's start, pause, stop or restart only CUTS it: it is
 * written as a run of chapters (video/chapters.ts), one per song (a restart and a new song are new
 * chapters), one per pause, one for the stage between songs, and a long chapter is cut into parts
 * of ten minutes at most. Every chapter is a performance of its own (its own file in Drive, its own
 * timestamp, its own entry under Performances), so a song is found and played on its own and a tab
 * that dies loses the tail of one chapter, never the meet. The cut overlaps: the next chapter's
 * recorder starts on the same picture and sound before the previous one stops, so nothing falls
 * between two files. Every chapter's pieces go straight into Drive as they come (`PerformanceStream`:
 * a resumable upload per chapter), so a two-hour meet never has to fit in memory.
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
import { continuedCue, type ChapterCue } from './chapters.ts';
import { pickShowMime, SHOW_FPS, showSupported, type ShowRecorder } from './showRecorder.ts';

/** How often a piece of the film goes to the upload (and how much a dying tab can lose). */
const PIECE_MS = 10_000;
/** A chapter longer than this is cut into parts: a file never grows past ten minutes. */
export const MAX_CHUNK_MS = 10 * 60_000;
/** A chapter that starts at a known instant (a kickstart) is cut this much ahead of it, so the first beat is in the new file. */
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
  /** The last chapter saved. */
  saved: PerformanceSummary | null;
  /** The sound reaching the film over the last second (dBFS; -100 when none), and whether it has heard any since it started. */
  level: number;
  heard: boolean;
  /** The chapter being written: its number, what it is, how long so far. */
  chapter: { index: number; kind: PerformanceChapter['kind']; title: string; seconds: number } | null;
  /** Chapters saved so far. */
  chapters: number;
}

export interface MeetFilmSpec {
  meetId: string;
  title: string;
  hostName: string;
  /** Who is on stage, asked when a chapter ends (its manifest names them). */
  singers: () => PerformanceSinger[];
  /** What the film is called in the performances list ("Full meet" unless said otherwise) and the note on it. */
  film?: { title: string; notes: string };
  /** Every chapter, once it is in Drive (registered with the meet by the caller). */
  onSaved?: (saved: PerformanceSummary, chapter: PerformanceChapter) => void;
}

const idleState = (): MeetFilmState => ({ recording: false, seconds: 0, bytes: 0, stored: 0, note: null, saved: null, level: -100, heard: false, chapter: null, chapters: 0 });

/** One chapter being written: its recorder, its upload (opened as the recorder starts), its manifest. */
interface Chunk {
  index: number;
  cue: ChapterCue;
  manifest: PerformanceManifest;
  mr: MediaRecorder;
  startedAt: number;
  /** The upload, once Drive opened it; pieces that came before wait in `pending`. */
  stream: PerformanceStream | null;
  pending: Blob[];
  bytes: number;
  /** The upload could not be opened: the chapter is lost (said on the line), the film goes on with the next. */
  failed: string | null;
  ended: boolean;
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
  private chunkCount = 0;
  private savedCount = 0;
  private totalBytes = 0;
  private totalStored = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private stopping: Promise<PerformanceSummary | null> | null = null;
  /** The cut the stage asked for, waiting for its instant. */
  private scheduled: { cue: ChapterCue; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The chapter the stage last asked for (`cue`), applied when the film starts if it is not running yet. */
  private wanted: ChapterCue | null = null;
  /** The chapters' uploads still finishing (a cut leaves the previous chapter's last piece on its way). */
  private finishing = new Set<Promise<unknown>>();

  constructor(private readonly show: ShowRecorder) {}

  get recording(): boolean {
    return this.current !== null;
  }

  /** The performance id of the chapter being made (null when none). */
  get performanceId(): string | null {
    return this.current?.manifest.performanceId ?? null;
  }

  /** The filming's id: every chapter carries it. */
  get filmEventId(): string {
    return this.eventId;
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
    // 1280×720 show at 24 fps. A browser that only offers WebM encodes in software — the film then runs lighter
    // (960×540, 15 fps, drawn from the show canvas) so the stage itself never slows down.
    const soft = !mime.includes('mp4');
    // The picture's track is fed frame by frame (CanvasTrack): the film goes on while the host's tab is hidden.
    const track = soft ? this.scaledSource() : this.show.takeTrack(SHOW_FPS);
    this.track = track;
    this.media = new MediaStream([track.track, ...dest.stream.getAudioTracks()]);
    this.mime = mime;
    this.soft = soft;
    this.detach = detach;
    this.spec = spec;
    this.sound = sound;
    this.eventId = newId('film-');
    this.filmStartedAt = Date.now();
    this.chunkCount = 0;
    this.savedCount = 0;
    this.totalBytes = 0;
    this.totalStored = 0;
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
   * The stage calls for a chapter (video/chapters.ts): the same key as the one being written changes
   * nothing; a new one cuts the film at the chapter's instant (a kickstart a moment ahead, a cued pause)
   * or right away when that instant has passed.
   */
  cue(c: ChapterCue): void {
    this.wanted = c;
    if (!this.current) return;
    const base = (k: string) => k.split('#')[0]; // a chapter cut into parts is still that chapter
    if (base(this.current.cue.key) === c.key || (this.scheduled && base(this.scheduled.cue.key) === c.key)) return;
    if (this.scheduled) clearTimeout(this.scheduled.timer);
    const wait = Math.max(0, c.at - CUT_LEAD_MS - Date.now());
    const timer = setTimeout(() => {
      this.scheduled = null;
      if (this.current && this.current.cue.key !== c.key) void this.startChunk(c);
    }, wait);
    this.scheduled = { cue: c, timer };
  }

  /** A chapter's manifest: a show of the meet, its chapter stamped on it (what it is, when it starts, which song). */
  private chunkManifest(cue: ChapterCue, index: number, startedAt: number): PerformanceManifest {
    const spec = this.spec!;
    const a = audioSettings.peek();
    const ext = this.mime.includes('mp4') ? 'mp4' : 'webm';
    const chapter: PerformanceChapter = { eventId: this.eventId, eventTitle: spec.film?.title ?? FILM_TITLE, index, kind: cue.kind, trackId: cue.trackId, trackTitle: cue.trackTitle, songEpoch: cue.songEpoch, startedAt: new Date(startedAt).toISOString(), startMs: Math.max(0, startedAt - this.filmStartedAt) };
    return {
      schema: 'singersvoice.performance.v2',
      performanceId: newId('perf-'),
      mode: 'live',
      state: 'kept',
      kind: 'show',
      meetTitle: spec.title,
      hostName: spec.hostName,
      singers: spec.singers(),
      chapter,
      createdAt: chapter.startedAt,
      expiresAt: null,
      trackId: cue.trackId,
      trackTitle: cue.title,
      trackArtist: '',
      singerSlot: 1,
      meetId: spec.meetId,
      durationMs: 0,
      timeline: { startedAtEpochMs: startedAt, vocalOffsetMs: 0, videoOffsetMs: 0, latencyCompMs: 0, sampleRate: this.sound?.ctx.sampleRate ?? 48000 },
      playback: { tempo: a.tempo, keyShift: a.keyShift, backingGain: a.backingGain },
      fx: a.params,
      device: { userAgent: navigator.userAgent, platform: platformName, headphones: null, build: appBuild },
      files: [{ name: `video.${ext}`, mimeType: this.mime, size: 0, sha256: '' }],
      notes: spec.film?.notes ?? 'The whole meet, as the audience saw and heard it.',
    };
  }

  /**
   * The next chapter: its recorder starts on the same media now (its first piece is already on the way
   * when the previous chapter's recorder stops), its upload is opened beside it. Resolves once the
   * recorder is running (false when it could not start — the film carries on in the previous chapter).
   */
  private async startChunk(cue: ChapterCue): Promise<boolean> {
    if (!this.media || !this.spec) return false;
    const index = ++this.chunkCount;
    const startedAt = Date.now();
    const manifest = this.chunkManifest(cue, index, startedAt);
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(this.media, { mimeType: this.mime, videoBitsPerSecond: this.soft ? 1_200_000 : 2_500_000, audioBitsPerSecond: 160_000 });
    } catch (e) {
      this.chunkCount--;
      this.state.value = { ...this.state.value, note: `This browser cannot record the meet: ${e instanceof Error ? e.message : String(e)}` };
      return false;
    }
    const chunk: Chunk = { index, cue, manifest, mr, startedAt, stream: null, pending: [], bytes: 0, failed: null, ended: false };
    mr.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunk.bytes += e.data.size;
      this.totalBytes += e.data.size;
      if (chunk.stream) chunk.stream.push(e.data, { durationMs: Date.now() - chunk.startedAt });
      else if (!chunk.failed) chunk.pending.push(e.data);
      this.tick();
    };
    mr.onerror = () => {
      this.state.value = { ...this.state.value, note: `The recorder of chapter ${index} stopped with an error` };
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
        for (const b of chunk.pending) stream.push(b, { durationMs: Date.now() - chunk.startedAt });
        chunk.pending = [];
        if (chunk.ended) void this.finishChunk(chunk);
      })
      .catch((e) => {
        chunk.failed = e instanceof Error ? e.message : String(e);
        chunk.pending = [];
        this.state.value = { ...this.state.value, note: `Chapter ${index} is not being saved: ${chunk.failed}` };
      });
    const ok = await running;
    if (!ok) {
      this.chunkCount--;
      return false;
    }
    // The new chapter runs: the previous one ends (its last piece arrives before it stops).
    const prev = this.current;
    this.current = chunk;
    this.state.value = { ...this.state.value, note: null, chapter: { index, kind: cue.kind, title: cue.title, seconds: 0 } };
    if (prev) void this.endChunk(prev);
    // A cue that came while this chapter was starting (the stage moved on in the meantime) is not lost: it is cut now.
    if (this.wanted && this.wanted.key.split('#')[0] !== cue.key.split('#')[0]) this.cue(this.wanted);
    return true;
  }

  /** A chapter's recorder stops; its upload completes once the last piece is in. */
  private endChunk(chunk: Chunk | null): Promise<void> {
    if (!chunk || chunk.ended) return Promise.resolve();
    chunk.ended = true;
    const done = (async () => {
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
    this.finishing.add(done);
    void done.finally(() => this.finishing.delete(done));
    return done;
  }

  private finished = new WeakSet<Chunk>();
  private async finishChunk(chunk: Chunk): Promise<void> {
    const stream = chunk.stream;
    if (!stream || this.finished.has(chunk)) return;
    this.finished.add(chunk);
    const durationMs = Date.now() - chunk.startedAt;
    try {
      const saved = await stream.finish({ durationMs });
      this.savedCount += 1;
      this.totalStored += stream.stored;
      this.state.value = { ...this.state.value, saved, chapters: this.savedCount, stored: this.totalStored };
      this.spec?.onSaved?.(saved, chunk.manifest.chapter!);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/nothing was recorded/i.test(msg)) this.state.value = { ...this.state.value, note: `Chapter ${chunk.index} was not saved: ${msg}` };
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
    const stored = this.totalStored + (c?.stream?.stored ?? 0);
    const error = c?.stream?.error ?? c?.failed ?? null;
    const s = this.state.value;
    this.state.value = { ...s, seconds: Math.floor((Date.now() - this.filmStartedAt) / 1000), bytes: this.totalBytes, stored, note: error ?? (s.note && /not being saved|was not saved|stopped with an error/.test(s.note) ? s.note : null), level, heard: s.heard || level > FILM_SILENT_DB, chapter: c ? { index: c.index, kind: c.cue.kind, title: c.cue.title, seconds: Math.floor((Date.now() - c.startedAt) / 1000) } : s.chapter };
    // A chapter never grows past MAX_CHUNK_MS: the same chapter goes on in a new part.
    if (c && !this.scheduled && Date.now() - c.startedAt >= MAX_CHUNK_MS) {
      const part = (Number(/\(part (\d+)\)$/.exec(c.cue.title)?.[1]) || 1) + 1;
      void this.startChunk(continuedCue(c.cue, part, Date.now()));
    }
  }

  /**
   * End the film: the chapter being written ends, its upload completes, every chapter is listed.
   * Resolves with the last chapter saved (null when nothing was recorded or it could not be saved).
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
      await Promise.allSettled([...this.finishing]);
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
