import type { PerformanceManifest, TrackPackageV2 } from '@singersvoice/protocol';

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
  durationMs: number;
  createdAt: string;
  expiresAt: string | null;
  ref: string;
  link?: string;
  hasVideo: boolean;
}

export interface LoadedPerformance {
  manifest: PerformanceManifest;
  vocal: Blob;
  video: Blob | null;
}

export type Progress = (p: { label: string; fraction: number }) => void;

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
  getPerformance(performanceId: string): Promise<LoadedPerformance | null>;
  savePerformance(manifest: PerformanceManifest, files: { vocal: Blob; video: Blob | null }, onProgress?: Progress): Promise<PerformanceSummary>;
  keepPerformance(performanceId: string): Promise<void>;
  deletePerformance(performanceId: string): Promise<void>;
  /** Delete Temp performances past their expiry. Returns how many were removed. */
  sweepTemp(): Promise<number>;

  getConfig<T>(name: string): Promise<T | null>;
  setConfig(name: string, value: unknown): Promise<void>;

  quota(): Promise<{ used: number; total: number } | null>;
}
