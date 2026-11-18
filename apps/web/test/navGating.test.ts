/**
 * Who sees what in the menu (components/Shell.tsx): Publishing is listed for the accounts it is open to —
 * a club owner with an active plan, a super admin — and for nobody else; Admin for super admins alone; the
 * Plans page for everyone who is not a super admin; My club for a club owner with seats of their own.
 */
import type { Entitlement, UserSubscription } from '@singersvoice/protocol';
import { describe, expect, it } from 'vitest';

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
(globalThis as { sessionStorage?: unknown }).sessionStorage = fakeStorage;
const { setPlan, setRole } = await import('../src/state/session.ts');
const { NAV, navAllowed, visibleNav } = await import('../src/components/Shell.tsx');

const labels = () => visibleNav().map((n) => n.label);
const children = () => visibleNav().flatMap((n) => (n.children ?? []).filter((c) => navAllowed(c.when)).map((c) => c.label));
const sub = (plan: string, status: UserSubscription['status'] = 'active'): UserSubscription => ({ plan, startedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', status, source: 'stripe', updatedAt: null });
const ent = (p: Partial<Entitlement>): Entitlement => ({ plan: 'free', planTitle: 'Free', via: 'none', video: false, videoHours: 0, videoUsedSeconds: 0, videoLeftSeconds: 0, periodKey: '2026-11', resetsAt: '2026-12-01T00:00:00.000Z', clubOwner: null, seatsUsed: 0, seats: 0, publishing: false, videoNote: '', ...p });

describe('the menu by account', () => {
  it('a singer (free, SVV): no Publishing, no Admin, no club; the Plans page under Settings', () => {
    setRole('dual', null, 'Publishing mode is for club owners', 'audio', ent({}));
    setPlan('free', null, false);
    expect(labels()).toEqual(['Home', 'Tracks', 'Studio', 'Live Meets', 'Performances', 'Settings']);
    expect(children()).toEqual(['Track Maker', 'Plans']);
    setRole('dual', sub('svv'), 'Publishing mode comes with the Club owner plan', 'dual', ent({ plan: 'svv', planTitle: 'SVV', via: 'own', video: true, videoHours: 10, videoLeftSeconds: 36000 }));
    setPlan('svv', '2027-01-01T00:00:00Z', false);
    expect(labels()).not.toContain('Publishing');
    expect(children()).toEqual(['Track Maker', 'Plans']);
  });

  it('a club owner: Publishing and My club while the plan is open, gone when it has run out; the Plans page stays to renew it', () => {
    setRole('club_owner', sub('club'), '', 'dual', ent({ plan: 'club', planTitle: 'Club owner', via: 'own', video: true, videoHours: 300, videoLeftSeconds: 300 * 3600, seats: 15, seatsUsed: 3, publishing: true }));
    setPlan('club', '2027-01-01T00:00:00Z', true);
    expect(labels()).toEqual(['Home', 'Tracks', 'Studio', 'Live Meets', 'Publishing', 'Performances', 'Settings']);
    expect(children()).toEqual(['Track Maker', 'Plans', 'My club']);
    setRole('club_owner', sub('club', 'expired'), 'Your club owner subscription expired on 2026-01-01 — renew it on the Plans page', 'audio', ent({}));
    setPlan('free', '2026-01-01T00:00:00Z', false);
    expect(labels()).not.toContain('Publishing');
    expect(children()).toEqual(['Track Maker', 'Plans']);
  });

  it("a club member: the club's picture, no Publishing, no club of their own", () => {
    setRole('dual', null, 'Publishing mode is for club owners', 'dual', ent({ plan: 'club', planTitle: 'Club owner', via: 'club', video: true, videoHours: 300, videoLeftSeconds: 1000, clubOwner: { userId: 'g-1', name: 'Grace' } }));
    setPlan('club', null, false);
    expect(labels()).not.toContain('Publishing');
    expect(children()).toEqual(['Track Maker', 'Plans']);
  });

  it('a super admin: Publishing, Admin and Coupons, and no Plans or club page of their own (the Admin page has it all)', () => {
    setRole('super_admin', null, '', 'dual', ent({ plan: 'club', planTitle: 'Club owner', via: 'super_admin', video: true, videoHours: 300, videoLeftSeconds: null, publishing: true, seats: 15 }));
    setPlan('club', null, true);
    expect(labels()).toContain('Publishing');
    expect(children()).toEqual(['Track Maker', 'Admin', 'Coupons']);
    expect(NAV.find((n) => n.label === 'Publishing')?.when).toBe('publish');
  });
});
