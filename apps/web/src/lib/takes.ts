/** Build and save performance manifests for solo (Studio) and live (Meets) takes. */
import { newId, tempExpiry, type FileEntry, type PerformanceKind, type PerformanceManifest, type PerformanceSinger, type TrackPackageV2 } from '@singersvoice/protocol';
import { sha256Blob } from './hash.ts';
import { platformName } from './platform.ts';
import type { PerformanceSummary, Progress } from './storage/types.ts';
import { audioSettings } from '../state/settings.ts';
import { withProvider } from '../state/session.ts';

export interface TakeResult {
  vocal: Blob;
  /** The show: the stage picture with everyone on it and the whole mix (see video/showRecorder.ts). */
  video: Blob | null;
  durationMs: number;
  vocalOffsetMs: number;
  videoOffsetMs: number | null;
  latencyCompMs: number;
  sampleRate: number;
  startedAtEpochMs: number;
}

export async function buildManifest(
  take: TakeResult,
  track: Pick<TrackPackageV2, 'trackId' | 'title' | 'artist'>,
  opts: {
    state: 'temp' | 'kept';
    mode: 'offline' | 'live';
    slot: number;
    meetId: string | null;
    performanceId?: string;
    nudgeMs?: number;
    kind?: PerformanceKind;
    meetTitle?: string;
    singers?: PerformanceSinger[];
    hostName?: string;
  },
): Promise<PerformanceManifest> {
  const files: FileEntry[] = [{ name: 'vocal.wav', mimeType: 'audio/wav', size: take.vocal.size, sha256: await sha256Blob(take.vocal) }];
  if (take.video && take.video.size) {
    const ext = take.video.type.includes('mp4') ? 'mp4' : 'webm';
    files.push({ name: `video.${ext}`, mimeType: take.video.type, size: take.video.size, sha256: await sha256Blob(take.video) });
  }
  const createdAt = new Date(take.startedAtEpochMs || Date.now()).toISOString();
  const a = audioSettings.peek();
  return {
    schema: 'singersvoice.performance.v2',
    performanceId: opts.performanceId ?? newId('perf-'),
    mode: opts.mode,
    state: opts.state,
    kind: opts.kind ?? (take.video ? 'show' : 'take'),
    ...(opts.meetTitle ? { meetTitle: opts.meetTitle } : {}),
    ...(opts.singers ? { singers: opts.singers } : {}),
    ...(opts.hostName ? { hostName: opts.hostName } : {}),
    createdAt,
    expiresAt: opts.state === 'temp' ? tempExpiry(new Date(createdAt)) : null,
    trackId: track.trackId,
    trackTitle: track.title,
    trackArtist: track.artist,
    singerSlot: opts.slot,
    meetId: opts.meetId,
    durationMs: take.durationMs,
    timeline: {
      startedAtEpochMs: take.startedAtEpochMs,
      vocalOffsetMs: take.vocalOffsetMs - take.latencyCompMs + (opts.nudgeMs ?? 0),
      videoOffsetMs: take.videoOffsetMs,
      latencyCompMs: take.latencyCompMs,
      sampleRate: take.sampleRate,
    },
    playback: { tempo: a.tempo, keyShift: a.keyShift, backingGain: a.backingGain },
    fx: a.params,
    device: { userAgent: navigator.userAgent, platform: platformName, headphones: null },
    files,
    notes: '',
  };
}

export async function saveTake(manifest: PerformanceManifest, take: TakeResult, onProgress?: Progress): Promise<PerformanceSummary> {
  return withProvider((p) => p.savePerformance(manifest, { vocal: take.vocal, video: take.video && take.video.size ? take.video : null }, onProgress));
}
