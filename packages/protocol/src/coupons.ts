/**
 * Coupons — the super admin's gate on who may use SingersVoice.
 *
 * The super admin issues a coupon to an email address: a code and an expiry date (and a note). A
 * singer who signs in with that address is asked for the code first — before anything else of the
 * app — and is in while the code they entered is the one issued and the date has not passed. The
 * service checks it on every request (`AccessStatus` on the account record, `403 coupon_required`
 * on every route but /me and /coupon): the admin changing the code, moving the expiry into the past
 * or deleting the coupon denies the account on its very next request, whatever a device shows. Super
 * admins are never locked out. The requirement itself can be switched off (Admin → Coupons), and
 * then everyone is in without a coupon.
 */

/** A coupon as issued: one per email address. */
export interface Coupon {
  email: string;
  code: string;
  /** ISO; the coupon is good until this instant. */
  expiresAt: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** Who issued it (a super admin's user id). */
  createdBy: string;
}

/** Where a coupon stands for the account that holds the address. */
export type CouponStanding = 'ok' | 'none' | 'missing' | 'wrong' | 'expired';

/** The account's standing at the gate, computed on the service on every request. */
export interface AccessStatus {
  /** The gate is on (Admin → Coupons); off, everyone is in. */
  required: boolean;
  /** This account is in right now. */
  ok: boolean;
  standing: CouponStanding;
  /** The issued coupon's expiry (when one is issued for this address). */
  expiresAt: string | null;
  /** The code this account entered (as kept), empty when none. */
  entered: string;
  /** Why the account is out, in words ('' when it is in). */
  note: string;
}

export interface CouponSettings {
  required: boolean;
  updatedAt: string | null;
}

/** A coupon on the admin's list, with the account that holds the address and whether it is in. */
export interface CouponRow {
  coupon: Coupon;
  standing: 'active' | 'expiring' | 'expired';
  daysLeft: number;
  user: { userId: string; name: string; picture: string; lastSeenAt: string; entered: string; ok: boolean } | null;
}

export interface AdminCouponsResponse {
  settings: CouponSettings;
  coupons: CouponRow[];
}

/** A code as compared: trimmed, upper-case, no spaces or dashes — what a singer types never fails on a dash. */
export const normalizeCode = (s: string): string =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .slice(0, 64);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function cryptoBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** A fresh code: SV- and eight characters from an alphabet without 0/O/1/I (crypto-random by default). */
export function newCouponCode(random: (n: number) => Uint8Array = cryptoBytes): string {
  const bytes = random(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `SV-${s}`;
}

/** "SV-ABCD2345" as shown: the normalized code with the dash back after SV. */
export const displayCode = (code: string): string => {
  const n = normalizeCode(code);
  return n.startsWith('SV') && n.length > 2 ? `SV-${n.slice(2)}` : n;
};

/**
 * The account's standing at the gate: the gate off is in; a super admin is in; else the issued coupon for the address
 * must exist, the code entered must be it, and the date must not have passed.
 */
export function accessOf(i: { required: boolean; superAdmin: boolean; coupon: Pick<Coupon, 'code' | 'expiresAt'> | null; entered: string | null | undefined; now?: number }): AccessStatus {
  const now = i.now ?? Date.now();
  const entered = normalizeCode(i.entered ?? '');
  const expiresAt = i.coupon?.expiresAt ?? null;
  const base = { required: i.required, expiresAt, entered };
  if (!i.required || i.superAdmin) return { ...base, ok: true, standing: 'ok', note: '' };
  if (!i.coupon) return { ...base, ok: false, standing: 'none', note: 'No coupon is issued for your account — ask the SingersVoice admin for one' };
  if (Date.parse(i.coupon.expiresAt) <= now) return { ...base, ok: false, standing: 'expired', note: `Your coupon expired on ${i.coupon.expiresAt.slice(0, 10)} — ask the SingersVoice admin for a new one` };
  if (!entered) return { ...base, ok: false, standing: 'missing', note: 'Enter the coupon the SingersVoice admin gave you' };
  if (entered !== normalizeCode(i.coupon.code)) return { ...base, ok: false, standing: 'wrong', note: 'That is not the coupon issued for your account — check it, or ask the SingersVoice admin' };
  return { ...base, ok: true, standing: 'ok', note: '' };
}

/** Whole days until the coupon's expiry (negative once past). */
export const couponDaysLeft = (c: Pick<Coupon, 'expiresAt'>, now: number = Date.now()): number => Math.ceil((Date.parse(c.expiresAt) - now) / 86_400_000);
