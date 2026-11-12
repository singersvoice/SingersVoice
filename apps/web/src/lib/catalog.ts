/**
 * The public catalog (SVT DB), as one small shared module so every portal gets the same behaviour
 * without depending on another portal:
 *
 *   publish   = the track's Drive folder (SingersVoice/Tracks/<title>) is shared "anyone with the
 *               link" and registered in the catalog with its public Drive file ids;
 *   pull      = fetch track.json + audio straight from the owner's Drive and save a copy into my
 *               own storage (Drive or this device), so it can be sung offline or in a live meet;
 *   fetch     = the same, without saving (a live-meet performer streaming the host's track).
 *
 * Studio (Track Maker, Sing), Tracks, Meets and Publishing call these directly; nothing here
 * imports a portal.
 */
import { createTrack, normalizeTrack, type CatalogListResponse, type CatalogTrack } from '@singersvoice/protocol';
import { api, ApiError, controlConfigured } from './api.ts';
import { GOOGLE_API_KEY } from './google.ts';
import type { LoadedTrack, Progress, TrackSummary } from './storage/types.ts';
import { driveProvider, profile, withProvider } from '../state/session.ts';

/** The catalog needs the SingersVoice service; publishing additionally needs Google Drive. */
export const catalogAvailable = (): boolean => controlConfigured.value;
export const canPublish = (): boolean => controlConfigured.value && driveProvider() !== null;

/** My id as the catalog knows it (owner checks). */
export function myCatalogUserId(): string {
  return profile.value?.sub ? `g-${profile.value.sub}` : '';
}

/** Ids of my tracks that are currently in the public catalog (empty when the service is off). */
export async function myPublishedIds(): Promise<Set<string>> {
  if (!controlConfigured.value) return new Set();
  try {
    const r = await api.get('GET /catalog/tracks', '/catalog/tracks?mine=1&limit=100');
    return new Set(r.items.map((t) => t.trackId));
  } catch {
    return new Set();
  }
}

/** Share the Drive folder with anyone-with-link and register (or refresh) the catalog entry. */
export async function publishTrack(trackId: string, onProgress?: Progress): Promise<{ link: string; track: CatalogTrack }> {
  const d = driveProvider();
  if (!d) throw new Error('Publishing to the catalog needs Google Drive — sign in with Google');
  if (!controlConfigured.value) throw new Error('The catalog service is not configured for this build');
  onProgress?.({ label: 'Sharing the Drive folder (anyone with the link)', fraction: 0.2 });
  const link = await d.shareTrack(trackId, { type: 'anyone' });
  const refs = await d.publicTrackRefs(trackId);
  onProgress?.({ label: 'Registering in the SingersVoice catalog', fraction: 0.7 });
  const loaded = await d.getTrack(trackId);
  if (!loaded) throw new Error('Track not found in Drive');
  const t = loaded.track;
  const r = await api.post('POST /catalog/tracks', '/catalog/tracks', {
    trackId,
    title: t.title,
    artist: t.artist,
    genre: t.genre,
    language: t.language,
    durationMs: t.durationMs,
    singerCount: t.singerCount,
    lineCount: t.lyrics.length,
    driveFolderId: refs.folderId,
    driveFolderLink: link,
    trackJsonId: refs.trackJsonId,
    audioId: refs.audioId,
    audioMime: refs.audioMime,
  });
  onProgress?.({ label: 'Published', fraction: 1 });
  return { link, track: r.track };
}

/** Remove the catalog entry and the anyone-with-link permission. */
export async function unpublishTrack(trackId: string): Promise<void> {
  const d = driveProvider();
  if (controlConfigured.value) {
    await api.del('DELETE /catalog/tracks/:id', `/catalog/tracks/${encodeURIComponent(trackId)}`).catch((e) => {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    });
  }
  if (d) await d.unshareTrack(trackId);
}

export async function searchCatalog(q = '', opts: { cursor?: string | null; limit?: number } = {}): Promise<CatalogListResponse> {
  if (!controlConfigured.value) return { items: [], nextCursor: null, total: 0 };
  const qs = `/catalog/tracks?q=${encodeURIComponent(q)}&limit=${opts.limit ?? 24}${opts.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : ''}`;
  return api.get('GET /catalog/tracks', qs);
}

export async function getCatalogTrack(trackId: string): Promise<CatalogTrack> {
  const r = await api.get('GET /catalog/tracks/:id', `/catalog/tracks/${encodeURIComponent(trackId)}`);
  return r.track;
}

/** Fetch a published track from its owner's Drive (own token → API key → public download URL). */
export async function fetchCatalogTrack(entry: CatalogTrack, onProgress?: Progress): Promise<LoadedTrack> {
  const d = driveProvider();
  const fetchBlob = async (id: string) => {
    if (d) return d.downloadPublic(id, GOOGLE_API_KEY);
    const key = GOOGLE_API_KEY ? `&key=${encodeURIComponent(GOOGLE_API_KEY)}` : '';
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media${key}`);
    if (!r.ok) throw new Error('Sign in with Google to pull catalog tracks');
    return r.blob();
  };
  onProgress?.({ label: "Fetching from the owner's Drive", fraction: 0.1 });
  const json = await fetchBlob(entry.trackJsonId);
  onProgress?.({ label: 'Fetching the backing track', fraction: 0.35 });
  const audio = await fetchBlob(entry.audioId);
  const track = normalizeTrack(JSON.parse(await json.text()) as LoadedTrack['track']);
  const audioMime = entry.audioMime || audio.type || 'audio/mpeg';
  return { track, audio: new Blob([audio], { type: audioMime }), audioMime };
}

/** The id a pulled copy gets in my library (stable per user, so pulling twice updates the copy). */
export function catalogCopyId(catalogTrackId: string): string {
  return `${catalogTrackId}-copy-${myCatalogUserId().slice(-4) || 'x'}`;
}

/** True when `trackId` is `catalogTrackId` itself or one of its pulled copies. */
export function isSameTrack(trackId: string, catalogTrackId: string): boolean {
  return trackId === catalogTrackId || trackId.startsWith(`${catalogTrackId}-copy-`);
}

/** Pull a published track into my own storage; returns the saved copy. */
export async function pullCatalogTrack(entry: CatalogTrack, onProgress?: Progress): Promise<TrackSummary> {
  const loaded = await fetchCatalogTrack(entry, onProgress);
  return keepCatalogCopy(entry, loaded, onProgress);
}

/** Save an already-fetched published track as my own copy (a singer on stage keeps what the meet sings). */
export async function keepCatalogCopy(entry: CatalogTrack, loaded: LoadedTrack, onProgress?: Progress): Promise<TrackSummary> {
  const copy = createTrack({
    ...loaded.track,
    trackId: catalogCopyId(entry.trackId),
    notes: `${loaded.track.notes}\nFrom the public catalog (by ${entry.ownerName})`.trim(),
    origin: 'unknown',
  });
  const summary = await withProvider((p) => p.saveTrack(copy, loaded.audio, onProgress));
  await api.post('POST /catalog/tracks/:id/pull', `/catalog/tracks/${encodeURIComponent(entry.trackId)}/pull`).catch(() => undefined);
  return summary;
}
