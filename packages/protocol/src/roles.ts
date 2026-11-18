/**
 * Who may do what. Every account has one role, kept in the SVT DB and changed only by a Super Admin
 * (the Admin page); the service enforces it on every request and the app shows only what the role
 * allows:
 *
 *   audio        — sings with sound only: no camera on stage, takes and films without their picture
 *   dual         — sings with sound and picture (the default for a new account)
 *   club_owner   — dual, and Publishing mode (the show view, destinations, going live) while the
 *                  club's yearly subscription is active
 *   super_admin  — everything, always: Publishing mode without a subscription, and the Admin page
 *                  (roles, subscriptions, publishing access). The first account ever to sign in is one,
 *                  as is every address in SV_PRIVILEGED_EMAILS.
 *
 * Publishing mode is open to a club owner from the subscription's start to its expiry, and closes by
 * itself the moment the expiry passes (`subscriptionActive`); a Super Admin can grant a year, renew
 * for another, set the dates by hand, or revoke.
 */
import type { UserRecord } from './publishing.ts';

export type UserRole = 'audio' | 'dual' | 'club_owner' | 'super_admin';

export const USER_ROLES: { role: UserRole; title: string; blurb: string }[] = [
  { role: 'audio', title: 'Audio only', blurb: 'Sings with sound only — no camera on stage; takes and films carry the voice, not the picture.' },
  { role: 'dual', title: 'Dual (audio + video)', blurb: 'Sings with sound and picture: the camera on stage, recorded and streamed.' },
  { role: 'club_owner', title: 'Club owner', blurb: 'Audio + video, and Publishing mode (the show view, destinations, going live) while the yearly subscription is active.' },
  { role: 'super_admin', title: 'Super admin', blurb: 'Everything, always — Publishing mode without a subscription, and the Admin page.' },
];

export const roleTitle = (role: UserRole): string => USER_ROLES.find((r) => r.role === role)?.title ?? role;

/** What a role may send and record of itself: its voice alone, or voice and picture. */
export type MediaPermission = 'audio' | 'dual';

export const mediaOfRole = (role: UserRole): MediaPermission => (role === 'audio' ? 'audio' : 'dual');

export type SubscriptionStatus = 'none' | 'active' | 'expired' | 'revoked';

/** A club owner's yearly subscription, as the SVT DB keeps it. */
export interface UserSubscription {
  startedAt: string | null;
  /** ISO; null = no end (a standing grant). */
  expiresAt: string | null;
  /** As stored (`active` / `revoked`); `expired` is what `subscriptionStatus` says once the expiry has passed. */
  status: SubscriptionStatus;
  /** Where it came from: a Super Admin's grant, or Stripe. */
  source: 'grant' | 'stripe';
  updatedAt: string | null;
}

/** A year from `from`, the length of a club owner's subscription. */
export function yearFrom(from: Date | string): string {
  const d = new Date(from);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString();
}

const DAY_MS = 24 * 3600_000;

/**
 * The subscription's standing right now: an active one past its expiry is `expired` — after the grace days the
 * super admin allows (none by default), so a renewal on its way is not cut off on the day.
 */
export function subscriptionStatus(s: Pick<UserSubscription, 'status' | 'expiresAt'> | null | undefined, now: number = Date.now(), graceDays = 0): SubscriptionStatus {
  if (!s || s.status === 'none') return 'none';
  if (s.status === 'revoked') return 'revoked';
  if (s.expiresAt && Date.parse(s.expiresAt) + Math.max(0, graceDays) * DAY_MS <= now) return 'expired';
  return 'active';
}

export const subscriptionActive = (s: Pick<UserSubscription, 'status' | 'expiresAt'> | null | undefined, now: number = Date.now(), graceDays = 0): boolean => subscriptionStatus(s, now, graceDays) === 'active';

/** Publishing mode is open to a Super Admin always, and to a club owner while the subscription is active. Nobody else. */
export function publishingOpen(role: UserRole, subscription: Pick<UserSubscription, 'status' | 'expiresAt'> | null | undefined, now: number = Date.now(), graceDays = 0): boolean {
  if (role === 'super_admin') return true;
  if (role === 'club_owner') return subscriptionActive(subscription, now, graceDays);
  return false;
}

