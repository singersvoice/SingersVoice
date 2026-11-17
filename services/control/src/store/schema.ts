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
 * Columns added after the first release — put on tables that exist already (`CREATE TABLE IF NOT EXISTS`
 * leaves an existing table as it was): checked and added one by one at startup (`PRAGMA table_info`).
 *   users.role                 — the account's role (roles.ts); a privileged row becomes a super admin
 *   subscriptions.started_at   — when the club owner's year started
 *   subscriptions.status       — active / revoked (expired is a matter of the date)
 */
export const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string; after?: string }[] = [
  { table: 'users', column: 'role', ddl: "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'dual'", after: "UPDATE users SET role='super_admin' WHERE privileged=1" },
  { table: 'subscriptions', column: 'started_at', ddl: 'ALTER TABLE subscriptions ADD COLUMN started_at TEXT' },
  { table: 'subscriptions', column: 'status', ddl: "ALTER TABLE subscriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'", after: "UPDATE users SET role='club_owner' WHERE role='dual' AND user_id IN (SELECT user_id FROM subscriptions WHERE plan='publisher')" },
];
