/**
 * Bookmarks (prefs.ts in the protocol) from the singer's side: what a singer kept with one tap on any
 * song they met — a song of the SingersVoice track database, a public catalog entry, a YouTube result,
 * a track of their own Drive (registered with the database on the way, as a Sing does, so the others on
 * a stage can sing it too). Kept on the account (the service), held here as one map by key so every
 * star on every page shows the same state; the Bookmarks tab lists them; on a live stage the service
 * answers every stage singer's bookmarks together (stageBookmarks), for the Recommended tab and the
 * song picker. Singing a bookmark brings the song into my library the way its kind does (singBookmark).
 */
import { bookmarkKey, type Bookmark, type BookmarkInput, type BookmarkKind, type CatalogTrack, type StageBookmark, type TrackRecord, type YtSearchItem } from '@singersvoice/protocol';
import { signal } from '@preact/signals';
import { api, controlConfigured } from './api.ts';
import { getCatalogTrack, isSameTrack, pullCatalogTrack } from './catalog.ts';
import { ensureRegistered, getTrackRecord, singRecord } from './registry.ts';
import type { Progress, TrackSummary } from './storage/types.ts';
import { importYoutubeTrack } from './ytTracks.ts';
import { driveProvider, withProvider } from '../state/session.ts';

/** My bookmarks by key, as last known. */
export const bookmarks = signal<Map<string, Bookmark>>(new Map());
export const bookmarksLoaded = signal(false);

let loading: Promise<Bookmark[]> | null = null;
/** My bookmarks from the account, once per session (again on `force`), the latest first. */
export function loadBookmarks(force = false): Promise<Bookmark[]> {
  if (!controlConfigured.value) return Promise.resolve([]);
  if (loading && !force) return loading;
  if (bookmarksLoaded.value && !force) return Promise.resolve(list());
  loading = api
    .get('GET /bookmarks', '/bookmarks')
    .then((r) => {
      bookmarks.value = new Map(r.items.map((b) => [b.key, b]));
      bookmarksLoaded.value = true;
      return r.items;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The bookmarks as a list, the latest kept first. */
export const list = (): Bookmark[] => [...bookmarks.value.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const isBookmarked = (kind: BookmarkKind, ref: string): boolean => bookmarks.value.has(bookmarkKey(kind, ref));

/** Keep or drop a bookmark; the map follows at once and is put back if the service refuses. */
export async function setBookmarked(input: BookmarkInput, on: boolean): Promise<void> {
  const key = bookmarkKey(input.kind, input.ref);
  const before = bookmarks.value;
  const next = new Map(before);
  if (on) next.set(key, { ...input, key, createdAt: before.get(key)?.createdAt ?? new Date().toISOString() });
  else next.delete(key);
  bookmarks.value = next;
  try {
    if (on) {
      const r = await api.put('PUT /bookmarks/:key', `/bookmarks/${encodeURIComponent(key)}`, input);
      bookmarks.value = new Map(bookmarks.value).set(key, r.bookmark);
    } else await api.del('DELETE /bookmarks/:key', `/bookmarks/${encodeURIComponent(key)}`);
  } catch (e) {
    bookmarks.value = before;
    throw e;
  }
}

/** The star tapped: kept when it was not, dropped when it was; answers what it is now. */
export async function toggleBookmark(input: BookmarkInput): Promise<boolean> {
  const on = !isBookmarked(input.kind, input.ref);
  await setBookmarked(input, on);
  return on;
}

/** Every stage singer's bookmarks in the meet, each saying whose (for anyone in the meet). */
export async function stageBookmarks(meetId: string): Promise<StageBookmark[]> {
  if (!controlConfigured.value) return [];
  return (await api.get('GET /meets/:id/bookmarks', `/meets/${encodeURIComponent(meetId)}/bookmarks`)).items;
}

// ---- what a bookmark is made of, per kind ----

export const bookmarkOfRecord = (v: TrackRecord): BookmarkInput => ({
  kind: 'registry',
  ref: v.trackId,
  title: v.song,
  artist: v.artists || v.movie,
  language: v.language,
  durationMs: v.durationMs,
  thumbnail: v.thumbnail,
  registryId: v.trackId,
  catalogTrackId: v.catalogTrackId,
  youtube: null,
});

export const bookmarkOfCatalog = (c: CatalogTrack): BookmarkInput => ({
  kind: 'catalog',
  ref: c.trackId,
  title: c.title,
  artist: c.artist,
  language: c.language,
  durationMs: c.durationMs,
  thumbnail: '',
  registryId: c.registryId ?? null,
  catalogTrackId: c.trackId,
  youtube: null,
});

export const bookmarkOfYoutube = (it: YtSearchItem): BookmarkInput => ({
  kind: 'youtube',
  ref: it.id,
  title: it.title,
  artist: it.channel,
  language: '',
  durationMs: it.durationMs,
  thumbnail: it.thumbnail,
  registryId: null,
  catalogTrackId: null,
  youtube: it,
});

/**
 * A track of my own Drive: bookmarked as the song of the track database it is — registered now when it never
 * was (the folder shared anyone-with-the-link, as the first Sing does), so the singers on a stage can sing it
 * from my bookmark. Null where there is nothing to register with (no Drive, no service).
 */
export async function bookmarkOfMine(t: TrackSummary, onProgress?: Progress): Promise<BookmarkInput | null> {
  const registryId = t.registryId ?? (driveProvider() ? await ensureRegistered(t.trackId, { onProgress }) : null);
  if (!registryId) return null;
  const rec = await getTrackRecord(registryId).catch(() => null);
  if (rec) return bookmarkOfRecord(rec);
  return { kind: 'registry', ref: registryId, title: t.title, artist: t.artist, language: '', durationMs: t.durationMs, thumbnail: '', registryId, catalogTrackId: null, youtube: null };
}

/** The registry id a bookmark names, when it does (a song of the database; a catalog entry the database mirrored). */
export const bookmarkRegistryId = (b: Pick<Bookmark, 'kind' | 'ref' | 'registryId'>): string | null => b.registryId ?? (b.kind === 'registry' ? b.ref : null);

/**
 * Sing a bookmark: the song comes into my library the way its kind does — a song of the database or a mirrored
 * catalog entry as singRecord does (my copy found, or fetched and kept), a catalog entry pulled, a YouTube result
 * fetched into my Drive — and the id of the track to open is answered.
 */
export async function singBookmark(b: Bookmark, onProgress?: Progress): Promise<string> {
  const registryId = bookmarkRegistryId(b);
  const mine = await withProvider(async (p) => (await p.ready(), p.listTracks())).catch(() => [] as TrackSummary[]);
  const have = mine.find((t) => (registryId && t.registryId === registryId) || (b.kind === 'catalog' && isSameTrack(t.trackId, b.ref)));
  if (have) return have.trackId;
  if (b.kind === 'youtube') {
    if (!b.youtube) throw new Error('This YouTube bookmark carries no video');
    return (await importYoutubeTrack(b.youtube, onProgress)).trackId;
  }
  if (registryId) {
    try {
      return await singRecord(await getTrackRecord(registryId), onProgress);
    } catch (e) {
      if (b.kind !== 'catalog') throw e; // a catalog entry has its own way in
    }
  }
  return (await pullCatalogTrack(await getCatalogTrack(b.ref), onProgress)).trackId;
}

/** For tests and sign-out. */
export function resetBookmarks(): void {
  bookmarks.value = new Map();
  bookmarksLoaded.value = false;
  loading = null;
}
