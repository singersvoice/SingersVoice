/**
 * The plans, and where an account stands (its entitlement).
 *
 *   Free        — sings in the Studio and in live meets with the voice alone (no picture in a meet)
 *   SVV         — a picture in live meets, 10 hours a calendar month
 *   SVVPro      — a picture in live meets, 100 hours a calendar month
 *   Club owner  — a club: the owner names up to 15 members (email addresses) who share 300 hours of
 *                 video a month between them (the owner included), and Publishing mode
 *
 * Every number here is the default: the super admin sets each plan's prices (per currency — a price in
 * INR lets singers in India pay with UPI through Stripe), the length of a period (a month or a year),
 * the video hours, the seats and whether singers may buy it themselves, on the Admin page
 * (`BillingSettings`, kept in the SVT DB). What an account may do is computed on the service on every
 * request (`entitlementOf`), never trusted from a device: the plan in force is the account's own
 * active subscription, else the club it is a member of (by email) while that club's plan is active,
 * else Free; a super admin has everything without limit. Video hours count while a singer is on stage
 * with the picture on, by the calendar month (UTC), and reset on the first.
 */
import type { MediaPermission, UserRole, UserSubscription } from './roles.ts';
import { subscriptionActive } from './roles.ts';

export type PlanId = 'free' | 'svv' | 'svvpro' | 'club';
export const PLAN_IDS: PlanId[] = ['free', 'svv', 'svvpro', 'club'];
export type PlanInterval = 'month' | 'year';

export interface PlanDef {
  id: PlanId;
  title: string;
  blurb: string;
  /** The price of one period, per currency (ISO 4217, lowercase → the currency's minor unit: 500 = $5.00); none = not for sale (free, or granted by the admin). */
  prices: Record<string, number>;
  /** How long a period is: a month or a year, `intervalCount` of them (1 = monthly / yearly). */
  interval: PlanInterval;
  intervalCount: number;
  /** A picture in live meets, hours per calendar month (0 = the voice alone). */
  videoHours: number;
  /** Members the owner may name (email addresses) to share the hours with (0 = a personal plan). */
  seats: number;
  /** Publishing mode (the show view, destinations, going live) comes with it. */
  publishing: boolean;
  /** Singers may buy it on the Plans page (needs Stripe on the service); off: the admin grants it. */
  selfService: boolean;
}

export const DEFAULT_PLANS: PlanDef[] = [
  { id: 'free', title: 'Free', blurb: 'Sing in the Studio, host and join live meets with your voice, keep every take in your own Drive.', prices: {}, interval: 'month', intervalCount: 1, videoHours: 0, seats: 0, publishing: false, selfService: false },
  { id: 'svv', title: 'SVV', blurb: 'Your picture on the stage of live meets — 10 hours a month.', prices: { usd: 500 }, interval: 'month', intervalCount: 1, videoHours: 10, seats: 0, publishing: false, selfService: true },
  { id: 'svvpro', title: 'SVVPro', blurb: 'Your picture on the stage of live meets — 100 hours a month.', prices: { usd: 5000 }, interval: 'month', intervalCount: 1, videoHours: 100, seats: 0, publishing: false, selfService: true },
  { id: 'club', title: 'Club owner', blurb: 'Video for your whole club: name up to 15 members who share 300 hours a month with you — and Publishing mode to stream your meets.', prices: { usd: 25000 }, interval: 'month', intervalCount: 1, videoHours: 300, seats: 15, publishing: true, selfService: true },
];

/** The admin's billing settings: the plans as priced, a line for the Plans page, and the margins of a subscription's standing. */
export interface BillingSettings {
  plans: PlanDef[];
  /** A line the admin wants on the Plans page (how to get in touch, what is coming). */
  note: string;
  /** A subscription this close to its expiry is flagged "expiring" on the admin's overview. */
  expiringSoonDays: number;
  /** Days after the expiry before a plan closes (0 = on the day), so a renewal on its way is not cut off. */
  graceDays: number;
  updatedAt: string | null;
}

export const DEFAULT_BILLING_SETTINGS: BillingSettings = { plans: DEFAULT_PLANS, note: '', expiringSoonDays: 7, graceDays: 0, updatedAt: null };

/** A plan id from anything stored (an older row's "publisher" is the Club owner plan). */
export const asPlanId = (v: unknown): PlanId => (v === 'publisher' ? 'club' : PLAN_IDS.includes(v as PlanId) ? (v as PlanId) : 'free');

/** The plan by id, the Free plan for anything unknown. */
export const planOf = (plans: readonly PlanDef[], id: unknown): PlanDef => plans.find((p) => p.id === asPlanId(id)) ?? plans.find((p) => p.id === 'free') ?? DEFAULT_PLANS[0]!;

/** The plans as the admin keeps them, every one of the four present (a saved list missing one gets the default back). */
export function completePlans(saved: readonly Partial<PlanDef>[] | null | undefined): PlanDef[] {
  return DEFAULT_PLANS.map((d) => {
    const s = saved?.find((p) => p.id === d.id);
    return s ? cleanPlan({ ...d, ...s, id: d.id }) : d;
  });
}

