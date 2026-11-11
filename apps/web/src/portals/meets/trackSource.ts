/** Where a meet's track comes from on this device: my own library (host / pulled copy) or the public catalog. */
import type { Meet } from '@singersvoice/protocol';
import { api } from '../../lib/api.ts';
import { GOOGLE_API_KEY } from '../../lib/google.ts';
import type { LoadedTrack } from '../../lib/storage/types.ts';
import { driveProvider, withProvider } from '../../state/session.ts';

export type MeetTrack = { loaded: LoadedTrack; source: 'library' | 'catalog' } | { loaded: null; source: 'none'; reason: string };

export async function loadMeetTrack(meet: Pick<Meet, 'trackId' | 'catalogTrackId'>): Promise<MeetTrack> {
  // 1. My library: the host's own track, or a copy pulled from the catalog.
  const ids = [meet.trackId, meet.catalogTrackId].filter((x): x is string => Boolean(x));
  try {
    const mine = await withProvider(async (p) => {
      await p.ready();
      const list = await p.listTracks();
      const hit = list.find((t) => ids.includes(t.trackId)) ?? list.find((t) => ids.some((id) => t.trackId.startsWith(`${id}-copy-`)));
      return hit ? p.getTrack(hit.trackId) : null;
    });
    if (mine) return { loaded: mine, source: 'library' };
  } catch {
    /* fall through to the catalog */
  }
  // 2. Public catalog (owner's Drive, anyone-with-link).
  if (meet.catalogTrackId) {
    try {
      const { track } = await api.get('GET /catalog/tracks/:id', `/catalog/tracks/${encodeURIComponent(meet.catalogTrackId)}`);
      const d = driveProvider();
      const fetchBlob = async (id: string) => {
        if (d) return d.downloadPublic(id, GOOGLE_API_KEY);
        const key = GOOGLE_API_KEY ? `&key=${encodeURIComponent(GOOGLE_API_KEY)}` : '';
        const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media${key}`);
        if (!r.ok) throw new Error('catalog fetch failed');
        return r.blob();
      };
      const [json, audio] = await Promise.all([fetchBlob(track.trackJsonId), fetchBlob(track.audioId)]);
      const pkg = JSON.parse(await json.text()) as LoadedTrack['track'];
      return { loaded: { track: pkg, audio, audioMime: track.audioMime }, source: 'catalog' };
    } catch (e) {
      return { loaded: null, source: 'none', reason: `The host's track could not be fetched from the catalog (${e instanceof Error ? e.message : String(e)})` };
    }
  }
  return { loaded: null, source: 'none', reason: meet.trackId ? "The host hasn't published this track to the public catalog, so only the host's devices have it." : 'The host has not picked a track yet.' };
}
