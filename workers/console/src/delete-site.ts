import { siteInsertGuardSQL } from '../../../shared/site-guard';

/** Discover retained monthly partitions as well as ordinary site-owned tables.
 * Deletion and insert guards commit atomically; a failed purge leaves the site
 * intact. No user-supplied identifier is interpolated into SQL.
 */
export async function purgeSite(db: D1Database, siteId: string, owner: string, name: string): Promise<void> {
  // D1 denies table-valued PRAGMA functions. Inspect its stored CREATE TABLE
  // definitions instead; all site-owned application tables declare site_id.
  const schema = await db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name != 'sites' AND name NOT LIKE 'sqlite_%'
    ORDER BY name`).all<{ name: string; sql: string }>();
  const tables = schema.results.filter((table) => /\bsite_id\b/i.test(table.sql));
  const statements: D1PreparedStatement[] = [];
  for (const { name: table } of tables) {
    statements.push(db.prepare(siteInsertGuardSQL(table)));
    statements.push(db.prepare(`DELETE FROM "${table}" WHERE site_id = ?
      AND EXISTS (SELECT 1 FROM sites WHERE site_id = ? AND owner_id = ? AND name = ?)`)
      .bind(siteId, siteId, owner, name));
  }
  statements.push(db.prepare('DELETE FROM sites WHERE site_id = ? AND owner_id = ? AND name = ?')
    .bind(siteId, owner, name));
  await db.batch(statements);
}