/** A plan within bounds: prices in whole minor units up to 1 000 000.00, 3-letter currencies, hours and seats that make sense. */
export function cleanPlan(p: PlanDef): PlanDef {
  const num = (v: unknown, lo: number, hi: number, fallback: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : fallback);
  const prices: Record<string, number> = {};
  for (const [cur, cents] of Object.entries(p.prices ?? {})) {
    if (!/^[a-z]{3}$/i.test(cur)) continue;
    const n = num(cents, 0, 100_000_000, 0);
    if (n > 0) prices[cur.toLowerCase()] = n;
  }
  return {
    id: p.id,
    title: String(p.title ?? '').trim().slice(0, 40) || p.id,
    blurb: String(p.blurb ?? '').trim().slice(0, 300),
    prices: p.id === 'free' ? {} : prices,
    interval: p.interval === 'year' ? 'year' : 'month',
    intervalCount: num(p.intervalCount, 1, 36, 1),
    videoHours: num(p.videoHours, 0, 100_000, 0),
    seats: num(p.seats, 0, 1000, 0),
    publishing: Boolean(p.publishing),
    selfService: p.id === 'free' ? false : Boolean(p.selfService),
  };
}

/** The calendar month (UTC) the video hours count in: "2026-11". */
export const periodKey = (now: number = Date.now()): string => new Date(now).toISOString().slice(0, 7);

/** When the month's hours start again: the first of next month, UTC, ISO. */
export function periodResetsAt(now: number = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/** "Nov 2026" for a period key. */
export function periodLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** The end of a period that starts at `from`: `intervalCount` months or years on, ISO. */
export function periodEnd(from: Date | string | number, interval: PlanInterval, intervalCount = 1): string {
  const d = new Date(from);
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + Math.max(1, intervalCount));
  else d.setUTCMonth(d.getUTCMonth() + Math.max(1, intervalCount));
  return d.toISOString();
}

/** "9 h 20 m", "45 m", "0 m" — hours and minutes of a count of seconds. */
export function hoursLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} m` : `${m} m`;
}

export type EntitlementVia = 'super_admin' | 'own' | 'club' | 'none';

/** Where an account stands right now — computed on the service on every request, shown by the app, never trusted from a device. */
export interface Entitlement {
  /** The plan in force (the account's own, the club's for a member, free for the rest). */
  plan: PlanId;
  planTitle: string;
  via: EntitlementVia;
  /** A picture in live meets right now: the plan has video hours and some are left (and the role allows a picture). */
  video: boolean;
  /** Hours of video a month under the plan in force (0 for free). */
  videoHours: number;
  /** Seconds used this month, of the pool in force (the account's own, or the club's). */
  videoUsedSeconds: number;
  /** Seconds left this month; null = without limit (a super admin). */
  videoLeftSeconds: number | null;
  periodKey: string;
  resetsAt: string;
  /** For a club member: whose club. */
  clubOwner: { userId: string; name: string } | null;
  /** For a club owner: members named so far, and the seats. */
  seatsUsed: number;
  seats: number;
  publishing: boolean;
  /** Why there is no picture right now ('' when there is). */
  videoNote: string;
}

export interface EntitlementInput {
  role: UserRole;
  /** The account's own subscription (null when it never had one). */
  subscription: UserSubscription | null;
  plans: readonly PlanDef[];
  /** The club this account is a member of (by email) whose plan is active right now, if any. */
  club: { ownerUserId: string; ownerName: string; subscription: UserSubscription } | null;
  /** Seconds of video used this month by the pool in force (the account's own when it has a plan, else the club's). */
  usedSeconds: number;
  /** Members this account has named (a club owner). */
  seatsUsed: number;
  now?: number;
  graceDays?: number;
}

/**
 * The plan in force and what it opens: a super admin has everything without limit; else the account's own
 * active paid plan; else the club it belongs to; else Free. Video needs hours left this month and a role
 * with a picture (an audio-only role has none whatever the plan).
 */
export function entitlementOf(i: EntitlementInput): Entitlement {
  const now = i.now ?? Date.now();
  const grace = i.graceDays ?? 0;
  const key = periodKey(now);
  const resetsAt = periodResetsAt(now);
  const ownActive = i.subscription !== null && subscriptionActive(i.subscription, now, grace) && asPlanId(i.subscription.plan) !== 'free';
  const ownPlan = ownActive ? planOf(i.plans, i.subscription!.plan) : null;
  const base = (plan: PlanDef, via: EntitlementVia, clubOwner: Entitlement['clubOwner']): Entitlement => ({
    plan: plan.id,
    planTitle: plan.title,
    via,
    video: false,
    videoHours: plan.videoHours,
    videoUsedSeconds: Math.max(0, Math.round(i.usedSeconds)),
    videoLeftSeconds: Math.max(0, Math.round(plan.videoHours * 3600 - i.usedSeconds)),
    periodKey: key,
    resetsAt,
    clubOwner,
    seatsUsed: plan.seats > 0 && via === 'own' ? i.seatsUsed : 0,
    seats: via === 'own' ? plan.seats : 0,
    publishing: false,
    videoNote: '',
  });
  const audioRole = i.role === 'audio';
  if (i.role === 'super_admin') {
    const plan = ownPlan ?? planOf(i.plans, 'club');
    const e = base(plan, 'super_admin', null);
    return { ...e, video: !audioRole, videoLeftSeconds: null, publishing: true, seats: plan.seats, seatsUsed: i.seatsUsed, videoNote: audioRole ? 'Your account is audio only — no picture on stage' : '' };
  }
  if (ownPlan) {
    const e = base(ownPlan, 'own', null);
    const left = e.videoLeftSeconds ?? 0;
    const video = !audioRole && ownPlan.videoHours > 0 && left > 0;
    return { ...e, video, publishing: ownPlan.publishing, videoNote: audioRole ? 'Your account is audio only — no picture on stage (the SingersVoice admin can change that)' : ownPlan.videoHours <= 0 ? `The ${ownPlan.title} plan has no video in live meets — see the Plans page` : left <= 0 ? `Your ${ownPlan.videoHours} video hours for ${periodLabel(key)} are used up — the voice alone on stage until ${resetsAt.slice(0, 10)}` : '' };
  }
  if (i.club && subscriptionActive(i.club.subscription, now, grace)) {
    const plan = planOf(i.plans, i.club.subscription.plan);
    if (plan.seats > 0) {
      const e = base(plan, 'club', { userId: i.club.ownerUserId, name: i.club.ownerName });
      const left = e.videoLeftSeconds ?? 0;
      const video = !audioRole && plan.videoHours > 0 && left > 0;
      return { ...e, video, publishing: false, videoNote: audioRole ? 'Your account is audio only — no picture on stage (the SingersVoice admin can change that)' : left <= 0 ? `${i.club.ownerName}'s club has used its ${plan.videoHours} video hours for ${periodLabel(key)} — the voice alone on stage until ${resetsAt.slice(0, 10)}` : '' };
    }
  }
  const free = planOf(i.plans, 'free');
  const e = base(free, 'none', null);
  return { ...e, videoUsedSeconds: 0, videoLeftSeconds: 0, videoNote: audioRole ? 'Your account is audio only — no picture on stage (the SingersVoice admin can change that)' : 'Free accounts sing with the voice alone in live meets — a picture on stage comes with SVV, SVVPro or a club (the Plans page)' };
}

