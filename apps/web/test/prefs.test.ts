/**
 * Songs a singer prefers and bookmarks from the singer's side (lib/prefs.ts, lib/bookmarks.ts), against a fake
 * service and the fake Drive: the preference loaded once and remembered on the device, saved whole; the languages
 * the Recommended tab and the catalog ask for (the preference's, or the session's pick when nothing is set); the
 * bookmarks as one map every star reads — kept at once and put back when the service refuses; what a bookmark is
 * made of per kind; a track of my own bookmarked by the record it is; singing a bookmark the way its kind does.
 */
import { createTrack } from '@singersvoice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDrive } from './helpers/fakeDrive.ts';

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
(globalThis as { sessionStorage?: unknown }).sessionStorage = fakeStorage;
const session = await import('../src/state/session.ts');
const { controlUrl } = await import('../src/lib/api.ts');
const prefs = await import('../src/lib/prefs.ts');
const marks = await import('../src/lib/bookmarks.ts');

let drive: FakeDrive;
let service: Record<string, (body: unknown, url: URL) => { status?: number; json: unknown }>;
let serviceCalls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  drive = new FakeDrive();
  store.clear();
  serviceCalls = [];
  service = {};
  controlUrl.value = 'https://svc.test';
  session.profile.value = { mode: 'drive', sub: 'sub1', name: 'Alice', email: 'a@example.com', picture: '' } as never;
  session.token.value = { accessToken: 'tok', expiresAt: Date.now() + 3600_000, scope: '' } as never;
  session.mode.value = 'drive';
  prefs.resetPrefs();
  prefs.setSongPick('');
  marks.resetBookmarks();
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://svc.test') {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      serviceCalls.push({ method, path: url.pathname + url.search, body });
      const a = service[`${method} ${url.pathname}`];
      if (!a) return new Response(JSON.stringify({ error: `no fake for ${method} ${url.pathname}`, code: 'nope' }), { status: 404, headers: { 'content-type': 'application/json' } });
      const r = a(body, url);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return drive.fetch(input, init);
  }) as typeof fetch;
});
afterEach(async () => {
  await session.signOut().catch(() => undefined);
});

describe('songs a singer prefers', () => {
  it('is loaded from the account once, remembered on the device, and saved whole on every change', async () => {
    service['GET /prefs'] = () => ({ json: { prefs: { languages: ['Hindi'], countries: ['India'] } } });
    expect(prefs.songPrefs.value).toEqual({ languages: [], countries: [] });
    await prefs.loadPrefs();
    expect(prefs.songPrefs.value).toEqual({ languages: ['Hindi'], countries: ['India'] });
    expect(prefs.prefsLoaded.value).toBe(true);
    await prefs.loadPrefs();
    expect(serviceCalls.filter((c) => c.path === '/prefs')).toHaveLength(1); // once
    expect(JSON.parse(store.get('sv.songPrefs')!)).toEqual({ languages: ['Hindi'], countries: ['India'] }); // the device's copy
    let put: unknown = null;
    service['PUT /prefs'] = (body) => {
      put = body;
      return { json: { prefs: body } };
    };
    await prefs.savePrefs({ languages: ['Hindi', 'Klingon'], countries: [] });
    expect(put).toEqual({ languages: ['Hindi'], countries: [] }); // what is known, whole
    expect(prefs.songPrefs.value).toEqual({ languages: ['Hindi'], countries: [] });
    // The languages the portals ask for: the preference's, a country standing for its languages.
    await prefs.savePrefs({ languages: ['English'], countries: ['Sri Lanka'] });
    expect(prefs.preferredLanguages.value).toEqual(['English', 'Sinhala', 'Tamil']);
  });

  it("with nothing set, the session's pick stands in — a language, or a country's languages — and goes with the session alone", async () => {
    expect(prefs.preferredLanguages.value).toEqual([]);
    prefs.setSongPick('country:India');
    expect(prefs.preferredLanguages.value.slice(0, 3)).toEqual(['Hindi', 'Telugu', 'Tamil']);
    expect(prefs.pickName('country:India')).toBe('India');
    expect(store.get('sv.songPick')).toBe('country:India');
    prefs.setSongPick('language:Korean');
    expect(prefs.preferredLanguages.value).toEqual(['Korean']);
    prefs.setSongPick('');
    expect(prefs.preferredLanguages.value).toEqual([]);
    expect(store.get('sv.songPick')).toBeUndefined();
    expect(serviceCalls).toEqual([]); // never the account's
    // A preference set wins over the pick.
    service['PUT /prefs'] = (body) => ({ json: { prefs: body } });
    prefs.setSongPick('language:Korean');
    await prefs.savePrefs({ languages: ['Tamil'], countries: [] });
    expect(prefs.preferredLanguages.value).toEqual(['Tamil']);
  });
});

