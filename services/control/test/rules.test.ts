import { describe, expect, it } from 'vitest';
import { MAX_LIVE_TAKE_MS, MAX_PERFORMERS, MEET_IDLE_EXPIRY_MS, playbackPositionMs, type Participant } from '@singersvoice/protocol';
import { addSong, claimSlot, decideRequest, ensureMeet, ensurePlayback, newMeet, nextSong, pause, reconcile, requestStage, resume, setStagePolicy, songAction, start, stop, tick, touch, withdrawRequest } from '../src/meets.ts';

const T0 = Date.parse('2026-11-11T10:00:00Z');
const person = (id: string, userId = `u-${id}`): Participant => ({
  participantId: id,
  userId,
  displayName: id,
  picture: '',
  role: 'audience',
  slot: null,
  stageRequest: 'none',
  joinedAt: new Date(T0).toISOString(),
  lastSeenAt: new Date(T0).toISOString(),
});
/** A meet with an open stage (the legacy rules below seat people directly). */
const openMeet = (input: Parameters<typeof newMeet>[0]) => {
  const m = newMeet(input, T0);
  setStagePolicy(m, 'open');
  return m;
};

describe('meet rules', () => {
  it('expires after 5 idle minutes and any activity extends it', () => {
    const m = newMeet({ title: 'Sunday', hostUserId: 'u-host', hostName: 'Host', trackId: null, trackTitle: '', catalogTrackId: null, backgroundId: 'bg' }, T0);
    expect(m.state).toBe('lobby');
    expect(Date.parse(m.expiresAt) - T0).toBe(MEET_IDLE_EXPIRY_MS);
    expect(tick(m, T0 + MEET_IDLE_EXPIRY_MS - 1)).toBe(false);
    touch(m, T0 + 4 * 60 * 1000);
    expect(tick(m, T0 + MEET_IDLE_EXPIRY_MS + 1000)).toBe(false); // extended by the touch
    expect(tick(m, T0 + 9 * 60 * 1000 + 1)).toBe(true);
    expect(m.state).toBe('expired');
  });

  it('seats at most 10 performers, refuses taken slots, frees slots of silent participants', () => {
    const m = openMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: null, trackTitle: '', catalogTrackId: null, backgroundId: 'bg' });
    const people = Array.from({ length: 12 }, (_, i) => person(`p${i + 1}`));
    people.forEach((p, i) => {
      const r = claimSlot(m, p, i + 1);
      expect(r.ok).toBe(i < MAX_PERFORMERS);
    });
    expect(claimSlot(m, person('x'), 1)).toEqual({ ok: false, reason: 'slot_taken' });
    // p1 goes quiet for 61 s → slot freed, counts recomputed.
    const later = T0 + 61_000;
    const stillHere = people.slice(1).map((p) => ({ ...p, lastSeenAt: new Date(later).toISOString() }));
    const { changed } = reconcile(m, [people[0]!, ...stillHere], later);
    expect(changed).toBe(true);
    expect(m.stage[0]!.participantId).toBeNull();
    expect(m.performerCount).toBe(9);
    expect(m.audienceCount).toBe(2); // p11, p12 never got a slot
  });

  it('kickstart: host starts with a lead, countdown becomes live at the instant, stop ends it', () => {
    const m = openMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: 'trk', trackTitle: 'AA', catalogTrackId: null, backgroundId: 'bg' });
    expect(start(m, 5000, T0)).toEqual({ ok: false, reason: 'no_performers' });
    claimSlot(m, person('p1'), 1);
    expect(start(m, 5000, T0)).toEqual({ ok: true });
    expect(m.state).toBe('countdown');
    expect(m.kickstartEpochMs).toBe(T0 + 5000);
    expect(claimSlot(m, person('p2'), 2)).toEqual({ ok: false, reason: 'song_in_progress' }); // the count-in has started: the stage is the singers' own
    tick(m, T0 + 5001);
    expect(m.state).toBe('live');
    expect(claimSlot(m, person('p3'), 3)).toEqual({ ok: false, reason: 'song_in_progress' });
    expect(claimSlot(m, person('p1'), 4).ok).toBe(true); // a singer already on stage may still move slots
    stop(m, T0 + 60_000);
    expect(m.state).toBe('ended');
    expect(m.kickstartEpochMs).toBeNull();
  });

  it('pause freezes the shared position; resume and restart cue a new kickstart with a new epoch', () => {
    const m = openMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: 'trk', trackTitle: 'AA', catalogTrackId: null, backgroundId: 'bg' });
    claimSlot(m, person('p1'), 1);
    expect(pause(m, T0)).toEqual({ ok: false, reason: 'not_playing' });
    start(m, 5000, T0);
    expect(m.playback).toMatchObject({ state: 'playing', offsetMs: 0, epoch: 1 });
    tick(m, T0 + 5000);
    // 12 s into the song the host presses pause: it is cued 3 s ahead so everyone stops at 15 s
    expect(playbackPositionMs(m, T0 + 17_000)).toBe(12_000);
    expect(pause(m, T0 + 17_000, 3000)).toEqual({ ok: true });
    expect(m.playback).toMatchObject({ state: 'playing', pauseAtEpochMs: T0 + 20_000, pausedAtMs: 15_000 });
    expect(pause(m, T0 + 17_500, 3000)).toEqual({ ok: false, reason: 'not_playing' }); // already cued
    expect(playbackPositionMs(m, T0 + 18_000)).toBe(13_000); // still running until the cue
    expect(playbackPositionMs(m, T0 + 25_000)).toBe(15_000); // frozen at the cue, even before tick()
    expect(tick(m, T0 + 25_000)).toBe(true);
    expect(m.playback).toMatchObject({ state: 'paused', pausedAtMs: 15_000, pauseAtEpochMs: null });
    expect(playbackPositionMs(m, T0 + 60_000)).toBe(15_000); // frozen while paused
    expect(resume(m, 3000, T0 + 60_000)).toEqual({ ok: true });
    expect(m.kickstartEpochMs).toBe(T0 + 63_000);
    expect(m.playback).toMatchObject({ state: 'playing', offsetMs: 15_000, epoch: 2 });
    expect(playbackPositionMs(m, T0 + 64_000)).toBe(16_000);
    expect(resume(m, 3000, T0 + 64_000)).toEqual({ ok: false, reason: 'already_playing' });
    // restart from 0 while playing
    expect(resume(m, 4000, T0 + 70_000, 0)).toEqual({ ok: true });
    expect(m.playback).toMatchObject({ state: 'playing', offsetMs: 0, epoch: 3 });
    expect(playbackPositionMs(m, T0 + 74_500)).toBe(500);
    // the 15-minute cap counts played time, not paused time
    pause(m, T0 + 80_000, 0);
    tick(m, T0 + 80_000);
    expect(m.playback.state).toBe('paused');
    expect(tick(m, T0 + 80_000 + MAX_LIVE_TAKE_MS * 2)).toBe(true); // idle expiry only
    expect(m.state).toBe('expired');
  });

  it('a meet saved before playback existed is treated as playing from its kickstart', () => {
    const m = openMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: 'trk', trackTitle: 'AA', catalogTrackId: null, backgroundId: 'bg' });
    claimSlot(m, person('p1'), 1);
    start(m, 3000, T0);
    tick(m, T0 + 3000);
    delete (m as { playback?: unknown }).playback;
    ensurePlayback(m);
    expect(m.playback.state).toBe('playing');
    expect(playbackPositionMs(m, T0 + 4000)).toBe(1000);
  });

  it('stage policy: everyone enters as audience; they ask, the host decides; the host steps on freely; open stage needs no asking', () => {
    const m = newMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: 'trk', trackTitle: 'AA', catalogTrackId: null, backgroundId: 'bg' }, T0);
    expect(m.stagePolicy).toBe('ask');
    const host = person('h', 'u-host');
    const a = person('a');
    const b = person('b');
    expect(claimSlot(m, a, 1)).toEqual({ ok: false, reason: 'ask_first' });
    expect(claimSlot(m, host, 1).ok).toBe(true); // the host (admin) is never asked
    expect(requestStage(m, a, T0)).toEqual({ ok: true });
    expect(requestStage(m, a, T0 + 1)).toEqual({ ok: true }); // idempotent
    expect(m.requests.map((r) => r.participantId)).toEqual(['a']);
    expect(a.stageRequest).toBe('pending');
    expect(requestStage(m, host)).toEqual({ ok: false, reason: 'on_stage' });
    expect(decideRequest(m, a, false)).toEqual({ ok: true });
    expect(a.stageRequest).toBe('declined');
    expect(m.requests).toHaveLength(0);
    expect(requestStage(m, a, T0)).toEqual({ ok: true }); // may ask again
    expect(decideRequest(m, a, true)).toEqual({ ok: true });
    expect(a.slot).toBe(2); // first free slot
    expect(a.role).toBe('performer');
    expect(a.stageRequest).toBe('none');
    expect(claimSlot(m, a, 3).ok).toBe(true); // a performer may move to another free slot without asking again
    expect(claimSlot(m, a, null).ok).toBe(true);
    expect(claimSlot(m, a, 3)).toEqual({ ok: false, reason: 'ask_first' }); // back in the audience: ask again
    requestStage(m, b, T0);
    withdrawRequest(m, b);
    expect(m.requests).toHaveLength(0);
    expect(b.stageRequest).toBe('none');
    requestStage(m, b, T0);
    // Someone who left the meet is no longer waiting.
    reconcile(m, [host, a], T0 + 1000);
    expect(m.requests).toHaveLength(0);
    requestStage(m, b, T0);
    setStagePolicy(m, 'open');
    expect(m.requests).toHaveLength(0);
    expect(claimSlot(m, b, 5).ok).toBe(true);
    expect(requestStage(m, a, T0)).toEqual({ ok: false, reason: 'open_stage' });
    // Rows from before the policy existed default to 'ask' with no requests.
    const legacy = { ...newMeet({ title: '', hostUserId: 'u', hostName: 'H', trackId: null, trackTitle: '', catalogTrackId: null, backgroundId: 'bg' }, T0) } as Partial<typeof m>;
    delete legacy.stagePolicy;
    delete legacy.requests;
    expect(ensureMeet(legacy as typeof m)).toMatchObject({ stagePolicy: 'ask', requests: [] });
  });

  it('set list: a karaoke event is many songs — pick, queue, play now, song over → lobby for the next one', () => {
    const m = newMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: null, trackTitle: '', catalogTrackId: null, backgroundId: 'bg' }, T0);
    const host = person('h', 'u-host');
    const a = person('a');
    claimSlot(m, host, 1);
    expect(start(m, 5000, T0)).toEqual({ ok: false, reason: 'no_song' }); // nothing to sing yet
    expect(addSong(m, a, { trackId: 't1', catalogTrackId: 'c1', trackTitle: 'One' })).toMatchObject({ ok: false, reason: 'not_on_stage' }); // audience picks nothing
    decideRequest(m, a, true); // seated by the host
    expect(addSong(m, a, { trackId: 't1', catalogTrackId: 'c1', trackTitle: 'One', durationMs: 20_000 }, false, T0).ok).toBe(true);
    expect(m).toMatchObject({ trackId: 't1', catalogTrackId: 'c1', trackTitle: 'One' }); // first song plays next at once
    expect(m.setList).toHaveLength(0);
    expect(addSong(m, host, { trackId: null, catalogTrackId: 'c2', trackTitle: 'Two' }, false, T0 + 1).ok).toBe(true);
    expect(addSong(m, a, { trackId: 't3', catalogTrackId: null, trackTitle: 'Three' }, false, T0 + 2).ok).toBe(true);
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['Two', 'Three']);
    // a singer may play now only through the host; the host swaps the current song, which goes back to the top
    expect(addSong(m, a, { trackId: 't4', catalogTrackId: null, trackTitle: 'Four' }, true)).toMatchObject({ ok: false, reason: 'not_host' });
    expect(addSong(m, host, { trackId: 't4', catalogTrackId: null, trackTitle: 'Four' }, true).ok).toBe(true);
    expect(m.trackTitle).toBe('Four');
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['One', 'Two', 'Three']);
    // ordering: only the host; the picker may remove their own
    const three = m.setList[2]!;
    expect(songAction(m, a, three.id, 'up')).toMatchObject({ ok: false, reason: 'not_host' });
    expect(songAction(m, host, three.id, 'up').ok).toBe(true);
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['One', 'Three', 'Two']);
    expect(songAction(m, a, m.setList[0]!.id, 'remove')).toMatchObject({ ok: false, reason: 'not_host' }); // One was re-queued by the host
    expect(songAction(m, a, three.id, 'remove').ok).toBe(true); // Three is hers
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['One', 'Two']);
    expect(songAction(m, host, m.setList[0]!.id, 'now').ok).toBe(true);
    expect(m.trackTitle).toBe('One');
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['Four', 'Two']);
    // sing it: nothing may be swapped under a song in progress, and the wait list waits for the song to end
    m.stage[0]!.ready = true;
    expect(start(m, 5000, T0 + 10).ok).toBe(true);
    const w = person('w');
    expect(requestStage(m, w, T0 + 11)).toEqual({ ok: true }); // asking is fine during a song…
    expect(decideRequest(m, w, true)).toEqual({ ok: false, reason: 'song_in_progress' }); // …seating waits
    expect(m.requests.map((r) => r.participantId)).toEqual(['w']);
    expect(addSong(m, host, { trackId: 't5', catalogTrackId: null, trackTitle: 'Five' }, true)).toMatchObject({ ok: false, reason: 'song_in_progress' });
    expect(songAction(m, host, m.setList[0]!.id, 'now')).toMatchObject({ ok: false, reason: 'song_in_progress' });
    expect(addSong(m, host, { trackId: 't5', catalogTrackId: null, trackTitle: 'Five' }).ok).toBe(true); // queued instead
    tick(m, T0 + 6000);
    expect(m.state).toBe('live');
    // song over → back to the lobby with the next song up; stage and slots untouched, ready reset; the wait list is served now
    expect(nextSong(m, T0 + 30_000)).toEqual({ ok: true });
    expect(decideRequest(m, w, true)).toEqual({ ok: true });
    expect(w.slot).toBe(3);
    expect(m).toMatchObject({ state: 'lobby', kickstartEpochMs: null, trackTitle: 'Four', songCount: 1 });
    expect(m.playback.state).toBe('idle');
    expect(m.stage[0]!.participantId).toBe('h');
    expect(m.stage[0]!.ready).toBe(false);
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['Two', 'Five']);
    // the 15-minute cap ends the song, not the meet
    start(m, 5000, T0 + 40_000);
    tick(m, T0 + 45_000);
    expect(tick(m, T0 + 45_000 + MAX_LIVE_TAKE_MS + 1)).toBe(true);
    expect(m).toMatchObject({ state: 'lobby', trackTitle: 'Two', songCount: 2 });
    // the queue runs dry: no song until somebody picks one
    nextSong(m, T0 + 50_000);
    nextSong(m, T0 + 51_000);
    expect(m.trackId).toBeNull();
    expect(start(m, 5000, T0 + 52_000)).toEqual({ ok: false, reason: 'no_song' });
    // rows from before the set list existed
    const legacy = { ...newMeet({ title: '', hostUserId: 'u', hostName: 'H', trackId: 'x', trackTitle: 'X', catalogTrackId: null, backgroundId: 'bg' }, T0) } as Partial<typeof m>;
    delete legacy.setList;
    delete legacy.songCount;
    expect(ensureMeet(legacy as typeof m)).toMatchObject({ setList: [], songCount: 0, trackTitle: 'X' });
  });
});
