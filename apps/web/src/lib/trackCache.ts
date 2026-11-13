/**
 * The library list, remembered on the device: Drive answers a listing in a second or two, which is
 * too long for a search box — so whoever lists the library keeps the answer here, and the song
 * picker searches it the instant it opens while the fresh list is on its way.
 */
import { profile, withProvider } from '../state/session.ts';
import type { TrackSummary } from './storage/types.ts';

const key = (): string => `sv.tracks.${profile.value?.sub ?? 'anon'}`;

export function readTrackCache(): TrackSummary[] | null {
  try {
    const raw = localStorage.getItem(key());
    const v = raw ? (JSON.parse(raw) as { tracks: TrackSummary[] }) : null;
    return Array.isArray(v?.tracks) ? v.tracks : null;
  } catch {
    return null;
  }
}

export function writeTrackCache(tracks: TrackSummary[]): void {
  try {
    localStorage.setItem(key(), JSON.stringify({ at: Date.now(), tracks: tracks.slice(0, 5000) }));
  } catch {
    /* storage full or blocked: the next listing simply takes its time */
  }
}

/** The library: what the device remembers at once, the fresh listing when it arrives (and remembered for next time). */
export async function listTracksFresh(): Promise<TrackSummary[]> {
  const tracks = await withProvider(async (p) => {
    await p.ready();
    return p.listTracks();
  });
  writeTrackCache(tracks);
  return tracks;
}
