import type { VoxForgeParams } from './audio.ts';

export type PerformanceState = 'temp' | 'kept';
export type PerformanceMode = 'offline' | 'live';

export interface FileEntry {
  /** File name inside the performance folder. */
  name: string;
  mimeType: string;
  size: number;
  /** Hex SHA-256 of the bytes, computed before upload. */
  sha256: string;
  /** Drive file id once uploaded. */
  driveId?: string;
  /** Drive-reported md5 after upload (verified against the local md5). */
  md5?: string;
}

/**
 * What a performance's video is: a 'take' is this singer's own camera; a 'show' is the broadcast
 * picture — every singer on stage cut out over the stage background, with the whole mix (backing
 * track + every vocal) as its sound — exactly what Publishing mode shows. A meet's show, recorded
 * on the host's device, is the one saved performance of that song, shared with everyone in the meet.
 */
export type PerformanceKind = 'take' | 'show';

export interface PerformanceSinger {
  slot: number;
  displayName: string;
  userId?: string;
}

/** singersvoice.performance.v2 — `manifest.json` inside each performance folder. */
export interface PerformanceManifest {
  schema: 'singersvoice.performance.v2';
  performanceId: string;
  mode: PerformanceMode;
  state: PerformanceState;
  /** Missing in older manifests = 'take'. */
  kind?: PerformanceKind;
  /** The meet this was sung in (live mode): its title, who was on stage, who hosted. */
  meetTitle?: string;
  singers?: PerformanceSinger[];
  hostName?: string;
  /** ISO date; Temp performances are deleted after `expiresAt`. */
  createdAt: string;
  expiresAt: string | null;
  trackId: string;
  trackTitle: string;
  trackArtist: string;
  /** Which singer slot this device sang. */
  singerSlot: number;
  meetId: string | null;
  durationMs: number;
  /** Timeline origin: absolute wall-clock the backing track started (ms since epoch) and the audio clock offsets. */
  timeline: {
    startedAtEpochMs: number;
    /** Vocal WAV sample 0 is this many ms after the backing-track start (can be negative). */
    vocalOffsetMs: number;
    /** Video frame 0 is this many ms after the backing-track start. */
    videoOffsetMs: number | null;
    /** Estimated output latency compensation applied at record time, ms. */
    latencyCompMs: number;
    sampleRate: number;
  };
  /** Backing-track playback settings used. */
  playback: { tempo: number; keyShift: number; backingGain: number };
  fx: VoxForgeParams;
  device: { userAgent: string; platform: string; headphones: boolean | null };
  files: FileEntry[];
  notes: string;
}

export const TEMP_RETENTION_DAYS = 7;

export function tempExpiry(from = new Date()): string {
  return new Date(from.getTime() + TEMP_RETENTION_DAYS * 86400000).toISOString();
}

export function performanceFolderName(m: Pick<PerformanceManifest, 'createdAt' | 'trackTitle' | 'performanceId'>): string {
  const d = m.createdAt.slice(0, 10);
  const t = m.createdAt.slice(11, 16).replace(':', '');
  return `${d} ${t} ${m.trackTitle} (${m.performanceId.slice(-6)})`;
}

/**
 * The saved show's file name as the people a Drive link reaches will see it: the song, the meet
 * (when it was one) and the date — "Ammo · Friday Meet · 2026-11-12.mp4" rather than "video.mp4".
 */
export function performanceVideoName(m: Pick<PerformanceManifest, 'createdAt' | 'trackTitle'> & { meetTitle?: string | null }, ext: string): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = [clean(m.trackTitle) || 'Performance', m.meetTitle ? clean(m.meetTitle) : '', m.createdAt.slice(0, 10)].filter(Boolean);
  return `${parts.join(' · ')}.${ext}`;
}
