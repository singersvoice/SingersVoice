/**
 * Where the film of a meet gets its chapter marks, read off the meet's shared transport: a new chapter
 * every time a song starts (a restart or a new song too, each on its own epoch), one for every pause
 * (an interruption), one for the stage between songs. The host's film and the publisher's footage
 * both follow this, so their marks line up with what the stage did — and a chapter that starts at
 * a known instant (a song's kickstart, a cued pause) is marked at that instant, not when the poll
 * that announced it happened to land.
 */
import { formatMs, idlePlayback, type ChapterKind, type Meet, type PerformanceChapter } from '@singersvoice/protocol';

export interface ChapterCue {
  kind: ChapterKind;
  /** What the chapter is called ("Ammo", "Ammo (from 1:12)", "Paused — Ammo", "On stage"). */
  title: string;
  /** Tells one chapter from the next: the same key twice is the same chapter. */
  key: string;
  /** When the chapter starts (ms since epoch, the server's clock): a song's kickstart, a cued pause's instant, now for the rest. */
  at: number;
  trackId: string;
  trackTitle: string;
  /** The meet's playback epoch the chapter belongs to (0 for the stage between songs). */
  songEpoch: number;
  /** A song cue: where in the song it picks the song up (0 from the top; a jump or a resume further in). */
  songMs?: number;
}

export type ChapterMeet = Pick<Meet, 'playback' | 'kickstartEpochMs' | 'trackId' | 'catalogTrackId' | 'trackTitle' | 'songCount'>;

/** The chapter the stage calls for right now. The caller cuts when the key differs from the chapter it is in. */
export function chapterCue(meet: ChapterMeet, now: number): ChapterCue {
  const pb = meet.playback ?? idlePlayback();
  const song = (meet.trackTitle || 'Song').trim();
  const trackId = meet.catalogTrackId ?? meet.trackId ?? '';
  if (pb.state === 'playing' && pb.pauseAtEpochMs !== null) return { kind: 'pause', title: `Paused — ${song}`, key: `pause:${pb.epoch}`, at: pb.pauseAtEpochMs, trackId, trackTitle: song, songEpoch: pb.epoch };
  if (pb.state === 'playing') return { kind: 'song', title: pb.offsetMs > 0 ? `${song} (from ${formatMs(pb.offsetMs)})` : song, key: `song:${pb.epoch}`, at: meet.kickstartEpochMs ?? now, trackId, trackTitle: song, songEpoch: pb.epoch, songMs: Math.max(0, Math.round(pb.offsetMs)) };
  if (pb.state === 'paused') return { kind: 'pause', title: `Paused — ${song}`, key: `pause:${pb.epoch}`, at: now, trackId, trackTitle: song, songEpoch: pb.epoch };
  return { kind: 'stage', title: 'On stage', key: `stage:${meet.songCount ?? 0}`, at: now, trackId: '', trackTitle: '', songEpoch: 0 };
}

export const chapterGlyph = (kind: ChapterKind): string => (kind === 'song' ? '♪' : kind === 'pause' ? '⏸' : '▪');

/** A mark's name: the song's ("Ammo", "Ammo (from 1:12)" where a jump or a resume picked it up), "Paused — the song", "On stage". */
export const markTitle = (c: Pick<PerformanceChapter, 'kind' | 'trackTitle' | 'songMs'>): string => (c.kind === 'song' ? `${c.trackTitle || 'Song'}${(c.songMs ?? 0) > 0 ? ` (from ${formatMs(c.songMs!)})` : ''}` : c.kind === 'pause' ? `Paused${c.trackTitle ? ` — ${c.trackTitle}` : ''}` : 'On stage');

/** The film's chapter marks on one line: "▪ On stage 0:00 · ♪ Ammo 3:18 · ⏸ Paused — Ammo 7:40 · …". */
export function marksLine(marks: PerformanceChapter[]): string {
  return marks.map((c) => `${chapterGlyph(c.kind)} ${markTitle(c)} ${formatMs(c.startMs)}`).join(' · ');
}
