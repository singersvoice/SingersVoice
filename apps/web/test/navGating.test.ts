/**
 * Who sees what in the menu (components/Shell.tsx): Publishing is listed for the accounts it is open to —
 * a club owner with an active year, a super admin — and for nobody else; Admin for super admins alone; the
 * Club owner page for everyone who is not a super admin.
 */
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

describe('the menu by account', () => {
  it('a singer (dual, audio): no Publishing, no Admin; the Club owner page under Settings', () => {
    setRole('dual', null, 'Publishing mode is for club owners — become one on the Club owner page');
    setPlan('free', null, false);
    expect(labels()).toEqual(['Home', 'Tracks', 'Studio', 'Live Meets', 'Performances', 'Settings']);
    expect(children()).toEqual(['Track Maker', 'Club owner']);
    setRole('audio', null, '');
    expect(labels()).not.toContain('Publishing');
    expect(children()).not.toContain('Admin');
  });

  it('a club owner: Publishing while the year is open, gone when it has run out; the Club owner page stays to renew it', () => {
    setRole('club_owner', { startedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', status: 'active', source: 'stripe', updatedAt: null }, '');
    setPlan('publisher', '2027-01-01T00:00:00Z', true);
    expect(labels()).toEqual(['Home', 'Tracks', 'Studio', 'Live Meets', 'Publishing', 'Performances', 'Settings']);
    expect(children()).toEqual(['Track Maker', 'Club owner']);
    setRole('club_owner', { startedAt: '2025-01-01T00:00:00Z', expiresAt: '2026-01-01T00:00:00Z', status: 'expired', source: 'stripe', updatedAt: null }, 'Your club owner subscription expired on 2026-01-01 — renew it on the Club owner page');
    setPlan('publisher', '2026-01-01T00:00:00Z', false);
    expect(labels()).not.toContain('Publishing');
    expect(children()).toContain('Club owner');
  });

  it('a super admin: Publishing and Admin, and no Club owner page of their own (the Admin page has the club owners)', () => {
    setRole('super_admin', null, '');
    setPlan('free', null, true);
    expect(labels()).toContain('Publishing');
    expect(children()).toEqual(['Track Maker', 'Admin']);
    expect(NAV.find((n) => n.label === 'Publishing')?.when).toBe('publish');
  });
});
