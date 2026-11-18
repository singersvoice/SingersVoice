/** Roles and the club owner year (roles.ts): the standing with grace days, the days left, the reasons, the money. */
import { describe, expect, it } from 'vitest';
import { daysLeft, moneyLabel, publishingClosedReason, publishingOpen, subscriptionStatus, yearFrom } from '../src/roles.ts';
import { DEFAULT_BILLING_SETTINGS } from '../src/plans.ts';

const DAY = 86_400_000;
const now = Date.parse('2026-11-17T12:00:00Z');
const sub = (expiresAt: string | null, status: 'active' | 'revoked' | 'none' = 'active', plan = 'club') => ({ plan, startedAt: '2025-11-17T12:00:00Z', expiresAt, status, source: 'grant' as const, updatedAt: null });

describe('the standing of a club owner year', () => {
  it('runs out by itself on the day — or after the grace days the admin allows', () => {
    expect(subscriptionStatus(sub(new Date(now + DAY).toISOString()), now)).toBe('active');
    expect(subscriptionStatus(sub(new Date(now - 1).toISOString()), now)).toBe('expired');
    expect(subscriptionStatus(sub(new Date(now - 3 * DAY).toISOString()), now, 7)).toBe('active'); // three days past, a week of grace
    expect(subscriptionStatus(sub(new Date(now - 8 * DAY).toISOString()), now, 7)).toBe('expired');
    expect(subscriptionStatus(sub(null), now)).toBe('active'); // a standing grant has no end
    expect(subscriptionStatus(sub('2030-01-01T00:00:00Z', 'revoked'), now, 30)).toBe('revoked'); // revoked is revoked, whatever the dates
    expect(subscriptionStatus(null, now)).toBe('none');
    expect(subscriptionStatus(sub('2030-01-01T00:00:00Z', 'none'), now)).toBe('none');
  });

  it('opens Publishing to a super admin always, to a plan that carries it while the subscription is active (grace included), to nobody else', () => {
    expect(publishingOpen('super_admin', null, false, now)).toBe(true);
    expect(publishingOpen('club_owner', sub(new Date(now + DAY).toISOString()), true, now)).toBe(true);
    expect(publishingOpen('club_owner', sub(new Date(now - DAY).toISOString()), true, now)).toBe(false);
    expect(publishingOpen('club_owner', sub(new Date(now - DAY).toISOString()), true, now, 2)).toBe(true);
    expect(publishingOpen('dual', sub(new Date(now + DAY).toISOString(), 'active', 'svv'), false, now)).toBe(false); // SVV carries no Publishing
    expect(publishingOpen('audio', null, false, now)).toBe(false);
  });

  it('says why it is closed, pointing at the Plans page', () => {
    expect(publishingClosedReason('dual', null, false, now)).toMatch(/for club owners — the Club owner plan on the Plans page/);
    expect(publishingClosedReason('dual', sub(new Date(now + DAY).toISOString(), 'active', 'svv'), false, now)).toMatch(/comes with the Club owner plan/);
    expect(publishingClosedReason('club_owner', sub('2026-01-01T00:00:00Z'), true, now)).toBe('Your club owner subscription expired on 2026-01-01 — renew it on the Plans page');
    expect(publishingClosedReason('club_owner', sub('2026-01-01T00:00:00Z'), true, now, 365)).toBe(''); // within a year of grace: open, no reason
    expect(publishingClosedReason('club_owner', sub('2030-01-01T00:00:00Z', 'revoked'), true, now)).toMatch(/revoked/);
    expect(publishingClosedReason('super_admin', null, false, now)).toBe('');
  });

  it('counts the days left (negative once past, none without an end), and a year is a calendar year', () => {
    expect(daysLeft(sub(new Date(now + 10 * DAY).toISOString()), now)).toBe(10);
    expect(daysLeft(sub(new Date(now + 10 * DAY + 1).toISOString()), now)).toBe(11); // part of a day counts as a day
    expect(daysLeft(sub(new Date(now - 3 * DAY).toISOString()), now)).toBe(-3);
    expect(daysLeft(sub(null), now)).toBeNull();
    expect(daysLeft(null, now)).toBeNull();
    expect(yearFrom('2026-11-17T12:00:00Z')).toBe('2027-11-17T12:00:00.000Z');
    expect(yearFrom('2028-02-29T00:00:00Z')).toBe('2029-03-01T00:00:00.000Z');
  });

  it('shows money in the currency, and the defaults sell nothing until the admin sets a price', () => {
    expect(moneyLabel(4900, 'usd')).toMatch(/49\.00/);
    expect(moneyLabel(4900, 'usd')).toMatch(/\$/);
    expect(moneyLabel(150000, 'inr')).toMatch(/1,?500/);
    expect(moneyLabel(500, 'xxx')).toMatch(/5\.00/); // an unknown code still reads as money
    expect(DEFAULT_BILLING_SETTINGS).toMatchObject({ note: '', expiringSoonDays: 7, graceDays: 0 });
    expect(DEFAULT_BILLING_SETTINGS.plans.map((p) => p.id)).toEqual(['free', 'svv', 'svvpro', 'club']);
  });
});
