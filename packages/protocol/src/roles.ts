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

/** The subscription's standing right now: an active one past its expiry is `expired`. */
export function subscriptionStatus(s: Pick<UserSubscription, 'status' | 'expiresAt'> | null | undefined, now: number = Date.now()): SubscriptionStatus {
  if (!s || s.status === 'none') return 'none';
  if (s.status === 'revoked') return 'revoked';
  if (s.expiresAt && Date.parse(s.expiresAt) <= now) return 'expired';
  return 'active';
}

export const subscriptionActive = (s: Pick<UserSubscription, 'status' | 'expiresAt'> | null | undefined, now: number = Date.now()): boolean => subscriptionStatus(s, now) === 'active';

/** Publishing mode is open to a Super Admin always, and to a club owner while the subscription is active. Nobody else. */
export function publishingOpen(role: UserRole, subscription: Pick<UserSubscription, 'status' | 'expiresAt'> | null | undefined, now: number = Date.now()): boolean {
  if (role === 'super_admin') return true;
  if (role === 'club_owner') return subscriptionActive(subscription, now);
  return false;
}

/** Why Publishing mode is closed to this account, in the account's own words (empty when it is open). */
export function publishingClosedReason(role: UserRole, subscription: Pick<UserSubscription, 'status' | 'expiresAt'> | null | undefined, now: number = Date.now()): string {
  if (publishingOpen(role, subscription, now)) return '';
  if (role !== 'club_owner') return 'Publishing mode is for club owners — ask the SingersVoice admin to make your account a club owner';
  switch (subscriptionStatus(subscription, now)) {
    case 'expired':
      return `Your club owner subscription expired on ${(subscription?.expiresAt ?? '').slice(0, 10)} — ask the SingersVoice admin to renew it`;
    case 'revoked':
      return 'Your club owner subscription was revoked — ask the SingersVoice admin';
    default:
      return 'Your club owner subscription has not started — ask the SingersVoice admin to grant it';
  }
}
