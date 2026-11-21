/** The SVT DB store: users, public track catalog, meets, participants, chat, recordings, publishing. */
import { accessOf, normalizeCode, normalizeBookmark, normalizePrefs, bookmarkKey, DEFAULT_BILLING_SETTINGS, DEFAULT_PLANS, LIVE_KEEP, MIX_KEEP, asPlanId, completePlans, entitlementOf, mediaOfEntitlement, newRegistryId, periodKey, planOf, publishingClosedReason, registrySourceKey, songKey, subscriptionStatus, type BillingSettings, type BlockedUser, type Bookmark, type BookmarkInput, type SongPrefs, type StageBookmark, type Coupon, type CouponRow, type CouponSettings, type CatalogTrack, type ClubMember, type EntitlementInput, type JoinInvite, type OrderRecord, type OrderStatus, type PaymentRecord, type PlanDef, type PlanId, type ChatMessage, type Destination, type Meet, type MeetPerformance, type MeetRecording, type LiveSegmentInfo, type MeetSignal, type MixBatch, type Participant, type PublishJob, type RegisterTrackRequest, type TrackAccessMine, type TrackCopyRequest, type TrackFileRefs, type TrackMetaPatch, type TrackRecord, type TrackSearchGroup, type TrackSearchResponse, type UserRecord, type PublishJobLive, type UserRole, type UserSubscription } from '@singersvoice/protocol';
import type { Driver } from './driver.ts';
import { COLUMN_MIGRATIONS, SCHEMA_SQL } from './schema.ts';

/** One account's subscription row: the plan, its dates and standing, and the Stripe ids behind it (none for a grant). */
export interface Subscription {
  userId: string;
  plan: PlanId;
  startedAt: string | null;
  planUntil: string | null;
  status: 'active' | 'revoked';
  customerId: string | null;
  subscriptionId: string | null;
  source: 'stripe' | 'grant';
  updatedAt: string;
}

type UserRow = { user_id: string; email: string; name: string; picture: string; privileged: number; role?: string | null; created_at: string; last_seen_at: string; coupon_code?: string | null; coupon_at?: string | null; plan?: string | null; plan_until?: string | null; started_at?: string | null; sub_status?: string | null; sub_source?: string | null; sub_updated_at?: string | null; sv_no?: number | null; google_id?: string | null; phone?: string | null; blocked?: number | null; blocked_at?: string | null; blocked_note?: string | null };

const ROLES: UserRole[] = ['audio', 'dual', 'club_owner', 'super_admin'];
export const asRole = (v: unknown, fallback: UserRole = 'dual'): UserRole => (ROLES.includes(v as UserRole) ? (v as UserRole) : fallback);

/** The subscription a joined row carries (null when the account never had one), its status as it stands now (`expired` once the date — and the grace days — have passed). */
function subscriptionFromRow(r: UserRow, now: number, graceDays: number): UserSubscription | null {
  if (!r.plan) return null;
  const plan = asPlanId(r.plan);
  const stored = { plan, startedAt: r.started_at ?? null, expiresAt: r.plan_until ?? null, status: plan === 'free' ? ('none' as const) : r.sub_status === 'revoked' ? ('revoked' as const) : ('active' as const), source: r.sub_source === 'stripe' ? ('stripe' as const) : ('grant' as const), updatedAt: r.sub_updated_at ?? null };
  return { ...stored, status: subscriptionStatus(stored, now, graceDays) };
}

/** What the record needs beside its row: the plans as priced, the club it belongs to, the month's usage, its members. */
export interface UserContext {
  now: number;
  graceDays: number;
  plans: readonly PlanDef[];
  club: EntitlementInput['club'];
  usedSeconds: number;
  seatsUsed: number;
  /** The coupon gate: on or off, and the coupon issued for this address (null when none). */
  couponsRequired: boolean;
  coupon: Pick<Coupon, 'code' | 'expiresAt'> | null;
}

/**
 * A user row (joined with its subscription) as the record the service hands out: the role, the subscription, where
 * the account stands (plans.ts), what it may send of itself in a meet, and whether Publishing is open right now.
 */
