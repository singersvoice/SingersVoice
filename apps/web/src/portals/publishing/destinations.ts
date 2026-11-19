/**
 * The publisher's destinations, saved with the service — and YouTube connected in one tap: the Google
 * screen once more (the YouTube permission), the channel's HLS stream key made by the app and kept by
 * the service, the destination enabled and run by the app (`auto`). Used by the Destinations tab and by
 * the show view's own Connect button, so a publisher never has to leave the show to get YouTube going.
 */
import type { Destination, DestinationKind } from '@singersvoice/protocol';
import { api } from '../../lib/api.ts';
import { connectYoutube, ensureHlsStream } from '../../lib/youtube.ts';

/** Save a platform's ingest URL / stream key (an empty key keeps the saved one), its live link, its enabled flag — and whether the app runs it (YouTube connected). */
export async function saveDestination(kind: DestinationKind, patch: { enabled: boolean; ingestUrl: string; streamKey?: string; watchUrl?: string; auto?: boolean }): Promise<Destination> {
  const r = await api.put('PUT /publishing/destinations/:kind', `/publishing/destinations/${kind}`, {
    enabled: patch.enabled,
    ingestUrl: patch.ingestUrl.trim(),
    ...(patch.streamKey?.trim() ? { streamKey: patch.streamKey.trim() } : {}),
    ...(patch.watchUrl !== undefined ? { watchUrl: patch.watchUrl.trim() } : {}),
    ...(patch.auto !== undefined ? { auto: patch.auto } : {}),
  });
  return r.destination;
}

/**
 * Connect YouTube (one tap, from a tap): the permission, the channel's HLS stream (found or made), its key saved
 * with the service, the destination enabled and run by the app. Resolves with the destination as saved.
 */
export async function connectYoutubeDestination(dest: Pick<Destination, 'ingestUrl' | 'keyHint'>, hint?: string): Promise<Destination> {
  const token = await connectYoutube(hint);
  const stream = await ensureHlsStream(token, dest.keyHint);
  return saveDestination('youtube', { enabled: true, ingestUrl: dest.ingestUrl, streamKey: stream.streamKey, auto: true, watchUrl: '' });
}
