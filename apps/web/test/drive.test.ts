/** DriveProvider against an in-memory fake of the Drive v3 endpoints it uses (helpers/fakeDrive.ts). */
import { createTrack } from '@singersvoice/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveProvider } from '../src/lib/storage/drive.ts';
import { FakeDrive, type FakeFile } from './helpers/fakeDrive.ts';


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
  it("a refusal in a token's first minute is asked again (the permission just given reaching Drive); the folders are tried three times; an old token's refusal counts", async () => {
    vi.useFakeTimers();
    try {
      // Drive says no to the first calls — the way it can right after the consent screen — then behaves.
      const realFetch = drive.fetch.bind(drive);
      let refuse = 0;
      (globalThis as { fetch: typeof fetch }).fetch = (i, init) => (refuse-- > 0 ? Promise.resolve(Response.json({ error: { message: 'The caller does not have permission' } }, { status: 403 })) : realFetch(i, init));
      refuse = 5;
      const fresh = new DriveProvider(() => ({ accessToken: 'tok', expiresAt: Date.now() + 3600_000, scope: '', issuedAt: Date.now() }), 'sub-fresh');
      const ready = fresh.ready();
      await vi.runAllTimersAsync();
      await ready; // five refusals absorbed: the call's own retries, then the folder build's
      expect([...drive.files.values()].some((f) => f.name === 'SingersVoice')).toBe(true);
      expect(refuse).toBeLessThanOrEqual(0);
      // A token from long ago gets no such benefit of the doubt: the folder build still tries three times, then the refusal stands.
      refuse = 3;
      const stale = new DriveProvider(() => ({ accessToken: 'tok2', expiresAt: Date.now() + 3600_000, scope: '' }), 'sub-stale');
      const failing = stale.ready();
      const outcome = failing.then(
        () => 'ok',
        (e: Error) => e.message,
      );
      await vi.runAllTimersAsync();
      expect(await outcome).toMatch(/Drive error 403: The caller does not have permission/);
      // …and the next attempt (the set-up screen's Retry) goes through.
      await stale.ready();
      expect(stale.links().root).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

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
    const json = await p.download(refs.trackJsonId); // one's own file: the token reads it
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
    for (const name of ['SingersVoice', 'Tracks', 'YT', 'Performances', 'Temp']) expect(folders(name)).toHaveLength(1);
    expect(folders('Live')).toHaveLength(0); // one level: performances are files straight under Performances
    expect(drive.calls.filter((c) => c.startsWith('POST /drive/v3/files')).length).toBe(8); // root + 7 folders (Tracks/YT among them), no repeats
    expect(folders('YT')[0]!.parents).toEqual([folders('Tracks')[0]!.id]);
  });

  it('a YouTube song track: its folder under Tracks/YT, the relay\'s two files found by their properties, the track.json written beside them; listed as a video track, published with its video, deleted whole', async () => {
    const p = new DriveProvider(() => token, 'sub1');
    const { folderId, link } = await p.createYtTrackFolder('Never Gonna Give You Up (Karaoke)', 'trk-yt-1');
    const yt = folders('YT')[0]!;
    expect(drive.files.get(folderId)!.parents).toEqual([yt.id]);
    expect(drive.files.get(folderId)!.appProperties).toEqual({ svType: 'trackFolder', svTrackId: 'trk-yt-1' });
    expect(link).toContain(folderId);
    // The relay's uploads, as it stamps them.
    const video = drive.addFile('Never Gonna Give You Up (Karaoke).mp4', folderId, 'video/mp4', { svType: 'trackVideo', svId: 'trk-yt-1', svTrackId: 'trk-yt-1', svYoutubeId: 'dQw4w9WgXcQ' }, new Uint8Array([9, 9, 9]));
    const audio = drive.addFile('backing.m4a', folderId, 'audio/mp4', { svType: 'trackAudio', svId: 'trk-yt-1', svTrackId: 'trk-yt-1', svYoutubeId: 'dQw4w9WgXcQ' }, new Uint8Array([1, 2]));
    const pkg = createTrack({ trackId: 'trk-yt-1', title: 'Never Gonna Give You Up (Karaoke)', artist: 'Sing King', durationMs: 213_400, layers: [{ id: 'L1', kind: 'backing', file: 'backing.m4a', mimeType: 'audio/mp4', gain: 1, enabledByDefault: true }], origin: 'youtube', video: { fileId: video.id, mimeType: 'video/mp4', width: 1280, height: 720, youtubeId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', channel: 'Sing King' } });
    const saved = await p.saveTrack(pkg, null); // no audio handed over: the relay's file is the backing track
    expect(saved.ref).toBe(folderId);
    expect(saved.video).toBe(true);
    const json = [...drive.files.values()].find((f) => f.name === 'track.json' && f.parents[0] === folderId)!;
    expect(json.appProperties.svVideo).toBe('1');
    expect([...drive.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.folder' && f.name.startsWith('Never Gonna'))).toHaveLength(1); // no second folder
    const listed = await p.listTracks();
    expect(listed.find((t) => t.trackId === 'trk-yt-1')).toMatchObject({ title: 'Never Gonna Give You Up (Karaoke)', artist: 'Sing King', video: true, ref: folderId });
    const loaded = await p.getTrack('trk-yt-1');
    expect(loaded!.track.video!.fileId).toBe(video.id);
    expect(loaded!.track.origin).toBe('youtube');
    expect(new Uint8Array(await loaded!.audio.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    expect(loaded!.audioMime).toBe('audio/mp4');
    const refs = await p.publicTrackRefs('trk-yt-1');
    expect(refs).toMatchObject({ folderId, trackJsonId: json.id, audioId: audio.id, audioMime: 'audio/mp4', videoId: video.id, videoMime: 'video/mp4' });
    expect(new Uint8Array(await (await p.download(video.id)).arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
    // A fetch that failed: the folder goes; a finished track deletes with its folder, video and all.
    const { folderId: failed } = await p.createYtTrackFolder('Gone', 'trk-yt-2');
    await p.removeYtTrackFolder(failed);
    expect(drive.files.get(failed)?.trashed ?? true).toBe(true);
    await p.deleteTrack('trk-yt-1');
    expect(await p.getTrack('trk-yt-1')).toBeNull();
    expect((await p.listTracks()).some((t) => t.trackId === 'trk-yt-1')).toBe(false);
  });

  it('a tree remembered by an older build (no Tracks/YT yet) is walked again and completed', async () => {
    const p = new DriveProvider(() => token, 'sub1');
    await p.ready();
    const remembered = JSON.parse(store.get('sv.drive.tree.sub1')!) as Record<string, string>;
    expect(remembered.yt).toBe(folders('YT')[0]!.id);
    delete remembered.yt;
    store.set('sv.drive.tree.sub1', JSON.stringify(remembered));
    const q = new DriveProvider(() => token, 'sub1');
    await q.ready();
    expect((JSON.parse(store.get('sv.drive.tree.sub1')!) as Record<string, string>).yt).toBe(folders('YT')[0]!.id);
    expect(folders('YT')).toHaveLength(1); // found, not made again
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

  const filmManifest = { ...(manifest as object), performanceId: 'perf-film01', trackId: '', trackTitle: 'Full meet', durationMs: 0, files: [{ name: 'video.mp4', mimeType: 'video/mp4', size: 0, sha256: '' }] } as never;
  const kib = (n: number, fill: number) => new Blob([new Uint8Array(n * 1024).fill(fill)], { type: 'video/mp4' });
  const bytesOf = (f: FakeFile) => f.bytes!;

  it('the film of a meet streams into Drive as it is recorded: 256 KiB pieces as they fill, the rest with the total, listed when done', async () => {
    const p = new DriveProvider(() => token, 'sub1');
    const film = await p.beginPerformanceStream(filmManifest, 'video/mp4');
    expect(drive.sessions.size).toBe(1);
    expect(drive.calls.at(-1)).toContain('uploadType=resumable');
    // Three 1.5 MiB pieces: nothing goes out under 4 MiB; the fourth tips it over → one aligned piece (5.75 MiB of 6) goes out.
    for (let i = 0; i < 4; i++) film.push(kib(1536, i + 1), { durationMs: (i + 1) * 10_000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(film.bytes).toBe(4 * 1536 * 1024);
    expect(film.stored).toBe(Math.floor((4 * 1536 * 1024) / (256 * 1024)) * 256 * 1024);
    const remembered = JSON.parse(store.get('sv.drive.tree.sub1.films')!) as { stored: number; durationMs: number; manifest: { performanceId: string } }[];
    expect(remembered).toHaveLength(1);
    expect(remembered[0]).toMatchObject({ stored: film.stored, durationMs: 40_000 });
    expect(remembered[0]!.manifest.performanceId).toBe('perf-film01');
    // The end: a last short piece, then finish with the total — Drive answers with the file.
    film.push(kib(100, 9), { durationMs: 41_000 });
    const saved = await film.finish({ durationMs: 41_500 });
    expect(drive.sessions.size).toBe(0);
    const file = drive.files.get(saved.ref)!;
    expect(bytesOf(file).length).toBe(4 * 1536 * 1024 + 100 * 1024);
    expect(bytesOf(file)[0]).toBe(1);
    expect(bytesOf(file)[4 * 1536 * 1024]).toBe(9); // the pieces in order
    expect(file.name).toMatch(/^Full meet · Friday Meet \[mwe8q644-onrv6m\] · \d{4}-\d{2}-\d{2} \d{4}\.mp4$/);
    expect(file.parents).toEqual([folders('Performances')[0]!.id]);
    expect(file.appProperties).toMatchObject({ svType: 'performance', svPerfId: 'perf-film01', svMedia: 'video', svDurationMs: '41500', svTitle: 'Full meet' });
    expect(JSON.parse(file.description!).files).toEqual([expect.objectContaining({ name: 'video.mp4', size: bytesOf(file).length, driveId: file.id })]);
    expect(saved).toMatchObject({ performanceId: 'perf-film01', trackTitle: 'Full meet', durationMs: 41_500, hasVideo: true });
    expect(store.get('sv.drive.tree.sub1.films')).toBe('[]'); // forgotten once complete
    expect((await p.listPerformances()).map((x) => x.performanceId)).toEqual(['perf-film01']);
  });

  it('a hiccup on the way: the piece is sent again from where Drive is; a dying tab leaves a film the next start completes', async () => {
    const p = new DriveProvider(() => token, 'sub1');
    const film = await p.beginPerformanceStream(filmManifest, 'video/mp4');
    drive.failPuts = 2; // the first piece meets an outage twice (and the resync in between is refused too)
    film.push(kib(4096, 3), { durationMs: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(film.error).toContain('retrying');
    await new Promise((r) => setTimeout(r, 3500)); // 1 s + 2 s back-off
    expect(film.error).toBeNull();
    expect(film.stored).toBe(4096 * 1024);
    expect([...drive.sessions.values()][0]!.size).toBe(4096 * 1024);
    // The tab dies here: no finish. The next start of the app finds the session in localStorage and completes the film as it stands.
    const q = new DriveProvider(() => token, 'sub1');
    await q.ready();
    expect(await q.finishDanglingFilms()).toBe(0); // ready() did it already in the background: once per start
    await new Promise((r) => setTimeout(r, 20));
    expect(drive.sessions.size).toBe(0);
    const listed = await q.listPerformances();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ performanceId: 'perf-film01', durationMs: 10_000, hasVideo: true });
    expect(bytesOf(drive.files.get(listed[0]!.ref)!).length).toBe(4096 * 1024);
    expect(store.get('sv.drive.tree.sub1.films')).toBe('[]');
  }, 10_000);

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