export function userFromRow(r: UserRow, ctx: UserContext): UserRecord {
  const privileged = !!r.privileged;
  const role = asRole(r.role, privileged ? 'super_admin' : 'dual');
  const subscription = subscriptionFromRow(r, ctx.now, ctx.graceDays);
  const entitlement = entitlementOf({ role, subscription, plans: ctx.plans, club: ctx.club, usedSeconds: ctx.usedSeconds, seatsUsed: ctx.seatsUsed, now: ctx.now, graceDays: ctx.graceDays });
  const ownPlan = planOf(ctx.plans, subscription?.plan);
  const access = accessOf({ required: ctx.couponsRequired, superAdmin: role === 'super_admin', coupon: ctx.coupon, entered: r.coupon_code ?? '', now: ctx.now });
  return {
    userId: r.user_id,
    svNo: Number(r.sv_no ?? 0),
    googleId: r.google_id ?? (r.user_id.startsWith('g-') ? r.user_id.slice(2) : ''),
    email: r.email,
    name: r.name,
    picture: r.picture,
    phone: r.phone ?? '',
    blocked: Boolean(r.blocked),
    blockedAt: r.blocked_at ?? null,
    blockedNote: r.blocked_note ?? '',
    role,
    subscription,
    entitlement,
    access,
    media: role === 'audio' ? 'audio' : mediaOfEntitlement(entitlement),
    privileged: role === 'super_admin',
    plan: entitlement.plan,
    planUntil: r.plan_until ?? null,
    canPublish: entitlement.publishing,
    publishingNote: publishingClosedReason(role, subscription, ownPlan.publishing, ctx.now, ctx.graceDays),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

const USER_SELECT = 'SELECT u.*, s.plan AS plan, s.plan_until AS plan_until, s.started_at AS started_at, s.status AS sub_status, s.source AS sub_source, s.updated_at AS sub_updated_at FROM users u LEFT JOIN subscriptions s ON s.user_id = u.user_id';

export interface StoredParticipant extends Participant {
  meetId: string;
  resumeToken: string;
  /** On stage with the picture on: when the video hours were last counted (the next heartbeat adds the seconds since). */
  videoTickAt?: string;
}

export interface StoredDestination extends Destination {
  keyEnc: string;
}

type PaymentRow = { id: string; user_id: string; amount_cents: number; currency: string; paid_at: string; source: string; ref: string; period_start: string | null; period_end: string | null; note: string; plan?: string | null; payment_intent_id?: string | null; charge_id?: string | null; fee_cents?: number | null; net_cents?: number | null; refunded_cents?: number | null; status?: string | null };
const paymentFromRow = (r: PaymentRow): PaymentRecord => ({
  id: r.id,
  userId: r.user_id,
  plan: asPlanId(r.plan ?? 'club'),
  amountCents: Number(r.amount_cents),
  currency: r.currency,
  paidAt: r.paid_at,
  source: r.source === 'stripe' ? 'stripe' : 'grant',
  ref: r.ref,
  periodStart: r.period_start ?? null,
  periodEnd: r.period_end ?? null,
  note: r.note,
  paymentIntentId: r.payment_intent_id ?? null,
  chargeId: r.charge_id ?? null,
  feeCents: r.fee_cents === null || r.fee_cents === undefined ? null : Number(r.fee_cents),
  netCents: r.net_cents === null || r.net_cents === undefined ? null : Number(r.net_cents),
  refundedCents: Number(r.refunded_cents ?? 0),
  status: r.status === 'refunded' ? 'refunded' : r.status === 'partly_refunded' ? 'partly_refunded' : 'paid',
});
type OrderRow = { order_id: string; user_id: string; plan: string; currency: string; amount_cents: number; session_id: string | null; payment_intent_id: string | null; status: string; note: string; created_at: string; updated_at: string };
const ORDER_STATUSES: OrderStatus[] = ['pending', 'processing', 'paid', 'failed', 'canceled', 'expired'];
const orderFromRow = (r: OrderRow): OrderRecord => ({ orderId: r.order_id, userId: r.user_id, plan: asPlanId(r.plan), currency: r.currency, amountCents: Number(r.amount_cents), sessionId: r.session_id ?? null, paymentIntentId: r.payment_intent_id ?? null, status: ORDER_STATUSES.includes(r.status as OrderStatus) ? (r.status as OrderStatus) : 'pending', note: r.note, createdAt: r.created_at, updatedAt: r.updated_at });
/** The billing settings within bounds: every plan present and clean, a note of a size, days that are days. */
function cleanBillingSettings(s: Partial<BillingSettings>): BillingSettings {
  const num = (v: unknown, lo: number, hi: number, fallback: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : fallback);
  return {
    plans: completePlans(s.plans),
    note: String(s.note ?? '').slice(0, 500),
    expiringSoonDays: num(s.expiringSoonDays, 0, 365, DEFAULT_BILLING_SETTINGS.expiringSoonDays),
    graceDays: num(s.graceDays, 0, 90, DEFAULT_BILLING_SETTINGS.graceDays),
    updatedAt: s.updatedAt ?? null,
  };
}
const lowerEmail = (e: string) => e.trim().toLowerCase();

/** A master-database row as selected (`REGISTRY_SELECT` adds the singer and copy counts). */
type RegistryRow = { track_id: string; source: string; source_key: string; song: string; song_key: string; artists: string; movie: string; year: number | null; language: string; drive_url: string; folder_id: string; owner_user_id: string; data: string; search: string; created_at: string; updated_at: string; last_accessed_at: string | null; access_count: number; unavailable: number; singers?: number; copies?: number };
/** What a registry row keeps in its `data` JSON. */
interface RegistryData {
  refs: TrackFileRefs;
  durationMs: number;
  singerCount: number;
  youtubeId: string | null;
  thumbnail: string;
  ownerName: string;
  catalogTrackId: string | null;
}
const REGISTRY_COLS = 'r.*, (SELECT COUNT(*) FROM track_access x WHERE x.track_id = r.track_id AND x.count > 0) AS singers, (SELECT COUNT(*) FROM track_access x WHERE x.track_id = r.track_id AND x.copy_refs IS NOT NULL) AS copies';
const REGISTRY_SELECT = `SELECT ${REGISTRY_COLS} FROM track_registry r`;
const cleanMeta = (m: { song?: string; artists?: string; movie?: string; year?: number | null; language?: string }) => ({
  song: String(m.song ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
  artists: String(m.artists ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
  movie: String(m.movie ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
  year: m.year === null || m.year === undefined || !Number.isFinite(Number(m.year)) || Number(m.year) < 1900 || Number(m.year) > 2100 ? null : Math.round(Number(m.year)),
  language: String(m.language ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
});
const searchText = (m: { song: string; artists: string; movie: string; year: number | null; language: string; source: string; ownerName: string }) => `${m.song} ${songKey(m.song)} ${m.artists} ${m.movie} ${m.year ?? ''} ${m.language} ${m.source} ${m.ownerName}`.toLowerCase();

export class SqlStore {
  private ready: Promise<void> | null = null;
  private db: Driver;

  constructor(db: Driver) {
    this.db = db;
  }

  migrate(): Promise<void> {
    if (!this.ready) this.ready = this.runMigrations();
    return this.ready;
  }

  private async runMigrations(): Promise<void> {
    await this.db.exec(SCHEMA_SQL);
    for (const m of COLUMN_MIGRATIONS) {
      const cols = await this.db.all<{ name: string }>(`PRAGMA table_info(${m.table})`);
      if (cols.some((c) => c.name === m.column)) continue;
      await this.db.exec(m.ddl);
      if (m.after) await this.db.exec(m.after);
    }
    await this.mirrorCatalogIntoRegistry(); // a catalog from before the master database: every entry a record, once
    await this.getBillingSettings(); // the plans and the grace days in force, for every standing read from now on
    await this.getCouponSettings(); // the gate as it stands
  }

  // ---------- users ----------

  async upsertUser(u: Pick<UserRecord, 'userId' | 'email' | 'name' | 'picture'> & { privileged?: boolean }): Promise<UserRecord> {
    const now = new Date().toISOString();
    const existing = await this.getUser(u.userId);
    if (existing) {
      // An address named in PRIVILEGED_EMAILS is a super admin whatever the row says; otherwise the role stays as set.
      const privileged = u.privileged === true || existing.role === 'super_admin';
      if (u.privileged === true && existing.role !== 'super_admin') await this.db.run("UPDATE users SET role='super_admin' WHERE user_id=?", [u.userId]);
      await this.db.run('UPDATE users SET email=?, name=?, picture=?, privileged=?, last_seen_at=? WHERE user_id=?', [
        u.email || existing.email,
        u.name || existing.name,
        u.picture || existing.picture,
        privileged ? 1 : 0,
        now,
        u.userId,
      ]);
      return (await this.getUser(u.userId))!;
    }
    const count = await this.countUsers();
    // The very first account becomes the super admin (bootstrap) unless told otherwise; everyone else starts as dual.
    // The SingersVoice number: the next one, in order of creation, never a number given before (the unique index guards it).
    const privileged = u.privileged ?? count === 0;
    await this.db.run("INSERT INTO users (user_id, email, name, picture, privileged, role, created_at, last_seen_at, sv_no, google_id) VALUES (?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sv_no), 999) + 1 FROM users),?)", [u.userId, u.email, u.name, u.picture, privileged ? 1 : 0, privileged ? 'super_admin' : 'dual', now, now, u.userId.startsWith('g-') ? u.userId.slice(2) : '']);
    return (await this.getUser(u.userId))!;
  }

  /** The singer's own details: the phone (optional). */
  async setUserPhone(userId: string, phone: string): Promise<void> {
    await this.db.run('UPDATE users SET phone=? WHERE user_id=?', [phone.trim().slice(0, 32), userId]);
  }

  /** A super admin blocks an account for good (or lets it back in), with a note for the admins. */
  async setUserBlocked(userId: string, blocked: boolean, note = ''): Promise<void> {
    await this.db.run('UPDATE users SET blocked=?, blocked_at=?, blocked_note=? WHERE user_id=?', [blocked ? 1 : 0, blocked ? new Date().toISOString() : null, note.slice(0, 200), userId]);
  }

  async getUserBySvNo(svNo: number): Promise<UserRecord | null> {
    const r = await this.db.get<UserRow>(`${USER_SELECT} WHERE u.sv_no = ?`, [svNo]);
    return r ? this.enrich(r) : null;
  }

  // ---------- blocks: who a singer keeps out of their meets ----------

  async block(blockerUserId: string, blockedUserId: string): Promise<void> {
    if (blockerUserId === blockedUserId) return;
    await this.db.run('INSERT OR IGNORE INTO blocks (blocker_user_id, blocked_user_id, created_at) VALUES (?,?,?)', [blockerUserId, blockedUserId, new Date().toISOString()]);
  }

  async unblock(blockerUserId: string, blockedUserId: string): Promise<void> {
    await this.db.run('DELETE FROM blocks WHERE blocker_user_id=? AND blocked_user_id=?', [blockerUserId, blockedUserId]);
  }

  async isBlocked(blockerUserId: string, blockedUserId: string): Promise<boolean> {
    return Boolean(await this.db.get<{ x: number }>('SELECT 1 AS x FROM blocks WHERE blocker_user_id=? AND blocked_user_id=?', [blockerUserId, blockedUserId]));
  }

  /** Everyone a singer blocked, newest first, as they are known (name, number, picture). */
  async listBlocks(blockerUserId: string): Promise<BlockedUser[]> {
    const rows = await this.db.all<{ blocked_user_id: string; created_at: string; sv_no: number | null; name: string | null; picture: string | null; email: string | null }>(
      'SELECT b.blocked_user_id, b.created_at, u.sv_no, u.name, u.picture, u.email FROM blocks b LEFT JOIN users u ON u.user_id = b.blocked_user_id WHERE b.blocker_user_id=? ORDER BY b.created_at DESC',
      [blockerUserId],
    );
    return rows.map((r) => ({ userId: r.blocked_user_id, svNo: Number(r.sv_no ?? 0), name: r.name ?? 'Somebody', picture: r.picture ?? '', email: r.email ?? '', blockedAt: r.created_at }));
  }

  /**
   * A row as the record the service hands out, with what the entitlement needs looked up: the club the account belongs
   * to by email (only when it has no active plan of its own), the month's usage of the pool in force, its members.
   */
  private async enrich(r: UserRow, now = Date.now()): Promise<UserRecord> {
    const grace = this.billing.graceDays;
    const own = subscriptionFromRow(r, now, grace);
    const ownActive = own !== null && own.status === 'active' && own.plan !== 'free';
    const role = asRole(r.role, r.privileged ? 'super_admin' : 'dual');
    const club = ownActive || role === 'super_admin' ? null : await this.clubFor(r.email, now);
    const poolId = club ? club.ownerUserId : r.user_id;
    const usedSeconds = role === 'super_admin' ? 0 : await this.videoUsed(poolId, periodKey(now));
    const ownPlan = planOf(this.billing.plans, own?.plan);
    const seatsUsed = (ownActive && ownPlan.seats > 0) || role === 'super_admin' ? await this.countClubMembers(r.user_id) : 0;
    const coupon = this.coupons.required && role !== 'super_admin' ? await this.getCoupon(r.email) : null;
    return userFromRow(r, { now, graceDays: grace, plans: this.billing.plans, club, usedSeconds, seatsUsed, couponsRequired: this.coupons.required, coupon });
  }

  // ---------- coupons: the gate (coupons.ts) ----------

  /** The requirement as it stands (read at startup and on every change); `couponsRequiredDefault` is the environment's word for a service that never set it. */
  private coupons: CouponSettings = { required: true, updatedAt: null };
  couponsRequiredDefault = true;
  couponSettings(): CouponSettings {
    return this.coupons;
  }

  async getCouponSettings(): Promise<CouponSettings> {
    const r = await this.db.get<{ value: string; updated_at: string }>("SELECT value, updated_at FROM settings WHERE key='coupons'", []);
    const stored = r ? (JSON.parse(r.value) as Partial<CouponSettings>) : {};
    this.coupons = { required: typeof stored.required === 'boolean' ? stored.required : this.couponsRequiredDefault, updatedAt: r?.updated_at ?? null };
    return this.coupons;
  }

  async setCouponSettings(patch: Partial<CouponSettings>): Promise<CouponSettings> {
    const current = await this.getCouponSettings();
    const next = { required: typeof patch.required === 'boolean' ? patch.required : current.required };
    const now = new Date().toISOString();
    await this.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('coupons', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", [JSON.stringify(next), now]);
    this.coupons = { ...next, updatedAt: now };
    return this.coupons;
  }

  async getCoupon(email: string): Promise<Coupon | null> {
    const r = await this.db.get<{ email: string; code: string; expires_at: string; note: string; created_at: string; updated_at: string; created_by: string }>('SELECT * FROM coupons WHERE email=?', [lowerEmail(email)]);
    return r ? { email: r.email, code: r.code, expiresAt: r.expires_at, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by } : null;
  }

  /** A coupon issued or changed for an address: the code (kept as given, compared normalized), the expiry, the note. */
  async setCoupon(c: { email: string; code: string; expiresAt: string; note: string; createdBy: string }): Promise<Coupon> {
    const now = new Date().toISOString();
    await this.db.run(
      'INSERT INTO coupons (email, code, expires_at, note, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at, note=excluded.note, updated_at=excluded.updated_at',
      [lowerEmail(c.email), c.code, c.expiresAt, c.note, now, now, c.createdBy],
    );
    return (await this.getCoupon(c.email))!;
  }

  async deleteCoupon(email: string): Promise<void> {
    await this.db.run('DELETE FROM coupons WHERE email=?', [lowerEmail(email)]);
  }

  /** Every coupon with the account that holds the address (the latest signed in) and whether it is in, newest first. */
  async listCoupons(now = Date.now()): Promise<CouponRow[]> {
    const rows = await this.db.all<{ email: string; code: string; expires_at: string; note: string; created_at: string; updated_at: string; created_by: string; user_id: string | null; name: string | null; picture: string | null; last_seen_at: string | null; coupon_code: string | null }>(
      'SELECT c.*, u.user_id, u.name, u.picture, u.last_seen_at, u.coupon_code FROM coupons c LEFT JOIN users u ON lower(u.email) = c.email ORDER BY c.updated_at DESC, u.last_seen_at DESC',
      [],
    );
    const seen = new Set<string>();
    const out: CouponRow[] = [];
    for (const r of rows) {
      if (seen.has(r.email)) continue;
      seen.add(r.email);
      const coupon: Coupon = { email: r.email, code: r.code, expiresAt: r.expires_at, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by };
      const daysLeft = Math.ceil((Date.parse(coupon.expiresAt) - now) / 86_400_000);
      const standing = daysLeft <= 0 ? 'expired' : daysLeft <= 7 ? 'expiring' : 'active';
      const entered = r.coupon_code ?? '';
      out.push({ coupon, standing, daysLeft, user: r.user_id ? { userId: r.user_id, name: r.name ?? '', picture: r.picture ?? '', lastSeenAt: r.last_seen_at ?? '', entered, ok: daysLeft > 0 && normalizeCode(entered) === normalizeCode(coupon.code) } : null });
    }
    return out;
  }

  /** The coupon an account entered at the gate (kept, so the account stays in across visits while the coupon stands). */
  async setUserCoupon(userId: string, code: string): Promise<void> {
    await this.db.run('UPDATE users SET coupon_code=?, coupon_at=? WHERE user_id=?', [normalizeCode(code), new Date().toISOString(), userId]);
  }

  // ---------- songs a singer prefers, bookmarks (prefs.ts) ----------

  async getPrefs(userId: string): Promise<SongPrefs> {
    const r = await this.db.get<{ prefs: string | null }>('SELECT prefs FROM users WHERE user_id=?', [userId]);
    let raw: unknown = null;
    try {
      raw = r?.prefs ? JSON.parse(r.prefs) : null;
    } catch {
      raw = null;
    }
    return normalizePrefs(raw);
  }

  /** The preference replaced whole (what is kept is what is known: normalizePrefs). */
  async setPrefs(userId: string, prefs: unknown): Promise<SongPrefs> {
    const clean = normalizePrefs(prefs);
    await this.db.run('UPDATE users SET prefs=? WHERE user_id=?', [JSON.stringify(clean), userId]);
    return clean;
  }

  private bookmarkFromRow(r: { key: string; data: string; created_at: string }): Bookmark {
    const data = JSON.parse(r.data) as BookmarkInput;
    return { ...data, key: r.key, createdAt: r.created_at };
  }

  /** A singer's bookmarks, the latest first. */
  async listBookmarks(userId: string, limit = 500): Promise<Bookmark[]> {
    const rows = await this.db.all<{ key: string; data: string; created_at: string }>('SELECT key, data, created_at FROM bookmarks WHERE user_id=? ORDER BY created_at DESC, key LIMIT ?', [userId, limit]);
    return rows.map((r) => this.bookmarkFromRow(r));
  }

  /** Keep a bookmark (or replace what is kept of it — its place in the list stays); null when the input is no bookmark. */
  async putBookmark(userId: string, input: unknown, now = new Date()): Promise<Bookmark | null> {
    const clean = normalizeBookmark(input);
    if (!clean) return null;
    const key = bookmarkKey(clean.kind, clean.ref);
    const data = JSON.stringify(clean);
    await this.db.run('INSERT INTO bookmarks (user_id, key, data, created_at) VALUES (?,?,?,?) ON CONFLICT(user_id, key) DO UPDATE SET data=excluded.data', [userId, key, data, now.toISOString()]);
    const r = await this.db.get<{ key: string; data: string; created_at: string }>('SELECT key, data, created_at FROM bookmarks WHERE user_id=? AND key=?', [userId, key]);
    return r ? this.bookmarkFromRow(r) : null;
  }

  async deleteBookmark(userId: string, key: string): Promise<boolean> {
    const had = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id=? AND key=?', [userId, key]);
    await this.db.run('DELETE FROM bookmarks WHERE user_id=? AND key=?', [userId, key]);
    return Number(had?.n ?? 0) > 0;
  }

  /** The bookmarks of the given singers together, each saying whose it is (every one of them who kept it), the latest kept first. */
  async bookmarksOf(singers: { userId: string; displayName: string }[]): Promise<StageBookmark[]> {
    const ids = [...new Set(singers.map((s) => s.userId).filter(Boolean))];
    if (!ids.length) return [];
    const rows = await this.db.all<{ user_id: string; key: string; data: string; created_at: string }>(`SELECT user_id, key, data, created_at FROM bookmarks WHERE user_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC, key`, ids);
    const out = new Map<string, StageBookmark>();
    for (const r of rows) {
      const who = singers.find((s) => s.userId === r.user_id);
      const by = { userId: r.user_id, displayName: who?.displayName ?? '' };
      const have = out.get(r.key);
      if (have) {
        if (!have.by.some((b) => b.userId === by.userId)) have.by.push(by);
      } else out.set(r.key, { ...this.bookmarkFromRow(r), by: [by] });
    }
    return [...out.values()];
  }

  /** The Admin page: every account, newest first. */
  async listUsers(limit = 500): Promise<UserRecord[]> {
    const rows = await this.db.all<UserRow>(`${USER_SELECT} ORDER BY u.created_at DESC LIMIT ?`, [limit]);
    const now = Date.now();
    const out: UserRecord[] = [];
    for (const r of rows) out.push(await this.enrich(r, now));
    return out;
  }

  // ---------- billing settings (the plans), payments, orders ----------

  /** The settings in force (read at startup and on every change): every standing and entitlement uses them. */
  private billing: BillingSettings = DEFAULT_BILLING_SETTINGS;
  /** `getBillingSettings` as it stands now, without a read (the plans, the grace days). */
  billingSettings(): BillingSettings {
    return this.billing;
  }

  async getBillingSettings(): Promise<BillingSettings> {
    const r = await this.db.get<{ value: string; updated_at: string }>("SELECT value, updated_at FROM settings WHERE key='billing'", []);
    let stored: Partial<BillingSettings> = r ? (JSON.parse(r.value) as Partial<BillingSettings>) : {};
    if (!r) {
      // A service from before the plans kept the club owner year alone: its price, note and margins carry over, once.
      const old = await this.db.get<{ value: string }>("SELECT value FROM settings WHERE key='club_owner'", []);
      if (old) {
        const o = JSON.parse(old.value) as { priceCents?: number; currency?: string; selfService?: boolean; note?: string; expiringSoonDays?: number; graceDays?: number };
        const club = { ...planOf(DEFAULT_PLANS, 'club'), interval: 'year' as const, prices: o.priceCents && o.priceCents > 0 ? { [o.currency ?? 'usd']: o.priceCents } : {}, selfService: o.selfService !== false };
        stored = { plans: completePlans([club]), note: o.note, expiringSoonDays: o.expiringSoonDays, graceDays: o.graceDays };
      }
    }
    const s = cleanBillingSettings({ ...stored, updatedAt: r?.updated_at ?? null });
    this.billing = s;
    return s;
  }

  /** The settings changed: the plans given merge by id (a plan left out keeps as it is), the rest replace. */
  async setBillingSettings(patch: Partial<BillingSettings>): Promise<BillingSettings> {
    const current = await this.getBillingSettings();
    const plans = patch.plans ? current.plans.map((p) => ({ ...p, ...(patch.plans!.find((x) => x.id === p.id) ?? {}), id: p.id })) : current.plans;
    const next = cleanBillingSettings({ ...current, ...patch, plans });
    const now = new Date().toISOString();
    const { updatedAt: _u, ...value } = next;
    await this.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('billing', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", [JSON.stringify(value), now]);
    this.billing = { ...next, updatedAt: now };
    return this.billing;
  }

  /** A payment for a plan, once per Stripe id (a retried webhook adds nothing); a grant has its own id. */
  async recordPayment(p: Omit<PaymentRecord, 'id' | 'paymentIntentId' | 'chargeId' | 'feeCents' | 'netCents' | 'refundedCents' | 'status'> & Partial<Pick<PaymentRecord, 'id' | 'paymentIntentId' | 'chargeId' | 'feeCents' | 'netCents'>>): Promise<PaymentRecord> {
    const id = p.id ?? `pay-${p.source}-${p.userId}-${Date.parse(p.paidAt) || Date.now()}`;
    await this.db.run('INSERT OR IGNORE INTO payments (id, user_id, amount_cents, currency, paid_at, source, ref, period_start, period_end, note, plan, payment_intent_id, charge_id, fee_cents, net_cents, refunded_cents, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)', [
      id,
      p.userId,
      Math.max(0, Math.round(p.amountCents)),
      (p.currency || 'usd').toLowerCase(),
      p.paidAt,
      p.source,
      p.ref,
      p.periodStart,
      p.periodEnd,
      p.note,
      asPlanId(p.plan),
      p.paymentIntentId ?? null,
      p.chargeId ?? null,
      p.feeCents ?? null,
      p.netCents ?? null,
      'paid',
    ]);
    return (await this.getPayment(id))!;
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    const r = await this.db.get<PaymentRow>('SELECT * FROM payments WHERE id=?', [id]);
    return r ? paymentFromRow(r) : null;
  }

  async paymentByCharge(chargeId: string): Promise<PaymentRecord | null> {
    const r = await this.db.get<PaymentRow>('SELECT * FROM payments WHERE charge_id=? OR payment_intent_id=? ORDER BY paid_at DESC', [chargeId, chargeId]);
    return r ? paymentFromRow(r) : null;
  }

  /** What Stripe said of a payment after the fact: its ids, its fee, a refund. */
  async updatePayment(id: string, patch: Partial<Pick<PaymentRecord, 'paymentIntentId' | 'chargeId' | 'feeCents' | 'netCents' | 'refundedCents' | 'status'>>): Promise<PaymentRecord | null> {
    const cur = await this.getPayment(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await this.db.run('UPDATE payments SET payment_intent_id=?, charge_id=?, fee_cents=?, net_cents=?, refunded_cents=?, status=? WHERE id=?', [next.paymentIntentId, next.chargeId, next.feeCents, next.netCents, Math.max(0, Math.round(next.refundedCents)), next.status, id]);
    return this.getPayment(id);
  }

  /** Every account's latest payment (the overview's "last paid" column), keyed by user id. */
  async latestPayments(): Promise<Map<string, PaymentRecord>> {
    const rows = await this.db.all<PaymentRow>('SELECT p.* FROM payments p WHERE p.paid_at = (SELECT MAX(q.paid_at) FROM payments q WHERE q.user_id = p.user_id) ORDER BY p.paid_at DESC');
    const out = new Map<string, PaymentRecord>();
    for (const r of rows) if (!out.has(r.user_id)) out.set(r.user_id, paymentFromRow(r));
    return out;
  }

  async listPayments(opts: { userId?: string; limit?: number } = {}): Promise<PaymentRecord[]> {
    const rows = opts.userId ? await this.db.all<PaymentRow>('SELECT * FROM payments WHERE user_id=? ORDER BY paid_at DESC LIMIT ?', [opts.userId, opts.limit ?? 50]) : await this.db.all<PaymentRow>('SELECT * FROM payments ORDER BY paid_at DESC LIMIT ?', [opts.limit ?? 100]);
    return rows.map(paymentFromRow);
  }

  /** A Checkout started: pending until Stripe says what became of it. */
  async createOrder(o: Pick<OrderRecord, 'orderId' | 'userId' | 'plan' | 'currency' | 'amountCents'>): Promise<OrderRecord> {
    const now = new Date().toISOString();
    await this.db.run('INSERT INTO orders (order_id, user_id, plan, currency, amount_cents, session_id, payment_intent_id, status, note, created_at, updated_at) VALUES (?,?,?,?,?,NULL,NULL,?,?,?,?)', [o.orderId, o.userId, o.plan, o.currency.toLowerCase(), Math.round(o.amountCents), 'pending', '', now, now]);
    return (await this.getOrder(o.orderId))!;
  }

  async getOrder(orderId: string): Promise<OrderRecord | null> {
    const r = await this.db.get<OrderRow>('SELECT * FROM orders WHERE order_id=?', [orderId]);
    return r ? orderFromRow(r) : null;
  }

  async getOrderBySession(sessionId: string): Promise<OrderRecord | null> {
    const r = await this.db.get<OrderRow>('SELECT * FROM orders WHERE session_id=?', [sessionId]);
    return r ? orderFromRow(r) : null;
  }

  async updateOrder(orderId: string, patch: Partial<Pick<OrderRecord, 'sessionId' | 'paymentIntentId' | 'status' | 'note'>>): Promise<OrderRecord | null> {
    const cur = await this.getOrder(orderId);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await this.db.run('UPDATE orders SET session_id=?, payment_intent_id=?, status=?, note=?, updated_at=? WHERE order_id=?', [next.sessionId, next.paymentIntentId, next.status, next.note, new Date().toISOString(), orderId]);
    return this.getOrder(orderId);
  }

  /** Checkouts that did not end in a payment (or not yet), newest first. */
  async listOpenOrders(limit = 50): Promise<OrderRecord[]> {
    const rows = await this.db.all<OrderRow>("SELECT * FROM orders WHERE status <> 'paid' ORDER BY created_at DESC LIMIT ?", [limit]);
    return rows.map(orderFromRow);
  }

  // ---------- clubs: the members a club owner named, and the video hours ----------

  async listClubMembers(ownerUserId: string): Promise<ClubMember[]> {
    const rows = await this.db.all<{ email: string; added_at: string; user_id: string | null; name: string | null; picture: string | null }>(
      'SELECT m.email, m.added_at, u.user_id, u.name, u.picture FROM club_members m LEFT JOIN users u ON lower(u.email) = m.email WHERE m.owner_user_id=? ORDER BY m.added_at ASC',
      [ownerUserId],
    );
    const seen = new Set<string>();
    const out: ClubMember[] = [];
    for (const r of rows) {
      if (seen.has(r.email)) continue; // two accounts with one address (an old row): the first signed in
      seen.add(r.email);
      out.push({ email: r.email, addedAt: r.added_at, user: r.user_id ? { userId: r.user_id, name: r.name ?? '', picture: r.picture ?? '' } : null });
    }
    return out;
  }

  /** Whether an address is on a club owner's list (a club meet's door). */
  async isClubMember(ownerUserId: string, email: string): Promise<boolean> {
    if (!email) return false;
    return Boolean(await this.db.get<{ email: string }>('SELECT email FROM club_members WHERE owner_user_id=? AND email=?', [ownerUserId, lowerEmail(email)]));
  }

  async countClubMembers(ownerUserId: string): Promise<number> {
    const r = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM club_members WHERE owner_user_id=?', [ownerUserId]);
    return Number(r?.n ?? 0);
  }

  /** True when the address was not on the list before. */
  async addClubMember(ownerUserId: string, email: string): Promise<boolean> {
    const e = lowerEmail(email);
    const had = await this.db.get<{ email: string }>('SELECT email FROM club_members WHERE owner_user_id=? AND email=?', [ownerUserId, e]);
    if (had) return false;
    await this.db.run('INSERT INTO club_members (owner_user_id, email, added_at) VALUES (?,?,?)', [ownerUserId, e, new Date().toISOString()]);
    return true;
  }

  async removeClubMember(ownerUserId: string, email: string): Promise<void> {
    await this.db.run('DELETE FROM club_members WHERE owner_user_id=? AND email=?', [ownerUserId, lowerEmail(email)]);
  }

  /** The club an address belongs to whose owner's plan is active right now and has seats — the first such, by the date named. */
  async clubFor(email: string, now = Date.now()): Promise<EntitlementInput['club']> {
    if (!email) return null;
    const rows = await this.db.all<{ owner_user_id: string; name: string; plan: string | null; plan_until: string | null; started_at: string | null; status: string | null; source: string | null; updated_at: string | null }>(
      'SELECT m.owner_user_id, u.name, s.plan, s.plan_until, s.started_at, s.status, s.source, s.updated_at FROM club_members m JOIN users u ON u.user_id = m.owner_user_id LEFT JOIN subscriptions s ON s.user_id = m.owner_user_id WHERE m.email=? ORDER BY m.added_at ASC',
      [lowerEmail(email)],
    );
    for (const r of rows) {
      if (!r.plan) continue;
      const plan = asPlanId(r.plan);
      const stored: UserSubscription = { plan, startedAt: r.started_at ?? null, expiresAt: r.plan_until ?? null, status: plan === 'free' ? 'none' : r.status === 'revoked' ? 'revoked' : 'active', source: r.source === 'stripe' ? 'stripe' : 'grant', updatedAt: r.updated_at ?? null };
      const sub = { ...stored, status: subscriptionStatus(stored, now, this.billing.graceDays) };
      if (sub.status !== 'active' || planOf(this.billing.plans, plan).seats <= 0) continue;
      return { ownerUserId: r.owner_user_id, ownerName: r.name, subscription: sub };
    }
    return null;
  }

  /** Seconds of video on stage this month, by pool (an account, or a club owner's for the club). */
  async videoUsed(poolUserId: string, period: string): Promise<number> {
    const r = await this.db.get<{ seconds: number }>('SELECT seconds FROM video_usage WHERE pool_user_id=? AND period=?', [poolUserId, period]);
    return Number(r?.seconds ?? 0);
  }

  /** Seconds of video on stage added to the month's count; the new total. */
  async addVideoSeconds(poolUserId: string, period: string, seconds: number): Promise<number> {
    const add = Math.max(0, seconds);
    await this.db.run('INSERT INTO video_usage (pool_user_id, period, seconds, updated_at) VALUES (?,?,?,?) ON CONFLICT(pool_user_id, period) DO UPDATE SET seconds = seconds + excluded.seconds, updated_at = excluded.updated_at', [poolUserId, period, add, new Date().toISOString()]);
    return this.videoUsed(poolUserId, period);
  }

  /** Tests and the admin: the month's count set outright. */
  async setVideoSeconds(poolUserId: string, period: string, seconds: number): Promise<void> {
    await this.db.run('INSERT INTO video_usage (pool_user_id, period, seconds, updated_at) VALUES (?,?,?,?) ON CONFLICT(pool_user_id, period) DO UPDATE SET seconds = excluded.seconds, updated_at = excluded.updated_at', [poolUserId, period, Math.max(0, seconds), new Date().toISOString()]);
  }

  /** A Super Admin sets an account's role; `privileged` follows it for older code paths. */
  async setRole(userId: string, role: UserRole): Promise<void> {
    await this.db.run('UPDATE users SET role=?, privileged=? WHERE user_id=?', [role, role === 'super_admin' ? 1 : 0, userId]);
  }

  async countSuperAdmins(): Promise<number> {
    const r = await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role='super_admin'");
    return Number(r?.n ?? 0);
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    const r = await this.db.get<UserRow>(`${USER_SELECT} WHERE u.user_id=?`, [userId]);
    return r ? this.enrich(r) : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const r = await this.db.get<UserRow>(`${USER_SELECT} WHERE lower(u.email)=? ORDER BY u.last_seen_at DESC`, [email.toLowerCase()]);
    return r ? this.enrich(r) : null;
  }

  // ---------- subscriptions ----------

  async getSubscription(userId: string): Promise<Subscription | null> {
    const r = await this.db.get<{ user_id: string; plan: string; plan_until: string | null; started_at: string | null; status: string | null; customer_id: string | null; subscription_id: string | null; source: string; updated_at: string }>('SELECT * FROM subscriptions WHERE user_id=?', [userId]);
    return r ? { userId: r.user_id, plan: asPlanId(r.plan), startedAt: r.started_at ?? null, planUntil: r.plan_until, status: r.status === 'revoked' ? 'revoked' : 'active', customerId: r.customer_id, subscriptionId: r.subscription_id, source: r.source === 'grant' ? 'grant' : 'stripe', updatedAt: r.updated_at } : null;
  }

  async userIdByCustomer(customerId: string): Promise<string | null> {
    const r = await this.db.get<{ user_id: string }>('SELECT user_id FROM subscriptions WHERE customer_id=?', [customerId]);
    return r?.user_id ?? null;
  }

  async userIdBySubscription(subscriptionId: string): Promise<string | null> {
    const r = await this.db.get<{ user_id: string }>('SELECT user_id FROM subscriptions WHERE subscription_id=?', [subscriptionId]);
    return r?.user_id ?? null;
  }

  /**
   * Put an account on a plan (a Stripe event, or a Super Admin's grant); ids not given are kept. `startedAt`
   * not given: kept, or now for a plan that begins; `status` not given: active (a `free` plan is 'none' to readers).
   */
  async setSubscription(s: { userId: string; plan: PlanId; planUntil: string | null; startedAt?: string | null; status?: 'active' | 'revoked'; customerId?: string | null; subscriptionId?: string | null; source: 'stripe' | 'grant' }): Promise<Subscription> {
    const now = new Date().toISOString();
    const existing = await this.getSubscription(s.userId);
    const customerId = s.customerId === undefined ? (existing?.customerId ?? null) : s.customerId;
    const subscriptionId = s.subscriptionId === undefined ? (existing?.subscriptionId ?? null) : s.subscriptionId;
    const startedAt = s.startedAt === undefined ? (existing?.startedAt ?? (s.plan !== 'free' ? now : null)) : s.startedAt;
    const status = s.status ?? 'active';
    await this.db.run(
      'INSERT INTO subscriptions (user_id, plan, plan_until, started_at, status, customer_id, subscription_id, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan, plan_until=excluded.plan_until, started_at=excluded.started_at, status=excluded.status, customer_id=excluded.customer_id, subscription_id=excluded.subscription_id, source=excluded.source, updated_at=excluded.updated_at',
      [s.userId, s.plan, s.planUntil, startedAt, status, customerId, subscriptionId, s.source, now],
    );
    return { userId: s.userId, plan: s.plan, startedAt, planUntil: s.planUntil, status, customerId, subscriptionId, source: s.source, updatedAt: now };
  }

  /** Stripe retries webhooks: true the first time an event id is seen. */
  async markBillingEvent(eventId: string): Promise<boolean> {
    const seen = await this.db.get<{ event_id: string }>('SELECT event_id FROM billing_events WHERE event_id=?', [eventId]);
    if (seen) return false;
    await this.db.run('INSERT INTO billing_events (event_id, received_at) VALUES (?,?)', [eventId, new Date().toISOString()]);
    return true;
  }

  async setPrivileged(userId: string, privileged: boolean): Promise<void> {
    await this.db.run('UPDATE users SET privileged=? WHERE user_id=?', [privileged ? 1 : 0, userId]);
  }

  async countUsers(): Promise<number> {
    const r = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    return Number(r?.n ?? 0);
  }

  // ---------- catalog ----------

  async publishTrack(t: CatalogTrack): Promise<CatalogTrack> {
    const search = `${t.title} ${t.artist} ${t.genre} ${t.language} ${t.ownerName}`.toLowerCase();
    const existing = await this.getCatalogTrack(t.trackId);
    let out: CatalogTrack;
    if (existing) {
      out = { ...t, publishedAt: existing.publishedAt, pulls: existing.pulls, ...(existing.registryId ? { registryId: existing.registryId } : {}) };
      await this.db.run('UPDATE catalog_tracks SET data=?, search=? WHERE track_id=?', [JSON.stringify(out), search, t.trackId]);
    } else {
      out = t;
      await this.db.run('INSERT INTO catalog_tracks (track_id, owner_user_id, data, search, published_at, pulls) VALUES (?,?,?,?,?,0)', [t.trackId, t.ownerUserId, JSON.stringify(t), search, t.publishedAt]);
    }
    // The master database holds every published entry too (the owner's files, the metadata, when it is sung).
    const record = await this.mirrorCatalogTrack(out);
    return { ...out, registryId: record.trackId };
  }

  async unpublishTrack(trackId: string, ownerUserId: string): Promise<boolean> {
    const t = await this.getCatalogTrack(trackId);
    if (!t || t.ownerUserId !== ownerUserId) return false;
    await this.db.run('DELETE FROM catalog_tracks WHERE track_id=?', [trackId]);
    return true;
  }

  async getCatalogTrack(trackId: string): Promise<CatalogTrack | null> {
    const r = await this.db.get<{ data: string; pulls: number }>('SELECT data, pulls FROM catalog_tracks WHERE track_id=?', [trackId]);
    return r ? { ...(JSON.parse(r.data) as CatalogTrack), pulls: Number(r.pulls) } : null;
  }

  async listCatalog(q: string, offset: number, limit: number, ownerUserId?: string, languages: string[] = []): Promise<{ items: CatalogTrack[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    // Every word of the query must appear (in the title, artist, genre, language or owner), in any order.
    for (const word of q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("search LIKE ? ESCAPE '\\'");
      params.push(`%${word.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    }
    if (ownerUserId) {
      where.push('owner_user_id=?');
      params.push(ownerUserId);
    }
    // The entries in the given languages (the singer's preference), by the language the entry was published with.
    const langs = [...new Set(languages.map((l) => l.trim().toLowerCase()).filter(Boolean))].slice(0, 24);
    if (langs.length) {
      where.push(`LOWER(COALESCE(json_extract(data, '$.language'), '')) IN (${langs.map(() => '?').join(',')})`);
      params.push(...langs);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM catalog_tracks ${w}`, params))?.n ?? 0);
    const rows = await this.db.all<{ data: string; pulls: number }>(`SELECT data, pulls FROM catalog_tracks ${w} ORDER BY published_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { items: rows.map((r) => ({ ...(JSON.parse(r.data) as CatalogTrack), pulls: Number(r.pulls) })), total };
  }

  async countPull(trackId: string): Promise<number> {
    await this.db.run('UPDATE catalog_tracks SET pulls = pulls + 1 WHERE track_id=?', [trackId]);
    return Number((await this.db.get<{ pulls: number }>('SELECT pulls FROM catalog_tracks WHERE track_id=?', [trackId]))?.pulls ?? 0);
  }

  /** The catalog entry's `registryId`, kept in its data once the master database holds it. */
  private async setCatalogRegistryId(catalogTrackId: string, registryId: string): Promise<void> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM catalog_tracks WHERE track_id=?', [catalogTrackId]);
    if (!r) return;
    const data = JSON.parse(r.data) as CatalogTrack;
    if (data.registryId === registryId) return;
    await this.db.run('UPDATE catalog_tracks SET data=? WHERE track_id=?', [JSON.stringify({ ...data, registryId }), catalogTrackId]);
  }

  // ---------- the master track database (registry.ts) ----------

  private registryFromRow(r: RegistryRow, mine?: TrackAccessMine | null): TrackRecord {
    const data = JSON.parse(r.data) as RegistryData;
    return {
      trackId: r.track_id,
      source: r.source as TrackRecord['source'],
      sourceKey: r.source_key,
      song: r.song,
      artists: r.artists,
      movie: r.movie,
      year: r.year === null || r.year === undefined ? null : Number(r.year),
      language: r.language,
      driveUrl: r.drive_url,
      refs: data.refs,
      durationMs: data.durationMs,
      singerCount: data.singerCount,
      hasVideo: Boolean(data.refs.videoId),
      youtubeId: data.youtubeId ?? null,
      thumbnail: data.thumbnail ?? '',
      ownerUserId: r.owner_user_id,
      ownerName: data.ownerName,
      catalogTrackId: data.catalogTrackId ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastAccessedAt: r.last_accessed_at ?? null,
      accessCount: Number(r.access_count ?? 0),
      singers: Number(r.singers ?? 0),
      copies: Number(r.copies ?? 0),
      unavailable: Boolean(r.unavailable),
      ...(mine !== undefined ? { mine } : {}),
    };
  }

  private async mineOf(trackId: string, userId: string | undefined): Promise<TrackAccessMine | null | undefined> {
    if (!userId) return undefined;
    const a = await this.db.get<{ last_at: string; count: number; copy_track_id: string | null }>('SELECT last_at, count, copy_track_id FROM track_access WHERE track_id=? AND user_id=?', [trackId, userId]);
    return a && (Number(a.count) > 0 || a.copy_track_id) ? { lastAccessedAt: a.last_at, count: Number(a.count), copyTrackId: a.copy_track_id ?? null } : null;
  }

  async getRegistryTrack(trackId: string, forUserId?: string): Promise<TrackRecord | null> {
    const r = await this.db.get<RegistryRow>(`${REGISTRY_SELECT} WHERE r.track_id=?`, [trackId]);
    return r ? this.registryFromRow(r, await this.mineOf(trackId, forUserId)) : null;
  }

  async getRegistryBySource(sourceKey: string, forUserId?: string): Promise<TrackRecord | null> {
    const r = await this.db.get<RegistryRow>(`${REGISTRY_SELECT} WHERE r.source_key=?`, [sourceKey]);
    return r ? this.registryFromRow(r, await this.mineOf(r.track_id, forUserId)) : null;
  }

  /**
   * Register a track: one record per source (the YouTube video, the Drive folder, the catalog entry). A second
   * registration of the same source answers the first record, filling in metadata it lacked (never blanking what
   * it had) — the owner's refresh (or a record with no file ids yet) takes the new file ids and URL.
   */
  async registerTrack(input: RegisterTrackRequest & { ownerUserId: string; ownerName: string }, now = new Date()): Promise<{ track: TrackRecord; created: boolean }> {
    const nowIso = now.toISOString();
    const key = input.sourceKey || registrySourceKey({ source: input.source, youtubeId: input.youtubeId, catalogTrackId: input.catalogTrackId, refs: input.refs });
    const clean = cleanMeta({ song: input.song, artists: input.artists, movie: input.movie, year: input.year, language: input.language });
    // The same source twice is one record — by its key, or by the Drive folder the files live in (a track published to the
    // catalog after it was registered from Drive, or the other way round, is still that one song).
    const existing = (await this.db.get<RegistryRow>(`${REGISTRY_SELECT} WHERE r.source_key=?`, [key])) ?? (await this.db.get<RegistryRow>(`${REGISTRY_SELECT} WHERE r.folder_id=? AND r.folder_id<>''`, [input.refs.folderId]));
    if (existing) {
      const data = JSON.parse(existing.data) as RegistryData;
      const takeFiles = existing.owner_user_id === input.ownerUserId || !data.refs.jsonId;
      const merged: RegistryData = {
        ...data,
        refs: takeFiles ? input.refs : data.refs,
        durationMs: data.durationMs || Number(input.durationMs ?? 0),
        singerCount: data.singerCount || Number(input.singerCount ?? 1),
        youtubeId: data.youtubeId ?? input.youtubeId ?? null,
        thumbnail: data.thumbnail || input.thumbnail || '',
        catalogTrackId: data.catalogTrackId ?? input.catalogTrackId ?? null,
      };
      const song = existing.song || clean.song;
      const artists = existing.artists || clean.artists;
      const movie = existing.movie || clean.movie;
      const year = existing.year ?? clean.year;
      const language = existing.language || clean.language;
      await this.db.run('UPDATE track_registry SET song=?, song_key=?, artists=?, movie=?, year=?, language=?, drive_url=?, data=?, search=?, updated_at=?, unavailable=CASE WHEN ? THEN 0 ELSE unavailable END WHERE track_id=?', [
        song,
        songKey(song),
        artists,
        movie,
        year,
        language,
        takeFiles ? input.driveUrl : existing.drive_url,
        JSON.stringify(merged),
        searchText({ song, artists, movie, year, language, source: existing.source, ownerName: merged.ownerName }),
        nowIso,
        takeFiles ? 1 : 0,
        existing.track_id,
      ]);
      if (input.copyTrackId) await this.recordTrackCopy(existing.track_id, input.ownerUserId, { refs: input.refs, driveUrl: input.driveUrl, copyTrackId: input.copyTrackId }, now);
      return { track: (await this.getRegistryTrack(existing.track_id, input.ownerUserId))!, created: false };
    }
    const data: RegistryData = {
      refs: input.refs,
      durationMs: Math.max(0, Number(input.durationMs ?? 0)),
      singerCount: Math.max(1, Math.min(10, Number(input.singerCount ?? 1) || 1)),
      youtubeId: input.youtubeId ?? null,
      thumbnail: input.thumbnail ?? '',
      ownerName: input.ownerName,
      catalogTrackId: input.catalogTrackId ?? null,
    };
    let trackId = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      trackId = newRegistryId(now);
      if (!(await this.db.get('SELECT 1 FROM track_registry WHERE track_id=?', [trackId]))) break;
      trackId = '';
    }
    if (!trackId) throw new Error('Could not mint a track id');
    await this.db.run('INSERT INTO track_registry (track_id, source, source_key, song, song_key, artists, movie, year, language, drive_url, folder_id, owner_user_id, data, search, created_at, updated_at, last_accessed_at, access_count, unavailable) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,0,0)', [
      trackId,
      input.source,
      key,
      clean.song,
      songKey(clean.song),
      clean.artists,
      clean.movie,
      clean.year,
      clean.language,
      input.driveUrl,
      input.refs.folderId,
      input.ownerUserId,
      JSON.stringify(data),
      searchText({ ...clean, source: input.source, ownerName: input.ownerName }),
      nowIso,
      nowIso,
    ]);
    if (input.copyTrackId) await this.recordTrackCopy(trackId, input.ownerUserId, { refs: input.refs, driveUrl: input.driveUrl, copyTrackId: input.copyTrackId }, now);
    return { track: (await this.getRegistryTrack(trackId, input.ownerUserId))!, created: true };
  }

  /** A successful access by a singer: the global last-accessed instant and their own history move to now (UTC). */
  async recordTrackAccess(trackId: string, userId: string, how: 'sing' | 'play', now = new Date()): Promise<TrackRecord | null> {
    const nowIso = now.toISOString();
    const r = await this.db.get<{ track_id: string }>('SELECT track_id FROM track_registry WHERE track_id=?', [trackId]);
    if (!r) return null;
    await this.db.run('UPDATE track_registry SET last_accessed_at=?, access_count=access_count+1, unavailable=0 WHERE track_id=?', [nowIso, trackId]);
    await this.db.run(
      "INSERT INTO track_access (track_id, user_id, first_at, last_at, count, how) VALUES (?,?,?,?,1,?) ON CONFLICT(track_id, user_id) DO UPDATE SET last_at=excluded.last_at, count=track_access.count+1, how=excluded.how",
      [trackId, userId, nowIso, nowIso, how],
    );
    return this.getRegistryTrack(trackId, userId);
  }

  /** A singer's own shared copy of the track: one more place its files can be fetched from (the owner's refresh sets the record's own). */
  async recordTrackCopy(trackId: string, userId: string, copy: TrackCopyRequest, now = new Date()): Promise<TrackRecord | null> {
    const nowIso = now.toISOString();
    const r = await this.db.get<RegistryRow>('SELECT * FROM track_registry WHERE track_id=?', [trackId]);
    if (!r) return null;
    await this.db.run(
      "INSERT INTO track_access (track_id, user_id, first_at, last_at, count, how, copy_track_id, copy_url, copy_refs, copy_at) VALUES (?,?,?,?,0,'copy',?,?,?,?) ON CONFLICT(track_id, user_id) DO UPDATE SET copy_track_id=excluded.copy_track_id, copy_url=excluded.copy_url, copy_refs=excluded.copy_refs, copy_at=excluded.copy_at",
      [trackId, userId, nowIso, nowIso, copy.copyTrackId, copy.driveUrl, JSON.stringify(copy.refs), nowIso],
    );
    const data = JSON.parse(r.data) as RegistryData;
    if (r.owner_user_id === userId || !data.refs.jsonId) await this.db.run('UPDATE track_registry SET data=?, drive_url=?, unavailable=0, updated_at=? WHERE track_id=?', [JSON.stringify({ ...data, refs: copy.refs }), copy.driveUrl, nowIso, trackId]);
    else await this.db.run('UPDATE track_registry SET unavailable=0 WHERE track_id=?', [trackId]);
    return this.getRegistryTrack(trackId, userId);
  }

  /** Where a track's files can be fetched from: the record's own (the owner's) first, then every singer's shared copy, the newest first. */
  async trackFileSources(trackId: string): Promise<{ userId: string; refs: TrackFileRefs; url: string }[]> {
    const r = await this.db.get<RegistryRow>('SELECT * FROM track_registry WHERE track_id=?', [trackId]);
    if (!r) return [];
    const data = JSON.parse(r.data) as RegistryData;
    const out: { userId: string; refs: TrackFileRefs; url: string }[] = [];
    if (data.refs.jsonId) out.push({ userId: r.owner_user_id, refs: data.refs, url: r.drive_url });
    const copies = await this.db.all<{ user_id: string; copy_refs: string; copy_url: string }>('SELECT user_id, copy_refs, copy_url FROM track_access WHERE track_id=? AND copy_refs IS NOT NULL ORDER BY copy_at DESC', [trackId]);
    for (const c of copies) {
      const refs = JSON.parse(c.copy_refs) as TrackFileRefs;
      if (refs.jsonId && !out.some((o) => o.refs.jsonId === refs.jsonId)) out.push({ userId: c.user_id, refs, url: c.copy_url });
    }
    return out;
  }

  async setTrackUnavailable(trackId: string, unavailable: boolean): Promise<void> {
    await this.db.run('UPDATE track_registry SET unavailable=? WHERE track_id=?', [unavailable ? 1 : 0, trackId]);
  }

  async patchRegistryTrack(trackId: string, patch: TrackMetaPatch, now = new Date()): Promise<TrackRecord | null> {
    const r = await this.db.get<RegistryRow>('SELECT * FROM track_registry WHERE track_id=?', [trackId]);
    if (!r) return null;
    const clean = cleanMeta({ song: patch.song ?? r.song, artists: patch.artists ?? r.artists, movie: patch.movie ?? r.movie, year: patch.year === undefined ? r.year : patch.year, language: patch.language ?? r.language });
    if (!clean.song) clean.song = r.song;
    const data = JSON.parse(r.data) as RegistryData;
    await this.db.run('UPDATE track_registry SET song=?, song_key=?, artists=?, movie=?, year=?, language=?, search=?, updated_at=? WHERE track_id=?', [clean.song, songKey(clean.song), clean.artists, clean.movie, clean.year, clean.language, searchText({ ...clean, source: r.source, ownerName: data.ownerName }), now.toISOString(), trackId]);
    return this.getRegistryTrack(trackId);
  }

  /**
   * Search the master database: every word must appear (song, artists, movie, year, language, source, owner); the
   * records with the same song name make one group; the groups are ordered by the latest access in them (the
   * newest first, the never-sung last), the versions in a group the same way.
   */
  async searchRegistry(q: string, offset: number, limit: number, forUserId?: string, opts: { languages?: string[]; popular?: boolean } = {}): Promise<TrackSearchResponse> {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const word of q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("search LIKE ? ESCAPE '\\'");
      params.push(`%${word.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    }
    // Recommendations: the songs in the singer's languages (prefs.ts), the most sung first.
    const langs = [...new Set((opts.languages ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))].slice(0, 24);
    if (langs.length) {
      where.push(`LOWER(language) IN (${langs.map(() => '?').join(',')})`);
      params.push(...langs);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = opts.popular ? 'ac DESC, la DESC, ca DESC' : 'la DESC, ca DESC';
    const total = Number((await this.db.get<{ n: number }>(`SELECT COUNT(DISTINCT song_key) AS n FROM track_registry ${w}`, params))?.n ?? 0);
    const keys = await this.db.all<{ song_key: string; la: string | null }>(`SELECT song_key, MAX(last_accessed_at) AS la, MAX(created_at) AS ca, SUM(access_count) AS ac FROM track_registry ${w} GROUP BY song_key ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const groups: TrackSearchGroup[] = [];
    for (const k of keys) {
      const rows = await this.db.all<RegistryRow>(`${REGISTRY_SELECT} ${w ? `${w} AND` : 'WHERE'} r.song_key=? ORDER BY ${opts.popular ? 'r.access_count DESC, ' : ''}r.last_accessed_at DESC, r.created_at DESC`, [...params, k.song_key]);
      const versions: TrackRecord[] = [];
      for (const r of rows) versions.push(this.registryFromRow(r, await this.mineOf(r.track_id, forUserId)));
      if (versions.length) groups.push({ songKey: k.song_key, song: versions[0]!.song, lastAccessedAt: k.la ?? null, versions });
    }
    return { groups, total, nextCursor: offset + keys.length < total ? String(offset + keys.length) : null };
  }

  /** What a singer sang, the latest first (their own history). */
  async registryHistory(userId: string, limit = 20): Promise<TrackRecord[]> {
    const rows = await this.db.all<RegistryRow & { last_at: string; count: number; copy_track_id: string | null }>(`SELECT ${REGISTRY_COLS}, a.last_at AS last_at, a.count AS count, a.copy_track_id AS copy_track_id FROM track_access a JOIN track_registry r ON r.track_id = a.track_id WHERE a.user_id=? AND a.count > 0 ORDER BY a.last_at DESC LIMIT ?`, [userId, limit]);
    return rows.map((r) => this.registryFromRow(r, { lastAccessedAt: r.last_at, count: Number(r.count), copyTrackId: r.copy_track_id ?? null }));
  }

  /** A published catalog entry is a record of the master database too (one per entry); the entry learns its registry id. */
  async mirrorCatalogTrack(t: CatalogTrack, now = new Date()): Promise<TrackRecord> {
    const { track } = await this.registerTrack(
      {
        source: 'catalog',
        sourceKey: `catalog:${t.trackId}`,
        song: t.title,
        artists: t.artist,
        language: t.language,
        driveUrl: t.driveFolderLink,
        refs: { folderId: t.driveFolderId, jsonId: t.trackJsonId, audioId: t.audioId, audioMime: t.audioMime, ...(t.videoId ? { videoId: t.videoId, videoMime: t.videoMime ?? 'video/mp4' } : {}) },
        durationMs: t.durationMs,
        singerCount: t.singerCount,
        catalogTrackId: t.trackId,
        copyTrackId: t.trackId,
        ownerUserId: t.ownerUserId,
        ownerName: t.ownerName,
      },
      now,
    );
    await this.setCatalogRegistryId(t.trackId, track.trackId);
    return track;
  }

  /** Every catalog entry the master database does not hold yet (a database from before it) is mirrored, once, at startup. */
  async mirrorCatalogIntoRegistry(): Promise<number> {
    const held = new Set((await this.db.all<{ source_key: string }>("SELECT source_key FROM track_registry WHERE source='catalog'")).map((r) => r.source_key));
    const rows = await this.db.all<{ data: string; pulls: number }>('SELECT data, pulls FROM catalog_tracks');
    let n = 0;
    for (const r of rows) {
      const t = { ...(JSON.parse(r.data) as CatalogTrack), pulls: Number(r.pulls) };
      if (held.has(`catalog:${t.trackId}`)) continue;
      await this.mirrorCatalogTrack(t, new Date(t.publishedAt || Date.now()));
      n += 1;
    }
    return n;
  }

  // ---------- meets ----------

  async createMeet(m: Meet): Promise<void> {
    await this.db.run('INSERT INTO meets (meet_id, join_code, host_user_id, state, data, last_activity_at, created_at) VALUES (?,?,?,?,?,?,?)', [
      m.meetId,
      m.joinCode,
      m.hostUserId,
      m.state,
      JSON.stringify(m),
      m.lastActivityAt,
      m.createdAt,
    ]);
  }

  async saveMeet(m: Meet): Promise<void> {
    await this.db.run('UPDATE meets SET state=?, data=?, last_activity_at=? WHERE meet_id=?', [m.state, JSON.stringify(m), m.lastActivityAt, m.meetId]);
  }

  async getMeet(meetId: string): Promise<Meet | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM meets WHERE meet_id=?', [meetId]);
    return r ? (JSON.parse(r.data) as Meet) : null;
  }

  async getMeetByCode(code: string): Promise<Meet | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM meets WHERE join_code=?', [code.toUpperCase()]);
    return r ? (JSON.parse(r.data) as Meet) : null;
  }

  async listMeetsForUser(userId: string, limit = 30): Promise<Meet[]> {
    const rows = await this.db.all<{ data: string }>(
      `SELECT m.data AS data FROM meets m
       WHERE m.host_user_id=? OR m.meet_id IN (SELECT meet_id FROM participants WHERE user_id=?)
       ORDER BY m.created_at DESC LIMIT ?`,
      [userId, userId, limit],
    );
    return rows.map((r) => JSON.parse(r.data) as Meet);
  }

  async listOpenMeets(): Promise<Meet[]> {
    const rows = await this.db.all<{ data: string }>("SELECT data FROM meets WHERE state IN ('lobby','countdown','live')");
    return rows.map((r) => JSON.parse(r.data) as Meet);
  }

  // ---------- participants ----------

  async saveParticipant(p: StoredParticipant): Promise<void> {
    await this.db.run(
      `INSERT INTO participants (meet_id, participant_id, user_id, resume_token, data, last_seen_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(meet_id, participant_id) DO UPDATE SET data=excluded.data, last_seen_at=excluded.last_seen_at, resume_token=excluded.resume_token`,
      [p.meetId, p.participantId, p.userId, p.resumeToken, JSON.stringify(p), p.lastSeenAt],
    );
  }

  async getParticipantByToken(meetId: string, token: string): Promise<StoredParticipant | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM participants WHERE meet_id=? AND resume_token=?', [meetId, token]);
    return r ? (JSON.parse(r.data) as StoredParticipant) : null;
  }

  async getParticipant(meetId: string, participantId: string): Promise<StoredParticipant | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM participants WHERE meet_id=? AND participant_id=?', [meetId, participantId]);
    return r ? (JSON.parse(r.data) as StoredParticipant) : null;
  }

  /**
   * The user's participant in a meet. One account can be in a meet twice: as a member (host /
   * performer / audience) and, from a Publishing show view, as a publisher — `kind` picks which.
   */
  async getParticipantByUser(meetId: string, userId: string, kind: 'member' | 'publisher' | 'any' = 'member'): Promise<StoredParticipant | null> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM participants WHERE meet_id=? AND user_id=? ORDER BY last_seen_at DESC', [meetId, userId]);
    for (const r of rows) {
      const p = JSON.parse(r.data) as StoredParticipant;
      if (kind === 'any' || (kind === 'publisher') === (p.role === 'publisher')) return p;
    }
    return null;
  }

  async listParticipants(meetId: string): Promise<StoredParticipant[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM participants WHERE meet_id=? ORDER BY last_seen_at DESC', [meetId]);
    return rows.map((r) => JSON.parse(r.data) as StoredParticipant);
  }

  /** Delete a meet and everything that hangs off it (the takes and shows themselves live in the singers' Drives). */
  async deleteMeet(meetId: string): Promise<void> {
    for (const t of ['mix', 'performances', 'meet_members', 'recordings', 'signals', 'chat', 'participants', 'meets']) await this.db.run(`DELETE FROM ${t} WHERE meet_id=?`, [meetId]);
  }

  // ---------- the stage mix for the audience: a rolling window of one-second Opus batches per meet ----------

  /**
   * Keep a batch; the service numbers it — always one past the newest the meet has, whatever number
   * the host's device sent. The device's own count starts again whenever it rebuilds its mix (a new
   * song, a reload), and a listener who has seen batch 150 must never wait for the new count to pass
   * 150: the numbers only ever go up. Resolves with the number given.
   */
  async addMix(meetId: string, batch: MixBatch): Promise<number> {
    const seq = ((await this.db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM mix WHERE meet_id=?', [meetId]))?.m ?? 0) + 1;
    await this.db.run('INSERT INTO mix (meet_id, seq, created_at, data) VALUES (?,?,?,?) ON CONFLICT(meet_id, seq) DO UPDATE SET data=excluded.data', [meetId, seq, new Date().toISOString(), JSON.stringify({ ...batch, seq })]);
    await this.db.run('DELETE FROM mix WHERE meet_id=? AND seq <= ?', [meetId, seq - MIX_KEEP]);
    return seq;
  }

  async listMix(meetId: string, since: number, limit = 8): Promise<{ batches: MixBatch[]; latest: number }> {
    const latest = (await this.db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM mix WHERE meet_id=?', [meetId]))?.m ?? 0;
    const rows = await this.db.all<{ data: string }>('SELECT data FROM mix WHERE meet_id=? AND seq > ? ORDER BY seq ASC LIMIT ?', [meetId, since, limit]);
    return { batches: rows.map((r) => JSON.parse(r.data) as MixBatch), latest };
  }

  // ---------- members: every account that was ever in a meet (participants come and go; the shows are shared with all of them) ----------

  async addMember(meetId: string, userId: string): Promise<void> {
    await this.db.run('INSERT OR IGNORE INTO meet_members (meet_id, user_id, joined_at) VALUES (?,?,?)', [meetId, userId, new Date().toISOString()]);
  }

  async listMembers(meetId: string): Promise<UserRecord[]> {
    const rows = await this.db.all<UserRow>(`SELECT u.*, s.plan AS plan, s.plan_until AS plan_until, s.started_at AS started_at, s.status AS sub_status, s.source AS sub_source, s.updated_at AS sub_updated_at FROM meet_members m JOIN users u ON u.user_id = m.user_id LEFT JOIN subscriptions s ON s.user_id = u.user_id WHERE m.meet_id=? ORDER BY m.joined_at ASC`, [meetId]);
    const now = Date.now();
    const out: UserRecord[] = [];
    for (const r of rows) out.push(await this.enrich(r, now));
    return out;
  }

  // ---------- performances: the saved shows (one per song, registered by the host) ----------

  async addPerformance(p: MeetPerformance): Promise<void> {
    await this.db.run(
      `INSERT INTO performances (performance_id, meet_id, host_user_id, data, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(performance_id) DO UPDATE SET data=excluded.data`,
      [p.performanceId, p.meetId, p.hostUserId, JSON.stringify(p), p.createdAt],
    );
  }

  async getPerformance(performanceId: string): Promise<MeetPerformance | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM performances WHERE performance_id=?', [performanceId]);
    return r ? (JSON.parse(r.data) as MeetPerformance) : null;
  }

  async listPerformancesForMeet(meetId: string): Promise<MeetPerformance[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM performances WHERE meet_id=? ORDER BY created_at ASC', [meetId]);
    return rows.map((r) => JSON.parse(r.data) as MeetPerformance);
  }

  /** Every show of every meet the user hosted or was ever in, newest first. */
  async listPerformancesForUser(userId: string, limit = 200): Promise<MeetPerformance[]> {
    const rows = await this.db.all<{ data: string }>(
      `SELECT data FROM performances WHERE host_user_id=? OR meet_id IN (SELECT meet_id FROM meet_members WHERE user_id=?) ORDER BY created_at DESC LIMIT ?`,
      [userId, userId, limit],
    );
    return rows.map((r) => JSON.parse(r.data) as MeetPerformance);
  }

  async deletePerformance(performanceId: string): Promise<void> {
    await this.db.run('DELETE FROM performances WHERE performance_id=?', [performanceId]);
  }

  // ---------- invites: performances open for others to join (join.ts) ----------

  /** Open (or re-open: the record is replaced, the join count kept) a performance for joining. */
  async putInvite(invite: JoinInvite): Promise<JoinInvite> {
    const had = await this.getInvite(invite.performanceId);
    const row: JoinInvite = { ...invite, joins: had?.joins ?? 0, createdAt: had?.createdAt ?? invite.createdAt };
    await this.db.run(
      `INSERT INTO invites (performance_id, owner_user_id, joined_from, data, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(performance_id) DO UPDATE SET data=excluded.data, joined_from=excluded.joined_from`,
      [row.performanceId, row.ownerUserId, row.joinedFrom, JSON.stringify(row), row.createdAt],
    );
    return row;
  }

  async getInvite(performanceId: string): Promise<JoinInvite | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM invites WHERE performance_id=?', [performanceId]);
    return r ? (JSON.parse(r.data) as JoinInvite) : null;
  }

  /** The performances a user opened for joining, newest first. */
  async listInvitesOf(ownerUserId: string, limit = 200): Promise<JoinInvite[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM invites WHERE owner_user_id=? ORDER BY created_at DESC LIMIT ?', [ownerUserId, limit]);
    return rows.map((r) => JSON.parse(r.data) as JoinInvite);
  }

  /** The performances that joined any of a user's (one step down the chain), newest first. */
  async listJoinsOf(ownerUserId: string, limit = 200): Promise<JoinInvite[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM invites WHERE joined_from IN (SELECT performance_id FROM invites WHERE owner_user_id=?) ORDER BY created_at DESC LIMIT ?', [ownerUserId, limit]);
    return rows.map((r) => JSON.parse(r.data) as JoinInvite);
  }

  /** One more performance joined this one. */
  async countJoin(performanceId: string): Promise<void> {
    const had = await this.getInvite(performanceId);
    if (!had) return;
    const row = { ...had, joins: had.joins + 1 };
    await this.db.run('UPDATE invites SET data=? WHERE performance_id=?', [JSON.stringify(row), performanceId]);
  }

  async deleteInvite(performanceId: string): Promise<void> {
    await this.db.run('DELETE FROM invites WHERE performance_id=?', [performanceId]);
  }

  async removeParticipant(meetId: string, participantId: string): Promise<void> {
    await this.db.run('DELETE FROM participants WHERE meet_id=? AND participant_id=?', [meetId, participantId]);
  }

  // ---------- chat ----------

  async addChat(meetId: string, m: Omit<ChatMessage, 'seq'>): Promise<ChatMessage> {
    const seq = Number((await this.db.get<{ n: number }>('SELECT COALESCE(MAX(seq),0)+1 AS n FROM chat WHERE meet_id=?', [meetId]))?.n ?? 1);
    const msg: ChatMessage = { ...m, seq };
    await this.db.run('INSERT INTO chat (meet_id, seq, data) VALUES (?,?,?)', [meetId, seq, JSON.stringify(msg)]);
    return msg;
  }

  async chatSince(meetId: string, since: number, limit = 100): Promise<ChatMessage[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM chat WHERE meet_id=? AND seq>? ORDER BY seq ASC LIMIT ?', [meetId, since, limit]);
    return rows.map((r) => JSON.parse(r.data) as ChatMessage);
  }

  async chatTail(meetId: string, limit = 50): Promise<ChatMessage[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM chat WHERE meet_id=? ORDER BY seq DESC LIMIT ?', [meetId, limit]);
    return rows.map((r) => JSON.parse(r.data) as ChatMessage).reverse();
  }

  // ---------- WebRTC signalling (performer ↔ performer, relayed) ----------

  /**
   * Append a signal. The per-meet sequence is assigned inside the INSERT itself (one statement, so
   * two performers — or a publisher fanning out offers to the whole stage — signalling at the same
   * instant can never collide on a seq and lose an offer); the seq column is authoritative on read.
   */
  async addSignal(meetId: string, sig: Omit<MeetSignal, 'seq'>): Promise<MeetSignal> {
    await this.db.run('INSERT INTO signals (meet_id, seq, to_id, data) SELECT ?, COALESCE(MAX(seq),0)+1, ?, ? FROM signals WHERE meet_id=?', [meetId, sig.to, JSON.stringify(sig), meetId]);
    const r = await this.db.get<{ n: number }>('SELECT COALESCE(MAX(seq),0) AS n FROM signals WHERE meet_id=?', [meetId]);
    return { ...sig, seq: Number(r?.n ?? 0) };
  }

  async signalsFor(meetId: string, to: string, since: number, limit = 200): Promise<MeetSignal[]> {
    const rows = await this.db.all<{ seq: number; data: string }>('SELECT seq, data FROM signals WHERE meet_id=? AND to_id=? AND seq>? ORDER BY seq ASC LIMIT ?', [meetId, to, since, limit]);
    return rows.map((r) => ({ ...(JSON.parse(r.data) as Omit<MeetSignal, 'seq'>), seq: Number(r.seq) }));
  }

  async clearSignals(meetId: string): Promise<void> {
    await this.db.run('DELETE FROM signals WHERE meet_id=?', [meetId]);
  }

  // ---------- recordings ----------

  async addRecording(r: MeetRecording): Promise<void> {
    await this.db.run(
      `INSERT INTO recordings (meet_id, participant_id, performance_id, data, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(meet_id, performance_id) DO UPDATE SET data=excluded.data`,
      [r.meetId, r.participantId, r.performanceId, JSON.stringify(r), r.createdAt],
    );
  }

  async listRecordings(meetId: string): Promise<MeetRecording[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM recordings WHERE meet_id=? ORDER BY created_at ASC', [meetId]);
    return rows.map((r) => JSON.parse(r.data) as MeetRecording);
  }

  // ---------- publishing ----------

  async listDestinations(ownerUserId: string): Promise<StoredDestination[]> {
    const rows = await this.db.all<{ data: string; key_enc: string }>('SELECT data, key_enc FROM destinations WHERE owner_user_id=?', [ownerUserId]);
    return rows.map((r) => ({ ...(JSON.parse(r.data) as Destination), keyEnc: r.key_enc }));
  }

  async getDestination(ownerUserId: string, kind: string): Promise<StoredDestination | null> {
    const r = await this.db.get<{ data: string; key_enc: string }>('SELECT data, key_enc FROM destinations WHERE owner_user_id=? AND kind=?', [ownerUserId, kind]);
    return r ? { ...(JSON.parse(r.data) as Destination), keyEnc: r.key_enc } : null;
  }

  async saveDestination(ownerUserId: string, d: StoredDestination): Promise<void> {
    const { keyEnc, ...pub } = d;
    await this.db.run(
      `INSERT INTO destinations (owner_user_id, kind, data, key_enc) VALUES (?,?,?,?)
       ON CONFLICT(owner_user_id, kind) DO UPDATE SET data=excluded.data, key_enc=excluded.key_enc`,
      [ownerUserId, d.kind, JSON.stringify(pub), keyEnc],
    );
  }

  async saveJob(j: PublishJob): Promise<void> {
    await this.db.run(
      `INSERT INTO publish_jobs (job_id, owner_user_id, meet_id, state, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(job_id) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=excluded.updated_at`,
      [j.jobId, j.ownerUserId, j.meetId, j.state, JSON.stringify(j), j.createdAt, j.updatedAt],
    );
  }

  /**
   * YouTube's verdict on a segment, landing after the answer to the show view went out: only these
   * fields change (json_set), so a segment saved meanwhile is never overwritten with a stale copy.
   */
  async patchJobYoutube(jobId: string, youtube: PublishJobLive['youtube'], note: string, error: string | null | undefined): Promise<void> {
    const args: unknown[] = ['$.live.youtube', youtube, '$.live.youtubeNote', note];
    if (error !== undefined) args.push('$.error', error);
    await this.db.run(`UPDATE publish_jobs SET data = json_set(data, ${args.map(() => '?').join(', ')}) WHERE job_id = ? AND json_type(data, '$.live') = 'object'`, [...args, jobId]);
  }

  async getJob(jobId: string): Promise<PublishJob | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM publish_jobs WHERE job_id=?', [jobId]);
    return r ? (JSON.parse(r.data) as PublishJob) : null;
  }

  async listJobs(ownerUserId: string, meetId?: string): Promise<PublishJob[]> {
    const rows = meetId
      ? await this.db.all<{ data: string }>('SELECT data FROM publish_jobs WHERE owner_user_id=? AND meet_id=? ORDER BY created_at DESC LIMIT 50', [ownerUserId, meetId])
      : await this.db.all<{ data: string }>('SELECT data FROM publish_jobs WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 50', [ownerUserId]);
    return rows.map((r) => JSON.parse(r.data) as PublishJob);
  }

  async liveJobsForMeet(meetId: string): Promise<PublishJob[]> {
    const rows = await this.db.all<{ data: string }>("SELECT data FROM publish_jobs WHERE meet_id=? AND state IN ('requested','starting','live') ORDER BY created_at DESC", [meetId]);
    return rows.map((r) => JSON.parse(r.data) as PublishJob);
  }

  // ---------- live segments (the browser-published show, a rolling window per job) ----------

  async addLiveSegment(jobId: string, seg: LiveSegmentInfo, data: Uint8Array): Promise<void> {
    // A publisher that started over (a reload) counts from 0 again: what remains of the earlier run is stale.
    await this.db.run('DELETE FROM live_segments WHERE job_id=? AND seq>=?', [jobId, seg.seq]);
    await this.db.run(
      `INSERT INTO live_segments (job_id, seq, name, duration_ms, created_at, data) VALUES (?,?,?,?,?,?)
       ON CONFLICT(job_id, seq) DO UPDATE SET name=excluded.name, duration_ms=excluded.duration_ms, created_at=excluded.created_at, data=excluded.data`,
      [jobId, seg.seq, seg.name, seg.durationMs, seg.createdAt, data],
    );
    await this.db.run('DELETE FROM live_segments WHERE job_id=? AND seq<=?', [jobId, seg.seq - LIVE_KEEP]);
  }

  async listLiveSegments(jobId: string): Promise<LiveSegmentInfo[]> {
    const rows = await this.db.all<{ seq: number; name: string; duration_ms: number; created_at: string }>('SELECT seq, name, duration_ms, created_at FROM live_segments WHERE job_id=? ORDER BY seq ASC', [jobId]);
    return rows.map((r) => ({ seq: Number(r.seq), name: r.name, durationMs: Number(r.duration_ms), createdAt: r.created_at }));
  }

  async getLiveSegment(jobId: string, name: string): Promise<Uint8Array | null> {
    const r = await this.db.get<{ data: unknown }>('SELECT data FROM live_segments WHERE job_id=? AND name=?', [jobId, name]);
    return r ? toBytes(r.data) : null;
  }

  async clearLiveSegments(jobId: string): Promise<void> {
    await this.db.run('DELETE FROM live_segments WHERE job_id=?', [jobId]);
  }
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(0);
}
