/** The plans and the entitlement (plans.ts): the defaults, the periods, the hours, who gets the picture and why not. */
import { describe, expect, it } from 'vitest';
import { asPlanId, cleanPlan, completePlans, DEFAULT_PLANS, entitlementOf, hoursLabel, mediaOfEntitlement, periodEnd, periodKey, periodLabel, periodResetsAt, planOf } from '../src/plans.ts';
import type { UserSubscription } from '../src/roles.ts';

const now = Date.parse('2026-11-17T15:00:00Z');
const DAY = 86_400_000;
const sub = (plan: string, expiresAt: string | null = new Date(now + 10 * DAY).toISOString(), status: UserSubscription['status'] = 'active'): UserSubscription => ({ plan, startedAt: '2026-11-01T00:00:00Z', expiresAt, status, source: 'grant', updatedAt: null });
const base = { role: 'dual' as const, subscription: null, plans: DEFAULT_PLANS, club: null, usedSeconds: 0, seatsUsed: 0, now, graceDays: 0 };

describe('the plans', () => {
  it('are the four, with the prices, periods, hours and seats asked for', () => {
    expect(DEFAULT_PLANS.map((p) => [p.id, p.title, p.prices.usd ?? 0, p.interval, p.videoHours, p.seats, p.publishing, p.selfService])).toEqual([
      ['free', 'Free', 0, 'month', 0, 0, false, false],
      ['svv', 'SVV', 500, 'month', 10, 0, false, true],
      ['svvpro', 'SVVPro', 5000, 'month', 100, 0, false, true],
      ['club', 'Club owner', 25000, 'month', 300, 15, true, true],
    ]);
    expect(asPlanId('publisher')).toBe('club'); // an older row
    expect(asPlanId('gold')).toBe('free');
    expect(planOf(DEFAULT_PLANS, 'svvpro').videoHours).toBe(100);
    expect(planOf([], 'svv').id).toBe('free');
  });

  it('are kept within bounds, and a saved list missing one gets the default back', () => {
    const c = cleanPlan({ ...planOf(DEFAULT_PLANS, 'svv'), prices: { USD: 700, inr: 42500, euro: 5, gbp: 0 }, intervalCount: 0, videoHours: -3, seats: 2000, title: '  ' });
    expect(c).toMatchObject({ prices: { usd: 700, inr: 42500 }, intervalCount: 1, videoHours: 0, seats: 1000, title: 'svv' });
    expect(cleanPlan({ ...planOf(DEFAULT_PLANS, 'free'), prices: { usd: 100 }, selfService: true })).toMatchObject({ prices: {}, selfService: false }); // free stays free
    const done = completePlans([{ id: 'club', interval: 'year', prices: { usd: 250000 } }]);
    expect(done.map((p) => p.id)).toEqual(['free', 'svv', 'svvpro', 'club']);
    expect(done[3]).toMatchObject({ interval: 'year', prices: { usd: 250000 }, videoHours: 300, seats: 15 });
    expect(done[1]).toEqual(planOf(DEFAULT_PLANS, 'svv'));
  });

  it('count the month by the calendar (UTC) and the period by the plan', () => {
    expect(periodKey(now)).toBe('2026-11');
    expect(periodResetsAt(now)).toBe('2026-12-01T00:00:00.000Z');
    expect(periodResetsAt(Date.parse('2026-12-31T23:59:59Z'))).toBe('2027-01-01T00:00:00.000Z');
    expect(periodLabel('2026-11')).toMatch(/Nov/);
    expect(periodEnd('2026-11-17T15:00:00Z', 'month', 1)).toBe('2026-12-17T15:00:00.000Z');
    expect(periodEnd('2026-11-17T15:00:00Z', 'month', 3)).toBe('2027-02-17T15:00:00.000Z');
    expect(periodEnd('2026-11-17T15:00:00Z', 'year', 1)).toBe('2027-11-17T15:00:00.000Z');
    expect(hoursLabel(0)).toBe('0 m');
    expect(hoursLabel(45 * 60 + 59)).toBe('45 m');
    expect(hoursLabel(9 * 3600 + 20 * 60)).toBe('9 h 20 m');
  });
});

