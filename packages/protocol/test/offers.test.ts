/** Offers and promo codes (offers.ts): what is on sale when, what a code gives and when it is refused. */
import { describe, expect, it } from 'vitest';
import { cleanOffer, cleanPromo, discountCents, freeUntil, offerOnSale, periodWords, promoLabel, promoPreview, promoRefusal } from '../src/offers.ts';
import { moneyLabel } from '../src/roles.ts';

const now = Date.parse('2026-11-20T12:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(now + days * DAY).toISOString();
const stamp = { createdAt: at(-1), updatedAt: at(-1) };
const offer = (o: Record<string, unknown>) => cleanOffer({ offerId: 'off-1', plan: 'svv', interval: 'month', intervalCount: 1, prices: { usd: 500 }, ...stamp, ...o } as Parameters<typeof cleanOffer>[0]);
const promo = (p: Record<string, unknown>) => cleanPromo({ code: 'SAVE20', kind: 'percent', value: 20, uses: 0, createdBy: 'alice', ...stamp, ...p } as Parameters<typeof cleanPromo>[0])!;

describe('offers', () => {
  it('are cleaned: a paid plan, a period of 1–36, prices in whole minor units and 3-letter currencies, dates as ISO or null, a title of a size', () => {
    const o = offer({ plan: 'nope', title: ' A year ', interval: 'year', intervalCount: 99, prices: { USD: 5000.4, inr: 0, xx: 10, eur: '1200' }, validFrom: '2026-12-01', validUntil: 'not a date', sort: '3' });
    expect(o).toMatchObject({ plan: 'free', title: 'A year', interval: 'year', intervalCount: 36, prices: { usd: 5000, eur: 1200 }, validFrom: '2026-12-01T00:00:00.000Z', validUntil: null, active: true, sort: 3 });
    expect(offer({ interval: 'week', intervalCount: 0 })).toMatchObject({ interval: 'month', intervalCount: 1 });
  });
  it('are on sale when active, between their dates, with a price', () => {
    expect(offerOnSale(offer({}), now)).toBe(true);
    expect(offerOnSale(offer({ active: false }), now)).toBe(false);
    expect(offerOnSale(offer({ validFrom: at(1) }), now)).toBe(false);
    expect(offerOnSale(offer({ validFrom: at(-1), validUntil: at(1) }), now)).toBe(true);
    expect(offerOnSale(offer({ validUntil: at(-1) }), now)).toBe(false);
    expect(offerOnSale(offer({ validUntil: new Date(now).toISOString() }), now)).toBe(false); // the instant itself is past
    expect(offerOnSale(offer({ prices: {} }), now)).toBe(false);
  });
  it('say their period in words', () => {
    expect(periodWords('month', 1)).toBe('a month');
    expect(periodWords('month', 3)).toBe('3 months');
    expect(periodWords('year', 1)).toBe('a year');
    expect(periodWords('year', 2)).toBe('2 years');
  });
});

describe('promo codes', () => {
  it('are cleaned: the code normalized (upper case, no spaces or dashes), a percent of 1–100, an amount with its currency, the paid plans only, once/forever, periods for a fee-void code', () => {
    expect(promo({ code: ' save-20 ', value: 250 })).toMatchObject({ code: 'SAVE20', kind: 'percent', value: 100, currency: null, plans: [], duration: 'once', freePeriods: 1, maxUses: 0, active: true });
    expect(promo({ code: 'TEN', kind: 'amount', value: 1000, currency: 'INR', duration: 'forever', plans: ['svv', 'free', 'nope', 'svv', 'club'] })).toMatchObject({ kind: 'amount', value: 1000, currency: 'inr', duration: 'forever', plans: ['svv', 'club'] });
    expect(promo({ code: 'AMT', kind: 'amount', value: 500 })).toMatchObject({ currency: 'usd' });
    expect(promo({ code: 'FREE', kind: 'free', value: 99, freePeriods: 3, duration: 'forever' })).toMatchObject({ kind: 'free', value: 0, freePeriods: 3, duration: 'forever' });
    expect(promo({ code: 'FREE', kind: 'free', freePeriods: 0 }).freePeriods).toBe(1);
    expect(promo({ code: 'XYZ', maxUses: -5, note: 'n'.repeat(300) })).toMatchObject({ maxUses: 0 });
    expect(promo({ code: 'XYZ', note: 'n'.repeat(300) }).note.length).toBe(200);
    expect(cleanPromo({ code: 'ab', uses: 0, createdBy: '', ...stamp })).toBeNull();
    expect(cleanPromo({ code: '--', uses: 0, createdBy: '', ...stamp })).toBeNull();
  });
  it('are refused when missing, off, expired, used up or for other plans — else not', () => {
    expect(promoRefusal(null, 'svv', now)).toBe('That code is not valid');
    expect(promoRefusal(promo({ active: false }), 'svv', now)).toBe('That code is not valid');
    expect(promoRefusal(promo({ validUntil: at(-1) }), 'svv', now)).toMatch(/expired on 2026-11-19/);
    expect(promoRefusal(promo({ validUntil: at(1) }), 'svv', now)).toBeNull();
    expect(promoRefusal(promo({ maxUses: 2, uses: 2 }), 'svv', now)).toBe('That code has been used up');
    expect(promoRefusal(promo({ maxUses: 2, uses: 1 }), 'svv', now)).toBeNull();
    expect(promoRefusal(promo({ plans: ['svv', 'club'] }), 'svvpro', now)).toBe('That code is for SVV, CLUB — not this plan');
    expect(promoRefusal(promo({ plans: ['svv', 'club'] }), 'club', now)).toBeNull();
  });
  it('take their discount off a payment: a percentage, an amount in the same currency (nothing in another), the whole of it for a fee-void code', () => {
    expect(discountCents(promo({ value: 20 }), 5000, 'usd')).toBe(1000);
    expect(discountCents(promo({ value: 33 }), 500, 'usd')).toBe(165);
    expect(discountCents(promo({ value: 100 }), 500, 'usd')).toBe(500);
    expect(discountCents(promo({ kind: 'amount', value: 1000, currency: 'usd' }), 5000, 'usd')).toBe(1000);
    expect(discountCents(promo({ kind: 'amount', value: 9000, currency: 'usd' }), 5000, 'USD')).toBe(5000);
    expect(discountCents(promo({ kind: 'amount', value: 1000, currency: 'usd' }), 5000, 'inr')).toBe(0);
    expect(discountCents(promo({ kind: 'free' }), 5000, 'usd')).toBe(5000);
  });
  it('grant a fee-void period: so many periods of the offer from the day', () => {
    expect(freeUntil('2026-11-20T12:00:00Z', 'month', 1, 3)).toBe('2027-02-20T12:00:00.000Z');
    expect(freeUntil('2026-11-20T12:00:00Z', 'month', 3, 1)).toBe('2027-02-20T12:00:00.000Z');
    expect(freeUntil('2026-11-20T12:00:00Z', 'year', 1, 2)).toBe('2028-11-20T12:00:00.000Z');
    expect(freeUntil('2026-11-20T12:00:00Z', 'month', 0, 0)).toBe('2026-12-20T12:00:00.000Z');
  });
  it('say what they give, in words, and show the Plans page only that', () => {
    expect(promoLabel(promo({ value: 20 }), moneyLabel)).toBe('20% off your first payment');
    expect(promoLabel(promo({ value: 20, duration: 'forever' }), moneyLabel)).toBe('20% off every payment');
    expect(promoLabel(promo({ kind: 'amount', value: 1000, currency: 'usd' }), moneyLabel)).toBe('$10.00 off your first payment');
    expect(promoLabel(promo({ kind: 'free', freePeriods: 3 }), moneyLabel)).toBe('3 periods free — no payment');
    expect(promoLabel(promo({ kind: 'free', freePeriods: 1 }), moneyLabel, { interval: 'month', intervalCount: 3 })).toBe('3 months free — no payment');
    expect(promoLabel(promo({ kind: 'free', freePeriods: 1 }), moneyLabel, { interval: 'year', intervalCount: 1 })).toBe('1 year free — no payment');
    const view = promoPreview(promo({ note: 'secret', plans: ['svv'] }), moneyLabel);
    expect(view).toEqual({ code: 'SAVE20', kind: 'percent', value: 20, currency: null, plans: ['svv'], duration: 'once', freePeriods: 1, label: '20% off your first payment' });
    expect('note' in view || 'uses' in view || 'createdBy' in view).toBe(false);
  });
});
