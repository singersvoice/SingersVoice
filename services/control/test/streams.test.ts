/** The push channels (events.ts, tv.ts): one participant, or one side of a TV screen, keeps a few streams at most — the oldest goes for a new one. */
import { describe, expect, it } from 'vitest';
import { MeetEvents, STREAMS_PER_PARTICIPANT } from '../src/events.ts';
import { TV_STREAMS_PER_SIDE, TvScreens } from '../src/tv.ts';

describe('stream caps', () => {
  it('a participant keeps at most a few event streams; the oldest is closed for a new one', () => {
    const ev = new MeetEvents();
    const ended: number[] = [];
    const offs = Array.from({ length: STREAMS_PER_PARTICIPANT + 2 }, (_, i) => ev.subscribe('meet-1', 'p-1', () => undefined, () => ended.push(i)));
    expect(ended).toEqual([0, 1]);
    expect(ev.listeners('meet-1')).toBe(STREAMS_PER_PARTICIPANT);
    // Another participant's streams are their own.
    ev.subscribe('meet-1', 'p-2', () => undefined, () => ended.push(99));
    expect(ended).toEqual([0, 1]);
    for (const off of offs) off();
  });
  it('a side of a TV screen keeps at most a few streams', () => {
    const tv = new TvScreens();
    const s = tv.create();
    const ended: string[] = [];
    for (let i = 0; i < TV_STREAMS_PER_SIDE + 1; i++) tv.subscribe(s.code, 'tv', () => undefined, () => ended.push(`tv${i}`));
    tv.subscribe(s.code, 'phone', () => undefined, () => ended.push('phone'));
    expect(ended).toEqual(['tv0']);
    expect(tv.listening(s.code, 'tv')).toBe(true);
    expect(tv.listening(s.code, 'phone')).toBe(true);
  });
});