/** What an account may send of itself in a live meet, from its entitlement: the picture only while the plan allows it. */
export const mediaOfEntitlement = (e: Pick<Entitlement, 'video'>): MediaPermission => (e.video ? 'dual' : 'audio');

/** A club member as the owner's page lists them. */
export interface ClubMember {
  email: string;
  addedAt: string;
  /** The account that signed in with that address, when one has. */
  user: { userId: string; name: string; picture: string } | null;
}

/** `GET /club`: the owner's club — the plan, the members, the month's pool. */
export interface ClubStatus {
  plan: PlanDef;
  seats: number;
  members: ClubMember[];
  pool: { usedSeconds: number; hours: number; periodKey: string; resetsAt: string };
  subscription: UserSubscription | null;
}

/** `GET /plans`: the plans on offer and what this account can do about them. */
export interface PlansResponse {
  plans: PlanDef[];
  note: string;
  /** The currencies a singer may pay in (every currency some plan is priced in). */
  currencies: string[];
  /** Stripe is configured on the service: self-service plans can be bought. */
  checkout: boolean;
  /** This account has a Stripe customer: the portal (card, invoices, cancel) is available. */
  portal: boolean;
  entitlement: Entitlement;
  subscription: UserSubscription | null;
  payments: import('./roles.ts').PaymentRecord[];
}

/** A Checkout started for a plan, as the service keeps it until Stripe says what became of it. */
export type OrderStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'canceled' | 'expired';
export interface OrderRecord {
  orderId: string;
  userId: string;
  plan: PlanId;
  currency: string;
  amountCents: number;
  sessionId: string | null;
  paymentIntentId: string | null;
  status: OrderStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** One line of the super admin's overview: an account with a subscription, where it stands, what it used. */
export interface SubscriberRow {
  user: import('./publishing.ts').UserRecord;
  standing: import('./roles.ts').SubscriptionStanding;
  daysLeft: number | null;
  lastPayment: import('./roles.ts').PaymentRecord | null;
}

export interface AdminBillingOverview {
  settings: BillingSettings;
  /** Stripe is configured on the service (a key). */
  stripe: boolean;
  subscribers: SubscriberRow[];
  payments: import('./roles.ts').PaymentRecord[];
  /** Checkouts started and not paid (pending, processing, failed, expired), newest first. */
  orders: OrderRecord[];
}