const rec = () => ({ trackId: 'MNPQRSTV2611', source: 'drive' as const, sourceKey: 'drive:folderbob', song: 'Bole Chudiyan', artists: 'Karaoke Hits', movie: 'K3G', year: 2001, language: 'Hindi', driveUrl: 'https://drive.google.com/drive/folders/folderbob', refs: { folderId: 'folderbob', jsonId: 'jsonbob', audioId: 'audiobob', audioMime: 'audio/mpeg' }, durationMs: 200_000, singerCount: 1, hasVideo: false, youtubeId: null, thumbnail: '', ownerUserId: 'g-bob', ownerName: 'Bob', catalogTrackId: null, createdAt: '', updatedAt: '', lastAccessedAt: null, accessCount: 0, singers: 0, copies: 1, unavailable: false, mine: null });

describe('bookmarks', () => {
  it('are one map every star reads: loaded once, kept at once on a tap (the service told), dropped the same way, put back when the service refuses', async () => {
    service['GET /bookmarks'] = () => ({ json: { items: [{ ...marks.bookmarkOfRecord(rec()), key: 'registry:MNPQRSTV2611', createdAt: '2026-11-18T10:00:00.000Z' }] } });
    await marks.loadBookmarks();
    expect(marks.isBookmarked('registry', 'MNPQRSTV2611')).toBe(true);
    expect(marks.isBookmarked('youtube', 'dQw4w9WgXcQ')).toBe(false);
    await marks.loadBookmarks();
    expect(serviceCalls.filter((c) => c.path === '/bookmarks')).toHaveLength(1);
    const yt = marks.bookmarkOfYoutube({ id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up (Karaoke)', channel: 'Karaoke', durationMs: 212_000, thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg', views: 10, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(yt).toMatchObject({ kind: 'youtube', ref: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up (Karaoke)', artist: 'Karaoke', registryId: null });
    service['PUT /bookmarks/youtube%3AdQw4w9WgXcQ'] = (body) => ({ json: { bookmark: { ...(body as object), key: 'youtube:dQw4w9WgXcQ', createdAt: '2026-11-18T11:00:00.000Z' } } });
    expect(await marks.toggleBookmark(yt)).toBe(true);
    expect(marks.isBookmarked('youtube', 'dQw4w9WgXcQ')).toBe(true);
    expect(marks.list().map((b) => b.key)).toEqual(['youtube:dQw4w9WgXcQ', 'registry:MNPQRSTV2611']); // the latest first
    expect(serviceCalls.at(-1)).toMatchObject({ method: 'PUT', path: '/bookmarks/youtube%3AdQw4w9WgXcQ' });
    service['DELETE /bookmarks/youtube%3AdQw4w9WgXcQ'] = () => ({ json: { ok: true } });
    expect(await marks.toggleBookmark(yt)).toBe(false);
    expect(marks.isBookmarked('youtube', 'dQw4w9WgXcQ')).toBe(false);
    expect(serviceCalls.at(-1)).toMatchObject({ method: 'DELETE', path: '/bookmarks/youtube%3AdQw4w9WgXcQ' });
    // The service refuses: the star goes back to what it was.
    service['PUT /bookmarks/youtube%3AdQw4w9WgXcQ'] = () => ({ status: 400, json: { error: 'no', code: 'bad_request' } });
    await expect(marks.toggleBookmark(yt)).rejects.toThrow();
    expect(marks.isBookmarked('youtube', 'dQw4w9WgXcQ')).toBe(false);
    // What the singers on stage bookmarked, as the service answers it.
    service['GET /meets/m1/bookmarks'] = () => ({ json: { items: [{ ...yt, key: 'youtube:dQw4w9WgXcQ', createdAt: '', by: [{ userId: 'g-bob', displayName: 'Bob Singer' }] }] } });
    const stage = await marks.stageBookmarks('m1');
    expect(stage.map((b) => `${b.key} by ${b.by.map((x) => x.displayName).join('+')}`)).toEqual(['youtube:dQw4w9WgXcQ by Bob Singer']);
  });

  it('what a bookmark is made of: a record of the database, a catalog entry (with its registry id when mirrored), and a track of my own by the record it is', async () => {
    expect(marks.bookmarkOfRecord(rec())).toEqual({ kind: 'registry', ref: 'MNPQRSTV2611', title: 'Bole Chudiyan', artist: 'Karaoke Hits', language: 'Hindi', durationMs: 200_000, thumbnail: '', registryId: 'MNPQRSTV2611', catalogTrackId: null, youtube: null });
    const cat = { trackId: 'trk-cat-1', ownerUserId: 'g-carol', ownerName: 'Carol', title: 'Hey Jude', artist: 'The Beatles', genre: '', language: 'English', durationMs: 180_000, singerCount: 1, lineCount: 10, driveFolderId: 'f', driveFolderLink: '', trackJsonId: 'j', audioId: 'a', audioMime: 'audio/mpeg', publishedAt: '', updatedAt: '', pulls: 0, registryId: 'WXYZABCD2611' };
    expect(marks.bookmarkOfCatalog(cat)).toMatchObject({ kind: 'catalog', ref: 'trk-cat-1', registryId: 'WXYZABCD2611', catalogTrackId: 'trk-cat-1', language: 'English' });
    expect(marks.bookmarkRegistryId({ kind: 'catalog', ref: 'trk-cat-1', registryId: null })).toBeNull();
    expect(marks.bookmarkRegistryId({ kind: 'registry', ref: 'MNPQRSTV2611', registryId: null })).toBe('MNPQRSTV2611');
    // A track of my own, registered already: the database's record of it (its metadata as the database has it).
    service['GET /tracks/MNPQRSTV2611'] = () => ({ json: { track: rec() } });
    const mine = await marks.bookmarkOfMine({ trackId: 'trk-own-1', title: 'Bole', artist: '', durationMs: 1, singerCount: 1, updatedAt: '', ref: 'x', registryId: 'MNPQRSTV2611' });
    expect(mine).toMatchObject({ kind: 'registry', ref: 'MNPQRSTV2611', title: 'Bole Chudiyan', artist: 'Karaoke Hits' });
    // Not registered yet: registered now (shared, told), then bookmarked as that record.
    const p = session.driveProvider()!;
    await p.saveTrack(createTrack({ trackId: 'trk-own-2', title: 'Hey Jude', artist: 'The Beatles', language: 'English', durationMs: 180_000, layers: [{ id: 'L1', kind: 'backing', file: 'backing', mimeType: 'audio/mpeg', gain: 1, enabledByDefault: true }], lyrics: [{ startMs: 0, endMs: 1000, text: 'la', singerSlot: 1 }] }), new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }));
    service['POST /tracks/register'] = () => ({ status: 201, json: { track: { trackId: 'BCDFGHJK2611' }, created: true } });
    service['GET /tracks/BCDFGHJK2611'] = () => ({ json: { track: { ...rec(), trackId: 'BCDFGHJK2611', song: 'Hey Jude', artists: 'The Beatles', language: 'English', ownerUserId: 'g-sub1' } } });
    const own = await marks.bookmarkOfMine({ trackId: 'trk-own-2', title: 'Hey Jude', artist: 'The Beatles', durationMs: 180_000, singerCount: 1, updatedAt: '', ref: 'x' });
    expect(own).toMatchObject({ kind: 'registry', ref: 'BCDFGHJK2611', title: 'Hey Jude', language: 'English' });
    expect(serviceCalls.some((c) => c.method === 'POST' && c.path === '/tracks/register')).toBe(true);
    // Without Drive there is nothing to register with.
    session.mode.value = 'local';
    session.profile.value = { mode: 'local', sub: 'sub1', name: 'Alice', email: '', picture: '' } as never;
    expect(await marks.bookmarkOfMine({ trackId: 'trk-own-3', title: 'x', artist: '', durationMs: 1, singerCount: 1, updatedAt: '', ref: 'x' })).toBeNull();
  });

  it('singing a bookmark: a song already in my library opens as it is; a song of the database is fetched and kept as singRecord does', async () => {
    const p = session.driveProvider()!;
    await p.saveTrack(createTrack({ ...createTrack({ title: 'Hey Jude' }), trackId: 'trk-own-2', registryId: 'BCDFGHJK2611', layers: [{ id: 'L1', kind: 'backing', file: 'backing', mimeType: 'audio/mpeg', gain: 1, enabledByDefault: true }] }), new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }));
    const b = { ...marks.bookmarkOfRecord({ ...rec(), trackId: 'BCDFGHJK2611' }), key: 'registry:BCDFGHJK2611', createdAt: '' };
    expect(await marks.singBookmark(b)).toBe('trk-own-2');
    expect(serviceCalls).toEqual([]); // nothing asked: it is mine already
    // Somebody else's record: the files through the service, a copy in my Drive, registered as a copy.
    service['GET /tracks/MNPQRSTV2611'] = () => ({ json: { track: rec() } });
    service['POST /tracks/MNPQRSTV2611/copies'] = () => ({ json: { track: rec() } });
    const pkg = createTrack({ title: 'Bole Chudiyan', artist: 'Karaoke Hits', layers: [{ id: 'L1', kind: 'backing', file: 'backing', mimeType: 'audio/mpeg', gain: 1, enabledByDefault: true }], lyrics: [{ startMs: 0, endMs: 1000, text: 'la', singerSlot: 1 }] });
    (globalThis as { fetch: typeof fetch }).fetch = ((orig) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/tracks/MNPQRSTV2611/file/json') return new Response(JSON.stringify(pkg), { headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/tracks/MNPQRSTV2611/file/audio') return new Response(new Uint8Array([9, 9]), { headers: { 'content-type': 'audio/mpeg' } });
      return orig(input, init);
    }) as typeof fetch)(globalThis.fetch);
    const other = { ...marks.bookmarkOfRecord(rec()), key: 'registry:MNPQRSTV2611', createdAt: '' };
    const id = await marks.singBookmark(other);
    expect(id).toBe('reg-MNPQRSTV2611-sub1');
    expect((await p.listTracks()).map((t) => t.trackId).sort()).toEqual(['reg-MNPQRSTV2611-sub1', 'trk-own-2']);
    expect(serviceCalls.some((c) => c.method === 'POST' && c.path === '/tracks/MNPQRSTV2611/copies')).toBe(true);
    // A YouTube bookmark without its video is nothing to sing.
    await expect(marks.singBookmark({ ...marks.bookmarkOfYoutube({ id: 'dQw4w9WgXcQ', title: 't', channel: '', durationMs: 0, thumbnail: '', views: null, url: '' }), youtube: null, key: 'youtube:dQw4w9WgXcQ', createdAt: '' })).rejects.toThrow(/no video/);
  });
});
