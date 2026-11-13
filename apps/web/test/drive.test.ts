/**
 * DriveProvider against an in-memory fake of the Drive v3 endpoints it uses. The fake answers
 * `alt=media` with the file's own content type (track.json → application/json), exactly like Google
 * does — the case that produced "a.text is not a function" on the first real save → publish.
 */
import { createTrack } from '@singersvoice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { md5Hex } from '../src/lib/md5.ts';
import { DriveProvider } from '../src/lib/storage/drive.ts';

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  bytes: Uint8Array | null;
  trashed: boolean;
  modifiedTime: string;
  createdTime: string;
  permissions: { id: string; type: string; role: string }[];
  description?: string;
}

class FakeDrive {
  files = new Map<string, FakeFile>();
  calls: string[] = [];
  private seq = 1;

  private meta(f: FakeFile) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      appProperties: f.appProperties,
      trashed: this.isTrashed(f),
      modifiedTime: f.modifiedTime,
      createdTime: f.createdTime,
      size: f.bytes ? String(f.bytes.length) : undefined,
      md5Checksum: f.bytes ? md5Hex(f.bytes) : undefined,
      webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
      description: f.description,
    };
  }

  private create(meta: Partial<FakeFile>, bytes: Uint8Array | null): FakeFile {
    const f: FakeFile = {
      id: `f${this.seq++}`,
      name: meta.name ?? 'untitled',
      mimeType: meta.mimeType ?? 'application/octet-stream',
      parents: meta.parents ?? [],
      appProperties: meta.appProperties ?? {},
      bytes,
      trashed: false,
      modifiedTime: new Date().toISOString(),
      createdTime: new Date(1_700_000_000_000 + this.seq * 1000).toISOString(), // creation order is the age order
      permissions: [],
      description: meta.description,
    };
    this.files.set(f.id, f);
    return f;
  }

  /** A folder made outside the provider (another device, an older build) — for the duplicate-folder tests. */
  addFolder(name: string, parentId: string | null, appProperties: Record<string, string> = {}): FakeFile {
    return this.create({ name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : [], appProperties }, null);
  }

  /** A file made by an older build. */
  addFile(name: string, parentId: string, mimeType: string, appProperties: Record<string, string>, bytes: Uint8Array): FakeFile {
    return this.create({ name, mimeType, parents: [parentId], appProperties }, bytes);
  }

  /** Drive reports a file as trashed when any ancestor folder is. */
  private isTrashed(f: FakeFile): boolean {
    if (f.trashed) return true;
    return f.parents.some((id) => {
      const parent = this.files.get(id);
      return parent ? this.isTrashed(parent) : false;
    });
  }

  /** The subset of Drive's `q` grammar the provider uses. */
  private query(q: string): FakeFile[] {
    let out = [...this.files.values()];
    const trashed = /trashed\s*=\s*false/.test(q);
    if (trashed) out = out.filter((f) => !this.isTrashed(f));
    const name = q.match(/name='([^']*)'/)?.[1];
    if (name) out = out.filter((f) => f.name === name);
    const mime = q.match(/mimeType='([^']*)'/)?.[1];
    if (mime) out = out.filter((f) => f.mimeType === mime);
    const parent = q.match(/'([^']*)' in parents/)?.[1];
    if (parent) out = out.filter((f) => (parent === 'root' ? f.parents.length === 0 : f.parents.includes(parent)));
    const prop = q.match(/appProperties has \{ key='([^']*)' and value='([^']*)' \}/);
    if (prop) out = out.filter((f) => f.appProperties[prop[1]!] === prop[2]);
    return out;
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=UTF-8' } });
  }

  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init.method ?? 'GET').toUpperCase();
    this.calls.push(`${method} ${url.pathname}${url.search}`);
    if (!new Headers(init.headers).get('authorization') && !url.searchParams.has('key') && !url.pathname.includes('/uc')) return this.json({ error: { message: 'unauthorized' } }, 401);
    const p = url.pathname;

    // list
    if (method === 'GET' && p === '/drive/v3/files') return this.json({ files: this.query(url.searchParams.get('q') ?? '').map((f) => this.meta(f)) });
    // create (folder / metadata)
    if (method === 'POST' && p === '/drive/v3/files') {
      const body = JSON.parse(String(init.body)) as Partial<FakeFile>;
      return this.json(this.meta(this.create(body, null)));
    }
    // multipart upload
    if (method === 'POST' && p === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'multipart') {
      const form = init.body as FormData;
      const meta = JSON.parse(await (form.get('metadata') as Blob).text()) as Partial<FakeFile>;
      const file = form.get('file') as Blob;
      const bytes = new Uint8Array(await file.arrayBuffer());
      return this.json(this.meta(this.create({ ...meta, mimeType: meta.mimeType ?? file.type }, bytes)));
    }
    // replace content
    const up = p.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (method === 'PATCH' && up) {
      const f = this.files.get(up[1]!);
      if (!f) return this.json({ error: { message: 'not found' } }, 404);
      f.bytes = new Uint8Array(await (init.body as Blob).arrayBuffer());
      f.modifiedTime = new Date().toISOString();
      return this.json(this.meta(f));
    }
    // permissions
    const perm = p.match(/^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/);
    if (perm) {
      const f = this.files.get(perm[1]!);
      if (!f) return this.json({ error: { message: 'not found' } }, 404);
      if (method === 'POST') {
        const body = JSON.parse(String(init.body)) as { type: string; role: string };
        const id = `p${this.seq++}`;
        f.permissions.push({ id, ...body });
        return this.json({ id, ...body });
      }
      if (method === 'GET') return this.json({ permissions: f.permissions });
      if (method === 'DELETE') {
        f.permissions = f.permissions.filter((x) => x.id !== perm[2]);
        return new Response(null, { status: 204 });
      }
    }
    // single file: media / metadata / patch / delete
    const one = p.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (one) {
      const f = this.files.get(one[1]!);
      if (!f) return this.json({ error: { message: 'File not found' } }, 404);
      if (method === 'GET' && url.searchParams.get('alt') === 'media') {
        if (!new Headers(init.headers).get('authorization') && !f.permissions.some((x) => x.type === 'anyone')) return this.json({ error: { message: 'forbidden' } }, 403);
        return new Response(f.bytes ? new Blob([f.bytes as BlobPart]) : null, { status: 200, headers: { 'content-type': f.mimeType } });
      }
      if (method === 'GET') return this.json(this.meta(f));
      if (method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Partial<FakeFile>;
        if (body.name) f.name = body.name;
        if (body.appProperties) f.appProperties = body.appProperties;
        if (typeof body.description === 'string') f.description = body.description;
        if (typeof body.trashed === 'boolean') f.trashed = body.trashed;
        const add = url.searchParams.get('addParents');
        const remove = url.searchParams.get('removeParents');
        if (remove) f.parents = f.parents.filter((x) => x !== remove);
        if (add && !f.parents.includes(add)) f.parents.push(add);
        return this.json(this.meta(f));
      }
      if (method === 'DELETE') {
        f.trashed = true;
        return new Response(null, { status: 204 });
      }
    }
    if (method === 'GET' && p === '/drive/v3/about') return this.json({ storageQuota: { usage: '123', limit: '1000' } });
    return this.json({ error: { message: `unhandled ${method} ${p}` } }, 500);
  }
}

