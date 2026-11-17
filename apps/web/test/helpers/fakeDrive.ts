/**
 * An in-memory fake of the Drive v3 endpoints the DriveProvider uses. It answers `alt=media` with the
 * file's own content type (track.json → application/json), exactly like Google does — the case that
 * produced "a.text is not a function" on the first real save → publish.
 */
import { md5Hex } from '../../src/lib/md5.ts';

export interface FakeFile {
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

/** Ids run on across instances: a provider that remembers a tree from an earlier fake must never find those ids reused. */
let nextSeq = 1;

export class FakeDrive {
  files = new Map<string, FakeFile>();
  calls: string[] = [];
  private get seq() {
    return nextSeq;
  }
  private set seq(v: number) {
    nextSeq = v;
  }
  /** Resumable upload sessions: the metadata given at the start and the bytes received so far, in order. */
  sessions = new Map<string, { meta: Partial<FakeFile>; bytes: Uint8Array[]; size: number }>();
  /** Answer the next N session PUTs with 503 (an outage on the way). */
  failPuts = 0;

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
      id: `f${String(this.seq++).padStart(12, '0')}`, // the length of a real Drive id: the service accepts it as one
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
    const uploadId = url.searchParams.get('upload_id');
    if (!uploadId && !new Headers(init.headers).get('authorization') && !url.searchParams.has('key') && !url.pathname.includes('/uc')) return this.json({ error: { message: 'unauthorized' } }, 401);
    const p = url.pathname;

    // resumable upload: start a session (the bytes come by PUT to the session url, no auth needed there — like Drive)
    if (method === 'POST' && p === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'resumable') {
      const id = `u${this.seq++}`;
      this.sessions.set(id, { meta: JSON.parse(String(init.body)) as Partial<FakeFile>, bytes: [], size: 0 });
      return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` } });
    }
    if (uploadId) {
      const s = this.sessions.get(uploadId);
      if (!s) return this.json({ error: { message: 'no such session' } }, 404);
      if (method === 'DELETE') {
        this.sessions.delete(uploadId);
        return new Response(null, { status: 499 });
      }
      if (this.failPuts > 0) {
        this.failPuts--;
        return this.json({ error: { message: 'backend error' } }, 503);
      }
      const range = new Headers(init.headers).get('content-range') ?? '';
      const m = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(range);
      if (!m) return this.json({ error: { message: `bad range ${range}` } }, 400);
      const total = m[3] === '*' ? null : Number(m[3]);
      if (m[1] !== undefined) {
        const from = Number(m[1]);
        const to = Number(m[2]);
        if (from !== s.size) return this.json({ error: { message: `expected offset ${s.size}, got ${from}` } }, 400);
        const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer());
        if (bytes.length !== to - from + 1) return this.json({ error: { message: 'range/body mismatch' } }, 400);
        if (total === null && bytes.length % (256 * 1024) !== 0) return this.json({ error: { message: 'a piece that is not the last must be a multiple of 256 KiB' } }, 400);
        s.bytes.push(bytes);
        s.size += bytes.length;
      }
      if (total !== null && s.size === total) {
        const all = new Uint8Array(s.size);
        let o = 0;
        for (const b of s.bytes) {
          all.set(b, o);
          o += b.length;
        }
        this.sessions.delete(uploadId);
        return this.json(this.meta(this.create({ ...s.meta, mimeType: s.meta.mimeType ?? 'application/octet-stream' }, all)));
      }
      return new Response(null, { status: 308, headers: s.size ? { Range: `bytes=0-${s.size - 1}` } : {} });
    }

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
