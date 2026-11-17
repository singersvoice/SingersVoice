/**
 * The master track database (the SVT DB's track registry, registry.ts in the protocol) from the
 * singer's side — one small shared module, like catalog.ts, that every portal uses the same way:
 *
 *   search     = what singers have sung, grouped by song, the latest sung first (the All tab)
 *   register   = a track of my own library: its Drive folder shared anyone-with-the-link and the
 *                song registered with its metadata (once — the id is written into the track.json)
 *   sing       = a record somebody else registered: its files fetched (the owner's shared Drive, or
 *                any singer's shared copy through the service), a copy saved into MY Drive under
 *                Tracks, shared, and registered as one more place the song can be fetched from
 *   access     = reported only after a successful load or playback start, never for a search —
 *                the global "last sung" and my own history move to now
 *
 * Nothing here imports a portal.
 */
import { createTrack, isRegistryId, normalizeTrack, type RegisterTrackRequest, type TrackFileRefs, type TrackPackageV2, type TrackRecord, type TrackSearchResponse } from '@singersvoice/protocol';
import { api, controlConfigured } from './api.ts';
import { catalogIdOfCopy } from './catalog.ts';
import { AuthExpiredError, GOOGLE_API_KEY } from './google.ts';
import type { LoadedTrack, Progress, TrackSummary } from './storage/types.ts';
import { driveProvider, profile, withProvider } from '../state/session.ts';

export const registryAvailable = (): boolean => controlConfigured.value;

export async function searchTracks(q = '', opts: { cursor?: string | null; limit?: number } = {}): Promise<TrackSearchResponse> {
  if (!controlConfigured.value) return { groups: [], total: 0, nextCursor: null };
  return api.get('GET /tracks/search', `/tracks/search?q=${encodeURIComponent(q)}&limit=${opts.limit ?? 20}${opts.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : ''}`);
}

/** What I sang, the latest first. */
export async function myHistory(limit = 12): Promise<TrackRecord[]> {
  if (!controlConfigured.value) return [];
  return (await api.get('GET /tracks/history', `/tracks/history?limit=${limit}`)).items;
}

export async function getTrackRecord(registryId: string): Promise<TrackRecord> {
  return (await api.get('GET /tracks/:id', `/tracks/${encodeURIComponent(registryId)}`)).track;
}

/**
 * A successful access — the track opened for performance (`sing`), or played for a preview (`play`): the global
 * last-accessed instant and my own history move to now. Reported after the fact, never before; best effort.
 */
export async function recordAccess(registryId: string | null | undefined, how: 'sing' | 'play'): Promise<TrackRecord | null> {
  if (!registryId || !isRegistryId(registryId) || !controlConfigured.value) return null;
  try {
    return (await api.post('POST /tracks/:id/access', `/tracks/${registryId}/access`, { how })).track;
  } catch {
    return null;
  }
}

/** The metadata a track package carries, as the database names it. */
export function metaOfTrack(t: TrackPackageV2): Pick<RegisterTrackRequest, 'song' | 'artists' | 'movie' | 'year' | 'language'> {
  return { song: t.title, artists: t.artist, movie: t.movie ?? '', year: t.year ?? null, language: t.language };
}

const asRefs = (r: { folderId: string; trackJsonId: string; audioId: string; audioMime: string; videoId?: string; videoMime?: string }): TrackFileRefs => ({ folderId: r.folderId, jsonId: r.trackJsonId, audioId: r.audioId, audioMime: r.audioMime, ...(r.videoId ? { videoId: r.videoId, videoMime: r.videoMime ?? 'video/mp4' } : {}) });

const registering = new Map<string, Promise<string | null>>();
/**
 * Register a track of my own library (Drive) with the master database, once: the folder is shared anyone-with-the-link
 * (the shareable URL), the song registered with its metadata and my file ids, and the id written into the track.json so
 * the next time it is known at once. Returns the registry id — or null where there is nothing to register with (no
 * service, no Drive: a device-only library has no files to share).
 */
