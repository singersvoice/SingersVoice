/**
 * Google Drive provider (scope `drive.file`). The singer's Drive is the system of record:
 *
 *   SingersVoice/
 *     Tracks/<title>/track.json + backing.<ext>
 *     Performances/Live|Offline/<date time song · meet [meet id] (id)>/manifest.json + vocal.wav + <song · meet · date time>.mp4
 *     Temp/<same as above, deleted after 7 days unless kept>
 *     Config/audio_plugin_settings.json, app_settings.json
 *     Backgrounds/, Exports/
 *
 * Every file carries appProperties (svType, svId, …) so lists are one query, independent of names.
 * Uploads: multipart for small JSON, resumable (8 MiB chunks, resume on 308/network error) for media;
 * every upload is verified against Drive's md5Checksum before the local copy is released.
 */
import {
  APP_PROPS,
  DRIVE_FOLDER_PATHS,
  DRIVE_ROOT,
  normalizeTrack,
  performanceVideoName,
  safeName,
  type DriveFolderKey,
  type PerformanceManifest,
  type SvFileType,
  type TrackPackageV2,
} from '@singersvoice/protocol';
import { extFromMime } from '../decode.ts';
import { AuthExpiredError, type GoogleToken } from '../google.ts';
import { md5Blob } from '../md5.ts';
import type { LoadedPerformance, LoadedTrack, PerformanceSummary, Progress, ProviderLinks, StorageProvider, TrackSummary } from './types.ts';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB
const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents,appProperties,description,webViewLink,trashed';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  createdTime?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  description?: string;
  webViewLink?: string;
  trashed?: boolean;
}

type Tree = Record<DriveFolderKey, string>;
/** Bump to make every device walk (and tidy) its Drive folder tree once more. */
const TIDY_VERSION = '2';

export class DriveProvider implements StorageProvider {
  readonly kind = 'drive' as const;
  readonly label = 'Google Drive';
  private tree: Tree | null = null;
  /** The folder tree being looked up / built right now: every caller waits for the same one (no second "Live" folder from a race). */
  private treeReady: Promise<void> | null = null;
  private treeKey: string;

  constructor(
    private getToken: () => GoogleToken | null,
    accountSub: string,
  ) {
    this.treeKey = `sv.drive.tree.${accountSub}`;
  }

  // ---------- HTTP ----------

  private auth(): string {
    const t = this.getToken();
    if (!t || t.expiresAt < Date.now()) throw new AuthExpiredError();
    return `Bearer ${t.accessToken}`;
  }

  /** Authenticated Drive call with retries; JSON responses are parsed (use `download` for file bytes). */
  private async req<T>(url: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const r = await this.fetchOk(url, init, attempt);
    if (r.status === 204) return undefined as T;
    const ct = r.headers.get('content-type') ?? '';
    return (ct.includes('application/json') ? await r.json() : await r.blob()) as T;
  }

  private async fetchOk(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    headers.set('Authorization', this.auth());
    let r: Response;
    try {
      r = await fetch(url, { ...init, headers });
    } catch (e) {
      if (attempt < 3) {
        await sleep(600 * 2 ** attempt);
        return this.fetchOk(url, init, attempt + 1);
      }
      throw e;
    }
    if (r.status === 401) throw new AuthExpiredError();
    if ((r.status === 429 || r.status >= 500 || (r.status === 403 && (await isRateLimited(r.clone())))) && attempt < 4) {
      await sleep(800 * 2 ** attempt + Math.random() * 300);
      return this.fetchOk(url, init, attempt + 1);
    }
    if (!r.ok) throw new Error(await errorMessage(r));
    return r;
  }

