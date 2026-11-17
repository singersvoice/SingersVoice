/**
 * Where the film of a meet is cut into chapters, read off the meet's shared transport: a new chapter
 * every time a song starts (a restart or a new song too, each on its own epoch), one for every pause
 * (an interruption), one for the stage between songs. The host's film and the publisher's footage
 * both follow this, so their chapters line up with what the stage did — and a chapter that starts
 * at a known instant (a song's kickstart, a cued pause) is cut at that instant, not when the poll
 * that announced it happened to land.
 */
import { formatMs, idlePlayback, type ChapterKind, type Meet } from '@singersvoice/protocol';

export interface ChapterCue {
  kind: ChapterKind;
  /** What the chapter is called ("Ammo", "Ammo (continued at 1:12)", "Paused — Ammo", "On stage"). */
  title: string;
  /** Tells one chapter from the next: the same key twice is the same chapter. */
  key: string;
  /** When the chapter starts (ms since epoch, the server's clock): a song's kickstart, a cued pause's instant, now for the rest. */
  at: number;
  trackId: string;
  trackTitle: string;
  /** The meet's playback epoch the chapter belongs to (0 for the stage between songs). */
  songEpoch: number;
}

export type ChapterMeet = Pick<Meet, 'playback' | 'kickstartEpochMs' | 'trackId' | 'catalogTrackId' | 'trackTitle' | 'songCount'>;

/** The chapter the stage calls for right now. The caller cuts when the key differs from the chapter it is in. */
export function chapterCue(meet: ChapterMeet, now: number): ChapterCue {
  const pb = meet.playback ?? idlePlayback();
  const song = (meet.trackTitle || 'Song').trim();
  const trackId = meet.catalogTrackId ?? meet.trackId ?? '';
  if (pb.state === 'playing' && pb.pauseAtEpochMs !== null) return { kind: 'pause', title: `Paused — ${song}`, key: `pause:${pb.epoch}`, at: pb.pauseAtEpochMs, trackId, trackTitle: song, songEpoch: pb.epoch };
  if (pb.state === 'playing') return { kind: 'song', title: pb.offsetMs > 0 ? `${song} (continued at ${formatMs(pb.offsetMs)})` : song, key: `song:${pb.epoch}`, at: meet.kickstartEpochMs ?? now, trackId, trackTitle: song, songEpoch: pb.epoch };
  if (pb.state === 'paused') return { kind: 'pause', title: `Paused — ${song}`, key: `pause:${pb.epoch}`, at: now, trackId, trackTitle: song, songEpoch: pb.epoch };
  return { kind: 'stage', title: 'On stage', key: `stage:${meet.songCount ?? 0}`, at: now, trackId: '', trackTitle: '', songEpoch: 0 };
}

/** The same chapter carried on in a new chunk (a chapter longer than a chunk may be). */
export function continuedCue(c: ChapterCue, part: number, now: number): ChapterCue {
  return { ...c, title: `${c.title.replace(/ \(part \d+\)$/, '')} (part ${part})`, key: `${c.key.split('#')[0]}#${part}`, at: now };
}