const token = { accessToken: 'tok', expiresAt: Date.now() + 3600_000, scope: '' } as never;
let drive: FakeDrive;
const store = new Map<string, string>();

beforeEach(() => {
  drive = new FakeDrive();
  store.clear();
  (globalThis as { fetch: typeof fetch }).fetch = (i, init) => drive.fetch(i, init);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

const sampleTrack = () =>
  createTrack({
    trackId: 'trk-test-1',
    title: 'AmmoAmmaayena',
    artist: 'SV TrackMaker',
    durationMs: 20_000,
    layers: [{ id: 'L1', kind: 'backing', file: 'backing', mimeType: 'audio/mpeg', gain: 1, enabledByDefault: true }],
    lyrics: [
      { startMs: 0, endMs: 1000, text: 'అమ్మో అమ్మాయేనా', singerSlot: 1 },
      { startMs: 1000, endMs: 2000, text: 'సరా\\\\గా//ల\\\\సంబ\\\\\\ర\\మవు//తా//??', singerSlot: 1 },
    ],
  });

describe('DriveProvider (fake Drive v3)', () => {
  it('creates the SingersVoice tree, saves track.json + audio under Tracks/<title>, and reads them back', async () => {
    const p = new DriveProvider(() => token, 'sub1');
    await p.ready();
    const names = [...drive.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.folder').map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['SingersVoice', 'Tracks', 'Performances', 'Temp', 'Config', 'Backgrounds', 'Exports']));

    const audio = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'audio/mpeg' });
    const saved = await p.saveTrack(sampleTrack(), audio);
    expect(saved.link).toMatch(/drive\.google\.com\/drive\/folders\//);
    const folder = drive.files.get(saved.ref)!;
    expect(folder.name).toBe('AmmoAmmaayena');
    expect(folder.parents[0]).toBe([...drive.files.values()].find((f) => f.name === 'Tracks')!.id);
    const inFolder = [...drive.files.values()].filter((f) => f.parents.includes(folder.id)).map((f) => [f.name, f.mimeType]);
    expect(inFolder).toEqual(expect.arrayContaining([['track.json', 'application/json'], ['backing.mp3', 'audio/mpeg']]));

    expect((await p.listTracks()).map((t) => t.title)).toEqual(['AmmoAmmaayena']);

    // alt=media for track.json comes back as application/json — must still be read as file bytes
    const loaded = await p.getTrack('trk-test-1');
    expect(loaded?.track.title).toBe('AmmoAmmaayena');
    expect(loaded?.track.lyrics[1]!.text).toBe('సరా గా ల సంబ ర మవు తా');
    expect(loaded?.audio.size).toBe(5);
    expect(loaded?.audioMime).toBe('audio/mpeg');
  });

  it('re-saving replaces the metadata without duplicating files', async () => {
    const p = new DriveProvider(() => token, 'sub1');
    const audio = new Blob([new Uint8Array([9, 9, 9])], { type: 'audio/mpeg' });
    await p.saveTrack(sampleTrack(), audio);
    const t2 = { ...sampleTrack(), title: 'Renamed' };
    await p.saveTrack(t2, null);
    const live = [...drive.files.values()].filter((f) => !f.trashed && f.appProperties.svTrackId === 'trk-test-1');
    expect(drive.calls.filter((c) => c.startsWith('POST /upload')).length).toBe(2); // audio + track.json once each
    expect(live.map((f) => f.name).sort()).toEqual(['Renamed', 'backing.mp3', 'track.json']);
    expect((await p.getTrack('trk-test-1'))?.track.title).toBe('Renamed');
  });

  it('share → public refs → public download → unshare', async () => {
    const p = new DriveProvider(() => token, 'sub1');
    await p.saveTrack(sampleTrack(), new Blob([new Uint8Array([7])], { type: 'audio/mpeg' }));
    const link = await p.shareTrack('trk-test-1', { type: 'anyone' });
    const refs = await p.publicTrackRefs('trk-test-1');
    expect(link).toBe(refs.folderLink);
    expect(refs.shared).toBe(true);
    expect(drive.files.get(refs.folderId)!.permissions.some((x) => x.type === 'anyone')).toBe(true);
    const json = await p.downloadPublic(refs.trackJsonId, '');
    expect(JSON.parse(await json.text()).trackId).toBe('trk-test-1');
    await p.unshareTrack('trk-test-1');
    expect(drive.files.get(refs.folderId)!.permissions.some((x) => x.type === 'anyone')).toBe(false);
    expect((await p.publicTrackRefs('trk-test-1')).shared).toBe(false);
  });

  it('config round-trips through JSON files and deleteTrack trashes the folder', async () => {
    const p = new DriveProvider(() => token, 'sub1');
    await p.setConfig('audio_plugin_settings', { preset: 'warm', gain: 0.5 });
    expect(await p.getConfig('audio_plugin_settings')).toEqual({ preset: 'warm', gain: 0.5 });
    await p.saveTrack(sampleTrack(), new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }));
    await p.deleteTrack('trk-test-1');
    expect(await p.listTracks()).toEqual([]);
    expect(await p.getTrack('trk-test-1')).toBeNull();
    expect(await p.quota()).toEqual({ used: 123, total: 1000 });
  });

  const folders = (name: string) => [...drive.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.folder' && f.name === name && !f.trashed);

  it('many callers asking for the tree at once make every folder exactly once', async () => {
    const p = new DriveProvider(() => token, 'sub1');
    await Promise.all([p.ready(), p.ready(), p.listTracks(), p.ready()]);
    for (const name of ['SingersVoice', 'Tracks', 'Performances', 'Temp']) expect(folders(name)).toHaveLength(1);
    expect(folders('Live')).toHaveLength(0); // one level: performances are files straight under Performances
    expect(drive.calls.filter((c) => c.startsWith('POST /drive/v3/files')).length).toBe(7); // root + 6 folders, no repeats
  });

  it('folds duplicate folders (made before the guard, or by another device) into the oldest, files and all', async () => {
    // Drive as the user found it: one root, three "Tracks" folders each holding a track folder.
    const root = drive.addFolder('SingersVoice', null);
    const tracks = [drive.addFolder('Tracks', root.id), drive.addFolder('Tracks', root.id), drive.addFolder('Tracks', root.id)];
    const songs = tracks.map((t, i) => drive.addFolder(`Song ${i} (trk${i})`, t.id));
    // This device had cached the newest duplicate as its Tracks folder (and had not tidied yet).
    store.set('sv.drive.tree.sub1', JSON.stringify({ root: root.id, tracks: tracks[2]!.id }));

    const p = new DriveProvider(() => token, 'sub1');
    await p.ready();
    expect(folders('Tracks')).toHaveLength(1);
    expect(folders('Tracks')[0]!.id).toBe(tracks[0]!.id); // the oldest stays
    for (const t of songs) expect(drive.files.get(t.id)!.parents).toEqual([tracks[0]!.id]); // every track moved into it
    expect(tracks.slice(1).every((l) => drive.files.get(l.id)!.trashed)).toBe(true); // the emptied duplicates are in the trash
    const tree = JSON.parse(store.get('sv.drive.tree.sub1')!) as Record<string, string>;
    expect(tree.tracks).toBe(tracks[0]!.id); // the cache now points at the kept folder
    expect(store.get('sv.drive.tree.sub1.tidy')).toBe('2');

    // A second start trusts the cache (one metadata call, no listing) and changes nothing.
    const before = drive.calls.length;
    const q = new DriveProvider(() => token, 'sub1');
    await q.ready();
    expect(drive.calls.slice(before)).toEqual([`GET /drive/v3/files/${root.id}?fields=id,trashed`]);
  });

  const manifest = {
    performanceId: 'perf-xyz123',
    trackId: 'trk-test-1',
    trackTitle: 'Ammo',
    state: 'kept',
    mode: 'live',
    kind: 'show',
    meetId: 'meet-mwe8q644-onrv6m',
    meetTitle: 'Friday Meet',
    singers: [{ slot: 1, displayName: 'Hari' }],
    durationMs: 1000,
    createdAt: '2026-11-12T03:04:05.000Z',
    expiresAt: null,
    timeline: { startedAtEpochMs: 1, vocalOffsetMs: 0, videoOffsetMs: 0, latencyCompMs: 0, sampleRate: 48000 },
    playback: { tempo: 1, keyShift: 0, backingGain: 0.85 },
    files: [{ name: 'vocal.wav', mimeType: 'audio/wav', size: 1, sha256: 'v' }, { name: 'video.mp4', mimeType: 'video/mp4', size: 1, sha256: 's' }],
  } as never;

  it('saves a performance as ONE file straight under Performances, named for the people a link reaches, its details on the file', async () => {
    const p = new DriveProvider(() => token, 'sub1');
    const saved = await p.savePerformance(manifest, { vocal: new Blob([new Uint8Array([1])], { type: 'audio/wav' }), video: new Blob([new Uint8Array([2])], { type: 'video/mp4' }) });
    const file = drive.files.get(saved.ref)!;
    expect(file.mimeType).toBe('video/mp4');
    expect(file.name).toMatch(/^Ammo · Friday Meet \[mwe8q644-onrv6m\] · \d{4}-\d{2}-\d{2} \d{4}\.mp4$/);
    expect(file.parents).toEqual([folders('Performances')[0]!.id]); // one level: no folder of its own
    expect(file.appProperties.svType).toBe('performance');
    expect(file.appProperties.svMedia).toBe('video');
    expect(JSON.parse(file.description!).files).toEqual([expect.objectContaining({ name: 'video.mp4', driveId: file.id })]); // the manifest rides on the file
    expect([...drive.files.values()].filter((f) => f.appProperties.svType === 'performanceAudio')).toHaveLength(0); // the vocal stem is not kept beside a show
    expect(saved.link).toBe(`https://drive.google.com/file/d/${file.id}/view`);
    expect(saved.videoLink).toBe(saved.link);
    expect(saved.hasVideo).toBe(true);

    const listed = await p.listPerformances();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ performanceId: 'perf-xyz123', trackTitle: 'Ammo', meetTitle: 'Friday Meet', kind: 'show', hasVideo: true, ref: file.id });
    const loaded = (await p.getPerformance('perf-xyz123'))!;
    expect(loaded.manifest.singers).toEqual([{ slot: 1, displayName: 'Hari' }]);
    expect(loaded.video?.size).toBe(1);
    expect(loaded.vocal.size).toBe(0);

    // Delete means delete: the file, nothing left to list.
    await p.deletePerformance('perf-xyz123');
    expect(drive.calls.at(-1)).toBe(`DELETE /drive/v3/files/${file.id}`);
    expect(await p.listPerformances()).toHaveLength(0);
  });

  it('a take without video is its vocal file, and sharing shares the file', async () => {
    const p = new DriveProvider(() => token, 'sub1');
    const saved = await p.savePerformance({ ...(manifest as object), kind: 'take', files: [{ name: 'vocal.wav', mimeType: 'audio/wav', size: 1, sha256: 'v' }] } as never, { vocal: new Blob([new Uint8Array([1])], { type: 'audio/wav' }), video: null });
    const file = drive.files.get(saved.ref)!;
    expect(file.mimeType).toBe('audio/wav');
    expect(file.name).toMatch(/\.wav$/);
    expect(saved.hasVideo).toBe(false);
    const shared = await p.sharePerformance('perf-xyz123', { type: 'anyone' });
    expect(shared.link).toBe(`https://drive.google.com/file/d/${file.id}/view`);
    expect(file.permissions.some((x) => x.type === 'anyone')).toBe(true);
    expect((await p.listPerformances())[0]!.shared).toBe(true);
    const loaded = (await p.getPerformance('perf-xyz123'))!;
    expect(loaded.vocal.size).toBe(1);
    expect(loaded.video).toBeNull();
  });

  it('flattens performances saved by an older build (a folder each) into one file each, once, and deletes the folders', async () => {
    // Drive as an older build left it: Performances/Live/<take folder>/{manifest.json, vocal.wav, show.mp4}, the folder shared.
    const root = drive.addFolder('SingersVoice', null);
    const perfs = drive.addFolder('Performances', root.id);
    const live = drive.addFolder('Live', perfs.id);
    const offline = drive.addFolder('Offline', perfs.id);
    const take = drive.addFolder('2026-11-12 2047 Ammo · Friday Meet [mwe8q644-onrv6m] (xyz123)', live.id, { svType: 'performanceFolder', svPerfId: 'perf-xyz123' });
    const old = { ...(manifest as object), files: [{ name: 'vocal.wav', mimeType: 'audio/wav', size: 1, sha256: 'v' }, { name: 'video.mp4', mimeType: 'video/mp4', size: 1, sha256: 's' }] };
    const json = drive.addFile('manifest.json', take.id, 'application/json', { svType: 'performance', svId: 'perf-xyz123', svPerfId: 'perf-xyz123', svShared: '1', svTitle: 'Ammo' }, new TextEncoder().encode(JSON.stringify(old)));
    const vocal = drive.addFile('vocal.wav', take.id, 'audio/wav', { svType: 'performanceAudio', svPerfId: 'perf-xyz123' }, new Uint8Array([1]));
    const video = drive.addFile('Ammo · Friday Meet [mwe8q644-onrv6m] · 2026-11-12 2047.mp4', take.id, 'video/mp4', { svType: 'performanceVideo', svPerfId: 'perf-xyz123' }, new Uint8Array([2]));
    // An older solo take without video: its vocal becomes the file.
    const solo = drive.addFolder('2026-11-01 1000 Solo (solo01)', offline.id, { svType: 'performanceFolder', svPerfId: 'perf-solo01' });
    const soloOld = { ...(manifest as object), performanceId: 'perf-solo01', mode: 'offline', kind: 'take', meetId: null, meetTitle: undefined, trackTitle: 'Solo', files: [{ name: 'vocal.wav', mimeType: 'audio/wav', size: 1, sha256: 'v' }] };
    drive.addFile('manifest.json', solo.id, 'application/json', { svType: 'performance', svId: 'perf-solo01', svPerfId: 'perf-solo01', svShared: '0', svTitle: 'Solo' }, new TextEncoder().encode(JSON.stringify(soloOld)));
    const soloVocal = drive.addFile('vocal.wav', solo.id, 'audio/wav', { svType: 'performanceAudio', svPerfId: 'perf-solo01' }, new Uint8Array([3]));

    const p = new DriveProvider(() => token, 'sub1');
    await p.ready();
    const movedVideo = drive.files.get(video.id)!;
    expect(movedVideo.parents).toEqual([perfs.id]); // straight under Performances
    expect(movedVideo.trashed).toBe(false);
    expect(movedVideo.appProperties).toMatchObject({ svType: 'performance', svPerfId: 'perf-xyz123', svMedia: 'video', svShared: '1', svTitle: 'Ammo', svMeet: 'Friday Meet' });
    expect(JSON.parse(movedVideo.description!).performanceId).toBe('perf-xyz123');
    expect(movedVideo.permissions.some((x) => x.type === 'anyone')).toBe(true); // shared again, as the folder was
    expect(drive.files.get(take.id)!.trashed).toBe(true); // the folder (manifest.json, vocal.wav) is gone with it
    expect(drive.files.get(json.id)!.parents).toEqual([take.id]);
    expect(drive.files.get(vocal.id)!.parents).toEqual([take.id]);
    const movedVocal = drive.files.get(soloVocal.id)!;
    expect(movedVocal.parents).toEqual([perfs.id]);
    expect(movedVocal.name).toMatch(/^Solo · \d{4}-\d{2}-\d{2} \d{4}\.wav$/);
    expect(movedVocal.appProperties.svMedia).toBe('vocal');
    expect(drive.files.get(live.id)!.trashed).toBe(true); // the emptied Live and Offline folders too
    expect(drive.files.get(offline.id)!.trashed).toBe(true);
    const listed = await p.listPerformances();
    expect(listed.map((x) => x.performanceId).sort()).toEqual(['perf-solo01', 'perf-xyz123']);
    expect(listed.find((x) => x.performanceId === 'perf-xyz123')!.link).toBe(`https://drive.google.com/file/d/${video.id}/view`);
    expect(store.get('sv.drive.tree.sub1.tidy')).toBe('2');
    // Done once: the next start trusts the cache.
    const before = drive.calls.length;
    await new DriveProvider(() => token, 'sub1').ready();
    expect(drive.calls.slice(before)).toEqual([`GET /drive/v3/files/${root.id}?fields=id,trashed`]);
  });
});
