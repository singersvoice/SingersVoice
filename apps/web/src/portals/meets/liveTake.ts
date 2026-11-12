/**
 * What happens to a take sung on a live stage: it saves itself. Kept straight away in the
 * singer's own Drive (`Performances/Live`, never Temp), its video being the show; registered with
 * the meet as this singer's take; and — the host's copy — made the meet's performance: shared
 * anyone-with-the-link and with every member's Google account, listed for everyone who was in the
 * meet. All of it in the background saver (`lib/saveQueue.ts`): the singer is already back on the
 * stage. Every stage is remembered, so a retry picks up where it failed.
 */
import { newId, type PerformanceSinger } from '@singersvoice/protocol';
import { api } from '../../lib/api.ts';
import { go } from '../../lib/nav.ts';
import { enqueueSave, type SaveReport } from '../../lib/saveQueue.ts';
import type { LoadedTrack, PerformanceSummary } from '../../lib/storage/types.ts';
import { buildManifest, saveTake, type TakeResult } from '../../lib/takes.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { withProvider } from '../../state/session.ts';

export interface LiveTakeSpec {
  take: TakeResult;
  loaded: LoadedTrack;
  slot: number;
  meet: { meetId: string; title: string; hostName: string };
  /** The host's take is the meet's performance. */
  host: boolean;
  singers: PerformanceSinger[];
  /** The room token while the singer is still in the room (optional: registration works by account too). */
  resumeToken?: string;
}

/** Hand a finished live take to the saver. Returns the performance id (null when there is nothing to save). */
export function saveLiveTake(spec: LiveTakeSpec): string | null {
  const { take, loaded, meet } = spec;
  const hasVocal = take.vocal.size > 0;
  const hasVideo = Boolean(take.video && take.video.size > 0);
  if (!hasVocal && !hasVideo) {
    toast('Nothing to save — the song had barely started', 'info');
    return null;
  }
  const id = newId('perf-');
  const shared = spec.host && hasVideo;
  // Stages, remembered across retries.
  let saved: PerformanceSummary | null = null;
  let registeredTake = false;
  let links: { link: string | null; videoLink: string | null } | null = null;
  let registeredShow = false;

  const work = async (report: SaveReport) => {
    if (!saved) {
      const manifest = await buildManifest(take, loaded.track, {
        state: 'kept',
        mode: 'live',
        slot: spec.slot,
        meetId: meet.meetId,
        performanceId: id,
        kind: hasVideo ? 'show' : 'take',
        meetTitle: meet.title,
        hostName: meet.hostName,
        singers: spec.singers,
      });
      saved = await saveTake(manifest, take, report);
    }
    if (!registeredTake) {
      await api
        .post('POST /meets/:id/recordings', `/meets/${encodeURIComponent(meet.meetId)}/recordings`, { resumeToken: spec.resumeToken, performanceId: id, driveFolderLink: saved.link ?? null, durationMs: take.durationMs, slot: spec.slot })
        .catch(() => undefined); // the list of personal takes on the ended screen: nice to have
      registeredTake = true;
    }
    if (!shared) return { link: saved.videoLink ?? saved.link ?? null };
    report({ label: 'Sharing with the meet', fraction: 0.96 });
    if (!links) {
      try {
        const s = await withProvider((p) => p.sharePerformance(id, { type: 'anyone' }));
        links = { link: s.link, videoLink: s.videoLink };
      } catch {
        links = { link: saved.link ?? null, videoLink: saved.videoLink ?? null }; // no Drive (local storage): listed for the meet without a link
      }
    }
    if (!registeredShow) {
      const r = await api.post('POST /meets/:id/performances', `/meets/${encodeURIComponent(meet.meetId)}/performances`, {
        resumeToken: spec.resumeToken,
        performanceId: id,
        songTitle: loaded.track.title,
        trackId: loaded.track.trackId,
        singers: spec.singers,
        link: links.link,
        videoLink: links.videoLink,
        durationMs: take.durationMs,
        bytes: take.video?.size ?? 0,
        mimeType: take.video?.type ?? '',
      });
      registeredShow = true;
      for (const email of r.shareWith) void withProvider((p) => p.sharePerformance(id, { type: 'user', email })).catch((e) => toast(`Could not share with ${email}: ${errorText(e)}`, 'warn', 6000));
    }
    return { link: links.videoLink ?? links.link };
  };

  enqueueSave({ id, title: loaded.track.title, meetTitle: meet.title, shared, work, onDone: () => go('/studio/performances') });
  return id;
}
