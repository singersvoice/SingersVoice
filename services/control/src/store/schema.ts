/** SVT DB schema (SQLite dialect — node:sqlite and Durable Object SQLite storage). Idempotent; run at startup. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  picture TEXT NOT NULL DEFAULT '',
  privileged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  plan_until TEXT,
  customer_id TEXT,
  subscription_id TEXT,
  source TEXT NOT NULL DEFAULT 'stripe',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);
CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_tracks (
  track_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  search TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  pulls INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_catalog_published ON catalog_tracks(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_owner ON catalog_tracks(owner_user_id);
CREATE TABLE IF NOT EXISTS meets (
  meet_id TEXT PRIMARY KEY,
  join_code TEXT NOT NULL UNIQUE,
  host_user_id TEXT NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meets_state ON meets(state, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_meets_host ON meets(host_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS participants (
  meet_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  resume_token TEXT NOT NULL,
  data TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (meet_id, participant_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_token ON participants(meet_id, resume_token);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id, meet_id);
CREATE TABLE IF NOT EXISTS chat (
  meet_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (meet_id, seq)
);
CREATE TABLE IF NOT EXISTS signals (
  meet_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  to_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (meet_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_signals_to ON signals(meet_id, to_id, seq);
CREATE TABLE IF NOT EXISTS recordings (
  meet_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  performance_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (meet_id, performance_id)
);
CREATE TABLE IF NOT EXISTS meet_members (
  meet_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (meet_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON meet_members(user_id);
CREATE TABLE IF NOT EXISTS performances (
  performance_id TEXT PRIMARY KEY,
  meet_id TEXT NOT NULL,
  host_user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_performances_meet ON performances(meet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_performances_host ON performances(host_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS invites (
  performance_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  joined_from TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_owner ON invites(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invites_from ON invites(joined_from, created_at DESC);
CREATE TABLE IF NOT EXISTS mix (
  meet_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (meet_id, seq)
);
CREATE TABLE IF NOT EXISTS destinations (
  owner_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  key_enc TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (owner_user_id, kind)
);
CREATE TABLE IF NOT EXISTS publish_jobs (
  job_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  meet_id TEXT NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON publish_jobs(owner_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  paid_at TEXT NOT NULL,
  source TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  period_start TEXT,
  period_end TEXT,
  note TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'club',
  payment_intent_id TEXT,
  charge_id TEXT,
  fee_cents INTEGER,
  net_cents INTEGER,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paid'
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_at ON payments(paid_at DESC);
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  session_id TEXT,
  payment_intent_id TEXT,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS plan_offers (
  offer_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  interval TEXT NOT NULL DEFAULT 'month',
  interval_count INTEGER NOT NULL DEFAULT 1,
  prices TEXT NOT NULL DEFAULT '{}',
  valid_from TEXT,
  valid_until TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_offers_plan ON plan_offers(plan, sort);
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'percent',
  value INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  plans TEXT NOT NULL DEFAULT '[]',
  duration TEXT NOT NULL DEFAULT 'once',
  free_periods INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  valid_until TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  stripe_coupon_id TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS promo_uses (
  code TEXT NOT NULL,
  user_id TEXT NOT NULL,
  order_id TEXT,
  used_at TEXT NOT NULL,
  PRIMARY KEY (code, user_id)
);
CREATE INDEX IF NOT EXISTS idx_promo_uses_order ON promo_uses(order_id);
CREATE TABLE IF NOT EXISTS social_accounts (
  user_id TEXT NOT NULL,
  network TEXT NOT NULL,
  target_id TEXT NOT NULL,
  handle TEXT NOT NULL DEFAULT '',
  sealed_token TEXT NOT NULL,
  sealed_refresh TEXT,
  expires_at TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, network)
);
CREATE TABLE IF NOT EXISTS social_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL DEFAULT '',
  app_url TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS social_pending (
  user_id TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS social_posts (
  post_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  network TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  url TEXT,
  text TEXT NOT NULL DEFAULT '',
  performance_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  clip_ms INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_posts_user ON social_posts(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS club_members (
  owner_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, email)
);
CREATE INDEX IF NOT EXISTS idx_club_members_email ON club_members(email);
CREATE TABLE IF NOT EXISTS coupons (
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_user_id);
CREATE TABLE IF NOT EXISTS video_usage (
  pool_user_id TEXT NOT NULL,
  period TEXT NOT NULL,
  seconds REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pool_user_id, period)
);
CREATE TABLE IF NOT EXISTS track_registry (
  track_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  song TEXT NOT NULL,
  song_key TEXT NOT NULL,
  artists TEXT NOT NULL DEFAULT '',
  movie TEXT NOT NULL DEFAULT '',
  year INTEGER,
  language TEXT NOT NULL DEFAULT '',
  drive_url TEXT NOT NULL DEFAULT '',
  folder_id TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  search TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  unavailable INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_registry_song ON track_registry(song_key);
CREATE INDEX IF NOT EXISTS idx_registry_access ON track_registry(last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_registry_owner ON track_registry(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_registry_folder ON track_registry(folder_id);
CREATE TABLE IF NOT EXISTS track_access (
  track_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  how TEXT NOT NULL DEFAULT 'sing',
  copy_track_id TEXT,
  copy_url TEXT NOT NULL DEFAULT '',
  copy_refs TEXT,
  copy_at TEXT,
  PRIMARY KEY (track_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_track_access_user ON track_access(user_id, last_at DESC);
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS live_segments (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (job_id, seq)
);
`;

/**
 * `settings` holds the service's few knobs as JSON by key (`billing`: the plans with their prices per
 * currency, period, video hours, seats, self-service; the admin's note; the expiring-soon and grace
 * days — plans.ts BillingSettings; an older `club_owner` entry is read once into it); `payments` is
 * every payment for a plan (Stripe's, by the webhook, with the ids a refund needs and what Stripe kept
 * of it; a period the admin granted, amount 0); `orders` every Checkout started and what became of it
 * (pending → paid / processing / failed / canceled / expired — the webhook's word, never the browser's);
 * `plan_offers` the ways to pay for a plan (offers.ts: a period with its prices per currency, on sale between
 * two dates) and `promo_codes` the codes that cut a payment (a percentage, an amount, or the fee voided) with
 * `promo_uses` one row per code and account that used it (an order's id while a Checkout is open, so a
 * Checkout that fails gives the use back); `social_accounts` the networks an account connected for
 * posting clips (social.ts: the target — an X user, a Facebook Page, an Instagram account —, its handle,
 * the tokens sealed with the service's secret, never in the clear), `social_states` a sign-in under way
 * (the state, the PKCE verifier, where to send the browser back; taken once, gone in a quarter hour),
 * `social_pending` the Pages a Meta sign-in found when there were several to pick from (sealed), and
 * `social_posts` every clip posted from here and what became of it; `club_members` the email addresses a club owner named to share the club's video hours; `video_usage`
 * the seconds of video on stage per pool (an account, or the club owner's for the whole club) and
 * calendar month (UTC); `coupons` the gate (coupons.ts): one per email address — the code, the expiry,
 * who issued it — with the code an account entered on `users.coupon_code`, and the requirement itself
 * under `settings` key `coupons`.
 *
 * The master track database (registry.ts): `track_registry` is one row per source file — the YouTube
 * video, the singer's Drive folder, the catalog entry (`source_key`, unique) — with the song's search
 * name and metadata, the owner's shareable Drive URL, the file ids in `data`, and the global
 * `last_accessed_at` (UTC, the most recent successful access by anyone — never a search);
 * `track_access` is every singer's own history of it (and their shared copy's file ids, so the files
 * can be fetched from any singer's Drive when the owner's is gone). `bookmarks` is what each singer
 * kept with a tap (prefs.ts): one row per song per singer, the song as it was met (a record of the
 * database, a catalog entry, a YouTube result).
 *
 * Columns added after the first release — put on tables that exist already (`CREATE TABLE IF NOT EXISTS`
 * leaves an existing table as it was): checked and added one by one at startup (`PRAGMA table_info`).
 *   users.role                 — the account's role (roles.ts); a privileged row becomes a super admin
 *   subscriptions.started_at   — when the club owner's year started
 *   subscriptions.status       — active / revoked (expired is a matter of the date)
 *   payments.plan, …           — the plan paid for, Stripe's ids, the fee and the net, refunds (plans.ts)
 *   users.coupon_code          — the coupon the account entered at the gate (coupons.ts)
 *   users.prefs                — the songs the singer prefers (prefs.ts), as JSON
 *   users.sv_no                — the SingersVoice number: SV-1000 upward in order of creation, given once, never reused
 *   users.google_id            — the Google account's id (the user_id without its `g-`)
 *   users.phone                — a phone number the singer gave (optional)
 *   users.blocked, …           — blocked for good by a super admin (the flag, when, the admins' note)
 *   orders.offer_id, promo_code, discount_cents — the offer chosen and the code on a Checkout (offers.ts)
 *   payments.promo_code        — the code on a payment
 * `blocks` is who blocked whom (a singer's own list): nobody blocked by a host gets into that host's meets.
 */
