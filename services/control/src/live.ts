/**
 * Live publishing from the browser: the publisher's show view PUTs two-second MPEG-TS segments to
 * the service, which keeps a rolling window for the in-house portal (HLS, playable anywhere) and
 * forwards each segment — then a fresh media playlist — to YouTube's HLS ingestion endpoint
 * (https://developers.google.com/youtube/v3/live/guides/hls-ingestion): PUT over HTTPS, segments
 * of 1–5 s, PAT/PMT first, a playlist after every segment, at most five segments outstanding.
 */
import { LIVE_KEEP, YOUTUBE_HLS_INGEST, type LiveSegmentInfo } from '@singersvoice/protocol';

/** The HLS media playlist for a run of segments; `uri` turns a segment name into what the player fetches. */
export function hlsPlaylist(segments: LiveSegmentInfo[], uri: (name: string) => string, opts: { ended?: boolean } = {}): string {
  const target = Math.max(1, Math.ceil(Math.max(0, ...segments.map((s) => s.durationMs)) / 1000));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${segments[0]?.seq ?? 0}`];
  for (const s of segments) {
    lines.push(`#EXTINF:${(s.durationMs / 1000).toFixed(3)},`);
    lines.push(uri(s.name));
  }
  if (opts.ended) lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

/** YouTube's ingest URL for one file: the key in `cid`, the file name appended to `file=`. */
export function youtubeIngestUrl(base: string, streamKey: string, file: string): string {
  return `${base}?cid=${encodeURIComponent(streamKey)}&copy=0&file=${file}`;
}

export const SEGMENT_NAME = /^[A-Za-z0-9_-]{1,80}\.ts$/;

export interface YoutubeOutcome {
  /** HTTP status of the segment PUT (or 0 when YouTube could not be reached). */
  status: number;
  /** HTTP status of the playlist PUT that followed (0 when skipped). */
  playlistStatus: number;
  note: string;
}

/**
 * Send one segment and the playlist that references it. Per the protocol, 200 and 202 are success
 * (202: the segment arrived before its playlist — the playlist follows at once), 401 means the key
 * is wrong or expired, 400 a malformed segment or playlist, 5xx "try again".
 */
export async function sendToYoutube(
  base: string,
  streamKey: string,
  segment: { name: string; bytes: Uint8Array },
  playlist: string,
  fetchImpl: typeof fetch = fetch,
): Promise<YoutubeOutcome> {
  const headers = { 'User-Agent': 'SingersVoice / web / 2.1' };
  let status = 0;
  try {
    const r = await fetchImpl(youtubeIngestUrl(base, streamKey, segment.name), { method: 'PUT', headers: { ...headers, 'Content-Type': 'video/MP2T' }, body: segment.bytes as unknown as BodyInit });
    status = r.status;
    await r.arrayBuffer().catch(() => undefined);
  } catch {
    return { status: 0, playlistStatus: 0, note: 'YouTube could not be reached' };
  }
  if (status !== 200 && status !== 202) return { status, playlistStatus: 0, note: youtubeNote(status) };
  let playlistStatus = 0;
  try {
    const r = await fetchImpl(youtubeIngestUrl(base, streamKey, 'live.m3u8'), { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/vnd.apple.mpegurl' }, body: playlist });
    playlistStatus = r.status;
    await r.arrayBuffer().catch(() => undefined);
  } catch {
    return { status, playlistStatus: 0, note: 'YouTube took the segment but the playlist did not get through' };
  }
  if (playlistStatus !== 200 && playlistStatus !== 202) return { status: playlistStatus, playlistStatus, note: youtubeNote(playlistStatus, true) };
  return { status, playlistStatus, note: 'YouTube is receiving the show' };
}

export function youtubeNote(status: number, playlist = false): string {
  const what = playlist ? 'the playlist' : 'a segment';
  if (status === 401) return 'YouTube rejected the stream key (401) — copy a fresh key from YouTube Studio → Go live';
  if (status === 400) return `YouTube could not read ${what} (400)`;
  if (status === 405) return 'YouTube refused the request method (405)';
  if (status >= 500) return `YouTube had a server error (${status}) — trying again with the next segment`;
  if (status === 0) return 'YouTube could not be reached';
  return `YouTube answered ${status} to ${what}`;
}

/** The last few segments for YouTube's playlist: at most five outstanding, two already-acknowledged ones for safety. */
export function youtubeWindow(segments: LiveSegmentInfo[]): LiveSegmentInfo[] {
  return segments.slice(-4);
}

export const liveKeep = LIVE_KEEP;
