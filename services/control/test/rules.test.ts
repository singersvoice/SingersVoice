import { describe, expect, it } from 'vitest';
import { MAX_LIVE_TAKE_MS, MAX_PERFORMERS, MEET_IDLE_EXPIRY_MS, playbackPositionMs, type Participant } from '@singersvoice/protocol';
import { addSong, choicePending, chooseSong, claimSlot, decideRequest, ensureMeet, ensurePlayback, isBanned, kick, newMeet, nextSong, pause, reconcile, reportClock, requestStage, resume, setStagePolicy, SNAPSHOT_AUDIENCE_NAMES, songAction, start, stop, tick, TOUCH_COALESCE_MS, touch, touchForHeartbeat, visibleParticipants, withdrawRequest } from '../src/meets.ts';

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

  it('a hundred in the room cost a poll the same as three: a dozen audience names, the rest a count; heartbeats rewrite the meet only when due', () => {
    const m = newMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: null, trackTitle: '', catalogTrackId: null, backgroundId: 'bg' }, T0);
    const host = { ...person('host', 'u-host'), role: 'host' as const };
    claimSlot(m, host, 1);
    setStagePolicy(m, 'ask'); // the host decides who sings, so there is a wait list to name
    const singer = person('singer');
    expect(decideRequest(m, singer, true, 2).ok).toBe(true);
    const crowd = Array.from({ length: 100 }, (_, i) => ({ ...person(`a${i}`), joinedAt: new Date(T0 + i * 1000).toISOString() }));
    expect(requestStage(m, crowd[70]!, T0).ok).toBe(true);
    const publisher = { ...person('pub'), role: 'publisher' as const };
    const everyone = [...crowd].reverse().concat(host, singer, publisher);
    const { active } = reconcile(m, everyone, T0 + 5000);
    expect(m.audienceCount).toBe(100); // the one asking and the publisher's view aside: the publisher is not audience, the asker still is
    const shown = visibleParticipants(m, active);
    const ids = shown.map((p) => p.participantId);
    expect(ids).toContain('host');
    expect(ids).toContain('singer');
    expect(ids).toContain('pub');
    expect(ids).toContain('a70'); // on the wait list, so the host sees them by name
    expect(shown.filter((p) => p.participantId.startsWith('a') && p.participantId !== 'a70').map((p) => p.participantId)).toEqual(crowd.slice(0, SNAPSHOT_AUDIENCE_NAMES).map((p) => p.participantId)); // the first dozen to arrive, in order
    expect(shown.length).toBe(SNAPSHOT_AUDIENCE_NAMES + 4);

    // The idle expiry is extended by every heartbeat, written once per window.
    expect(touchForHeartbeat(m, T0 + 10_000)).toBe(true);
    expect(touchForHeartbeat(m, T0 + 10_000 + TOUCH_COALESCE_MS - 1)).toBe(false);
    expect(Date.parse(m.expiresAt)).toBe(T0 + 10_000 + MEET_IDLE_EXPIRY_MS); // the extension waits for the window (two seconds against five minutes)
    expect(touchForHeartbeat(m, T0 + 10_000 + TOUCH_COALESCE_MS)).toBe(true);
    // A clock report changes the meet only when it says something new; the audience's never does.
    expect(reportClock(m, singer, 3, 40)).toBe(true);
    expect(reportClock(m, singer, 3, 40)).toBe(false);
    expect(reportClock(m, crowd[0]!, 3, 40)).toBe(false);
  });

  it('the host removes a singer or a listener from the meet, and they cannot come back; nobody else can, and never the host', () => {
    const m = newMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: null, trackTitle: '', catalogTrackId: null, backgroundId: 'bg' }, T0);
    const host = { ...person('host', 'u-host'), role: 'host' as const };
    const singer = person('singer');
    const fan = person('fan');
    claimSlot(m, host, 1);
    claimSlot(m, singer, 2);
    expect(kick(m, singer, fan)).toEqual({ ok: false, reason: 'not_host' });
    expect(kick(m, host, host)).toEqual({ ok: false, reason: 'self' });
    expect(kick(m, host, singer)).toEqual({ ok: true });
    expect(singer.slot).toBeNull();
    expect(m.stage.find((s) => s.slot === 2)?.participantId).toBeNull();
    expect(isBanned(m, singer.userId)).toBe(true);
    expect(kick(m, host, fan)).toEqual({ ok: true });
    expect(m.bannedUserIds).toEqual([singer.userId, fan.userId]);
    expect(isBanned(m, host.userId)).toBe(false);
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
    const cued = m.kickstartEpochMs;
    expect(start(m, 5000, T0 + 1000)).toEqual({ ok: true }); // a second singer's tap during the count-in: nothing moves
    expect(m.kickstartEpochMs).toBe(cued);
    expect(m.playback.epoch).toBe(1);
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
    expect(m.stagePolicy).toBe('open'); // a new meet: whoever has the link may sing
    const host = person('h', 'u-host');
    setStagePolicy(m, 'ask'); // the host would rather decide
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

  it('the song of the stage: one at a time — picked is up; two picked, the stage chooses and the other is dropped; song over → the next', () => {
    const m = newMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: null, trackTitle: '', catalogTrackId: null, backgroundId: 'bg' }, T0);
    const host = person('h', 'u-host');
    const a = person('a');
    claimSlot(m, host, 1);
    setStagePolicy(m, 'ask');
    expect(start(m, 5000, T0)).toEqual({ ok: false, reason: 'no_song' }); // nothing to sing yet
    expect(addSong(m, a, { trackId: 't1', catalogTrackId: 'c1', trackTitle: 'One' })).toMatchObject({ ok: false, reason: 'not_on_stage' }); // audience picks nothing
    decideRequest(m, a, true); // seated by the host
    // picked is up: the first pick is the song of the stage, nothing put forward, anyone on stage starts it
    expect(addSong(m, a, { trackId: 't1', catalogTrackId: 'c1', trackTitle: 'One', durationMs: 20_000 }, T0).ok).toBe(true);
    expect(m).toMatchObject({ trackId: 't1', catalogTrackId: 'c1', trackTitle: 'One', currentDurationMs: 20_000 });
    expect(m.setList).toHaveLength(0);
    expect(choicePending(m)).toBe(false);
    // a second singer picks another song at the same time: both are listed, the stage must choose
    expect(addSong(m, host, { trackId: null, catalogTrackId: 'c2', trackTitle: 'Two' }, T0 + 1).ok).toBe(true);
    expect(m.trackTitle).toBe('One');
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['Two']);
    expect(choicePending(m)).toBe(true);
    // the same song twice is never listed twice: the ids meet, or the title and length do (a singer's own copy)
    expect(addSong(m, host, { trackId: 'x-own', catalogTrackId: 'c2', trackTitle: 'Two (copy)' }, T0 + 3)).toMatchObject({ ok: true, duplicate: 'proposed' });
    expect(addSong(m, a, { trackId: 'own-1', catalogTrackId: null, trackTitle: ' one ', durationMs: 20_500 }, T0 + 3)).toMatchObject({ ok: true, duplicate: 'current' });
    expect(addSong(m, a, { trackId: 'own-1', catalogTrackId: null, trackTitle: 'One', durationMs: 60_000 }, T0 + 3).ok).toBe(true); // a namesake of another length is its own song
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['Two', 'One']);
    const fan = person('fan');
    expect(songAction(m, fan, m.setList[1]!.id, 'remove')).toMatchObject({ ok: false, reason: 'not_on_stage' }); // the audience withdraws nothing
    expect(songAction(m, a, m.setList[1]!.id, 'remove').ok).toBe(true); // a singer withdraws one
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['Two']);
    // the stage chooses: one tap, any singer — the chosen song is up, every other song put forward is dropped (the one that was up included)
    expect(chooseSong(m, fan, m.setList[0]!.id)).toMatchObject({ ok: false, reason: 'not_on_stage' });
    expect(chooseSong(m, a, m.setList[0]!.id)).toEqual({ ok: true });
    expect(m).toMatchObject({ trackTitle: 'Two', catalogTrackId: 'c2', trackId: null });
    expect(m.setList).toHaveLength(0);
    expect(chooseSong(m, a, 'song-gone')).toMatchObject({ ok: false, reason: 'no_song' });
    // …or keeps the one that is up: 'current' drops the rest
    addSong(m, host, { trackId: 't3', catalogTrackId: null, trackTitle: 'Three' }, T0 + 4);
    addSong(m, a, { trackId: 't4', catalogTrackId: null, trackTitle: 'Four' }, T0 + 5);
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['Three', 'Four']);
    expect(chooseSong(m, host, 'current')).toEqual({ ok: true });
    expect(m.trackTitle).toBe('Two');
    expect(m.setList).toHaveLength(0);
    // sing it: a song picked during the song waits for its end; the wait list waits for the song to end
    m.stage[0]!.ready = true;
    expect(start(m, 5000, T0 + 10).ok).toBe(true);
    const w = person('w');
    expect(requestStage(m, w, T0 + 11)).toEqual({ ok: true }); // asking is fine during a song…
    expect(decideRequest(m, w, true)).toEqual({ ok: false, reason: 'song_in_progress' }); // …seating waits
    expect(m.requests.map((r) => r.participantId)).toEqual(['w']);
    expect(addSong(m, host, { trackId: 't5', catalogTrackId: null, trackTitle: 'Five' }, T0 + 12).ok).toBe(true); // put forward for after the song
    expect(addSong(m, a, { trackId: 't6', catalogTrackId: null, trackTitle: 'Six' }, T0 + 13).ok).toBe(true);
    expect(m.trackTitle).toBe('Two'); // nothing is swapped under a running song
    expect(choicePending(m)).toBe(false); // nothing to settle while the song plays
    // choosing during the song keeps that one alone for after it
    expect(chooseSong(m, a, m.setList[1]!.id)).toEqual({ ok: true });
    expect(m.trackTitle).toBe('Two');
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['Six']);
    tick(m, T0 + 6000);
    expect(m.state).toBe('live');
    // song over → back to the lobby; the one song put forward is up by itself; stage and slots untouched, ready reset; the wait list is served now
    expect(nextSong(m, T0 + 30_000)).toEqual({ ok: true });
    expect(decideRequest(m, w, true)).toEqual({ ok: true });
    expect(w.slot).toBe(3);
    expect(m).toMatchObject({ state: 'lobby', kickstartEpochMs: null, trackTitle: 'Six', songCount: 1 });
    expect(m.playback.state).toBe('idle');
    expect(m.stage[0]!.participantId).toBe('h');
    expect(m.stage[0]!.ready).toBe(false);
    expect(m.setList).toHaveLength(0);
    // several put forward during a song: the song ends with nothing up and the choice open
    addSong(m, host, { trackId: 't7', catalogTrackId: null, trackTitle: 'Seven' }, T0 + 31_000);
    addSong(m, a, { trackId: 't8', catalogTrackId: null, trackTitle: 'Eight' }, T0 + 32_000);
    expect(choicePending(m)).toBe(true);
    expect(chooseSong(m, host, 'current')).toEqual({ ok: true }); // Six it is
    start(m, 5000, T0 + 40_000);
    addSong(m, host, { trackId: 't7', catalogTrackId: null, trackTitle: 'Seven' }, T0 + 41_000);
    addSong(m, a, { trackId: 't8', catalogTrackId: null, trackTitle: 'Eight' }, T0 + 42_000);
    tick(m, T0 + 45_000);
    // the 15-minute cap ends the song, not the meet
    expect(tick(m, T0 + 45_000 + MAX_LIVE_TAKE_MS + 1)).toBe(true);
    expect(m).toMatchObject({ state: 'lobby', trackId: null, songCount: 2 });
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['Seven', 'Eight']);
    expect(choicePending(m)).toBe(true);
    expect(start(m, 5000, T0 + 46_000 + MAX_LIVE_TAKE_MS)).toEqual({ ok: false, reason: 'choice_pending' }); // nothing starts until the stage chooses
    expect(chooseSong(m, a, m.setList[1]!.id)).toEqual({ ok: true });
    expect(m).toMatchObject({ trackTitle: 'Eight' });
    expect(m.setList).toHaveLength(0);
    // a withdrawal that leaves one song put forward with nothing up ends the choice: that song is up
    nextSong(m, T0 + 47_000 + MAX_LIVE_TAKE_MS);
    addSong(m, host, { trackId: 't9', catalogTrackId: null, trackTitle: 'Nine' }, T0 + 48_000 + MAX_LIVE_TAKE_MS);
    addSong(m, a, { trackId: 't10', catalogTrackId: null, trackTitle: 'Ten' }, T0 + 48_100 + MAX_LIVE_TAKE_MS);
    expect(m).toMatchObject({ trackTitle: 'Nine' });
    expect(m.setList.map((e) => e.trackTitle)).toEqual(['Ten']);
    addSong(m, host, { trackId: 't11', catalogTrackId: null, trackTitle: 'Eleven' }, T0 + 48_200 + MAX_LIVE_TAKE_MS);
    expect(choicePending(m)).toBe(true);
    expect(chooseSong(m, a, m.setList[0]!.id)).toEqual({ ok: true }); // Ten
    expect(start(m, 5000, T0 + 48_300 + MAX_LIVE_TAKE_MS).ok).toBe(true);
    addSong(m, host, { trackId: 't12', catalogTrackId: null, trackTitle: 'Twelve' }, T0 + 48_400 + MAX_LIVE_TAKE_MS);
    addSong(m, a, { trackId: 't13', catalogTrackId: null, trackTitle: 'Thirteen' }, T0 + 48_500 + MAX_LIVE_TAKE_MS);
    nextSong(m, T0 + 49_000 + MAX_LIVE_TAKE_MS); // over with two put forward: nothing up, the choice open
    expect(m.trackId).toBeNull();
    expect(songAction(m, host, m.setList[0]!.id, 'remove')).toEqual({ ok: true }); // Twelve withdrawn → Thirteen is up by itself
    expect(m).toMatchObject({ trackTitle: 'Thirteen', trackId: 't13' });
    expect(m.setList).toHaveLength(0);
    expect(choicePending(m)).toBe(false);
    expect(start(m, 5000, T0 + 49_100 + MAX_LIVE_TAKE_MS).ok).toBe(true);
    nextSong(m, T0 + 49_200 + MAX_LIVE_TAKE_MS);
    addSong(m, host, { trackId: 't14', catalogTrackId: null, trackTitle: 'Fourteen' }, T0 + 49_300 + MAX_LIVE_TAKE_MS);
    expect(m).toMatchObject({ trackTitle: 'Fourteen' });
    // nothing put forward: the song ends with nothing up, no song until somebody picks one
    nextSong(m, T0 + 50_000);
    expect(m.trackId).toBeNull();
    expect(start(m, 5000, T0 + 52_000)).toEqual({ ok: false, reason: 'no_song' });
    // rows from before the set list existed
    const legacy = { ...newMeet({ title: '', hostUserId: 'u', hostName: 'H', trackId: 'x', trackTitle: 'X', catalogTrackId: null, backgroundId: 'bg' }, T0) } as Partial<typeof m>;
    delete legacy.setList;
    delete legacy.songCount;
    expect(ensureMeet(legacy as typeof m)).toMatchObject({ setList: [], songCount: 0, trackTitle: 'X' });
  });
});