  private async list(q: string, pageSize = 200): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ q, pageSize: String(pageSize), fields: `nextPageToken,files(${FILE_FIELDS})`, spaces: 'drive' });
      if (pageToken) params.set('pageToken', pageToken);
      const j = await this.req<{ files: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params}`);
      out.push(...(j.files ?? []));
      pageToken = j.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  private async createFolder(name: string, parentId: string | null, props: Record<string, string>): Promise<DriveFile> {
    const body = { name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined, appProperties: props };
    return this.req<DriveFile>(`${API}/files?fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Every folder of that name under the parent, oldest first (Drive allows several; the oldest is the one we keep). */
  private async findFolders(name: string, parentId: string | null): Promise<DriveFile[]> {
    const parent = parentId ? `'${parentId}' in parents` : `'root' in parents`;
    const files = await this.list(`name='${esc(name)}' and mimeType='${FOLDER_MIME}' and ${parent} and trashed=false`, 20);
    return files.sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? '') || a.id.localeCompare(b.id));
  }

  private async findFolder(name: string, parentId: string | null): Promise<DriveFile | null> {
    return (await this.findFolders(name, parentId))[0] ?? null;
  }

  /**
   * Find the folder or make it — and when Drive holds several of the same name (two devices, or two
   * first runs, made one each before this guard existed) fold the newer ones into the oldest: their
   * files and folders move over, the emptied duplicates go to the trash. Safe to repeat; a failure
   * here never blocks the app (the oldest folder is used either way).
   */
  private async ensureFolder(name: string, parentId: string | null, props: Record<string, string>): Promise<DriveFile> {
    const found = await this.findFolders(name, parentId);
    if (!found.length) return this.createFolder(name, parentId, props);
    const keep = found[0]!;
    if (found.length > 1) await this.foldDuplicates(keep, found.slice(1)).catch((e) => console.warn('Drive: duplicate folders not merged', e));
    return keep;
  }

  private async foldDuplicates(keep: DriveFile, dupes: DriveFile[]): Promise<void> {
    for (const d of dupes) {
      const children = await this.list(`'${d.id}' in parents and trashed=false`);
      for (const c of children) {
        await this.req(`${API}/files/${c.id}?addParents=${keep.id}&removeParents=${d.id}&fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      }
      await this.req(`${API}/files/${d.id}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
    }
  }

  private async uploadMultipart(meta: Record<string, unknown>, blob: Blob): Promise<DriveFile> {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', blob);
    return this.req<DriveFile>(`${UPLOAD}?uploadType=multipart&fields=${FILE_FIELDS}`, { method: 'POST', body: form });
  }

  /** Resumable upload with chunking, resume-on-error and md5 verification. */
  private async uploadResumable(meta: Record<string, unknown>, blob: Blob, onProgress?: (f: number) => void): Promise<DriveFile> {
    const start = await fetch(`${UPLOAD}?uploadType=resumable&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: {
        Authorization: this.auth(),
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': blob.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify(meta),
    });
    if (start.status === 401) throw new AuthExpiredError();
    if (!start.ok) throw new Error(await errorMessage(start));
    const session = start.headers.get('Location');
    if (!session) throw new Error('Drive did not return an upload session');

    let offset = 0;
    let failures = 0;
    while (offset < blob.size) {
      const end = Math.min(blob.size, offset + CHUNK);
      let r: Response;
      try {
        r = await fetch(session, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}`, 'Content-Type': blob.type || 'application/octet-stream' },
          body: blob.slice(offset, end),
        });
      } catch {
        if (++failures > 6) throw new Error('Upload failed after repeated network errors');
        await sleep(1000 * 2 ** failures);
        offset = await this.queryResumeOffset(session, blob.size);
        continue;
      }
      if (r.status === 308) {
        const range = r.headers.get('Range');
        offset = range ? Number(range.split('-')[1]) + 1 : end;
        failures = 0;
      } else if (r.ok) {
        onProgress?.(1);
        const file = (await r.json()) as DriveFile;
        return file;
      } else if (r.status === 401) {
        throw new AuthExpiredError();
      } else if (r.status >= 500 || r.status === 429) {
        if (++failures > 6) throw new Error(await errorMessage(r));
        await sleep(1000 * 2 ** failures);
        offset = await this.queryResumeOffset(session, blob.size);
        continue;
      } else {
        throw new Error(await errorMessage(r));
      }
      onProgress?.(offset / blob.size);
    }
    throw new Error('Upload ended without a final response');
  }

  private async queryResumeOffset(session: string, total: number): Promise<number> {
    const r = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } });
    if (r.status === 308) {
      const range = r.headers.get('Range');
      return range ? Number(range.split('-')[1]) + 1 : 0;
    }
    if (r.ok) return total;
    return 0;
  }

  /** Upload (multipart < 5 MB, else resumable), then verify size + md5. Deletes the file on mismatch. */
  private async upload(
    name: string,
    blob: Blob,
    parentId: string,
    props: Record<string, string>,
    onProgress?: (f: number) => void,
  ): Promise<DriveFile> {
    const meta = { name, parents: [parentId], appProperties: props, mimeType: blob.type || 'application/octet-stream' };
    const [file, localMd5] = await Promise.all([
      blob.size < 5 * 1024 * 1024 ? this.uploadMultipart(meta, blob) : this.uploadResumable(meta, blob, onProgress),
      md5Blob(blob),
    ]);
    const okSize = Number(file.size ?? -1) === blob.size;
    const okMd5 = !file.md5Checksum || file.md5Checksum === localMd5;
    if (!okSize || !okMd5) {
      await this.req(`${API}/files/${file.id}`, { method: 'DELETE' }).catch(() => undefined);
      throw new Error(`Upload verification failed for ${name} (size ${okSize ? 'ok' : 'mismatch'}, md5 ${okMd5 ? 'ok' : 'mismatch'}) — retry`);
    }
    return file;
  }

  private async replaceContent(fileId: string, blob: Blob): Promise<DriveFile> {
    return this.req<DriveFile>(`${UPLOAD}/${fileId}?uploadType=media&fields=${FILE_FIELDS}`, {
      method: 'PATCH',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
  }

  /** File bytes, always as a Blob — `alt=media` answers with the file's own content type (track.json is
   *  application/json), so this must not go through the JSON-parsing `req`. */
  async download(fileId: string): Promise<Blob> {
    const r = await this.fetchOk(`${API}/files/${fileId}?alt=media`);
    return r.blob();
  }

  private async downloadJson<T>(fileId: string): Promise<T> {
    const b = await this.download(fileId);
    return JSON.parse(await b.text()) as T;
  }

  // ---------- Tree ----------

  async ready(): Promise<void> {
    if (this.tree) return;
    if (!this.treeReady) {
      this.treeReady = this.buildTree().finally(() => {
        this.treeReady = null;
      });
    }
    return this.treeReady;
  }

  private async buildTree(): Promise<void> {
    const cached = readJson<Tree>(localStorage.getItem(this.treeKey));
    // Once per device (per tidy version) the tree is walked again instead of trusted from the cache,
    // so folders that were doubled before the build guard existed are folded into one.
    const tidied = localStorage.getItem(`${this.treeKey}.tidy`) === TIDY_VERSION;
    if (cached && tidied) {
      try {
        const root = await this.req<DriveFile>(`${API}/files/${cached.root}?fields=id,trashed`);
        if (!root.trashed) {
          this.tree = cached;
          return;
        }
      } catch (e) {
        if (e instanceof AuthExpiredError) throw e;
      }
    }
    const root = await this.ensureFolder(DRIVE_ROOT, null, { [APP_PROPS.type]: 'root' });
    const tree = { root: root.id } as Tree;
    const byPath = new Map<string, string>([['', root.id]]);
    for (const key of Object.keys(DRIVE_FOLDER_PATHS) as DriveFolderKey[]) {
      if (key === 'root') continue;
      const parts = DRIVE_FOLDER_PATHS[key];
      let parent = root.id;
      let path = '';
      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        let id = byPath.get(path);
        if (!id) {
          id = (await this.ensureFolder(part, parent, { [APP_PROPS.type]: 'folder' })).id;
          byPath.set(path, id);
        }
        parent = id;
      }
      tree[key] = parent;
    }
    this.tree = tree;
    localStorage.setItem(this.treeKey, JSON.stringify(tree));
    const flattened = await this.flattenPerformances().then(
      () => true,
      (e) => {
        if (e instanceof AuthExpiredError) throw e;
        console.warn('Drive: performances not flattened', e); // tried again next start: the tidy mark is not set
        return false;
      },
    );
    if (flattened) localStorage.setItem(`${this.treeKey}.tidy`, TIDY_VERSION);
  }

  private folder(key: DriveFolderKey): string {
    if (!this.tree) throw new Error('Drive folders not ready');
    return this.tree[key];
  }

  links(): ProviderLinks {
    if (!this.tree) return {};
    const f = (id: string) => `https://drive.google.com/drive/folders/${id}`;
    return { root: f(this.tree.root), tracks: f(this.tree.tracks), performances: f(this.tree.performances), temp: f(this.tree.temp) };
  }

  // ---------- Tracks ----------

  async listTracks(): Promise<TrackSummary[]> {
    await this.ready();
    const files = await this.list(`appProperties has { key='${APP_PROPS.type}' and value='track' } and trashed=false`);
    return files
      .map((f) => {
        const p = f.appProperties ?? {};
        return {
          trackId: p[APP_PROPS.id] ?? f.id,
          title: p.svTitle ?? f.name.replace(/\.json$/, ''),
          artist: p.svArtist ?? '',
          durationMs: Number(p.svDurationMs ?? 0),
          singerCount: Number(p.svSingers ?? 1),
          updatedAt: f.modifiedTime ?? '',
          ref: f.parents?.[0] ?? f.id,
          link: f.parents?.[0] ? `https://drive.google.com/drive/folders/${f.parents[0]}` : f.webViewLink,
          shared: p.svShared === '1',
        } satisfies TrackSummary;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async trackFiles(trackId: string): Promise<DriveFile[]> {
    return this.list(`appProperties has { key='${APP_PROPS.trackId}' and value='${esc(trackId)}' } and trashed=false`);
  }

  async getTrack(trackId: string): Promise<LoadedTrack | null> {
    await this.ready();
    const files = await this.trackFiles(trackId);
    const json = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'track');
    const audio = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'trackAudio');
    if (!json || !audio) return null;
    const [track, blob] = await Promise.all([this.downloadJson<TrackPackageV2>(json.id), this.download(audio.id)]);
    return { track: normalizeTrack(track), audio: blob, audioMime: audio.mimeType || blob.type };
  }

  async saveTrack(track: TrackPackageV2, audio: Blob | null, onProgress?: Progress): Promise<TrackSummary> {
    await this.ready();
    onProgress?.({ label: 'Preparing Drive folder', fraction: 0.05 });
    const existing = await this.trackFiles(track.trackId);
    const existingJson = existing.find((f) => f.appProperties?.[APP_PROPS.type] === 'track');
    const existingAudio = existing.find((f) => f.appProperties?.[APP_PROPS.type] === 'trackAudio');
    let folderId = existingJson?.parents?.[0] ?? existingAudio?.parents?.[0];
    const folderName = safeName(track.title, 'Untitled track');
    if (!folderId) {
      const folder = await this.createFolder(folderName, this.folder('tracks'), {
        [APP_PROPS.type]: 'trackFolder',
        [APP_PROPS.trackId]: track.trackId,
      });
      folderId = folder.id;
    } else if (existingJson && existingJson.name !== 'track.json') {
      // legacy name — leave it
    }
    const props = {
      [APP_PROPS.type]: 'track' as SvFileType,
      [APP_PROPS.id]: track.trackId,
      [APP_PROPS.trackId]: track.trackId,
      [APP_PROPS.schema]: '2',
      svTitle: track.title.slice(0, 60),
      svArtist: track.artist.slice(0, 40),
      svDurationMs: String(track.durationMs),
      svSingers: String(track.singerCount),
      svShared: existingJson?.appProperties?.svShared ?? '0',
    };
    if (audio) {
      onProgress?.({ label: 'Uploading backing track', fraction: 0.1 });
      const ext = extFromMime(audio.type, 'mp3');
      const audioProps = { [APP_PROPS.type]: 'trackAudio', [APP_PROPS.id]: track.trackId, [APP_PROPS.trackId]: track.trackId };
      if (existingAudio) await this.req(`${API}/files/${existingAudio.id}`, { method: 'DELETE' }).catch(() => undefined);
      await this.upload(`backing.${ext}`, audio, folderId, audioProps, (f) => onProgress?.({ label: 'Uploading backing track', fraction: 0.1 + f * 0.7 }));
    } else if (!existingAudio) {
      throw new Error('This track has no audio yet');
    }
    onProgress?.({ label: 'Saving lyrics & metadata', fraction: 0.85 });
    const jsonBlob = new Blob([JSON.stringify(track, null, 1)], { type: 'application/json' });
    let file: DriveFile;
    if (existingJson) {
      await this.req(`${API}/files/${existingJson.id}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appProperties: props }),
      });
      file = await this.replaceContent(existingJson.id, jsonBlob);
    } else {
      file = await this.upload('track.json', jsonBlob, folderId, props);
    }
    // Keep the folder named after the title.
    if (existingJson) {
      await this.req(`${API}/files/${folderId}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName }),
      }).catch(() => undefined);
    }
    onProgress?.({ label: 'Saved to Drive', fraction: 1 });
    return {
      trackId: track.trackId,
      title: track.title,
      artist: track.artist,
      durationMs: track.durationMs,
      singerCount: track.singerCount,
      updatedAt: file.modifiedTime ?? new Date().toISOString(),
      ref: folderId,
      link: `https://drive.google.com/drive/folders/${folderId}`,
      shared: props.svShared === '1',
    };
  }

  async deleteTrack(trackId: string): Promise<void> {
    await this.ready();
    const files = await this.trackFiles(trackId);
    const folderId = files.find((f) => f.mimeType === FOLDER_MIME)?.id ?? files[0]?.parents?.[0];
    if (folderId) await this.req(`${API}/files/${folderId}`, { method: 'DELETE' });
    else for (const f of files) await this.req(`${API}/files/${f.id}`, { method: 'DELETE' }).catch(() => undefined);
  }

  async shareTrack(trackId: string, with_: { type: 'anyone' } | { type: 'user'; email: string }): Promise<string> {
    await this.ready();
    const files = await this.trackFiles(trackId);
    const json = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'track');
    const folderId = files.find((f) => f.mimeType === FOLDER_MIME)?.id ?? json?.parents?.[0];
    if (!folderId) throw new Error('Track folder not found in Drive');
    const body = with_.type === 'anyone' ? { role: 'reader', type: 'anyone' } : { role: 'reader', type: 'user', emailAddress: with_.email };
    const params = with_.type === 'user' ? '?sendNotificationEmail=true&emailMessage=' + encodeURIComponent('A SingersVoice track was shared with you. Open SingersVoice → Library → Import from Drive.') : '';
    await this.req(`${API}/files/${folderId}/permissions${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (json) {
      await this.req(`${API}/files/${json.id}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appProperties: { ...(json.appProperties ?? {}), svShared: '1' } }),
      }).catch(() => undefined);
    }
    return `https://drive.google.com/drive/folders/${folderId}`;
  }

  /** Drive ids the public catalog needs so other singers can fetch the package (folder must be shared first). */
  async publicTrackRefs(trackId: string): Promise<{ folderId: string; folderLink: string; trackJsonId: string; audioId: string; audioMime: string; shared: boolean }> {
    await this.ready();
    const files = await this.trackFiles(trackId);
    const json = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'track');
    const audio = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'trackAudio');
    const folderId = files.find((f) => f.mimeType === FOLDER_MIME)?.id ?? json?.parents?.[0];
    if (!json || !audio || !folderId) throw new Error('Track files not found in Drive');
    return {
      folderId,
      folderLink: `https://drive.google.com/drive/folders/${folderId}`,
      trackJsonId: json.id,
      audioId: audio.id,
      audioMime: audio.mimeType || 'audio/mpeg',
      shared: json.appProperties?.svShared === '1',
    };
  }

  /** Remove the anyone-with-link permission from a track folder (catalog unpublish). */
  async unshareTrack(trackId: string): Promise<void> {
    await this.ready();
    const files = await this.trackFiles(trackId);
    const json = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'track');
    const folderId = files.find((f) => f.mimeType === FOLDER_MIME)?.id ?? json?.parents?.[0];
    if (!folderId) return;
    const perms = await this.req<{ permissions?: { id: string; type: string }[] }>(`${API}/files/${folderId}/permissions?fields=permissions(id,type)`);
    for (const p of perms.permissions ?? []) if (p.type === 'anyone') await this.req(`${API}/files/${folderId}/permissions/${p.id}`, { method: 'DELETE' }).catch(() => undefined);
    if (json) {
      await this.req(`${API}/files/${json.id}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appProperties: { ...(json.appProperties ?? {}), svShared: '0' } }),
      }).catch(() => undefined);
    }
  }

  /** Import a track folder/file another singer shared (after the Google Picker granted access to it). */
  async importShared(fileOrFolderId: string): Promise<LoadedTrack> {
    await this.ready();
    let meta = await this.req<DriveFile>(`${API}/files/${fileOrFolderId}?fields=${FILE_FIELDS}&supportsAllDrives=true`);
    let files: DriveFile[];
    if (meta.mimeType === FOLDER_MIME) files = await this.list(`'${meta.id}' in parents and trashed=false`);
    else {
      const parent = meta.parents?.[0];
      files = parent ? await this.list(`'${parent}' in parents and trashed=false`) : [meta];
      if (!files.some((f) => f.id === meta.id)) files.push(meta);
      meta = files.find((f) => f.mimeType === FOLDER_MIME) ?? meta;
    }
    const json = files.find((f) => f.name.endsWith('.json'));
    const audio = files.find((f) => (f.mimeType || '').startsWith('audio/') || /\.(mp3|m4a|wav|ogg|webm|flac)$/i.test(f.name));
    if (!json || !audio) throw new Error('That folder has no track.json + audio pair');
    const track = normalizeTrack(await this.downloadJson<TrackPackageV2>(json.id));
    const blob = await this.download(audio.id);
    return { track, audio: blob, audioMime: audio.mimeType || blob.type };
  }

  // ---------- Performances: one file each, one level ----------
  //
  // A performance is ONE file in `Performances` (or `Temp` while it is a temporary take): the show
  // video — or, for a take without video, the vocal WAV — named for the people a Drive link reaches
  // ("Song · Meet [id] · date.mp4"). Its summary rides in the file's appProperties (how it is found
  // and listed) and the whole manifest in its `description`. Delete means delete: the file is gone.

  private perfProps(manifest: PerformanceManifest, media: 'video' | 'vocal', shared: string): Record<string, string> {
    return {
      [APP_PROPS.type]: 'performance',
      [APP_PROPS.id]: manifest.performanceId,
      svPerfId: manifest.performanceId,
      [APP_PROPS.trackId]: manifest.trackId,
      [APP_PROPS.meetId]: manifest.meetId ?? '',
      [APP_PROPS.state]: manifest.state,
      svMode: manifest.mode,
      svKind: manifest.kind ?? 'take',
      svMeet: (manifest.meetTitle ?? '').slice(0, 60),
      svTitle: manifest.trackTitle.slice(0, 60),
      svDurationMs: String(manifest.durationMs),
      svCreatedAt: manifest.createdAt,
      svExpiresAt: manifest.expiresAt ?? '',
      svMedia: media,
      svShared: shared,
    };
  }

  private perfSummary(f: DriveFile): PerformanceSummary {
    const p = f.appProperties ?? {};
    const view = `https://drive.google.com/file/d/${f.id}/view`;
    const legacy = f.mimeType === 'application/json'; // a manifest.json still in a folder of its own (not migrated yet)
    const video = legacy ? (p.svVideo === '1' ? `https://drive.google.com/file/d/${p.svVideoId}/view` : undefined) : p.svMedia === 'video' ? view : undefined;
    return {
      performanceId: p[APP_PROPS.id] ?? f.id,
      trackId: p[APP_PROPS.trackId] ?? '',
      trackTitle: p.svTitle ?? f.name,
      state: (p[APP_PROPS.state] === 'kept' ? 'kept' : 'temp') as 'temp' | 'kept',
      mode: (p.svMode === 'live' ? 'live' : 'offline') as 'offline' | 'live',
      kind: (p.svKind === 'show' ? 'show' : 'take') as 'take' | 'show',
      meetId: p[APP_PROPS.meetId] || null,
      meetTitle: p.svMeet || undefined,
      durationMs: Number(p.svDurationMs ?? 0),
      createdAt: p.svCreatedAt ?? f.modifiedTime ?? '',
      expiresAt: p.svExpiresAt || null,
      ref: f.id,
      link: legacy && f.parents?.[0] ? `https://drive.google.com/drive/folders/${f.parents[0]}` : view,
      videoLink: video,
      hasVideo: Boolean(video),
      shared: p.svShared === '1',
    };
  }

  async listPerformances(): Promise<PerformanceSummary[]> {
    await this.ready();
    const files = await this.list(`appProperties has { key='${APP_PROPS.type}' and value='performance' } and trashed=false`);
    return files.map((f) => this.perfSummary(f)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The performance's file (the media; a manifest.json for one not migrated yet). */
  private async perfFile(performanceId: string): Promise<DriveFile | null> {
    const files = await this.list(`appProperties has { key='svPerfId' and value='${esc(performanceId)}' } and trashed=false`);
    return files.find((f) => f.appProperties?.[APP_PROPS.type] === 'performance') ?? null;
  }

  /** The manifest a file carries in its description, or the little its properties say. */
  private manifestOf(f: DriveFile): PerformanceManifest {
    const fromDescription = readJson<PerformanceManifest>(f.description ?? null);
    if (fromDescription && fromDescription.performanceId) return fromDescription;
    const s = this.perfSummary(f);
    return {
      schema: 'singersvoice.performance.v2',
      performanceId: s.performanceId,
      mode: s.mode,
      state: s.state,
      kind: s.kind,
      ...(s.meetTitle ? { meetTitle: s.meetTitle } : {}),
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      trackId: s.trackId,
      trackTitle: s.trackTitle,
      trackArtist: '',
      singerSlot: 1,
      meetId: s.meetId ?? null,
      durationMs: s.durationMs,
      timeline: { startedAtEpochMs: Date.parse(s.createdAt) || 0, vocalOffsetMs: 0, videoOffsetMs: 0, latencyCompMs: 0, sampleRate: 48000 },
      playback: { tempo: 1, keyShift: 0, backingGain: 0.85 },
      fx: {} as PerformanceManifest['fx'],
      device: { userAgent: '', platform: '', headphones: null },
      files: [],
      notes: '',
    } as PerformanceManifest;
  }

  async getPerformance(performanceId: string): Promise<LoadedPerformance | null> {
    await this.ready();
    const f = await this.perfFile(performanceId);
    if (!f) return null;
    if (f.mimeType === 'application/json') return this.getLegacyPerformance(f);
    const manifest = this.manifestOf(f);
    const blob = await this.download(f.id);
    const video = f.appProperties?.svMedia === 'video';
    return { manifest, vocal: video ? new Blob([], { type: 'audio/wav' }) : blob, video: video ? blob : null };
  }

  /** A performance still in a folder of its own (made before the one-file layout; migrated on the next start). */
  private async getLegacyPerformance(json: DriveFile): Promise<LoadedPerformance | null> {
    const folderId = json.parents?.[0];
    const files = folderId ? await this.list(`'${folderId}' in parents and trashed=false`) : [];
    const vocal = files.find((x) => x.appProperties?.[APP_PROPS.type] === 'performanceAudio');
    const video = files.find((x) => x.appProperties?.[APP_PROPS.type] === 'performanceVideo');
    const [manifest, vocalBlob, videoBlob] = await Promise.all([this.downloadJson<PerformanceManifest>(json.id), vocal ? this.download(vocal.id) : Promise.resolve(new Blob([], { type: 'audio/wav' })), video ? this.download(video.id) : Promise.resolve(null)]);
    return { manifest, vocal: vocalBlob, video: videoBlob };
  }

  async savePerformance(manifest: PerformanceManifest, files: { vocal: Blob; video: Blob | null }, onProgress?: Progress): Promise<PerformanceSummary> {
    await this.ready();
    const media = files.video ?? files.vocal;
    const kind: 'video' | 'vocal' = files.video ? 'video' : 'vocal';
    const ext = files.video ? extFromMime(files.video.type, 'webm') : 'wav';
    const parent = this.folder(manifest.state === 'temp' ? 'temp' : 'performances');
    onProgress?.({ label: kind === 'video' ? 'Uploading the show' : 'Uploading the vocal', fraction: 0.03 });
    // Named for the people a Drive link reaches ("Song · Meet · date.mp4"); found again by its app properties, not its name.
    const file = await this.upload(performanceVideoName(manifest, ext), media, parent, this.perfProps(manifest, kind, '0'), (f) => onProgress?.({ label: kind === 'video' ? 'Uploading the show' : 'Uploading the vocal', fraction: 0.03 + f * 0.9 }));
    const entry = manifest.files.find((fe) => (kind === 'video' ? fe.name.startsWith('video.') : fe.name === 'vocal.wav'));
    const stamped: PerformanceManifest = { ...manifest, files: [{ name: kind === 'video' ? `video.${ext}` : 'vocal.wav', mimeType: media.type, size: media.size, sha256: entry?.sha256 ?? '', driveId: file.id, md5: file.md5Checksum }] };
    onProgress?.({ label: 'Writing the details', fraction: 0.95 });
    await this.setDescription(file.id, stamped);
    onProgress?.({ label: 'Saved to Drive', fraction: 1 });
    return this.perfSummary({ ...file, appProperties: this.perfProps(manifest, kind, '0') });
  }

  /** The manifest, in the file's description (best effort: the properties already say what the lists need). */
  private async setDescription(fileId: string, manifest: PerformanceManifest): Promise<void> {
    await this.req(`${API}/files/${fileId}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: JSON.stringify(manifest) }) }).catch((e) => console.warn('Drive: performance details not written', e));
  }

  async sharePerformance(performanceId: string, with_: { type: 'anyone' } | { type: 'user'; email: string }): Promise<{ link: string; videoLink: string | null }> {
    await this.ready();
    const f = await this.perfFile(performanceId);
    if (!f) throw new Error('Performance not found in Drive');
    const body = with_.type === 'anyone' ? { role: 'reader', type: 'anyone' } : { role: 'reader', type: 'user', emailAddress: with_.email };
    const params = with_.type === 'user' ? '?sendNotificationEmail=true&emailMessage=' + encodeURIComponent('A SingersVoice performance you sang in was shared with you. It is also listed under Performances in SingersVoice.') : '';
    await this.req(`${API}/files/${f.id}/permissions${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (with_.type === 'anyone') {
      await this.req(`${API}/files/${f.id}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appProperties: { ...(f.appProperties ?? {}), svShared: '1' } }),
      }).catch(() => undefined);
    }
    const s = this.perfSummary(f);
    return { link: s.link ?? `https://drive.google.com/file/d/${f.id}/view`, videoLink: s.videoLink ?? null };
  }

  async keepPerformance(performanceId: string): Promise<void> {
    await this.ready();
    const f = await this.perfFile(performanceId);
    if (!f) throw new Error('Performance not found');
    const manifest: PerformanceManifest = { ...this.manifestOf(f), state: 'kept', expiresAt: null };
    const from = f.parents?.[0] ?? this.folder('temp');
    await this.req(`${API}/files/${f.id}?addParents=${this.folder('performances')}&removeParents=${from}&fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appProperties: { ...(f.appProperties ?? {}), [APP_PROPS.state]: 'kept', svExpiresAt: '' }, description: JSON.stringify(manifest) }),
    });
  }

  /** Gone for good: the file is deleted, not trashed (a performance not migrated yet loses its whole folder). */
  async deletePerformance(performanceId: string): Promise<void> {
    await this.ready();
    const f = await this.perfFile(performanceId);
    if (!f) return;
    const target = f.mimeType === 'application/json' && f.parents?.[0] ? f.parents[0] : f.id;
    await this.req(`${API}/files/${target}`, { method: 'DELETE' });
  }

  async sweepTemp(): Promise<number> {
    const perfs = await this.listPerformances();
    const now = Date.now();
    let n = 0;
    for (const p of perfs) {
      if (p.state === 'temp' && p.expiresAt && Date.parse(p.expiresAt) < now) {
        await this.deletePerformance(p.performanceId).catch(() => undefined);
        n++;
      }
    }
    return n;
  }

  /**
   * One-time: performances saved as a folder each (manifest.json + vocal.wav + the video, under
   * Performances/Live or /Offline) become one file each, straight under Performances — the video
   * (or the vocal when there is none) moved up, stamped with the summary and the manifest, shared
   * again where the folder was; the folder and what is left in it are deleted; the emptied Live and
   * Offline folders too.
   */
  private async flattenPerformances(): Promise<void> {
    const folders = await this.list(`appProperties has { key='${APP_PROPS.type}' and value='performanceFolder' } and trashed=false`);
    for (const folder of folders) {
      try {
        const files = await this.list(`'${folder.id}' in parents and trashed=false`);
        const json = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'performance');
        const video = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'performanceVideo');
        const vocal = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'performanceAudio');
        const media = video ?? vocal;
        if (!json || !media) continue; // not one of ours as we know them: left alone
        const manifest = await this.downloadJson<PerformanceManifest>(json.id);
        const kind: 'video' | 'vocal' = video ? 'video' : 'vocal';
        const dest = this.folder(manifest.state === 'temp' ? 'temp' : 'performances');
        const shared = json.appProperties?.svShared ?? '0';
        const name = video ? media.name : performanceVideoName(manifest, 'wav');
        await this.req(`${API}/files/${media.id}?addParents=${dest}&removeParents=${folder.id}&fields=id`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, appProperties: this.perfProps(manifest, kind, shared), description: JSON.stringify({ ...manifest, files: manifest.files.filter((fe) => (kind === 'video' ? fe.name.startsWith('video.') : fe.name === 'vocal.wav')) }) }),
        });
        if (shared === '1') await this.req(`${API}/files/${media.id}/permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }) }).catch(() => undefined);
        await this.req(`${API}/files/${folder.id}`, { method: 'DELETE' });
      } catch (e) {
        if (e instanceof AuthExpiredError) throw e;
        console.warn('Drive: performance not flattened', folder.name, e);
      }
    }
    for (const name of ['Live', 'Offline']) {
      const subs = await this.list(`name='${esc(name)}' and '${this.folder('performances')}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`);
      for (const sub of subs) {
        const inside = await this.list(`'${sub.id}' in parents and trashed=false`, 1);
        if (!inside.length) await this.req(`${API}/files/${sub.id}`, { method: 'DELETE' }).catch(() => undefined);
      }
    }
  }

  // ---------- Config ----------

  private async findConfig(name: string): Promise<DriveFile | null> {
    const files = await this.list(`name='${esc(name)}' and '${this.folder('config')}' in parents and trashed=false`, 2);
    return files[0] ?? null;
  }

  async getConfig<T>(name: string): Promise<T | null> {
    await this.ready();
    const f = await this.findConfig(name);
    return f ? this.downloadJson<T>(f.id) : null;
  }

  async setConfig(name: string, value: unknown): Promise<void> {
    await this.ready();
    const blob = new Blob([JSON.stringify(value, null, 1)], { type: 'application/json' });
    const f = await this.findConfig(name);
    if (f) await this.replaceContent(f.id, blob);
    else await this.upload(name, blob, this.folder('config'), { [APP_PROPS.type]: 'config', [APP_PROPS.id]: name });
  }

  async quota(): Promise<{ used: number; total: number } | null> {
    const j = await this.req<{ storageQuota?: { usage?: string; limit?: string } }>(`${API}/about?fields=storageQuota`);
    if (!j.storageQuota) return null;
    return { used: Number(j.storageQuota.usage ?? 0), total: Number(j.storageQuota.limit ?? 0) };
  }
}

// ---------- helpers ----------

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function isRateLimited(r: Response): Promise<boolean> {
  try {
    const j = (await r.json()) as { error?: { errors?: { reason?: string }[] } };
    return (j.error?.errors ?? []).some((e) => /rateLimit|userRateLimit|quotaExceeded/i.test(e.reason ?? ''));
  } catch {
    return false;
  }
}

async function errorMessage(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: { message?: string } };
    return `Drive error ${r.status}: ${j.error?.message ?? r.statusText}`;
  } catch {
    return `Drive error ${r.status}: ${r.statusText}`;
  }
}
