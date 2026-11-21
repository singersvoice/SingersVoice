/**
 * The ways to pay for a plan, and the codes that cut the price.
 *
 * Offers — the table of valid options per plan: each one a period (a month, a year, three months…)
 * with its prices per currency, on sale between two dates (a launch price until the end of the year,
 * a yearly price that stays). The Plans page shows a plan's offers that are on sale now as its
 * choices; a plan with no offer sells at its own price and period (plans.ts) as before. The super
 * admin keeps the offers on the Admin page; they live in their own table (`plan_offers`), never in
 * the plan itself.
 *
 * Promo codes — the coupons on a payment: a percentage off, an amount off in one currency, or the
 * fee voided (the plan for a number of periods without a payment at all). A code is good for some
 * plans or all, until a date, for so many uses, once per account. Percent and amount codes become a
 * Stripe coupon on the Checkout (created on Stripe the first time the code is used, its id kept);
 * a fee-void code never reaches Stripe: the service grants the plan itself and records a payment of
 * 0 with the code. The account's master row (`users`) holds the plan and its end date as always;
 * the uses are kept by account (`promo_uses`): a code is used once per account, whatever it is
 * typed on.
 */
import type { PlanId, PlanInterval } from './plans.ts';
import { PLAN_IDS, asPlanId, periodEnd } from './plans.ts';
import { normalizeCode } from './coupons.ts';

export interface PlanOffer {
  offerId: string;
  plan: PlanId;
  /** "Monthly", "A year — two months free", "Launch price": the button's words. */
  title: string;
  interval: PlanInterval;
  intervalCount: number;
  /** The price of one period, per currency (minor units: 500 = $5.00); none in a currency = not for sale in it. */
  prices: Record<string, number>;
  /** ISO; null = on sale now / with no end. */
  validFrom: string | null;
  validUntil: string | null;
  /** Off: kept but not for sale (the admin's switch). */
  active: boolean;
  /** The order on the Plans page (lowest first). */
  sort: number;
  createdAt: string;
  updatedAt: string;
}

/** What the admin sends to make or change an offer. */
export type PlanOfferInput = Partial<Omit<PlanOffer, 'offerId' | 'createdAt' | 'updatedAt'>>;

export type PromoKind = 'percent' | 'amount' | 'free';

export interface PromoCode {
  /** As compared: upper case, no spaces or dashes (`normalizeCode`). */
  code: string;
  kind: PromoKind;
  /** percent: 1–100; amount: minor units of `currency`; free: unused. */
  value: number;
  /** amount: the currency the amount is in (a payment in another currency cannot use it). */
  currency: string | null;
  /** The plans it is good for; empty = every paid plan. */
  plans: PlanId[];
  /** percent / amount: on the first payment only, or on every renewal too (Stripe's coupon duration). */
  duration: 'once' | 'forever';
  /** free: how many periods of the offer are granted without a payment (1 = one period). */
  freePeriods: number;
  /** 0 = without limit. */
  maxUses: number;
  uses: number;
  validUntil: string | null;
  active: boolean;
  note: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type PromoCodeInput = Partial<Omit<PromoCode, 'uses' | 'createdBy' | 'createdAt' | 'updatedAt'>>;

/** A code as the Plans page learns of it before paying: what it gives, for which plans. */
export interface PromoPreview {
  code: string;
  kind: PromoKind;
  value: number;
  currency: string | null;
  plans: PlanId[];
  duration: 'once' | 'forever';
  freePeriods: number;
  /** In words: "20% off your first payment", "₹100 off", "3 months free". */
  label: string;
}

const num = (v: unknown, lo: number, hi: number, fallback: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : fallback);
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const cleanPrices = (prices: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!prices || typeof prices !== 'object') return out;
  for (const [cur, cents] of Object.entries(prices as Record<string, unknown>)) {
    if (!/^[a-z]{3}$/i.test(cur)) continue;
    const n = num(cents, 0, 100_000_000, 0);
    if (n > 0) out[cur.toLowerCase()] = n;
  }
  return out;
};

