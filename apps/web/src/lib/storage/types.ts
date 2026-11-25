import type { PerformanceChapter, PerformanceManifest, TrackPackageV2 } from '@singersvoice/protocol';

export type ProviderKind = 'drive' | 'local';

export interface TrackSummary {
  trackId: string;
  title: string;
  artist: string;
  durationMs: number;
  singerCount: number;
  updatedAt: string;
  /** Drive folder id (drive) or trackId (local). */
  ref: string;
  link?: string;
  shared?: boolean;
  /** A karaoke video behind the track (a YouTube song track): the stage shows it in place of the lyrics. */
  video?: boolean;
  /** The master track database's id (registry.ts), once the track has been registered. */
  registryId?: string;
}

export interface LoadedTrack {
  track: TrackPackageV2;
  audio: Blob;
  audioMime: string;
}

export interface PerformanceSummary {
  performanceId: string;
  trackId: string;
  trackTitle: string;
  state: 'temp' | 'kept';
  mode: 'offline' | 'live';
  /** 'show' = the video is the stage picture with everyone and the whole mix; missing = an older camera take. */
  kind?: 'take' | 'show';
  meetId?: string | null;
  meetTitle?: string;
  singers?: { slot: number; displayName: string }[];
  durationMs: number;
  createdAt: string;
  expiresAt: string | null;
  ref: string;
  /** The performance's file in Drive (one file per performance; a folder only for one saved by an older build). */
  link?: string;
  /** The video file itself (Drive): watchable in a browser once shared. */
  videoLink?: string;
  hasVideo: boolean;
  /** Shared anyone-with-the-link (Drive). */
  shared?: boolean;
  /** The film of a meet (or a broadcast's footage), one file: its chapter marks — where each song, pause and stretch of stage starts. */
  chapters?: PerformanceChapter[];
  /** An older build's film: this file is one chapter of it. */
  chapter?: PerformanceChapter;
  /** The singer's cut-out video beside the show (join.ts): what another singer's stage draws them from. Drive: the file's id; this device: ''. */
  cutout?: { driveId: string; mimeType: string; bytes: number };
  /** A take sung over another performance: everyone on it ("alice & bob"), for the list. */
  with?: string;
}

export interface LoadedPerformance {
  manifest: PerformanceManifest;
  vocal: Blob;
  video: Blob | null;
  /** The singer's cut-out video, when asked for (`getPerformance(id, { cutout: true })`). */
  cutout?: Blob | null;
}

/** The files of a take as saved: the vocal, the show (or a camera take), and the singer's cut-out beside the show. */
export interface PerformanceFiles {
  vocal: Blob;
  video: Blob | null;
  cutout?: Blob | null;
}

export type Progress = (p: { label: string; fraction: number }) => void;

/** A saved sound settings file as listed: its id in the store, its name (`<initials>_<date>_<time>`), when it was saved. */
export interface SoundSettingsEntry {
  id: string;
  name: string;
  createdAt: string;
  link?: string;
}

/** A background in the singer's own store (the Backgrounds folder). */
export interface BackgroundEntry {
  id: string;
  name: string;
  createdAt: string;
  mimeType: string;
  bytes: number;
  /** The built-in picture this is a copy of (its id in the bundle), when it is one. */
  stock?: string;
  link?: string;
}

/**
 * A performance's video written as it is recorded — an hour-long meet never has to fit in the
 * browser's memory: pieces go out in order (Drive: a resumable upload, finished with the total;
 * local: kept and saved at the end), and the performance is listed once `finish` ran.
 */
