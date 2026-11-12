import { describe, expect, it } from 'vitest';
import { MAX_LIVE_TAKE_MS, MAX_PERFORMERS, MEET_IDLE_EXPIRY_MS, playbackPositionMs, type Participant } from '@singersvoice/protocol';
import { claimSlot, ensurePlayback, newMeet, pause, reconcile, resume, start, stop, tick, touch } from '../src/meets.ts';

const T0 = Date.parse('2026-11-11T10:00:00Z');
const person = (id: string, userId = `u-${id}`): Participant => ({
  participantId: id,
  userId,
  displayName: id,
  picture: '',
  role: 'audience',
  slot: null,
  joinedAt: new Date(T0).toISOString(),
  lastSeenAt: new Date(T0).toISOString(),
});

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
    const m = newMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: null, trackTitle: '', catalogTrackId: null, backgroundId: 'bg' }, T0);
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
    const m = newMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: 'trk', trackTitle: 'AA', catalogTrackId: null, backgroundId: 'bg' }, T0);
    expect(start(m, 5000, T0)).toEqual({ ok: false, reason: 'no_performers' });
    claimSlot(m, person('p1'), 1);
    expect(start(m, 5000, T0)).toEqual({ ok: true });
    expect(m.state).toBe('countdown');
    expect(m.kickstartEpochMs).toBe(T0 + 5000);
    expect(claimSlot(m, person('p2'), 2).ok).toBe(true); // still allowed during countdown
    tick(m, T0 + 5001);
    expect(m.state).toBe('live');
    expect(claimSlot(m, person('p3'), 3)).toEqual({ ok: false, reason: 'already_live' });
    stop(m, T0 + 60_000);
    expect(m.state).toBe('ended');
    expect(m.kickstartEpochMs).toBeNull();
  });

  it('pause freezes the shared position; resume and restart cue a new kickstart with a new epoch', () => {
    const m = newMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: 'trk', trackTitle: 'AA', catalogTrackId: null, backgroundId: 'bg' }, T0);
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
    const m = newMeet({ title: '', hostUserId: 'u-host', hostName: 'Host', trackId: 'trk', trackTitle: 'AA', catalogTrackId: null, backgroundId: 'bg' }, T0);
    claimSlot(m, person('p1'), 1);
    start(m, 3000, T0);
    tick(m, T0 + 3000);
    delete (m as { playback?: unknown }).playback;
    ensurePlayback(m);
    expect(m.playback.state).toBe('playing');
    expect(playbackPositionMs(m, T0 + 4000)).toBe(1000);
  });
});