describe('the entitlement', () => {
  it('a free account: the voice alone in meets, and why', () => {
    const e = entitlementOf(base);
    expect(e).toMatchObject({ plan: 'free', via: 'none', video: false, videoHours: 0, videoLeftSeconds: 0, publishing: false, periodKey: '2026-11', resetsAt: '2026-12-01T00:00:00.000Z' });
    expect(e.videoNote).toMatch(/Free accounts sing with the voice alone/);
    expect(mediaOfEntitlement(e)).toBe('audio');
  });

  it('an own plan: the picture while hours are left, the voice alone once they are used up, Publishing with the club plan only', () => {
    const svv = entitlementOf({ ...base, subscription: sub('svv'), usedSeconds: 3600 });
    expect(svv).toMatchObject({ plan: 'svv', planTitle: 'SVV', via: 'own', video: true, videoHours: 10, videoUsedSeconds: 3600, videoLeftSeconds: 32400, publishing: false, videoNote: '' });
    const out = entitlementOf({ ...base, subscription: sub('svv'), usedSeconds: 36000 });
    expect(out).toMatchObject({ video: false, videoLeftSeconds: 0 });
    expect(out.videoNote).toBe('Your 10 video hours for Nov 2026 are used up — the voice alone on stage until 2026-12-01');
    const club = entitlementOf({ ...base, role: 'club_owner', subscription: sub('club'), seatsUsed: 4 });
    expect(club).toMatchObject({ plan: 'club', via: 'own', video: true, videoHours: 300, seats: 15, seatsUsed: 4, publishing: true });
    const expired = entitlementOf({ ...base, subscription: sub('svv', '2026-11-01T00:00:00Z') });
    expect(expired).toMatchObject({ plan: 'free', via: 'none', video: false });
    const revoked = entitlementOf({ ...base, subscription: sub('club', null, 'revoked') });
    expect(revoked.plan).toBe('free');
    const graced = entitlementOf({ ...base, subscription: sub('svv', new Date(now - DAY).toISOString()), graceDays: 3 });
    expect(graced).toMatchObject({ plan: 'svv', video: true }); // a day past, within the grace days
  });

  it("a club member: the club's plan and pool, no Publishing, no seats of their own; their own plan beats the club's", () => {
    const club = { ownerUserId: 'g-owner', ownerName: 'Grace', subscription: sub('club') };
    const member = entitlementOf({ ...base, club, usedSeconds: 1000 });
    expect(member).toMatchObject({ plan: 'club', via: 'club', video: true, videoHours: 300, videoUsedSeconds: 1000, clubOwner: { userId: 'g-owner', name: 'Grace' }, publishing: false, seats: 0, seatsUsed: 0 });
    const drained = entitlementOf({ ...base, club, usedSeconds: 300 * 3600 });
    expect(drained.video).toBe(false);
    expect(drained.videoNote).toBe("Grace's club has used its 300 video hours for Nov 2026 — the voice alone on stage until 2026-12-01");
    const ownFirst = entitlementOf({ ...base, club, subscription: sub('svvpro'), usedSeconds: 0 });
    expect(ownFirst).toMatchObject({ plan: 'svvpro', via: 'own' });
    const lapsedClub = entitlementOf({ ...base, club: { ...club, subscription: sub('club', '2026-11-01T00:00:00Z') } });
    expect(lapsedClub).toMatchObject({ plan: 'free', via: 'none' });
    const noSeats = entitlementOf({ ...base, club: { ...club, subscription: sub('svv') } }); // a "club" whose plan has no seats is none
    expect(noSeats.via).toBe('none');
  });

  it('a super admin has everything without limit; an audio-only role has no picture whatever the plan', () => {
    const admin = entitlementOf({ ...base, role: 'super_admin', usedSeconds: 999999 });
    expect(admin).toMatchObject({ via: 'super_admin', video: true, videoLeftSeconds: null, publishing: true, plan: 'club' });
    const audio = entitlementOf({ ...base, role: 'audio', subscription: sub('svvpro') });
    expect(audio).toMatchObject({ plan: 'svvpro', video: false });
    expect(audio.videoNote).toMatch(/audio only/);
    expect(mediaOfEntitlement(audio)).toBe('audio');
  });
});
