/**
 * Timing the live mix (video/align.ts): the plan made at the count-in — every other singer held back by what they
 * are early by, the lag growing for a slow link and never past its ceiling, a singer not yet measured held back by
 * nothing, a latecomer fitted to the plan as it stands.
 */
import { describe, expect, it } from 'vitest';
import { ALIGN_MARGIN_MS, alignLine, alignPlan, delayFor, LAG_MAX_MS, LAG_MIN_MS } from '../src/video/align.ts';

describe('timing the mix', () => {
  it('each other singer is held back by what they are early by against the track in the mix (the lag plus my round trip)', () => {
    const plan = alignPlan(90, [
      { id: 'bob', arrivalMs: 200 },
      { id: 'carol', arrivalMs: 300 },
    ]);
    expect(plan).toEqual({ lagMs: LAG_MIN_MS, trackDelayMs: 340, delays: { bob: 140, carol: 40 } });
  });

  it('a voice arriving later than the lag allows makes the lag grow for the song — by the margin, and never past the ceiling', () => {
    const slow = alignPlan(90, [{ id: 'bob', arrivalMs: 600 }]);
    expect(slow.lagMs).toBe(600 - 90 + ALIGN_MARGIN_MS);
    expect(slow.delays.bob).toBe(ALIGN_MARGIN_MS);
    const far = alignPlan(90, [{ id: 'bob', arrivalMs: 5000 }]);
    expect(far.lagMs).toBe(LAG_MAX_MS);
    expect(far.delays.bob).toBe(0); // as early as it gets: nothing more to hold back
  });

  it('a singer not measured yet is held back by nothing; nobody linked is the plain lag', () => {
    expect(alignPlan(90, [{ id: 'bob', arrivalMs: null }])).toEqual({ lagMs: LAG_MIN_MS, trackDelayMs: 340, delays: { bob: 0 } });
    expect(alignPlan(0, [])).toEqual({ lagMs: LAG_MIN_MS, trackDelayMs: LAG_MIN_MS, delays: {} });
  });

  it('a latecomer is fitted to the plan as it stands; the line names them', () => {
    const plan = alignPlan(90, [{ id: 'bob', arrivalMs: 200 }]);
    expect(delayFor(plan, 260)).toBe(80);
    expect(delayFor(plan, 900)).toBe(0);
    expect(alignLine(plan, (id) => id)).toBe('bob +140 ms (lag 250 ms)');
    expect(alignLine(alignPlan(0, []), (id) => id)).toBe('(lag 250 ms)');
  });
});