/** Why Publishing mode is closed to this account, in the account's own words (empty when it is open). */
export function publishingClosedReason(role: UserRole, subscription: Pick<UserSubscription, 'status' | 'expiresAt'> | null | undefined, now: number = Date.now(), graceDays = 0): string {
  if (publishingOpen(role, subscription, now, graceDays)) return '';
  if (role !== 'club_owner') return 'Publishing mode is for club owners — become one on the Club owner page';
  switch (subscriptionStatus(subscription, now, graceDays)) {
    case 'expired':
      return `Your club owner subscription expired on ${(subscription?.expiresAt ?? '').slice(0, 10)} — renew it on the Club owner page`;
    case 'revoked':
      return 'Your club owner subscription was revoked — ask the SingersVoice admin';
    default:
      return 'Your club owner subscription has not started — pay for a year on the Club owner page, or ask the SingersVoice admin';
  }
}

/** How many whole days a subscription has left (negative once past; null without an expiry). */
export function daysLeft(s: Pick<UserSubscription, 'expiresAt'> | null | undefined, now: number = Date.now()): number | null {
  if (!s?.expiresAt) return null;
  return Math.ceil((Date.parse(s.expiresAt) - now) / DAY_MS);
}

/** The club owner year: what it costs, whether singers may buy it themselves, what the admin wants said, and the margins. */
export interface ClubOwnerSettings {
  /** The price of a year in the currency's minor unit (4900 = $49.00); 0 = not for sale (the admin grants years). */
  priceCents: number;
  /** ISO 4217, lowercase (usd, eur, inr…). */
  currency: string;
  /** Singers may pay for a year themselves on the Club owner page (needs Stripe on the service). */
  selfService: boolean;
  /** A line the admin wants on the Club owner page (what a club owner gets, how to get in touch). */
  note: string;
  /** A subscription this close to its expiry is flagged "expiring" on the admin's overview. */
  expiringSoonDays: number;
  /** Days after the expiry before Publishing closes (0 = on the day). */
  graceDays: number;
  updatedAt: string | null;
}

export const DEFAULT_CLUB_OWNER_SETTINGS: ClubOwnerSettings = { priceCents: 0, currency: 'usd', selfService: true, note: '', expiringSoonDays: 30, graceDays: 0, updatedAt: null };

/** A payment for a club owner year — Stripe's, or a year the admin granted (amount 0). */
export interface PaymentRecord {
  id: string;
  userId: string;
  amountCents: number;
  currency: string;
  paidAt: string;
  source: 'stripe' | 'grant';
  /** Stripe's id (the session, the invoice), or who granted it. */
  ref: string;
  periodStart: string | null;
  periodEnd: string | null;
  note: string;
}

/** The Club owner page's answer for the signed-in singer: their standing, the offer, their payments. */
export interface ClubOwnerStatus {
  role: UserRole;
  subscription: UserSubscription | null;
  canPublish: boolean;
  publishingNote: string;
  daysLeft: number | null;
  /** The year's price (null when the admin has not set one and Stripe has none). */
  price: { amount: number; currency: string; interval: 'year' | 'month' | 'week' | 'day' } | null;
  /** Singers may buy a year here right now (self-service on, a price, Stripe configured). */
  checkout: boolean;
  /** This account has a Stripe customer: the portal (card, invoices, cancel) is available. */
  portal: boolean;
  selfService: boolean;
  note: string;
  payments: PaymentRecord[];
}

export type ClubOwnerStanding = 'active' | 'expiring' | 'expired' | 'revoked' | 'none';

/** One line of the super admin's overview: a club owner (or an account with a subscription), where they stand. */
export interface ClubOwnerRow {
  user: UserRecord;
  standing: ClubOwnerStanding;
  daysLeft: number | null;
  lastPayment: PaymentRecord | null;
}

export interface ClubOwnerOverview {
  settings: ClubOwnerSettings;
  /** Stripe is configured on the service (a key) — self-service can take money. */
  stripe: boolean;
  owners: ClubOwnerRow[];
  payments: PaymentRecord[];
}

/** 4900 + 'usd' → "$49.00". */
export function moneyLabel(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
