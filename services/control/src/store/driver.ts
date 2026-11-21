/**
 * Minimal SQL driver so the same store runs on Node (node:sqlite, zero dependencies) and on
 * Cloudflare Workers (SQLite-backed Durable Object storage). Both speak SQLite, so one schema serves both.
 *
 * Every driver counts what it does (`stats`): statements, rows read and rows written — the Durable Object's
 * own counters where it has them (an index entry is a row too; the free plan allows 100,000 written a day),
 * node:sqlite's change count on Node — and remembers the last write that failed, so /health can say whether
 * the service can save right now and the store can keep the day's budget in view.
 */
export interface DriverStats {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  /** Counting since (ms since epoch): the process or the object started. */
  since: number;
  /** The last statement that failed, if any (the message is what the runtime said). */
  lastError: { at: number; message: string; write: boolean } | null;
}

export interface Driver {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Execute several statements (schema setup). */
  exec(sql: string): Promise<void>;
  readonly stats: DriverStats;
}

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

function newStats(): DriverStats {
  return { statements: 0, rowsRead: 0, rowsWritten: 0, since: Date.now(), lastError: null };
}

function failed(stats: DriverStats, sql: string, e: unknown): never {
  stats.lastError = { at: Date.now(), message: e instanceof Error ? e.message : String(e), write: WRITE.test(sql) };
  throw e;
}

// ---- Node: node:sqlite (Node 22.13+ built-in) ----
interface NodeSqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
export interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
}

export function nodeSqliteDriver(db: NodeSqliteDatabase): Driver {
  const stats = newStats();
  return {
    stats,
    async run(sql, params = []) {
      stats.statements++;
      try {
        const r = db.prepare(sql).run(...params) as { changes?: number | bigint } | undefined;
        stats.rowsWritten += Number(r?.changes ?? 0);
      } catch (e) {
        failed(stats, sql, e);
      }
    },
    async all<T>(sql: string, params: unknown[] = []) {
      stats.statements++;
      try {
        const rows = db.prepare(sql).all(...params) as T[];
        stats.rowsRead += rows.length;
        return rows;
      } catch (e) {
        failed(stats, sql, e);
      }
    },
    async get<T>(sql: string, params: unknown[] = []) {
      stats.statements++;
      try {
        const row = (db.prepare(sql).get(...params) as T | undefined) ?? undefined;
        if (row !== undefined) stats.rowsRead++;
        return row;
      } catch (e) {
        failed(stats, sql, e);
      }
    },
    async exec(sql) {
      stats.statements++;
      try {
        db.exec(sql);
      } catch (e) {
        failed(stats, sql, e);
      }
    },
  };
}

// ---- Cloudflare Durable Object SQLite storage (ctx.storage.sql) ----
export interface SqlStorageCursorLike {
  toArray(): Record<string, unknown>[];
  /** Filled once the cursor is consumed (the runtime's own count; index rows included). */
  rowsRead?: number;
  rowsWritten?: number;
}
export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): SqlStorageCursorLike;
}

/** Durable Object SQL binds BLOBs as ArrayBuffer (node:sqlite as a typed array): hand each driver what it takes. */
const toArrayBuffer = (params: unknown[]): unknown[] => params.map((p) => (ArrayBuffer.isView(p) ? p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) : p));

export function durableSqlDriver(sql: SqlStorageLike): Driver {
  const stats = newStats();
  const count = (c: SqlStorageCursorLike) => {
    stats.rowsRead += Number(c.rowsRead ?? 0);
    stats.rowsWritten += Number(c.rowsWritten ?? 0);
  };
  return {
    stats,
    async run(q, params = []) {
      stats.statements++;
      try {
        const c = sql.exec(q, ...toArrayBuffer(params));
        c.toArray();
        count(c);
      } catch (e) {
        failed(stats, q, e);
      }
    },
    async all<T>(q: string, params: unknown[] = []) {
      stats.statements++;
      try {
        const c = sql.exec(q, ...toArrayBuffer(params));
        const rows = c.toArray() as T[];
        count(c);
        return rows;
      } catch (e) {
        failed(stats, q, e);
      }
    },
    async get<T>(q: string, params: unknown[] = []) {
      stats.statements++;
      try {
        const c = sql.exec(q, ...toArrayBuffer(params));
        const row = (c.toArray()[0] as T | undefined) ?? undefined;
        count(c);
        return row;
      } catch (e) {
        failed(stats, q, e);
      }
    },
    async exec(q) {
      for (const stmt of q.split(';').map((s) => s.trim()).filter(Boolean)) {
        stats.statements++;
        try {
          const c = sql.exec(stmt);
          c.toArray();
          count(c);
        } catch (e) {
          failed(stats, stmt, e);
        }
      }
    },
  };
}
