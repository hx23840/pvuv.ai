/** Keep queued events and in-flight reports from recreating deleted site data.
 * NULL site_id is allowed for instance-wide clusters and owner-wide API tokens.
 * Use a trigger so the existence check and insert are one SQLite operation.
 */
export function siteInsertGuardSQL(table: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error('invalid table name');
  return `CREATE TRIGGER IF NOT EXISTS "pvuv_site_guard_${table}"
    BEFORE INSERT ON "${table}"
    WHEN NEW.site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sites WHERE site_id = NEW.site_id)
    BEGIN SELECT RAISE(IGNORE); END`;
}
