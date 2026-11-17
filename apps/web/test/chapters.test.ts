/**
 * Where the film of a meet is cut: a chapter per song (its kickstart the instant, a restart or a new
 * song a new chapter), one per pause (cued at its instant, the same chapter once it has landed), one
 * for the stage between songs (a new one after every song); the same stage state asked twice is the
 * same chapter. And how the Performances list puts a filming back together from its chapters.
 */
import { idlePlayback, type Meet, type MeetPerformance, type MeetPlayback } from '@singersvoice/protocol';
import { describe, expect, it } from 'vitest';
import type { PerformanceSummary } from '../src/lib/storage/types.ts';
import { groupEvents } from '../src/lib/filmEvents.ts';
import { chapterCue, continuedCue } from '../src/video/chapters.ts';

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
    expect(resumed).toMatchObject({ kind: 'song', key: 'song:2', title: 'Ammo (continued at 0:06)', at: now + 12_000, songEpoch: 2 });
    // Restarted from the top: its own chapter again, plain title.
    expect(chapterCue(meet({ state: 'playing', epoch: 3, offsetMs: 0 }, { kickstartEpochMs: now + 20_000 }), now + 19_000)).toMatchObject({ kind: 'song', key: 'song:3', title: 'Ammo' });
    // The song over: the stage again — a new stretch of it (the song count moved on); the next song is its own chapter.
    const stage1 = chapterCue(meet({ state: 'idle' }, { songCount: 1 }), now + 30_000);
    expect(stage1).toMatchObject({ kind: 'stage', key: 'stage:1', title: 'On stage' });
    expect(chapterCue(meet({ state: 'playing', epoch: 4 }, { kickstartEpochMs: now + 40_000, trackTitle: 'Second song', trackId: 'trk-2', songCount: 1 }), now + 37_000)).toMatchObject({ kind: 'song', key: 'song:4', title: 'Second song', trackId: 'trk-2' });
    // A chapter cut into parts keeps its kind and song, says the part, and is still that chapter by its key's base.
    const part2 = continuedCue(song, 2, now + 600_000);
    expect(part2).toMatchObject({ kind: 'song', title: 'Ammo (part 2)', key: 'song:1#2', at: now + 600_000 });
    expect(continuedCue(part2, 3, now + 1_200_000)).toMatchObject({ title: 'Ammo (part 3)', key: 'song:1#3' });
  });
});

describe('a filming put back together', () => {
  const chapter = (eventId: string, index: number, kind: 'song' | 'pause' | 'stage', startedAt: string) => ({ eventId, eventTitle: 'Full meet', index, kind, trackId: kind === 'song' ? 'trk-1' : '', trackTitle: kind === 'song' ? 'Ammo' : '', songEpoch: 0, startedAt, startMs: 0 });
  const show = (id: string, index: number, kind: 'song' | 'pause' | 'stage', title: string, startedAt: string): MeetPerformance => ({ performanceId: id, meetId: 'm1', meetTitle: 'Friday', hostUserId: 'u-host', hostName: 'Hari', songTitle: title, trackId: '', singers: [{ slot: 1, displayName: 'Hari N' }], link: `https://drive/${id}`, videoLink: `https://drive/${id}/view`, durationMs: 60_000, bytes: 1, mimeType: 'video/mp4', createdAt: startedAt, chapter: chapter('film-1', index, kind, startedAt) });
  const own = (id: string, index: number, kind: 'song' | 'pause' | 'stage', title: string, startedAt: string, eventId = 'film-1'): PerformanceSummary => ({ performanceId: id, trackId: '', trackTitle: title, state: 'kept', mode: 'live', kind: 'show', meetId: 'm1', meetTitle: 'Friday', durationMs: 60_000, createdAt: startedAt, expiresAt: null, ref: id, hasVideo: true, chapter: { ...chapter(eventId, index, kind, startedAt), eventTitle: eventId === 'film-1' ? 'Full meet' : 'Broadcast' } });

  it('chapters from the registry and from my Drive are one row each, in order; a song show without a chapter is not an event; my own footage is its own event', () => {
    const shows = [show('p3', 3, 'stage', 'On stage', '2026-11-16T23:20:00Z'), show('p1', 1, 'stage', 'On stage', '2026-11-16T23:15:00Z'), show('p2', 2, 'song', 'Ammo', '2026-11-16T23:16:00Z'), { ...show('song-show', 0, 'song', 'A song show', '2026-11-16T22:00:00Z'), chapter: undefined }];
    const mine = [own('p2', 2, 'song', 'Ammo', '2026-11-16T23:16:00Z'), own('p4', 4, 'pause', 'Paused — Ammo', '2026-11-16T23:21:00Z'), own('b1', 1, 'stage', 'On stage', '2026-11-16T23:10:00Z', 'film-2')];
    const events = groupEvents(shows, mine);
    expect(events.map((e) => e.eventId)).toEqual(['film-1', 'film-2']);
    const film = events[0]!;
    expect(film).toMatchObject({ title: 'Full meet', meetTitle: 'Friday', hostUserId: 'u-host', hostName: 'Hari', startedAt: '2026-11-16T23:15:00Z', durationMs: 240_000 });
    expect(film.chapters.map((c) => `${c.index}:${c.kind}:${c.performanceId}`)).toEqual(['1:stage:p1', '2:song:p2', '3:stage:p3', '4:pause:p4']);
    expect(film.chapters[1]!.show?.performanceId).toBe('p2');
    expect(film.chapters[1]!.own?.performanceId).toBe('p2'); // one row, known both ways
    expect(film.chapters[0]!.own).toBeNull();
    expect(film.chapters[3]!.show).toBeNull();
    expect(events[1]).toMatchObject({ title: 'Broadcast', hostUserId: '', chapters: [{ performanceId: 'b1' }] });
  });
});
