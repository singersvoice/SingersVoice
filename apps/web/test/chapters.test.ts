/**
 * Where the film of a meet gets its chapter marks: one per song (its kickstart the instant, a restart or
 * a new song a new chapter), one per pause (cued at its instant, the same chapter once it has landed),
 * one for the stage between songs (a new one after every song); the same stage state asked twice is
 * the same chapter. And how the marks read on a line.
 */
import { idlePlayback, type Meet, type MeetPlayback } from '@singersvoice/protocol';
import { describe, expect, it } from 'vitest';
import { chapterCue, marksLine } from '../src/video/chapters.ts';

const meet = (pb: Partial<MeetPlayback>, rest: Partial<Pick<Meet, 'kickstartEpochMs' | 'trackTitle' | 'trackId' | 'catalogTrackId' | 'songCount'>> = {}) => ({ playback: { ...idlePlayback(), ...pb }, kickstartEpochMs: null, trackTitle: 'Ammo', trackId: 'trk-1', catalogTrackId: null, songCount: 0, ...rest });

describe('chapter cues', () => {
  it('the stage between songs, a song at its kickstart, a pause at its cued instant, the song continued after it, a restart, the next song', () => {
    const now = 1_700_000_000_000;
    const stage0 = chapterCue(meet({ state: 'idle' }), now);
    expect(stage0).toMatchObject({ kind: 'stage', key: 'stage:0', title: 'On stage', at: now, songEpoch: 0 });
    expect(chapterCue(meet({ state: 'idle' }), now + 5000).key).toBe('stage:0'); // the same chapter, asked again
    // The song counts in: its chapter starts at the kickstart, a few seconds ahead.
    const song = chapterCue(meet({ state: 'playing', epoch: 1 }, { kickstartEpochMs: now + 3000 }), now);
    expect(song).toMatchObject({ kind: 'song', key: 'song:1', title: 'Ammo', at: now + 3000, trackId: 'trk-1', trackTitle: 'Ammo', songEpoch: 1 });
    expect(chapterCue(meet({ state: 'playing', epoch: 1 }, { kickstartEpochMs: now + 3000, catalogTrackId: 'cat-9' }), now).trackId).toBe('cat-9'); // the shared entry names the song
    // A pause is cued ahead: the chapter starts at its instant; once it has landed it is the same chapter.
    const pausing = chapterCue(meet({ state: 'playing', epoch: 1, pauseAtEpochMs: now + 9000, pausedAtMs: 6000 }, { kickstartEpochMs: now + 3000 }), now + 6000);
    expect(pausing).toMatchObject({ kind: 'pause', key: 'pause:1', title: 'Paused — Ammo', at: now + 9000 });
    const paused = chapterCue(meet({ state: 'paused', epoch: 1, pausedAtMs: 6000 }), now + 9500);
    expect(paused.key).toBe('pause:1');
    // Resumed: a new epoch, the song continued from where it stood.
    const resumed = chapterCue(meet({ state: 'playing', epoch: 2, offsetMs: 6000 }, { kickstartEpochMs: now + 12_000 }), now + 10_500);
    expect(resumed).toMatchObject({ kind: 'song', key: 'song:2', title: 'Ammo (from 0:06)', at: now + 12_000, songEpoch: 2, songMs: 6000 });
    // Restarted from the top: its own chapter again, plain title.
    expect(chapterCue(meet({ state: 'playing', epoch: 3, offsetMs: 0 }, { kickstartEpochMs: now + 20_000 }), now + 19_000)).toMatchObject({ kind: 'song', key: 'song:3', title: 'Ammo' });
    // The song over: the stage again — a new stretch of it (the song count moved on); the next song is its own chapter.
    const stage1 = chapterCue(meet({ state: 'idle' }, { songCount: 1 }), now + 30_000);
    expect(stage1).toMatchObject({ kind: 'stage', key: 'stage:1', title: 'On stage' });
    expect(chapterCue(meet({ state: 'playing', epoch: 4 }, { kickstartEpochMs: now + 40_000, trackTitle: 'Second song', trackId: 'trk-2', songCount: 1 }), now + 37_000)).toMatchObject({ kind: 'song', key: 'song:4', title: 'Second song', trackId: 'trk-2' });
  });

  it('the marks of a film read on one line, each with where it starts', () => {
    const mark = (index: number, kind: 'song' | 'pause' | 'stage', trackTitle: string, startMs: number, songMs?: number) => ({ eventId: 'film-1', eventTitle: 'Full meet', index, kind, trackId: '', trackTitle, songEpoch: 0, startedAt: '', startMs, ...(songMs ? { songMs } : {}) });
    // A song mark that picks the song up further in (a resume, a jump) says where.
    expect(marksLine([mark(1, 'stage', '', 0), mark(2, 'song', 'Ammo', 198_000), mark(3, 'pause', 'Ammo', 460_000), mark(4, 'song', 'Ammo', 470_000, 262_000), mark(5, 'stage', '', 700_000)])).toBe('▪ On stage 0:00 · ♪ Ammo 3:18 · ⏸ Paused — Ammo 7:40 · ♪ Ammo (from 4:22) 7:50 · ▪ On stage 11:40');
  });
});