export function ensureRegistered(trackId: string, opts: { loaded?: LoadedTrack; onProgress?: Progress } = {}): Promise<string | null> {
  const running = registering.get(trackId);
  if (running) return running;
  const p = registerNow(trackId, opts).finally(() => registering.delete(trackId));
  registering.set(trackId, p);
  return p;
}

async function registerNow(trackId: string, opts: { loaded?: LoadedTrack; onProgress?: Progress }): Promise<string | null> {
  if (!controlConfigured.value) return null;
  const d = driveProvider();
  if (!d) return null;
  const loaded = opts.loaded ?? (await d.getTrack(trackId));
  if (!loaded) return null;
  const pkg = loaded.track;
  if (pkg.registryId && isRegistryId(pkg.registryId)) return pkg.registryId;
  opts.onProgress?.({ label: 'Sharing the song (anyone with the link)', fraction: 0.2 });
  const driveUrl = await d.shareTrack(trackId, { type: 'anyone' });
  const refs = asRefs(await d.publicTrackRefs(trackId));
  const catalogTrackId = catalogIdOfCopy(trackId);
  const youtubeId = pkg.origin === 'youtube' ? (pkg.video?.youtubeId ?? null) : null;
  opts.onProgress?.({ label: 'Registering in the SingersVoice track database', fraction: 0.6 });
  const r = await api.post('POST /tracks/register', '/tracks/register', {
    source: youtubeId ? 'youtube' : catalogTrackId ? 'catalog' : 'drive',
    ...metaOfTrack(pkg),
    driveUrl,
    refs,
    durationMs: pkg.durationMs,
    singerCount: pkg.singerCount,
    youtubeId,
    catalogTrackId,
    copyTrackId: trackId,
  });
  const registryId = r.track.trackId;
  // The id into the track.json (and the file's own properties), so it is known on every device from now on.
  await d.saveTrack({ ...pkg, registryId }, null).catch(() => undefined);
  opts.onProgress?.({ label: 'Registered', fraction: 1 });
  return registryId;
}

/** My copy of a record, stable per singer: singing it twice updates the copy instead of making another. */
export function registryCopyId(registryId: string): string {
  return `reg-${registryId}-${(profile.value?.sub ?? 'x').slice(-4)}`;
}

/**
 * A record's files: with my own token when they are mine (`drive.file` sees only this app's own files), else with the
 * app's Google API key when the build has one, else through the service — which also knows every singer's shared copy
 * and hands the files over from whichever Drive still shares them.
 */
