/**
 * The film of the meet, once it is in the host's Drive (`video/meetRecorder.ts`): what is left runs in
 * the background saver (`lib/saveQueue.ts`) — the film is shared anyone-with-the-link and with every
 * member's Google account, and registered with the meet, its chapter marks on it, so it is listed under
 * Performances for everyone who was in the meet. Nothing is saved per song: the one film is the record
 * of every song sung in the meet.
 */
import type { PerformanceChapter, PerformanceSinger } from '@singersvoice/protocol';
import { enqueueSave, type SaveReport } from '../../lib/saveQueue.ts';
import type { PerformanceSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { withProvider } from '../../state/session.ts';
import type { MeetSession } from './meetSession.ts';

export interface MeetFilmSpec {
  /** The film as the provider saved it (the upload is complete by now): one file for the whole meet. */
  saved: PerformanceSummary;
  /** Its chapter marks — where each song, pause and stretch of stage starts in it. */
  chapters: PerformanceChapter[];
  meet: { meetId: string; title: string; hostName: string };
  singers: PerformanceSinger[];
  /** The room's session: the registration goes through it so the ended screen lists the film at once. */
  session: Pick<MeetSession, 'registerPerformance'>;
}

/**
 * The film of the meet (video/meetRecorder.ts) is in the host's Drive already; what is left runs in
 * the saver: share it anyone-with-the-link and with every member's Google account, and list it with
 * the meet, its chapter marks on it, for everyone who was there.
 */
export function registerMeetFilm(spec: MeetFilmSpec): void {
  const { saved, meet } = spec;
  let links: { link: string | null; videoLink: string | null } | null = null;
  let registered = false;
  const work = async (report: SaveReport) => {
    report({ label: 'Sharing the film with the meet', fraction: 0.5 });
    if (!links) {
      try {
        const s = await withProvider((p) => p.sharePerformance(saved.performanceId, { type: 'anyone' }));
        links = { link: s.link, videoLink: s.videoLink };
      } catch {
        links = { link: saved.link ?? null, videoLink: saved.videoLink ?? null }; // no Drive (local storage): listed without a link
      }
    }
    if (!registered) {
      const r = await spec.session.registerPerformance({
        performanceId: saved.performanceId,
        songTitle: saved.trackTitle,
        trackId: '',
        singers: spec.singers,
        link: links.link,
        videoLink: links.videoLink,
        durationMs: saved.durationMs,
        bytes: 0,
        mimeType: 'video/mp4',
        chapters: spec.chapters,
      });
      registered = true;
      for (const email of r.shareWith) void withProvider((p) => p.sharePerformance(saved.performanceId, { type: 'user', email })).catch((e) => toast(`Could not share the film with ${email}: ${errorText(e)}`, 'warn', 6000));
    }
    return { link: links.videoLink ?? links.link };
  };
  enqueueSave({ id: saved.performanceId, title: saved.trackTitle, meetTitle: meet.title, shared: true, work });
}
