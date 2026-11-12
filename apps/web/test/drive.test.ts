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
  permissions: { id: string; type: string; role: string }[];
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
      size: f.bytes ? String(f.bytes.length) : undefined,
      md5Checksum: f.bytes ? md5Hex(f.bytes) : undefined,
      webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
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
      permissions: [],
    };
    this.files.set(f.id, f);
    return f;
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
    expect(names).toEqual(expect.arrayContaining(['SingersVoice', 'Tracks', 'Performances', 'Live', 'Offline', 'Temp', 'Config', 'Backgrounds', 'Exports']));

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
});
