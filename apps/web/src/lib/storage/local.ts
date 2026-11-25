/**
 * Local provider: IndexedDB on this device. Used when Google isn't configured/linked and as
 * the always-available staging area (local-first recording). Same shapes as the Drive provider.
 */
import { normalizeTrack, singersLine, type PerformanceManifest, type TrackPackageV2 } from '@singersvoice/protocol';
import { idb, STORES } from '../idb.ts';
import { storageEstimate } from '../platform.ts';
import type { BackgroundEntry, LoadedPerformance, LoadedTrack, PerformanceFiles, PerformanceStream, PerformanceSummary, Progress, ProviderLinks, SoundSettingsEntry, StorageProvider, TrackSummary } from './types.ts';

/** A sound settings file on this device: under the config store as `sound:<name>`. */
interface SoundRecord {
  name: string;
  createdAt: string;
  value: unknown;
}
/** A background on this device: under the config store as `background:<id>`. */
interface BackgroundRecord {
  id: string;
  name: string;
  createdAt: string;
  blob: Blob;
  stock?: string;
}
const SOUND_PREFIX = 'sound:';
const BACKGROUND_PREFIX = 'background:';

interface TrackRecord {
  track: TrackPackageV2;
  audio: Blob | null;
  audioMime: string;
}
interface PerfRecord {
  manifest: PerformanceManifest;
  vocal: Blob;
  video: Blob | null;
  /** The singer's cut-out video beside the show (join.ts); missing on records of older builds. */
  cutout?: Blob | null;
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
        ...(r.track.video ? { video: true } : {}),
        ...(r.track.registryId ? { registryId: r.track.registryId } : {}),
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
      ...(track.video ? { video: true } : {}),
      ...(track.registryId ? { registryId: track.registryId } : {}),
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
        kind: r.manifest.kind ?? 'take',
        meetId: r.manifest.meetId,
        meetTitle: r.manifest.meetTitle,
        singers: r.manifest.singers,
        durationMs: r.manifest.durationMs,
        createdAt: r.manifest.createdAt,
        expiresAt: r.manifest.expiresAt,
        ref: r.manifest.performanceId,
        hasVideo: Boolean(r.video),
        ...(r.manifest.chapter ? { chapter: r.manifest.chapter } : {}),
        ...(r.manifest.chapters?.length ? { chapters: r.manifest.chapters } : {}),
        ...(r.cutout ? { cutout: { driveId: '', mimeType: r.cutout.type, bytes: r.cutout.size } } : {}),
        ...(r.manifest.join ? { with: singersLine(r.manifest.singers ?? []) } : {}),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async describePerformance(performanceId: string): Promise<{ manifest: PerformanceManifest; summary: PerformanceSummary } | null> {
    const summary = (await this.listPerformances()).find((p) => p.performanceId === performanceId);
    const r = await idb.get<PerfRecord>(STORES.performances, performanceId);
    return r && summary ? { manifest: r.manifest, summary } : null;
  }

  async getPerformance(performanceId: string, opts: { cutout?: boolean } = {}): Promise<LoadedPerformance | null> {
    const r = await idb.get<PerfRecord>(STORES.performances, performanceId);
    return r ? { manifest: r.manifest, vocal: r.vocal, video: r.video, ...(opts.cutout ? { cutout: r.cutout ?? null } : {}) } : null;
  }

  async savePerformance(manifest: PerformanceManifest, files: PerformanceFiles, onProgress?: Progress): Promise<PerformanceSummary> {
    onProgress?.({ label: 'Saving take on this device', fraction: 0.3 });
    await idb.put(STORES.performances, manifest.performanceId, { manifest, vocal: files.vocal, video: files.video, cutout: files.cutout ?? null } satisfies PerfRecord);
    onProgress?.({ label: 'Saved', fraction: 1 });
    return {
      performanceId: manifest.performanceId,
      trackId: manifest.trackId,
      trackTitle: manifest.trackTitle,
      state: manifest.state,
      mode: manifest.mode,
      kind: manifest.kind ?? 'take',
      meetId: manifest.meetId,
      meetTitle: manifest.meetTitle,
      singers: manifest.singers,
      durationMs: manifest.durationMs,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
      ref: manifest.performanceId,
      hasVideo: Boolean(files.video),
      ...(manifest.chapter ? { chapter: manifest.chapter } : {}),
      ...(files.cutout ? { cutout: { driveId: '', mimeType: files.cutout.type, bytes: files.cutout.size } } : {}),
      ...(manifest.join ? { with: singersLine(manifest.singers ?? []) } : {}),
    };
  }

