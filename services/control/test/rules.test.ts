import { describe, expect, it } from 'vitest';
import { MAX_PERFORMERS, MEET_IDLE_EXPIRY_MS, type Participant } from '@singersvoice/protocol';
import { claimSlot, newMeet, reconcile, start, stop, tick, touch } from '../src/meets.ts';

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
});
