/**
 * Local provider: IndexedDB on this device. Used when Google isn't configured/linked and as
 * the always-available staging area (local-first recording). Same shapes as the Drive provider.
 */
import { normalizeTrack, type PerformanceManifest, type TrackPackageV2 } from '@singersvoice/protocol';
import { idb, STORES } from '../idb.ts';
import { storageEstimate } from '../platform.ts';
import type { LoadedPerformance, LoadedTrack, PerformanceSummary, Progress, ProviderLinks, StorageProvider, TrackSummary } from './types.ts';

interface TrackRecord {
  track: TrackPackageV2;
  audio: Blob | null;
  audioMime: string;
}
interface PerfRecord {
  manifest: PerformanceManifest;
  vocal: Blob;
  video: Blob | null;
}

export class LocalProvider implements StorageProvider {
  readonly kind = 'local' as const;
  readonly label = 'This device';

  async ready(): Promise<void> {
    await idb.keys(STORES.config);
  }

  links(): ProviderLinks {
    return {};
  }

  async listTracks(): Promise<TrackSummary[]> {
    const all = await idb.all<TrackRecord>(STORES.tracks);
    return all
      .map((r) => ({
        trackId: r.track.trackId,
        title: r.track.title,
        artist: r.track.artist,
        durationMs: r.track.durationMs,
        singerCount: r.track.singerCount,
        updatedAt: r.track.updatedAt,
        ref: r.track.trackId,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getTrack(trackId: string): Promise<LoadedTrack | null> {
    const r = await idb.get<TrackRecord>(STORES.tracks, trackId);
    if (!r || !r.audio) return null;
    return { track: normalizeTrack(r.track), audio: r.audio, audioMime: r.audioMime };
  }

  async saveTrack(track: TrackPackageV2, audio: Blob | null, onProgress?: Progress): Promise<TrackSummary> {
    onProgress?.({ label: 'Saving on this device', fraction: 0.2 });
    const existing = await idb.get<TrackRecord>(STORES.tracks, track.trackId);
    const rec: TrackRecord = {
      track,
      audio: audio ?? existing?.audio ?? null,
      audioMime: audio?.type || existing?.audioMime || 'audio/mpeg',
    };
    await idb.put(STORES.tracks, track.trackId, rec);
    onProgress?.({ label: 'Saved', fraction: 1 });
    return {
      trackId: track.trackId,
      title: track.title,
      artist: track.artist,
      durationMs: track.durationMs,
      singerCount: track.singerCount,
      updatedAt: track.updatedAt,
      ref: track.trackId,
    };
  }

  async deleteTrack(trackId: string): Promise<void> {
    await idb.del(STORES.tracks, trackId);
  }

  async shareTrack(): Promise<string> {
    throw new Error('Sharing needs Google Drive — link your Drive in Settings, or export the track and send the file.');
  }

  async listPerformances(): Promise<PerformanceSummary[]> {
    const all = await idb.all<PerfRecord>(STORES.performances);
    return all
      .map((r) => ({
        performanceId: r.manifest.performanceId,
        trackId: r.manifest.trackId,
        trackTitle: r.manifest.trackTitle,
        state: r.manifest.state,
        mode: r.manifest.mode,
        durationMs: r.manifest.durationMs,
        createdAt: r.manifest.createdAt,
        expiresAt: r.manifest.expiresAt,
        ref: r.manifest.performanceId,
        hasVideo: Boolean(r.video),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getPerformance(performanceId: string): Promise<LoadedPerformance | null> {
    const r = await idb.get<PerfRecord>(STORES.performances, performanceId);
    return r ? { manifest: r.manifest, vocal: r.vocal, video: r.video } : null;
  }

  async savePerformance(manifest: PerformanceManifest, files: { vocal: Blob; video: Blob | null }, onProgress?: Progress): Promise<PerformanceSummary> {
    onProgress?.({ label: 'Saving take on this device', fraction: 0.3 });
    await idb.put(STORES.performances, manifest.performanceId, { manifest, vocal: files.vocal, video: files.video } satisfies PerfRecord);
    onProgress?.({ label: 'Saved', fraction: 1 });
    return {
      performanceId: manifest.performanceId,
      trackId: manifest.trackId,
      trackTitle: manifest.trackTitle,
      state: manifest.state,
      mode: manifest.mode,
      durationMs: manifest.durationMs,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
      ref: manifest.performanceId,
      hasVideo: Boolean(files.video),
    };
  }

  async keepPerformance(performanceId: string): Promise<void> {
    const r = await idb.get<PerfRecord>(STORES.performances, performanceId);
    if (!r) return;
    r.manifest = { ...r.manifest, state: 'kept', expiresAt: null };
    await idb.put(STORES.performances, performanceId, r);
  }

  async deletePerformance(performanceId: string): Promise<void> {
    await idb.del(STORES.performances, performanceId);
  }

  async sweepTemp(): Promise<number> {
    const all = await idb.all<PerfRecord>(STORES.performances);
    const now = Date.now();
    let n = 0;
    for (const r of all) {
      if (r.manifest.state === 'temp' && r.manifest.expiresAt && Date.parse(r.manifest.expiresAt) < now) {
        await idb.del(STORES.performances, r.manifest.performanceId);
        n++;
      }
    }
    return n;
  }

  async getConfig<T>(name: string): Promise<T | null> {
    return (await idb.get<T>(STORES.config, name)) ?? null;
  }

  async setConfig(name: string, value: unknown): Promise<void> {
    await idb.put(STORES.config, name, value);
  }

  async quota(): Promise<{ used: number; total: number } | null> {
    const e = await storageEstimate();
    return e ? { used: e.usage, total: e.quota } : null;
  }
}
