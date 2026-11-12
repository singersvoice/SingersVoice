/**
 * Where a meet's track comes from on this device: my own library (host / pulled copy) or the
 * public catalog — and, for a singer on stage, a copy of a catalog song is kept in their own
 * library (Drive) in the background, so what the meet sang is theirs to sing again.
 */
import type { CatalogTrack, Meet } from '@singersvoice/protocol';
import { fetchCatalogTrack, getCatalogTrack, isSameTrack, keepCatalogCopy } from '../../lib/catalog.ts';
import type { LoadedTrack } from '../../lib/storage/types.ts';
import { toast } from '../../lib/toast.ts';
import { withProvider } from '../../state/session.ts';

export type MeetTrack = { loaded: LoadedTrack; source: 'library' } | { loaded: LoadedTrack; source: 'catalog'; entry: CatalogTrack } | { loaded: null; source: 'none'; reason: string };

const kept = new Set<string>();
/** Keep a copy of a catalog song in my own library, once, in the background (a singer on stage). */
export function keepMeetTrack(t: MeetTrack): void {
  if (t.source !== 'catalog' || kept.has(t.entry.trackId)) return;
  kept.add(t.entry.trackId);
  void keepCatalogCopy(t.entry, t.loaded)
    .then(() => toast(`"${t.loaded.track.title}" is now in your library too`, 'info', 4000))
    .catch(() => {
      kept.delete(t.entry.trackId); // try again next time it comes up
    });
}

export async function loadMeetTrack(meet: Pick<Meet, 'trackId' | 'catalogTrackId'>): Promise<MeetTrack> {
  // 1. My library: the host's own track, or a copy pulled from the catalog.
  const ids = [meet.trackId, meet.catalogTrackId].filter((x): x is string => Boolean(x));
  try {
    const mine = await withProvider(async (p) => {
      await p.ready();
      const list = await p.listTracks();
      const hit = list.find((t) => ids.includes(t.trackId)) ?? list.find((t) => ids.some((id) => isSameTrack(t.trackId, id)));
      return hit ? p.getTrack(hit.trackId) : null;
    });
    if (mine) return { loaded: mine, source: 'library' };
  } catch {
    /* fall through to the catalog */
  }
  // 2. Public catalog (owner's Drive, anyone-with-link) — shared helper, same path as Tracks/Studio.
  if (meet.catalogTrackId) {
    try {
      const entry = await getCatalogTrack(meet.catalogTrackId);
      return { loaded: await fetchCatalogTrack(entry), source: 'catalog', entry };
    } catch (e) {
      return { loaded: null, source: 'none', reason: `This song could not be loaded on this device (${e instanceof Error ? e.message : String(e)})` };
    }
  }
  return { loaded: null, source: 'none', reason: meet.trackId ? 'This song is not reachable from this device: the singer who picked it needs a Google Drive sign-in so it can be shared with the meet.' : 'No song picked yet.' };
}
