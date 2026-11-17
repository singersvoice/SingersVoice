/**
 * YouTube song tracks, the browser's side: a result's title made a library title, the finished job made
 * a track package (its video where the lyrics would be), and the whole import — the folder made under
 * Tracks/YT, the relay's job followed through the service, the track.json written beside the relay's
 * files — against the fake Drive and a fake service; a failed job leaves nothing in the Drive. And the
 * stage's way to the video: the owner's token, else the service.
 */
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
const { importYoutubeTrack, ytTrackPackage, ytTrackTitle } = await import('../src/lib/ytTracks.ts');
const { forgetTrackVideos, trackVideoUrl } = await import('../src/lib/trackVideo.ts');
const { youtubeVideoId } = await import('@singersvoice/protocol');

let drive: FakeDrive;
/** The service's answers by `METHOD /path`; every call recorded. */
let service: Record<string, (body: unknown) => { status?: number; json: unknown }>;
let serviceCalls: { method: string; path: string; body: unknown; auth: string }[];

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
      const path = url.pathname + url.search;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      serviceCalls.push({ method, path, body, auth: String((init?.headers as Record<string, string>)?.Authorization ?? '') });
      const a = service[`${method} ${url.pathname}`];
      if (!a) return new Response(JSON.stringify({ error: `no fake for ${method} ${path}`, code: 'nope' }), { status: 404 });
      const r = a(body);
      return r.json instanceof Blob ? new Response(r.json, { status: r.status ?? 200 }) : new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return drive.fetch(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  forgetTrackVideos();
  session.profile.value = null;
  session.token.value = null;
  session.mode.value = null;
});