/** An offer within bounds (prices in whole minor units, a period of 1–36 months or years, dates as ISO). */
export function cleanOffer(o: PlanOfferInput & Pick<PlanOffer, 'offerId' | 'createdAt' | 'updatedAt'>): PlanOffer {
  return {
    offerId: o.offerId,
    plan: asPlanId(o.plan),
    title: String(o.title ?? '').trim().slice(0, 60),
    interval: o.interval === 'year' ? 'year' : 'month',
    intervalCount: num(o.intervalCount, 1, 36, 1),
    prices: cleanPrices(o.prices),
    validFrom: iso(o.validFrom),
    validUntil: iso(o.validUntil),
    active: o.active !== false,
    sort: num(o.sort, -1000, 1000, 0),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/** An offer is on sale now: active, between its dates, with a price in some currency. */
export function offerOnSale(o: Pick<PlanOffer, 'active' | 'validFrom' | 'validUntil' | 'prices'>, now: number = Date.now()): boolean {
  if (!o.active) return false;
  if (o.validFrom && Date.parse(o.validFrom) > now) return false;
  if (o.validUntil && Date.parse(o.validUntil) <= now) return false;
  return Object.keys(o.prices).length > 0;
}

/** "a month", "a year", "3 months", "2 years". */
export function periodWords(interval: PlanInterval, count: number): string {
  const n = Math.max(1, Math.round(count));
  return n === 1 ? `a ${interval}` : `${n} ${interval}s`;
}

/** A promo code within bounds; the code itself normalized (null when there is no code left after that). */
export function cleanPromo(p: PromoCodeInput & Pick<PromoCode, 'uses' | 'createdBy' | 'createdAt' | 'updatedAt'>): PromoCode | null {
  const code = normalizeCode(String(p.code ?? ''));
  if (!code || code.length < 3) return null;
  const kind: PromoKind = p.kind === 'amount' || p.kind === 'free' ? p.kind : 'percent';
  const currency = kind === 'amount' && /^[a-z]{3}$/i.test(String(p.currency ?? '')) ? String(p.currency).toLowerCase() : kind === 'amount' ? 'usd' : null;
  const plans = Array.isArray(p.plans) ? [...new Set(p.plans.map(asPlanId).filter((id) => id !== 'free' && PLAN_IDS.includes(id)))] : [];
  return {
    code,
    kind,
    value: kind === 'percent' ? num(p.value, 1, 100, 10) : kind === 'amount' ? num(p.value, 1, 100_000_000, 100) : 0,
    currency,
    plans,
    duration: p.duration === 'forever' ? 'forever' : 'once',
    freePeriods: kind === 'free' ? num(p.freePeriods, 1, 36, 1) : 1,
    maxUses: num(p.maxUses, 0, 1_000_000, 0),
    uses: Math.max(0, Math.round(p.uses)),
    validUntil: iso(p.validUntil),
    active: p.active !== false,
    note: String(p.note ?? '').trim().slice(0, 200),
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * Why a code cannot be used on this plan right now, in words — null when it can. The per-account use is the
 * service's to check (it knows who asks).
 */
export function promoRefusal(p: PromoCode | null, plan: PlanId, now: number = Date.now()): string | null {
  if (!p || !p.active) return 'That code is not valid';
  if (p.validUntil && Date.parse(p.validUntil) <= now) return `That code expired on ${p.validUntil.slice(0, 10)}`;
  if (p.maxUses > 0 && p.uses >= p.maxUses) return 'That code has been used up';
  if (p.plans.length && !p.plans.includes(plan)) return `That code is for ${p.plans.map((id) => id.toUpperCase()).join(', ')} — not this plan`;
  return null;
}

/** What a percent or amount code takes off a payment of `cents` in `currency` (0 when the currencies differ). */
export function discountCents(p: Pick<PromoCode, 'kind' | 'value' | 'currency'>, cents: number, currency: string): number {
  if (p.kind === 'percent') return Math.min(cents, Math.round((cents * p.value) / 100));
  if (p.kind === 'amount') return p.currency === currency.toLowerCase() ? Math.min(cents, p.value) : 0;
  return cents;
}

/** The end of a fee-void grant: `freePeriods` periods of the offer from `from`. */
export function freeUntil(from: Date | string | number, interval: PlanInterval, intervalCount: number, freePeriods: number): string {
  return periodEnd(from, interval, Math.max(1, intervalCount) * Math.max(1, freePeriods));
}

/** "20% off your first payment", "20% off every payment", "₹100.00 off", "3 months free", "1 period free". */
export function promoLabel(p: Pick<PromoCode, 'kind' | 'value' | 'currency' | 'duration' | 'freePeriods'>, money: (cents: number, currency: string) => string, offer?: Pick<PlanOffer, 'interval' | 'intervalCount'> | null): string {
  if (p.kind === 'percent') return `${p.value}% off ${p.duration === 'forever' ? 'every payment' : 'your first payment'}`;
  if (p.kind === 'amount') return `${money(p.value, p.currency ?? 'usd')} off ${p.duration === 'forever' ? 'every payment' : 'your first payment'}`;
  if (offer) {
    const n = Math.max(1, offer.intervalCount) * Math.max(1, p.freePeriods);
    return `${n} ${offer.interval}${n === 1 ? '' : 's'} free — no payment`;
  }
  return `${p.freePeriods} period${p.freePeriods === 1 ? '' : 's'} free — no payment`;
}

/** The code as the Plans page may know it (no uses, no note, no author). */
export function promoPreview(p: PromoCode, money: (cents: number, currency: string) => string): PromoPreview {
  return { code: p.code, kind: p.kind, value: p.value, currency: p.currency, plans: p.plans, duration: p.duration, freePeriods: p.freePeriods, label: promoLabel(p, money) };
}
