/**
 * Minimal SQL driver so the same store runs on Node (node:sqlite, zero dependencies) and on
 * Cloudflare Workers (SQLite-backed Durable Object storage). Both speak SQLite, so one schema serves both.
 */
export interface Driver {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Execute several statements (schema setup). */
  exec(sql: string): Promise<void>;
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
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...params) as T | undefined) ?? undefined;
    },
    async exec(sql) {
      db.exec(sql);
    },
  };
}

// ---- Cloudflare Durable Object SQLite storage (ctx.storage.sql) ----
export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** Durable Object SQL binds BLOBs as ArrayBuffer (node:sqlite as a typed array): hand each driver what it takes. */
const toArrayBuffer = (params: unknown[]): unknown[] => params.map((p) => (ArrayBuffer.isView(p) ? p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) : p));

export function durableSqlDriver(sql: SqlStorageLike): Driver {
  return {
    async run(q, params = []) {
      sql.exec(q, ...toArrayBuffer(params));
    },
    async all<T>(q: string, params: unknown[] = []) {
      return sql.exec(q, ...toArrayBuffer(params)).toArray() as T[];
    },
    async get<T>(q: string, params: unknown[] = []) {
      return (sql.exec(q, ...toArrayBuffer(params)).toArray()[0] as T | undefined) ?? undefined;
    },
    async exec(q) {
      for (const stmt of q.split(';').map((s) => s.trim()).filter(Boolean)) sql.exec(stmt);
    },
  };
}
