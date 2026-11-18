/**
 * Who may do what. Every account has one role, kept in the SVT DB and changed only by a Super Admin
 * (the Admin page); the service enforces it on every request and the app shows only what the role
 * allows:
 *
 *   audio        — sings with sound only: no camera on stage, takes and films without their picture
 *   dual         — sings with sound and picture (the default for a new account)
 *   club_owner   — dual, and Publishing mode (the show view, destinations, going live) while the
 *                  Club owner plan is active
 *   super_admin  — everything, always: Publishing mode without a subscription, and the Admin page
 *                  (roles, subscriptions, publishing access). The first account ever to sign in is one,
 *                  as is every address in SV_PRIVILEGED_EMAILS.
 *
 * Beside the role, the account's PLAN (plans.ts: Free, SVV, SVVPro, Club owner) says whether it has a
 * picture in live meets and for how many hours a month, and the Club owner plan carries Publishing
 * mode. A subscription runs from its start to its expiry and closes by itself the moment the expiry
 * passes (`subscriptionActive`, after the grace days the admin allows); a Super Admin can grant a
 * period, renew for another, set the dates by hand, or revoke.
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

/** An account's subscription (the plan it is on, plans.ts), as the SVT DB keeps it. */
export interface UserSubscription {
  /** The plan (plans.ts: free, svv, svvpro, club); an older row's "publisher" reads as club. */
  plan: string;
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

/** The club owner's subscription (any plan, roles.ts / plans.ts) stands active and the plan carries Publishing mode. */
export function publishingOpen(role: UserRole, subscription: Pick<UserSubscription, 'status' | 'expiresAt' | 'plan'> | null | undefined, planPublishing: boolean, now: number = Date.now(), graceDays = 0): boolean {
  if (role === 'super_admin') return true;
  return planPublishing && subscriptionActive(subscription, now, graceDays);
}

/** Why Publishing mode is closed to this account, in the account's own words (empty when it is open). */
export function publishingClosedReason(role: UserRole, subscription: Pick<UserSubscription, 'status' | 'expiresAt' | 'plan'> | null | undefined, planPublishing: boolean, now: number = Date.now(), graceDays = 0): string {
  if (publishingOpen(role, subscription, planPublishing, now, graceDays)) return '';
  const standing = subscriptionStatus(subscription, now, graceDays);
  if (standing === 'active' && !planPublishing) return 'Publishing mode comes with the Club owner plan — see the Plans page';
  if (standing === 'none' || !planPublishing) return 'Publishing mode is for club owners — the Club owner plan on the Plans page opens it';
  switch (standing) {
    case 'expired':
      return `Your club owner subscription expired on ${(subscription?.expiresAt ?? '').slice(0, 10)} — renew it on the Plans page`;
    case 'revoked':
      return 'Your club owner subscription was revoked — ask the SingersVoice admin';
    default:
      return 'Your club owner subscription has not started — the Plans page, or ask the SingersVoice admin';
  }
}

/** How many whole days a subscription has left (negative once past; null without an expiry). */
export function daysLeft(s: Pick<UserSubscription, 'expiresAt'> | null | undefined, now: number = Date.now()): number | null {
  if (!s?.expiresAt) return null;
  return Math.ceil((Date.parse(s.expiresAt) - now) / DAY_MS);
}

/** A payment for a plan — Stripe's (the first period from Checkout, renewals from invoices), or a period the admin granted (amount 0). */
export interface PaymentRecord {
  id: string;
  userId: string;
  /** The plan paid for (plans.ts). */
  plan: string;
  amountCents: number;
  currency: string;
  paidAt: string;
  source: 'stripe' | 'grant';
  /** Stripe's id (the session, the invoice), or who granted it. */
  ref: string;
  periodStart: string | null;
  periodEnd: string | null;
  note: string;
  /** Stripe's ids behind it (a refund needs one), and what Stripe kept of it (from the balance transaction, when known). */
  paymentIntentId: string | null;
  chargeId: string | null;
  feeCents: number | null;
  netCents: number | null;
  refundedCents: number;
  status: 'paid' | 'refunded' | 'partly_refunded';
}

export type SubscriptionStanding = 'active' | 'expiring' | 'expired' | 'revoked' | 'none';

/** 4900 + 'usd' → "$49.00". */
export function moneyLabel(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
