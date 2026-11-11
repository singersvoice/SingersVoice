/** Node only: open a node:sqlite database (file path or ':memory:'). Kept out of the Worker bundle. */
import type { NodeSqliteDatabase } from './driver.ts';

export async function openNodeSqlite(path: string): Promise<NodeSqliteDatabase> {
  const mod = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => NodeSqliteDatabase };
  return new mod.DatabaseSync(path);
}
