/**
 * The master track database from the singer's side (lib/registry.ts), against the fake Drive and a fake
 * service: a track of my own registered on its first Sing (the folder shared, the song registered with its
 * metadata, the id written into the track.json — once); somebody else's record sung (its files through the
 * service, a copy under MY Tracks carrying the id, shared and registered as a copy; sung again, the copy is
 * found, not made twice); an access reported only as asked; a preview's audio.
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
const { ensureRegistered, myCopyOf, previewUrl, recordAccess, registryCopyId, singRecord } = await import('../src/lib/registry.ts');

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
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://svc.test') {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      serviceCalls.push({ method, path: url.pathname + url.search, body });
      const a = service[`${method} ${url.pathname}`];
      if (!a) return new Response(JSON.stringify({ error: `no fake for ${method} ${url.pathname}`, code: 'nope' }), { status: 404, headers: { 'content-type': 'application/json' } });
      const r = a(body, url);
      return r.json instanceof Blob ? new Response(r.json, { status: r.status ?? 200, headers: { 'content-type': r.json.type } }) : new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return drive.fetch(input, init);
  }) as typeof fetch;
});
afterEach(async () => {
  // Sign out: the provider (and the Drive tree it remembers) is let go, so the next test's fake Drive starts clean.
  await session.signOut().catch(() => undefined);
});

const ownTrack = () => createTrack({ trackId: 'trk-own-1', title: 'Bole Chudiyan', artist: 'Udit Narayan', language: 'Hindi', movie: 'K3G', year: 2001, durationMs: 200_000, layers: [{ id: 'L1', kind: 'backing', file: 'backing', mimeType: 'audio/mpeg', gain: 1, enabledByDefault: true }], lyrics: [{ startMs: 0, endMs: 1000, text: 'la', singerSlot: 1 }] });

describe('a track of my own, on its first Sing', () => {
  it('is shared, registered with its metadata and my file ids, and carries the id from then on (one registration)', async () => {
    const p = session.driveProvider()!;
    await p.saveTrack(ownTrack(), new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }));
    let registered: Record<string, unknown> | null = null;
    service['POST /tracks/register'] = (body) => {
      registered = body as Record<string, unknown>;
      return { status: 201, json: { track: { trackId: 'BCDFGHJK2611' }, created: true } };
    };
    const id = await ensureRegistered('trk-own-1');
    expect(id).toBe('BCDFGHJK2611');
    expect(registered).toMatchObject({ source: 'drive', song: 'Bole Chudiyan', artists: 'Udit Narayan', movie: 'K3G', year: 2001, language: 'Hindi', durationMs: 200_000, singerCount: 1, copyTrackId: 'trk-own-1', youtubeId: null, catalogTrackId: null });
    const refs = (registered as unknown as { refs: { folderId: string; jsonId: string; audioId: string; audioMime: string } }).refs;
    const json = [...drive.files.values()].find((f) => f.name === 'track.json')!;
    expect(refs).toEqual({ folderId: json.parents[0], jsonId: json.id, audioId: [...drive.files.values()].find((f) => f.name === 'backing.mp3')!.id, audioMime: 'audio/mpeg' });
    expect((registered as unknown as { driveUrl: string }).driveUrl).toBe(`https://drive.google.com/drive/folders/${json.parents[0]}`);
    expect(drive.files.get(json.parents[0]!)!.permissions.some((x) => x.type === 'anyone')).toBe(true); // the shareable URL is real
    const loaded = await p.getTrack('trk-own-1');
    expect(loaded!.track.registryId).toBe('BCDFGHJK2611');
    expect((await p.listTracks())[0]).toMatchObject({ registryId: 'BCDFGHJK2611', shared: true });
    // Known now: no second registration, the id at once.
    serviceCalls = [];
    expect(await ensureRegistered('trk-own-1')).toBe('BCDFGHJK2611');
    expect(serviceCalls).toEqual([]);
  });

  it('is nothing to register without Drive (a device-only library) — and an access is reported only for a real id', async () => {
    session.mode.value = 'local';
    session.profile.value = { mode: 'local', sub: 'sub1', name: 'Alice', email: '', picture: '' } as never;
    expect(await ensureRegistered('trk-own-1')).toBeNull();
    let accessed: unknown = null;
    service['POST /tracks/BCDFGHJK2611/access'] = (body) => {
      accessed = body;
      return { json: { track: { trackId: 'BCDFGHJK2611', lastAccessedAt: '2026-11-17T15:00:00.000Z' } } };
    };
    expect(await recordAccess('BCDFGHJK2611', 'sing')).toMatchObject({ lastAccessedAt: '2026-11-17T15:00:00.000Z' });
    expect(accessed).toEqual({ how: 'sing' });
    expect(await recordAccess('trk-own-1', 'sing')).toBeNull(); // not a database id: nothing asked
    expect(await recordAccess(null, 'play')).toBeNull();
    expect(serviceCalls).toHaveLength(1);
  });
});

const record = () => ({
  trackId: 'MNPQRSTV2611',
  source: 'drive' as const,
  sourceKey: 'drive:folderbob',
  song: 'Bole Chudiyan',
  artists: 'Karaoke Hits',
  movie: 'K3G',
  year: 2001,
  language: 'Hindi',
  driveUrl: 'https://drive.google.com/drive/folders/folderbob',
  refs: { folderId: 'folderbob', jsonId: 'jsonbob', audioId: 'audiobob', audioMime: 'audio/mpeg' },
  durationMs: 200_000,
  singerCount: 1,
  hasVideo: false,
  youtubeId: null,
  thumbnail: '',
  ownerUserId: 'g-bob',
  ownerName: 'Bob',
  catalogTrackId: null,
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
  lastAccessedAt: '2026-11-16T12:00:00.000Z',
  accessCount: 3,
  singers: 2,
  copies: 1,
  unavailable: false,
  mine: null,
});

describe("somebody else's record, sung", () => {
  it("comes through the service into MY Drive under Tracks as a copy carrying the id, shared and registered as a copy; sung again it is found, not copied twice", async () => {
    const bobsTrack = createTrack({ trackId: 'trk-bob-1', title: 'Bole Chudiyan', artist: 'Karaoke Hits', durationMs: 200_000, layers: [{ id: 'L1', kind: 'backing', file: 'backing', mimeType: 'audio/mpeg', gain: 1, enabledByDefault: true }] });
    service['GET /tracks/MNPQRSTV2611/file/json'] = () => ({ json: new Blob([JSON.stringify(bobsTrack)], { type: 'application/json' }) });
    service['GET /tracks/MNPQRSTV2611/file/audio'] = () => ({ json: new Blob([new Uint8Array([7, 7, 7])], { type: 'audio/mpeg' }) });
    let copyPosted: Record<string, unknown> | null = null;
    service['POST /tracks/MNPQRSTV2611/copies'] = (body) => {
      copyPosted = body as Record<string, unknown>;
      return { json: { track: { ...record(), copies: 2 } } };
    };
    const seen: string[] = [];
    const id = await singRecord(record(), (p) => seen.push(p.label));
    expect(id).toBe(registryCopyId('MNPQRSTV2611'));
    expect(id).toBe('reg-MNPQRSTV2611-sub1');
    expect(seen[0]).toBe("Fetching from Bob's Drive");
    const p = session.driveProvider()!;
    const mine = await p.listTracks();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ trackId: id, title: 'Bole Chudiyan', registryId: 'MNPQRSTV2611', shared: true });
    const loaded = await p.getTrack(id);
    expect(loaded!.track).toMatchObject({ registryId: 'MNPQRSTV2611', movie: 'K3G', year: 2001, language: 'Hindi', artist: 'Karaoke Hits' });
    expect(loaded!.track.notes).toContain('by Bob');
    expect(new Uint8Array(await loaded!.audio.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));
    const json = [...drive.files.values()].find((f) => f.name === 'track.json')!;
    expect(drive.files.get(json.parents[0]!)!.name).toBe('Bole Chudiyan');
    expect(drive.files.get(drive.files.get(json.parents[0]!)!.parents[0]!)!.name).toBe('Tracks'); // under Tracks
    expect(drive.files.get(json.parents[0]!)!.permissions.some((x) => x.type === 'anyone')).toBe(true);
    expect(copyPosted).toMatchObject({ copyTrackId: id, driveUrl: `https://drive.google.com/drive/folders/${json.parents[0]}`, refs: { folderId: json.parents[0], jsonId: json.id } });
    expect(serviceCalls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /tracks/MNPQRSTV2611/file/json', 'GET /tracks/MNPQRSTV2611/file/audio', 'POST /tracks/MNPQRSTV2611/copies']);
    // Sung again: my copy is the song — nothing fetched, nothing saved again.
    serviceCalls = [];
    expect(await singRecord(record())).toBe(id);
    expect(serviceCalls).toEqual([]);
    expect(await p.listTracks()).toHaveLength(1);
    expect((await myCopyOf(record()))?.trackId).toBe(id);
  });

  it("files nobody shares any more: the service's refusal comes back as it is, nothing is saved, no access", async () => {
    service['GET /tracks/MNPQRSTV2611/file/json'] = () => ({ status: 404, json: { error: "This song's files are no longer shared from any singer's Drive", code: 'not_shared' } });
    await expect(singRecord(record())).rejects.toThrow(/no longer shared/);
    expect(await session.driveProvider()!.listTracks()).toEqual([]);
    expect(serviceCalls.map((c) => c.path)).toEqual(['/tracks/MNPQRSTV2611/file/json']);
  });

  it("a preview's audio: through the service for somebody else's song", async () => {
    let made = '';
    (globalThis as { URL: { createObjectURL?: unknown } }).URL.createObjectURL = (b: Blob) => (made = `blob:${b.type}:${b.size}`);
    service['GET /tracks/MNPQRSTV2611/file/audio'] = () => ({ json: new Blob([new Uint8Array([1, 2])], { type: 'audio/mpeg' }) });
    expect(await previewUrl(record())).toBe('blob:audio/mpeg:2');
    expect(made).toBe('blob:audio/mpeg:2');
  });
});