export const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string; after?: string }[] = [
  { table: 'users', column: 'role', ddl: "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'dual'", after: "UPDATE users SET role='super_admin' WHERE privileged=1" },
  { table: 'subscriptions', column: 'started_at', ddl: 'ALTER TABLE subscriptions ADD COLUMN started_at TEXT' },
  { table: 'subscriptions', column: 'status', ddl: "ALTER TABLE subscriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'", after: "UPDATE users SET role='club_owner' WHERE role='dual' AND user_id IN (SELECT user_id FROM subscriptions WHERE plan='publisher')" },
  { table: 'payments', column: 'plan', ddl: "ALTER TABLE payments ADD COLUMN plan TEXT NOT NULL DEFAULT 'club'" },
  { table: 'payments', column: 'payment_intent_id', ddl: 'ALTER TABLE payments ADD COLUMN payment_intent_id TEXT' },
  { table: 'payments', column: 'charge_id', ddl: 'ALTER TABLE payments ADD COLUMN charge_id TEXT' },
  { table: 'payments', column: 'fee_cents', ddl: 'ALTER TABLE payments ADD COLUMN fee_cents INTEGER' },
  { table: 'payments', column: 'net_cents', ddl: 'ALTER TABLE payments ADD COLUMN net_cents INTEGER' },
  { table: 'payments', column: 'refunded_cents', ddl: 'ALTER TABLE payments ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0' },
  { table: 'payments', column: 'status', ddl: "ALTER TABLE payments ADD COLUMN status TEXT NOT NULL DEFAULT 'paid'" },
  { table: 'users', column: 'coupon_code', ddl: "ALTER TABLE users ADD COLUMN coupon_code TEXT NOT NULL DEFAULT ''" },
  { table: 'users', column: 'coupon_at', ddl: 'ALTER TABLE users ADD COLUMN coupon_at TEXT' },
  { table: 'users', column: 'prefs', ddl: "ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT ''" },
  // Every account that exists gets its number in the order it was made; the index keeps a number from ever being given twice.
  { table: 'users', column: 'sv_no', ddl: 'ALTER TABLE users ADD COLUMN sv_no INTEGER', after: 'UPDATE users SET sv_no = 999 + (SELECT COUNT(*) FROM users u2 WHERE u2.created_at < users.created_at OR (u2.created_at = users.created_at AND u2.user_id <= users.user_id)); CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sv_no ON users(sv_no)' },
  { table: 'users', column: 'google_id', ddl: "ALTER TABLE users ADD COLUMN google_id TEXT NOT NULL DEFAULT ''", after: "UPDATE users SET google_id = substr(user_id, 3) WHERE user_id LIKE 'g-%'" },
  { table: 'users', column: 'phone', ddl: "ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''" },
  { table: 'users', column: 'blocked', ddl: 'ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'blocked_at', ddl: 'ALTER TABLE users ADD COLUMN blocked_at TEXT' },
  { table: 'users', column: 'blocked_note', ddl: "ALTER TABLE users ADD COLUMN blocked_note TEXT NOT NULL DEFAULT ''" },
  { table: 'orders', column: 'offer_id', ddl: 'ALTER TABLE orders ADD COLUMN offer_id TEXT' },
  { table: 'orders', column: 'promo_code', ddl: "ALTER TABLE orders ADD COLUMN promo_code TEXT NOT NULL DEFAULT ''" },
  { table: 'orders', column: 'discount_cents', ddl: 'ALTER TABLE orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0' },
  { table: 'payments', column: 'promo_code', ddl: "ALTER TABLE payments ADD COLUMN promo_code TEXT NOT NULL DEFAULT ''" },
];
