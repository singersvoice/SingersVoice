/**
 * Minimal SQL driver so the same store runs on Node (node:sqlite, zero dependencies) and on
 * Cloudflare Workers (D1). Both speak SQLite, so one schema serves both.
 */
export interface Driver {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Execute several statements (schema setup). */
  exec(sql: string): Promise<void>;
}

// ---- Cloudflare D1 (structural types; no dependency on @cloudflare/workers-types) ----
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  first<T = unknown>(): Promise<T | null>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

export function d1Driver(db: D1DatabaseLike): Driver {
  return {
    async run(sql, params = []) {
      await db.prepare(sql).bind(...params).run();
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const r = await db.prepare(sql).bind(...params).all<T>();
      return r.results ?? [];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const r = await db.prepare(sql).bind(...params).first<T>();
      return r ?? undefined;
    },
    async exec(sql) {
      const stmts = sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s));
      if (stmts.length) await db.batch(stmts);
    },
  };
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

/** Open a node:sqlite database (file path or ':memory:'). Loaded lazily so the Worker bundle never sees it. */
export async function openNodeSqlite(path: string): Promise<NodeSqliteDatabase> {
  const mod = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => NodeSqliteDatabase };
  return new mod.DatabaseSync(path);
}
