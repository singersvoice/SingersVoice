/**
 * The karaoke video behind a YouTube song track, fetched for the stage. The file sits in the owner's
 * Drive, shared anyone-with-the-link: the owner's own token reads it; another singer's device (a meet,
 * a pulled copy) reads it with the app's Google API key when the build has one, else through the
 * service, which fetches it from Drive (`/catalog/tracks/:id/file/video`) — the same three ways a
 * published track's audio comes in (lib/catalog.ts). The last videos stay in memory as object URLs,
 * so a song sung twice is not downloaded twice.
 */
import type { TrackPackageV2 } from '@singersvoice/protocol';
import { api } from './api.ts';
import { catalogIdOfCopy } from './catalog.ts';
import { AuthExpiredError, GOOGLE_API_KEY } from './google.ts';
import { driveProvider } from '../state/session.ts';

const urls = new Map<string, Promise<string>>();
const KEEP = 3;

/** An object URL for the track's video (null when the track has none); rejects with a plain message when it cannot be fetched. */
export function trackVideoUrl(track: Pick<TrackPackageV2, 'trackId' | 'video'>, catalogTrackId?: string | null): Promise<string> | null {
  const v = track.video;
  if (!v?.fileId) return null;
  const hit = urls.get(v.fileId);
  if (hit) return hit;
  const p = fetchVideo(v.fileId, v.mimeType, catalogTrackId ?? catalogIdOfCopy(track.trackId) ?? track.trackId)
    .then((blob) => URL.createObjectURL(blob))
    .catch((e) => {
      urls.delete(v.fileId); // the next try fetches again
      throw e;
    });
  urls.set(v.fileId, p);
  if (urls.size > KEEP) {
    const oldest = urls.keys().next().value;
    if (oldest) {
      void urls.get(oldest)?.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
      urls.delete(oldest);
    }
  }
  return p;
}

async function fetchVideo(fileId: string, mime: string, catalogTrackId: string): Promise<Blob> {
  const d = driveProvider();
  const type = mime || 'video/mp4';
  if (d) {
    try {
      const b = await d.download(fileId);
      return b.type ? b : new Blob([b], { type });
    } catch (e) {
      if (e instanceof AuthExpiredError) throw e;
      /* not mine: the other ways below */
    }
  }
  if (GOOGLE_API_KEY) {
    try {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(GOOGLE_API_KEY)}`);
      if (r.ok) return new Blob([await r.blob()], { type });
    } catch {
      /* the service then */
    }
  }
  try {
    const b = await api.getBlob('GET /catalog/tracks/:id/file/:which', `/catalog/tracks/${encodeURIComponent(catalogTrackId)}/file/video`);
    return b.type ? b : new Blob([b], { type });
  } catch (e) {
    throw new Error(`The karaoke video could not be fetched (${e instanceof Error ? e.message : String(e)}) — the song still plays, without its picture`);
  }
}

/** Tests: forget the cached videos. */
export function forgetTrackVideos(): void {
  for (const p of urls.values()) void p.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
  urls.clear();
}