export interface PerformanceStream {
  readonly performanceId: string;
  /** The next piece of the file, in order (and how long the recording is by then). Never throws: a piece that cannot go out yet waits in the buffer. */
  push(chunk: Blob, progress?: { durationMs: number }): void;
  /** Bytes handed over so far. */
  readonly bytes: number;
  /** Bytes the store has confirmed so far. */
  readonly stored: number;
  /** The last error on the way (the stream keeps trying), or null. */
  readonly error: string | null;
  /** The manifest as it now stands (the film's chapter marks grow as the meet goes): what the file is stamped with — and what an interrupted film is completed with. */
  update(manifest: PerformanceManifest): void;
  /** The file is complete: everything buffered goes out, the manifest is written with the final duration and size. */
  finish(final: { durationMs: number }): Promise<PerformanceSummary>;
  /** Give the file up (best effort: what was stored is removed). */
  abort(): Promise<void>;
}

export interface ProviderLinks {
  root?: string;
  tracks?: string;
  performances?: string;
  temp?: string;
}

export interface StorageProvider {
  readonly kind: ProviderKind;
  readonly label: string;
  /** Resolve folders / open the DB. Safe to call repeatedly. */
  ready(): Promise<void>;
  links(): ProviderLinks;

  listTracks(): Promise<TrackSummary[]>;
  getTrack(trackId: string): Promise<LoadedTrack | null>;
  saveTrack(track: TrackPackageV2, audio: Blob | null, onProgress?: Progress): Promise<TrackSummary>;
  deleteTrack(trackId: string): Promise<void>;
  /** Share a track folder: anyone-with-link or a specific Google account. Returns the link. */
  shareTrack(trackId: string, with_: { type: 'anyone' } | { type: 'user'; email: string }): Promise<string>;

  listPerformances(): Promise<PerformanceSummary[]>;
  /** A performance's details without its files (the manifest, the summary with its file ids). */
  describePerformance(performanceId: string): Promise<{ manifest: PerformanceManifest; summary: PerformanceSummary } | null>;
  getPerformance(performanceId: string, opts?: { cutout?: boolean }): Promise<LoadedPerformance | null>;
  savePerformance(manifest: PerformanceManifest, files: PerformanceFiles, onProgress?: Progress): Promise<PerformanceSummary>;
  /** Start writing a performance's video piece by piece (the film of a whole meet); `manifest.files` names the one video file. */
  beginPerformanceStream(manifest: PerformanceManifest, mimeType: string): Promise<PerformanceStream>;
  keepPerformance(performanceId: string): Promise<void>;
  deletePerformance(performanceId: string): Promise<void>;
  /**
   * Share a performance (the show, and the singer's cut-out beside it): anyone-with-the-link, or a
   * Google account (the other singers of a meet). Returns the file link and the video link.
   */
  sharePerformance(performanceId: string, with_: { type: 'anyone' } | { type: 'user'; email: string }): Promise<{ link: string; videoLink: string | null }>;
  /** Delete Temp performances past their expiry. Returns how many were removed. */
  sweepTemp(): Promise<number>;

  getConfig<T>(name: string): Promise<T | null>;
  setConfig(name: string, value: unknown): Promise<void>;

  /** The saved sound settings files in the Config folder (sounds.ts): newest first. */
  listSoundSettings(): Promise<SoundSettingsEntry[]>;
  getSoundSettings(id: string): Promise<unknown | null>;
  /** A sound settings file written to the Config folder as `<name>.svsound.json` (a second save under the same name replaces it). */
  saveSoundSettings(name: string, value: unknown): Promise<SoundSettingsEntry>;
  deleteSoundSettings(id: string): Promise<void>;

  /** The singer's own stage backgrounds (the Backgrounds folder; BackgroundPicker.tsx): newest first. */
  listBackgrounds(): Promise<BackgroundEntry[]>;
  /** The picture itself (the file as uploaded). */
  getBackground(id: string): Promise<Blob | null>;
  /** A background put in the Backgrounds folder: `stock` names the built-in picture it is a copy of (the picker then draws the bundled one). */
  saveBackground(name: string, blob: Blob, opts?: { stock?: string }): Promise<BackgroundEntry>;
  deleteBackgrounds(ids: string[]): Promise<void>;

  quota(): Promise<{ used: number; total: number } | null>;
}
