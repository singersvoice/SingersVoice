/**
 * Google Drive provider (scope `drive.file`). The singer's Drive is the system of record:
 *
 *   SingersVoice/
 *     Tracks/<title>/track.json + backing.<ext>
 *     Performances/Live|Offline/<date time title (id)>/manifest.json + vocal.wav + video.*
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
  performanceFolderName,
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
const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,parents,appProperties,webViewLink,trashed';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  webViewLink?: string;
  trashed?: boolean;
}

type Tree = Record<DriveFolderKey, string>;

export class DriveProvider implements StorageProvider {
  readonly kind = 'drive' as const;
  readonly label = 'Google Drive';
  private tree: Tree | null = null;
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

  private async req<T>(url: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const headers = new Headers(init.headers ?? {});
    headers.set('Authorization', this.auth());
    let r: Response;
    try {
      r = await fetch(url, { ...init, headers });
    } catch (e) {
      if (attempt < 3) {
        await sleep(600 * 2 ** attempt);
        return this.req<T>(url, init, attempt + 1);
      }
      throw e;
    }
    if (r.status === 401) throw new AuthExpiredError();
    if ((r.status === 429 || r.status >= 500 || (r.status === 403 && (await isRateLimited(r.clone())))) && attempt < 4) {
      await sleep(800 * 2 ** attempt + Math.random() * 300);
      return this.req<T>(url, init, attempt + 1);
    }
    if (!r.ok) throw new Error(await errorMessage(r));
    if (r.status === 204) return undefined as T;
    const ct = r.headers.get('content-type') ?? '';
    return (ct.includes('application/json') ? await r.json() : await r.blob()) as T;
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

  private async findFolder(name: string, parentId: string | null): Promise<DriveFile | null> {
    const parent = parentId ? `'${parentId}' in parents` : `'root' in parents`;
    const files = await this.list(`name='${esc(name)}' and mimeType='${FOLDER_MIME}' and ${parent} and trashed=false`, 5);
    return files[0] ?? null;
  }

  private async ensureFolder(name: string, parentId: string | null, props: Record<string, string>): Promise<DriveFile> {
    return (await this.findFolder(name, parentId)) ?? (await this.createFolder(name, parentId, props));
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

  private async download(fileId: string): Promise<Blob> {
    return this.req<Blob>(`${API}/files/${fileId}?alt=media`);
  }

  private async downloadJson<T>(fileId: string): Promise<T> {
    const b = await this.download(fileId);
    return JSON.parse(await b.text()) as T;
  }

  // ---------- Tree ----------

  async ready(): Promise<void> {
    if (this.tree) return;
    const cached = readJson<Tree>(localStorage.getItem(this.treeKey));
    if (cached) {
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
    return { track, audio: blob, audioMime: audio.mimeType || blob.type };
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
    const track = await this.downloadJson<TrackPackageV2>(json.id);
    const blob = await this.download(audio.id);
    return { track, audio: blob, audioMime: audio.mimeType || blob.type };
  }

  // ---------- Performances ----------

  async listPerformances(): Promise<PerformanceSummary[]> {
    await this.ready();
    const files = await this.list(`appProperties has { key='${APP_PROPS.type}' and value='performance' } and trashed=false`);
    return files
      .map((f) => {
        const p = f.appProperties ?? {};
        return {
          performanceId: p[APP_PROPS.id] ?? f.id,
          trackId: p[APP_PROPS.trackId] ?? '',
          trackTitle: p.svTitle ?? f.name,
          state: (p[APP_PROPS.state] === 'kept' ? 'kept' : 'temp') as 'temp' | 'kept',
          mode: (p.svMode === 'live' ? 'live' : 'offline') as 'offline' | 'live',
          durationMs: Number(p.svDurationMs ?? 0),
          createdAt: p.svCreatedAt ?? f.modifiedTime ?? '',
          expiresAt: p.svExpiresAt || null,
          ref: f.parents?.[0] ?? f.id,
          link: f.parents?.[0] ? `https://drive.google.com/drive/folders/${f.parents[0]}` : f.webViewLink,
          hasVideo: p.svVideo === '1',
        } satisfies PerformanceSummary;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async perfFiles(performanceId: string): Promise<DriveFile[]> {
    return this.list(`appProperties has { key='svPerfId' and value='${esc(performanceId)}' } and trashed=false`);
  }

  async getPerformance(performanceId: string): Promise<LoadedPerformance | null> {
    await this.ready();
    const files = await this.perfFiles(performanceId);
    const json = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'performance');
    const vocal = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'performanceAudio');
    const video = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'performanceVideo');
    if (!json || !vocal) return null;
    const [manifest, vocalBlob, videoBlob] = await Promise.all([
      this.downloadJson<PerformanceManifest>(json.id),
      this.download(vocal.id),
      video ? this.download(video.id) : Promise.resolve(null),
    ]);
    return { manifest, vocal: vocalBlob, video: videoBlob };
  }

  async savePerformance(manifest: PerformanceManifest, files: { vocal: Blob; video: Blob | null }, onProgress?: Progress): Promise<PerformanceSummary> {
    await this.ready();
    const parentKey: DriveFolderKey = manifest.state === 'temp' ? 'temp' : manifest.mode === 'live' ? 'performancesLive' : 'performancesOffline';
    const name = performanceFolderName(manifest);
    onProgress?.({ label: 'Creating performance folder', fraction: 0.03 });
    const folder = await this.createFolder(name, this.folder(parentKey), {
      [APP_PROPS.type]: 'performanceFolder',
      svPerfId: manifest.performanceId,
      [APP_PROPS.trackId]: manifest.trackId,
    });
    const common = { svPerfId: manifest.performanceId, [APP_PROPS.trackId]: manifest.trackId, [APP_PROPS.meetId]: manifest.meetId ?? '' };
    const vocalFile = await this.upload('vocal.wav', files.vocal, folder.id, { ...common, [APP_PROPS.type]: 'performanceAudio' }, (f) =>
      onProgress?.({ label: 'Uploading vocal', fraction: 0.05 + f * (files.video ? 0.45 : 0.85) }),
    );
    let videoFile: DriveFile | null = null;
    if (files.video) {
      const ext = extFromMime(files.video.type, 'webm');
      videoFile = await this.upload(`video.${ext}`, files.video, folder.id, { ...common, [APP_PROPS.type]: 'performanceVideo' }, (f) =>
        onProgress?.({ label: 'Uploading video', fraction: 0.5 + f * 0.4 }),
      );
    }
    const stamped: PerformanceManifest = {
      ...manifest,
      files: manifest.files.map((fe) =>
        fe.name === 'vocal.wav'
          ? { ...fe, driveId: vocalFile.id, md5: vocalFile.md5Checksum }
          : videoFile && fe.name.startsWith('video.')
            ? { ...fe, driveId: videoFile.id, md5: videoFile.md5Checksum }
            : fe,
      ),
    };
    onProgress?.({ label: 'Writing manifest', fraction: 0.95 });
    await this.upload('manifest.json', new Blob([JSON.stringify(stamped, null, 1)], { type: 'application/json' }), folder.id, {
      ...common,
      [APP_PROPS.type]: 'performance',
      [APP_PROPS.id]: manifest.performanceId,
      [APP_PROPS.state]: manifest.state,
      svMode: manifest.mode,
      svTitle: manifest.trackTitle.slice(0, 60),
      svDurationMs: String(manifest.durationMs),
      svCreatedAt: manifest.createdAt,
      svExpiresAt: manifest.expiresAt ?? '',
      svVideo: files.video ? '1' : '0',
    });
    onProgress?.({ label: 'Saved to Drive', fraction: 1 });
    return {
      performanceId: manifest.performanceId,
      trackId: manifest.trackId,
      trackTitle: manifest.trackTitle,
      state: manifest.state,
      mode: manifest.mode,
      durationMs: manifest.durationMs,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
      ref: folder.id,
      link: `https://drive.google.com/drive/folders/${folder.id}`,
      hasVideo: Boolean(files.video),
    };
  }

  async keepPerformance(performanceId: string): Promise<void> {
    await this.ready();
    const files = await this.perfFiles(performanceId);
    const json = files.find((f) => f.appProperties?.[APP_PROPS.type] === 'performance');
    const folderId = files.find((f) => f.mimeType === FOLDER_MIME)?.id ?? json?.parents?.[0];
    if (!json || !folderId) throw new Error('Performance not found');
    const manifest = await this.downloadJson<PerformanceManifest>(json.id);
    const dest = this.folder(manifest.mode === 'live' ? 'performancesLive' : 'performancesOffline');
    await this.req(`${API}/files/${folderId}?addParents=${dest}&removeParents=${this.folder('temp')}&fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const kept: PerformanceManifest = { ...manifest, state: 'kept', expiresAt: null };
    await this.req(`${API}/files/${json.id}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appProperties: { ...(json.appProperties ?? {}), [APP_PROPS.state]: 'kept', svExpiresAt: '' } }),
    });
    await this.replaceContent(json.id, new Blob([JSON.stringify(kept, null, 1)], { type: 'application/json' }));
  }

  async deletePerformance(performanceId: string): Promise<void> {
    await this.ready();
    const files = await this.perfFiles(performanceId);
    const folderId = files.find((f) => f.mimeType === FOLDER_MIME)?.id ?? files[0]?.parents?.[0];
    if (folderId) await this.req(`${API}/files/${folderId}`, { method: 'DELETE' });
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