export async function fetchRecordFiles(rec: TrackRecord, onProgress?: Progress): Promise<LoadedTrack> {
  const d = driveProvider();
  const fetchBlob = async (id: string, which: 'json' | 'audio') => {
    if (d && rec.ownerUserId === myRegistryUserId()) {
      try {
        return await d.download(id);
      } catch (e) {
        if (e instanceof AuthExpiredError) throw e; // gone from my Drive: the service may know a copy
      }
    }
    if (GOOGLE_API_KEY) {
      try {
        const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${encodeURIComponent(GOOGLE_API_KEY)}`);
        if (r.ok) return await r.blob();
      } catch {
        /* the service then */
      }
    }
    return api.getBlob('GET /tracks/:id/file/:which', `/tracks/${encodeURIComponent(rec.trackId)}/file/${which}`);
  };
  onProgress?.({ label: `Fetching from ${rec.ownerName ? `${rec.ownerName}'s` : 'the'} Drive`, fraction: 0.1 });
  const json = await fetchBlob(rec.refs.jsonId, 'json');
  onProgress?.({ label: 'Fetching the backing track', fraction: 0.35 });
  const audio = await fetchBlob(rec.refs.audioId, 'audio');
  const track = normalizeTrack(JSON.parse(await json.text()) as TrackPackageV2);
  const audioMime = rec.refs.audioMime || audio.type || 'audio/mpeg';
  return { track, audio: new Blob([audio], { type: audioMime }), audioMime };
}

/** My id as the database knows it (the owner checks). */
export function myRegistryUserId(): string {
  return profile.value?.sub ? `g-${profile.value.sub}` : '';
}

/** The track of my library that is this record: my registered copy, or any track of mine carrying its id. */
export async function myCopyOf(rec: Pick<TrackRecord, 'trackId' | 'mine'>, tracks?: TrackSummary[]): Promise<TrackSummary | null> {
  const list = tracks ?? (await withProvider(async (p) => (await p.ready(), p.listTracks())).catch(() => [] as TrackSummary[]));
  return list.find((t) => t.registryId === rec.trackId) ?? list.find((t) => t.trackId === rec.mine?.copyTrackId) ?? list.find((t) => t.trackId === registryCopyId(rec.trackId)) ?? null;
}

/**
 * Sing a record: the track of my library that is it, or else a copy of it made now — the files fetched, saved into my
 * Drive under Tracks (or on this device), shared anyone-with-the-link and registered as one more place the song can be
 * fetched from. Returns the id of the track in my library to open; throws (with the reason) when the files cannot be had.
 */
export async function singRecord(rec: TrackRecord, onProgress?: Progress): Promise<string> {
  const mine = await myCopyOf(rec);
  if (mine) return mine.trackId;
  const loaded = await fetchRecordFiles(rec, onProgress);
  const copyId = registryCopyId(rec.trackId);
  const copy = createTrack({
    ...loaded.track,
    trackId: copyId,
    registryId: rec.trackId,
    title: loaded.track.title || rec.song,
    artist: loaded.track.artist || rec.artists,
    language: loaded.track.language || rec.language,
    movie: loaded.track.movie || rec.movie,
    year: loaded.track.year ?? rec.year,
    notes: `${loaded.track.notes}\nFrom the SingersVoice track database${rec.ownerName ? ` (by ${rec.ownerName})` : ''}`.trim(),
    origin: loaded.track.origin === 'youtube' ? 'youtube' : 'unknown',
  });
  const saved = await withProvider((p) => p.saveTrack(copy, loaded.audio, onProgress));
  await registerCopy(rec.trackId, saved.trackId).catch(() => undefined); // my Drive copy: shared and known; a failure here keeps the copy singable
  return saved.trackId;
}

/** Share my copy of a record and tell the database where it is (Drive only). */
export async function registerCopy(registryId: string, copyTrackId: string): Promise<void> {
  const d = driveProvider();
  if (!d || !controlConfigured.value) return;
  const driveUrl = await d.shareTrack(copyTrackId, { type: 'anyone' });
  const refs = asRefs(await d.publicTrackRefs(copyTrackId));
  await api.post('POST /tracks/:id/copies', `/tracks/${encodeURIComponent(registryId)}/copies`, { refs, driveUrl, copyTrackId });
}

/** The audio of a record for a preview, as an object URL (fetched the same three ways as the files). */
export async function previewUrl(rec: TrackRecord): Promise<string> {
  const d = driveProvider();
  let blob: Blob | null = null;
  if (d && rec.ownerUserId === myRegistryUserId()) blob = await d.download(rec.refs.audioId).catch(() => null);
  if (!blob && GOOGLE_API_KEY) {
    try {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${rec.refs.audioId}?alt=media&key=${encodeURIComponent(GOOGLE_API_KEY)}`);
      if (r.ok) blob = await r.blob();
    } catch {
      /* the service then */
    }
  }
  if (!blob) blob = await api.getBlob('GET /tracks/:id/file/:which', `/tracks/${encodeURIComponent(rec.trackId)}/file/audio`);
  return URL.createObjectURL(new Blob([blob], { type: rec.refs.audioMime || blob.type || 'audio/mpeg' }));
}
