/**
 * YouTube song tracks, from the browser's side: a search through the service (which asks the relay),
 * and the fetch of a chosen video into the singer's own Drive as a track — the folder made here
 * (`SingersVoice/Tracks/YT/<title>`), the relay filling it with the video and its sound through the
 * singer's own Drive sign-in, the track.json written here when the job is done. From then on it is a
 * track like any other: it lists, sings, is picked for a meet, is published to the catalog; on stage
 * the video (the words are in the picture) stands where the lyrics would be.
 */
import { createTrack, parseSongTitle, youtubeSearchQuery, type TrackPackageV2, type YtJob, type YtSearchItem, type YtStatus } from '@singersvoice/protocol';
import { api, ApiError, controlConfigured } from './api.ts';
import type { Progress, TrackSummary } from './storage/types.ts';
import { driveProvider } from '../state/session.ts';

const POLL_MS = 2000;
/** The job's fraction fills this much of the bar; writing the track.json is the rest. */
const JOB_SHARE = 0.92;

export async function ytStatus(): Promise<YtStatus> {
  if (!controlConfigured.value) return { available: false, ytdlp: null, note: 'The SingersVoice service is not configured for this build' };
  // The relay's machine stops when idle and starts on the first call: an answer that it did not answer in time is asked once more.
  for (let attempt = 0; ; attempt++) {
    try {
      const s = await api.get('GET /yt', '/yt');
      if (s.available || attempt > 0 || !/did not answer|unreachable/i.test(s.note)) return s;
    } catch (e) {
      if (attempt > 0) return { available: false, ytdlp: null, note: e instanceof ApiError ? e.message : String(e) };
    }
    await sleep(4000);
  }
}

/** Search YouTube for the singer's words — always as a karaoke track (`youtubeSearchQuery`). */
export async function searchYoutube(q: string): Promise<YtSearchItem[]> {
  const query = youtubeSearchQuery(q);
  if (!query) return [];
  const r = await api.get('GET /yt/search', `/yt/search?q=${encodeURIComponent(query)}`);
  return r.items;
}

/** "Song — Artist (Karaoke Version) [Official]" → a title for the library; the channel becomes the artist. */
export function ytTrackTitle(item: Pick<YtSearchItem, 'title'>): string {
  return item.title
    .replace(/\s*[([{][^)\]}]*\b(official|hd|hq|4k|1080p|720p|lyrics?|video|audio|with lyrics)\b[^)\]}]*[)\]}]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/** The track package a finished job becomes (lyrics none — they are in the picture); what the video's title says of the song is kept with it. */
export function ytTrackPackage(trackId: string, title: string, job: NonNullable<YtJob['result']>): TrackPackageV2 {
  const meta = parseSongTitle(job.title || title, job.channel);
  return createTrack({
    trackId,
    title: title || job.title,
    artist: meta.artists || job.channel,
    movie: meta.movie,
    year: meta.year,
    language: meta.language,
    durationMs: job.durationMs,
    layers: [{ id: 'L1', kind: 'backing', file: 'backing.m4a', mimeType: job.audioMime || 'audio/mp4', gain: 1, enabledByDefault: true }],
    lyrics: [],
    singerCount: 1,
    notes: `A YouTube song track: ${job.sourceUrl}${job.channel ? ` (${job.channel})` : ''}. The words are in the video.`,
    origin: 'youtube',
    video: { fileId: job.videoFileId, mimeType: job.videoMime || 'video/mp4', width: job.width, height: job.height, youtubeId: job.youtubeId, sourceUrl: job.sourceUrl, channel: job.channel },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a YouTube video into my Drive as a song track. Needs Google Drive (the files are the singer's own).
 * Progress: the relay's own words while it downloads, converts and uploads; then the track is written.
 */
export async function importYoutubeTrack(item: YtSearchItem, onProgress?: Progress, opts: { pollMs?: number } = {}): Promise<TrackSummary> {
  const d = driveProvider();
  if (!d) throw new Error('YouTube song tracks go into your Google Drive — sign in with Google first');
  const title = ytTrackTitle(item) || item.id;
  const track = createTrack({ title, origin: 'youtube' });
  onProgress?.({ label: 'Making the track folder in your Drive', fraction: 0.02 });
  const { folderId } = await d.createYtTrackFolder(title, track.trackId);
  let job: YtJob;
  try {
    job = (await api.post('POST /yt/fetch', '/yt/fetch', { videoId: item.id, trackId: track.trackId, folderId, name: title })).job;
    onProgress?.({ label: job.note || 'starting', fraction: 0.03 });
    while (job.state !== 'done' && job.state !== 'error') {
      await sleep(opts.pollMs ?? POLL_MS);
      job = (await api.get('GET /yt/jobs/:id', `/yt/jobs/${encodeURIComponent(job.jobId)}`)).job;
      onProgress?.({ label: job.note || job.state, fraction: 0.03 + Math.min(1, job.fraction) * (JOB_SHARE - 0.03) });
    }
    if (job.state === 'error' || !job.result) throw new Error(job.error || 'The download failed');
  } catch (e) {
    await d.removeYtTrackFolder(folderId); // nothing half-made stays in the Drive
    throw e;
  }
  const pkg = ytTrackPackage(track.trackId, title, job.result);
  onProgress?.({ label: 'Writing the track', fraction: JOB_SHARE });
  // Drive lists a just-uploaded file a moment later at times: the track.json waits for its sound to be listed.
  let last: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      let summary = await d.saveTrack(pkg, null, (p) => onProgress?.({ label: p.label, fraction: JOB_SHARE + p.fraction * (1 - JOB_SHARE) }));
      // The song in the SingersVoice track database — the video it is, what its title says, my shared folder as a place to
      // fetch it from — and its id in the track.json. A failure here leaves a track that registers on its first Sing.
      summary = (await registerYoutubeTrack(pkg, item, summary).catch(() => null)) ?? summary;
      onProgress?.({ label: 'Ready to sing', fraction: 1 });
      return summary;
    } catch (e) {
      last = e;
      if (!(e instanceof Error && /no audio yet/i.test(e.message))) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error('The track could not be written');
}

async function registerYoutubeTrack(pkg: TrackPackageV2, item: YtSearchItem, summary: TrackSummary): Promise<TrackSummary | null> {
  const d = driveProvider();
  if (!d || !controlConfigured.value) return null;
  const meta = parseSongTitle(item.title, item.channel);
  const driveUrl = await d.shareTrack(pkg.trackId, { type: 'anyone' });
  const refs = await d.publicTrackRefs(pkg.trackId);
  const r = await api.post('POST /tracks/register', '/tracks/register', {
    source: 'youtube',
    song: meta.song || pkg.title,
    artists: meta.artists || pkg.artist,
    movie: meta.movie,
    year: meta.year,
    language: meta.language,
    driveUrl,
    refs: { folderId: refs.folderId, jsonId: refs.trackJsonId, audioId: refs.audioId, audioMime: refs.audioMime, ...(refs.videoId ? { videoId: refs.videoId, videoMime: refs.videoMime ?? 'video/mp4' } : {}) },
    durationMs: pkg.durationMs,
    singerCount: 1,
    youtubeId: item.id,
    thumbnail: item.thumbnail,
    copyTrackId: pkg.trackId,
  });
  await d.saveTrack({ ...pkg, registryId: r.track.trackId }, null);
  return { ...summary, registryId: r.track.trackId, shared: true };
}
