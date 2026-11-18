/** The coupon gate (coupons.ts): codes as compared, the standing at the gate, the days left. */
import { describe, expect, it } from 'vitest';
import { accessOf, couponDaysLeft, displayCode, newCouponCode, normalizeCode } from '../src/coupons.ts';

const now = Date.parse('2026-11-18T12:00:00Z');
const coupon = { code: 'SV-ABCD2345', expiresAt: '2026-12-01T00:00:00Z' };

describe('coupon codes', () => {
  it('compare without case, spaces or dashes; a fresh one is SV- and eight unambiguous characters', () => {
    expect(normalizeCode(' sv-abcd 2345 ')).toBe('SVABCD2345');
    expect(normalizeCode('SV-ABCD2345')).toBe(normalizeCode('svabcd2345'));
    expect(displayCode('svabcd2345')).toBe('SV-ABCD2345');
    expect(displayCode('MYCLUB')).toBe('MYCLUB');
    const c = newCouponCode((n) => new Uint8Array(n).map((_, i) => i * 29));
    expect(c).toMatch(/^SV-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(newCouponCode((n) => new Uint8Array(n).map((_, i) => i * 29))).toBe(c);
    expect(new Set(Array.from({ length: 30 }, () => newCouponCode())).size).toBe(30);
  });
});

describe('the standing at the gate', () => {
  it('the gate off, or a super admin: in; else the issued coupon, the right code, the date not passed', () => {
    expect(accessOf({ required: false, superAdmin: false, coupon: null, entered: '', now })).toMatchObject({ required: false, ok: true, standing: 'ok' });
    expect(accessOf({ required: true, superAdmin: true, coupon: null, entered: '', now })).toMatchObject({ ok: true, standing: 'ok' });
    expect(accessOf({ required: true, superAdmin: false, coupon: null, entered: 'SV-ABCD2345', now })).toMatchObject({ ok: false, standing: 'none', note: expect.stringMatching(/No coupon is issued/) });
    expect(accessOf({ required: true, superAdmin: false, coupon, entered: '', now })).toMatchObject({ ok: false, standing: 'missing', expiresAt: coupon.expiresAt });
    expect(accessOf({ required: true, superAdmin: false, coupon, entered: 'SV-ZZZZ9999', now })).toMatchObject({ ok: false, standing: 'wrong' });
    expect(accessOf({ required: true, superAdmin: false, coupon, entered: 'sv abcd2345', now })).toMatchObject({ ok: true, standing: 'ok', entered: 'SVABCD2345', note: '' });
    expect(accessOf({ required: true, superAdmin: false, coupon: { ...coupon, expiresAt: '2026-11-18T11:59:59Z' }, entered: 'SV-ABCD2345', now })).toMatchObject({ ok: false, standing: 'expired', note: expect.stringMatching(/expired on 2026-11-18/) });
    // The admin changed the code: the code entered no longer opens the gate.
    expect(accessOf({ required: true, superAdmin: false, coupon: { ...coupon, code: 'SV-NEWC0DE2' }, entered: 'SV-ABCD2345', now })).toMatchObject({ ok: false, standing: 'wrong' });
    expect(couponDaysLeft(coupon, now)).toBe(13);
    expect(couponDaysLeft({ expiresAt: '2026-11-01T00:00:00Z' }, now)).toBeLessThan(0);
  });
});