  /** On this device the pieces are kept in memory and the record is written when the film is finished. */
  async beginPerformanceStream(manifest: PerformanceManifest, mimeType: string): Promise<PerformanceStream> {
    const pieces: Blob[] = [];
    let bytes = 0;
    const self = this;
    return {
      performanceId: manifest.performanceId,
      push(chunk) {
        pieces.push(chunk);
        bytes += chunk.size;
      },
      get bytes() {
        return bytes;
      },
      get stored() {
        return bytes;
      },
      error: null,
      update(m) {
        manifest = m;
      },
      async finish(final) {
        if (!bytes) throw new Error('Nothing was recorded');
        const video = new Blob(pieces, { type: mimeType });
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const done: PerformanceManifest = { ...manifest, durationMs: final.durationMs, files: [{ name: `video.${ext}`, mimeType, size: video.size, sha256: '' }] };
        return self.savePerformance(done, { vocal: new Blob([], { type: 'audio/wav' }), video });
      },
      async abort() {
        pieces.length = 0;
      },
    };
  }

  async sharePerformance(): Promise<{ link: string; videoLink: string | null }> {
    throw new Error('Sharing a performance needs Google Drive — link your Drive in Settings.');
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

  async listSoundSettings(): Promise<SoundSettingsEntry[]> {
    const keys = (await idb.keys(STORES.config)).map(String).filter((k) => k.startsWith(SOUND_PREFIX));
    const out: SoundSettingsEntry[] = [];
    for (const k of keys) {
      const r = await idb.get<SoundRecord>(STORES.config, k);
      if (r) out.push({ id: k, name: r.name, createdAt: r.createdAt });
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getSoundSettings(id: string): Promise<unknown | null> {
    return (await idb.get<SoundRecord>(STORES.config, id))?.value ?? null;
  }

  async saveSoundSettings(name: string, value: unknown): Promise<SoundSettingsEntry> {
    const id = `${SOUND_PREFIX}${name}`;
    const existing = await idb.get<SoundRecord>(STORES.config, id);
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    await idb.put(STORES.config, id, { name, createdAt, value } satisfies SoundRecord);
    return { id, name, createdAt };
  }

  async deleteSoundSettings(id: string): Promise<void> {
    await idb.del(STORES.config, id);
  }

  async listBackgrounds(): Promise<BackgroundEntry[]> {
    const keys = (await idb.keys(STORES.config)).map(String).filter((k) => k.startsWith(BACKGROUND_PREFIX));
    const out: BackgroundEntry[] = [];
    for (const k of keys) {
      const r = await idb.get<BackgroundRecord>(STORES.config, k);
      if (r) out.push({ id: k, name: r.name, createdAt: r.createdAt, mimeType: r.blob.type, bytes: r.blob.size, ...(r.stock ? { stock: r.stock } : {}) });
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getBackground(id: string): Promise<Blob | null> {
    return (await idb.get<BackgroundRecord>(STORES.config, id))?.blob ?? null;
  }

  async saveBackground(name: string, blob: Blob, opts: { stock?: string } = {}): Promise<BackgroundEntry> {
    const id = `${BACKGROUND_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const createdAt = new Date().toISOString();
    await idb.put(STORES.config, id, { id, name, createdAt, blob, ...(opts.stock ? { stock: opts.stock } : {}) } satisfies BackgroundRecord);
    return { id, name, createdAt, mimeType: blob.type, bytes: blob.size, ...(opts.stock ? { stock: opts.stock } : {}) };
  }

  async deleteBackgrounds(ids: string[]): Promise<void> {
    for (const id of ids) await idb.del(STORES.config, id);
  }

  async quota(): Promise<{ used: number; total: number } | null> {
    const e = await storageEstimate();
    return e ? { used: e.usage, total: e.quota } : null;
  }
}