const result = { videoFileId: 'vid1', videoMime: 'video/mp4', audioFileId: 'aud1', audioMime: 'audio/mp4', durationMs: 213_400, width: 1280, height: 720, title: 'Never Gonna Give You Up (Karaoke Version)', channel: 'Sing King', bytes: 123, youtubeId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
const item = { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up (Karaoke Version) [Official HD]', channel: 'Sing King', durationMs: 213_400, thumbnail: '', views: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };

describe('YouTube song tracks', () => {
  it('titles and ids: the clutter YouTube titles carry is dropped; a link or an id is a video id', () => {
    expect(ytTrackTitle({ title: 'Amma — Karaoke (Official Video) [HD]' })).toBe('Amma — Karaoke');
    expect(ytTrackTitle({ title: 'Never Gonna Give You Up (Karaoke Version)' })).toBe('Never Gonna Give You Up (Karaoke Version)');
    expect(ytTrackTitle({ title: 'Song (with lyrics) (1080p)' })).toBe('Song');
    expect(youtubeVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=3')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('amma karaoke')).toBeNull();
    const pkg = ytTrackPackage('trk-1', 'Never Gonna Give You Up', result);
    expect(pkg).toMatchObject({ trackId: 'trk-1', title: 'Never Gonna Give You Up', artist: 'Sing King', durationMs: 213_400, origin: 'youtube', singerCount: 1, lyrics: [] });
    expect(pkg.layers).toEqual([{ id: 'L1', kind: 'backing', file: 'backing.m4a', mimeType: 'audio/mp4', gain: 1, enabledByDefault: true }]);
    expect(pkg.video).toEqual({ fileId: 'vid1', mimeType: 'video/mp4', width: 1280, height: 720, youtubeId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', channel: 'Sing King' });
  });

  it('the import: the folder under Tracks/YT first, the job through the service (its words on the bar), the relay\'s files found, the track.json written — a track with a video', async () => {
    let polls = 0;
    service['POST /yt/fetch'] = (body) => {
      const b = body as { videoId: string; trackId: string; folderId: string; name: string };
      expect(b.videoId).toBe('dQw4w9WgXcQ');
      expect(b.name).toBe('Never Gonna Give You Up (Karaoke Version)');
      const folder = drive.files.get(b.folderId)!;
      expect(folder.appProperties).toEqual({ svType: 'trackFolder', svTrackId: b.trackId });
      expect(drive.files.get(folder.parents[0]!)!.name).toBe('YT');
      // The relay, by the time the job is done: both files in the folder, stamped.
      drive.addFile(`${b.name}.mp4`, b.folderId, 'video/mp4', { svType: 'trackVideo', svId: b.trackId, svTrackId: b.trackId, svYoutubeId: 'dQw4w9WgXcQ' }, new Uint8Array([9]));
      drive.addFile('backing.m4a', b.folderId, 'audio/mp4', { svType: 'trackAudio', svId: b.trackId, svTrackId: b.trackId, svYoutubeId: 'dQw4w9WgXcQ' }, new Uint8Array([1, 2]));
      return { status: 202, json: { job: { jobId: 'yt-1', state: 'queued', fraction: 0, note: 'starting', videoId: b.videoId, trackId: b.trackId, startedAt: 'now' } } };
    };
    service['GET /yt/jobs/yt-1'] = () => {
      polls += 1;
      const states = [
        { state: 'downloading', fraction: 0.3, note: 'downloading · 56 %' },
        { state: 'uploading', fraction: 0.8, note: 'uploading the video · 12 MB of 40 MB' },
        { state: 'done', fraction: 1, note: 'done', result },
      ];
      return { json: { job: { jobId: 'yt-1', videoId: 'dQw4w9WgXcQ', trackId: 't', startedAt: 'now', ...states[Math.min(polls, states.length) - 1]! } } };
    };
    // The master track database: the song registered as the video it is, with what its title says, my shared folder as its place.
    let registered: Record<string, unknown> | null = null;
    service['POST /tracks/register'] = (body) => {
      registered = body as Record<string, unknown>;
      return { status: 201, json: { track: { trackId: 'ABCDEFGH2611', song: 'Never Gonna Give You Up' }, created: true } };
    };
    const seen: string[] = [];
    const saved = await importYoutubeTrack(item, (p) => seen.push(`${p.label}@${p.fraction.toFixed(2)}`), { pollMs: 1 });
    expect(saved.title).toBe('Never Gonna Give You Up (Karaoke Version)');
    expect(saved.video).toBe(true);
    expect(saved.registryId).toBe('ABCDEFGH2611');
    expect(seen).toContain('downloading · 56 %@0.30');
    expect(seen.some((s) => s.startsWith('uploading the video'))).toBe(true);
    expect(seen.at(-1)).toBe('Ready to sing@1.00');
    expect(serviceCalls.map((c) => c.method + ' ' + c.path)).toEqual(['POST /yt/fetch', 'GET /yt/jobs/yt-1', 'GET /yt/jobs/yt-1', 'GET /yt/jobs/yt-1', 'POST /tracks/register']);
    expect(serviceCalls[0]!.auth).toBe('Bearer tok'); // the singer's own token: the files go into their Drive
    expect(registered).toMatchObject({ source: 'youtube', song: 'Never Gonna Give You Up', artists: 'Sing King', youtubeId: 'dQw4w9WgXcQ', durationMs: 213_400, copyTrackId: saved.trackId });
    expect((registered as unknown as { refs: { videoId: string; audioId: string; jsonId: string; folderId: string } }).refs).toMatchObject({ videoId: expect.any(String), audioId: expect.any(String), jsonId: expect.any(String), folderId: expect.any(String) });
    expect(String((registered as unknown as { driveUrl: string }).driveUrl)).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\//);
    const p = session.driveProvider()!;
    const list = await p.listTracks();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ trackId: saved.trackId, artist: 'Sing King', durationMs: 213_400, video: true, registryId: 'ABCDEFGH2611', shared: true });
    const loaded = await p.getTrack(saved.trackId);
    expect(loaded!.track.video!.fileId).toBe('vid1');
    expect(loaded!.track.registryId).toBe('ABCDEFGH2611'); // the id in the track.json: known on every device from now on
    const folderOfJson = [...drive.files.values()].find((f) => f.name === 'track.json')!.parents[0]!;
    expect(drive.files.get(folderOfJson)!.permissions.some((x) => x.type === 'anyone')).toBe(true); // the folder shared: the shareable URL
    expect(loaded!.track.notes).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(new Uint8Array(await loaded!.audio.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    const json = [...drive.files.values()].find((f) => f.name === 'track.json')!;
    expect(drive.files.get(json.parents[0]!)!.name).toBe('Never Gonna Give You Up (Karaoke Version)');
  });

  it('a failed job leaves no folder behind, and says why in the relay\'s words', async () => {
    service['POST /yt/fetch'] = (body) => ({ status: 202, json: { job: { jobId: 'yt-2', state: 'queued', fraction: 0, note: 'starting', videoId: 'dQw4w9WgXcQ', trackId: (body as { trackId: string }).trackId, startedAt: 'now' } } });
    service['GET /yt/jobs/yt-2'] = () => ({ json: { job: { jobId: 'yt-2', state: 'error', fraction: 0.1, note: 'failed', error: 'This video is private on YouTube.', videoId: 'dQw4w9WgXcQ', trackId: 't', startedAt: 'now' } } });
    await expect(importYoutubeTrack(item, undefined, { pollMs: 1 })).rejects.toThrow('This video is private on YouTube.');
    const tree = ['Backgrounds', 'Config', 'Exports', 'Performances', 'SingersVoice', 'Temp', 'Tracks', 'YT'];
    const folders = [...drive.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.folder' && !f.trashed && !tree.includes(f.name)).map((f) => f.name);
    expect(folders).toEqual([]); // the track's folder is gone again
    expect(await session.driveProvider()!.listTracks()).toEqual([]);
  });

  it('the video for the stage: my own file through my token; another singer\'s through the service (the copy names its catalog entry); fetched once', async () => {
    let made = 0;
    (globalThis as { URL: { createObjectURL?: unknown; revokeObjectURL?: unknown } }).URL.createObjectURL = () => `blob:v${++made}`;
    (globalThis as { URL: { revokeObjectURL?: unknown } }).URL.revokeObjectURL = () => undefined;
    const own = drive.addFile('x.mp4', 'nowhere', 'video/mp4', {}, new Uint8Array([5, 5]));
    const mine = { trackId: 'trk-own', video: { fileId: own.id, mimeType: 'video/mp4', width: 1, height: 1, youtubeId: 'dQw4w9WgXcQ', sourceUrl: '', channel: '' } };
    expect(await trackVideoUrl(mine)).toBe('blob:v1');
    expect(await trackVideoUrl(mine)).toBe('blob:v1'); // cached
    expect(serviceCalls).toEqual([]);
    // Somebody else's file (not in my Drive): the service fetches it from the owner's Drive, by the catalog entry the copy came from.
    service['GET /catalog/tracks/trk-9/file/video'] = () => ({ json: new Blob([new Uint8Array([7])], { type: 'video/mp4' }) });
    const theirs = { trackId: 'trk-9-copy-ab12', video: { fileId: 'not-mine-00000000', mimeType: 'video/mp4', width: 1, height: 1, youtubeId: 'dQw4w9WgXcQ', sourceUrl: '', channel: '' } };
    expect(await trackVideoUrl(theirs)).toBe('blob:v2');
    expect(serviceCalls.map((c) => c.path)).toEqual(['/catalog/tracks/trk-9/file/video']);
    // A meet names the catalog entry itself.
    service['GET /catalog/tracks/trk-cat/file/video'] = () => ({ json: new Blob([new Uint8Array([8])], { type: 'video/mp4' }) });
    expect(await trackVideoUrl({ trackId: 'whatever', video: { ...theirs.video, fileId: 'not-mine-11111111' } }, 'trk-cat')).toBe('blob:v3');
    // Nothing to fetch: no video on the track; a video nobody can hand over: a plain message, the song still plays.
    expect(trackVideoUrl({ trackId: 'trk-plain' })).toBeNull();
    await expect(trackVideoUrl({ trackId: 'trk-none', video: { ...theirs.video, fileId: 'gone-000000000000' } }, 'trk-gone')).rejects.toThrow(/could not be fetched/);
  });
});
