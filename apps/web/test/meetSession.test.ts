import { describe, expect, it, vi } from 'vitest';
import type { MeetSnapshot, Participant, RoomUpdate } from '@singersvoice/protocol';

// lib/api.ts reads the storages as it loads; nothing leaves this test.
const store = new Map<string, string>();
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
(globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
(globalThis as { sessionStorage?: unknown }).sessionStorage = fakeStorage;
vi.stubGlobal('fetch', () => Promise.reject(new Error('offline in tests')));
const { MeetSession } = await import('../src/portals/meets/meetSession.ts');

// The session's state against the service's clock: an answer that reaches the page after a newer room was pushed
// (an action's answer held up on a busy device; a heartbeat's answer that crossed a push) must not turn the clock
// back — a listener who had just come in would be gone from the host's list until the next heartbeat.
const person = (name: string, slot: number | null = null, role: Participant['role'] = 'audience'): Participant => ({ participantId: `p-${name}`, userId: `u-${name}`, displayName: name, picture: '', role, slot, stageRequest: 'none', joinedAt: '', lastSeenAt: '' });
const meet = { meetId: 'm1', state: 'lobby', expiresAt: new Date(Date.now() + 60_000).toISOString(), stage: [{ slot: 1, participantId: 'p-bob' }], requests: [], audienceCount: 1 };
const snap = (at: number, names: string[], extra: Partial<MeetSnapshot> = {}): MeetSnapshot => ({ meet, participants: [person('bob', 1, 'host'), ...names.map((n) => person(n))], chat: [], recordings: [], performances: [], serverEpochMs: at, ...extra }) as unknown as MeetSnapshot;
const room = (at: number, names: string[]): RoomUpdate => ({ meet, participants: [person('bob', 1, 'host'), ...names.map((n) => person(n))], recordings: [], performances: [], serverEpochMs: at }) as unknown as RoomUpdate;
const names = (s: InstanceType<typeof MeetSession>) => (s.snapshot.value?.participants ?? []).map((p) => p.displayName).join(',');

describe('meet session state and the service clock', () => {
  it('keeps the newer room when an older answer arrives after it, and takes the answer\'s own lines', () => {
    const s = new MeetSession('m1');
    const priv = s as unknown as { apply: (snap: MeetSnapshot) => void; applyRoom: (room: RoomUpdate) => void };
    priv.apply(snap(1000, ['dave']));
    expect(names(s)).toBe('bob,dave');
    priv.applyRoom(room(2000, ['dave', 'erin'])); // the stream: erin came in
    expect(names(s)).toBe('bob,dave,erin');
    // The host's own action (the members-only switch), answered before erin came in but read by the page after the push
    priv.apply(snap(1500, ['dave'], { yourVideo: { leftSeconds: 100, note: '', reason: '' }, chat: [{ id: 'c1', seq: 1, meetId: 'm1', participantId: 'p-dave', displayName: 'dave', text: 'hi', sentAt: '' }] } as Partial<MeetSnapshot>));
    expect(names(s)).toBe('bob,dave,erin'); // erin stays
    expect(s.yourVideo.value?.leftSeconds).toBe(100); // the hours are this device's own: taken
    expect(s.chat.value.map((c) => c.text)).toEqual(['hi']); // the chat is merged by sequence: taken
    priv.applyRoom(room(1800, ['dave'])); // an older room (a stream catching up): nothing to learn
    expect(names(s)).toBe('bob,dave,erin');
    priv.apply(snap(2500, ['dave', 'erin', 'fay'])); // newer: applied
    expect(names(s)).toBe('bob,dave,erin,fay');
    priv.apply(snap(2500, ['dave', 'erin'])); // the same instant: applied (not older)
    expect(names(s)).toBe('bob,dave,erin');
  });

  it('applies an answer without a clock (an older service) as it comes', () => {
    const s = new MeetSession('m2');
    const priv = s as unknown as { apply: (snap: MeetSnapshot) => void };
    priv.apply(snap(1000, ['dave']));
    priv.apply(snap(undefined as unknown as number, ['dave', 'erin']));
    expect(names(s)).toBe('bob,dave,erin');
  });
});
