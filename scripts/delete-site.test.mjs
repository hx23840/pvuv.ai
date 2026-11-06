import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'pvuv-delete-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
async function bundled(entry) {
  const outfile = join(dir, entry.replaceAll('/', '_') + '.mjs');
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  return import(pathToFileURL(outfile));
}
const { default: consoleWorker } = await bundled('workers/console/src/index.ts');
const { default: consumer } = await bundled('workers/consumer/src/index.ts');
const { eventsTableDDL, EVENT_COLUMNS } = await bundled('shared/events.ts');
const { hmacSign } = await bundled('shared/ids.ts');
const secret = 'local-test-only';
const origin = 'https://console.example.test';

// Real SQLite runs the exact worker SQL, including atomic batches and triggers.
function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(join('migrations', file), 'utf8'));
  }
  for (const ddl of eventsTableDDL('202611')) sql.exec(ddl);
  sql.exec("INSERT INTO sites (site_id,name,owner_id,allowed_domains,created_at) VALUES ('testSite','测试 <site>','admin','[]',1),('keepSite','Keep','other','[]',1)");
  const tables = sql.prepare("SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND p.name='site_id' AND m.name!='sites'").all().map((r) => r.name);
  for (const table of tables) {
    const columns = sql.prepare(`PRAGMA table_info("${table}")`).all()
      .filter((c) => !(c.name === 'id' && c.type === 'INTEGER') && (c.notnull || c.pk || c.name === 'site_id'));
    for (const site of ['testSite', 'keepSite']) {
      sql.prepare(`INSERT INTO "${table}" (${columns.map((c) => `"${c.name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
        .run(...columns.map((c) => c.name === 'site_id' ? site : /INT|REAL/.test(c.type) ? 1 : `${site}-${c.name}`));
    }
  }
  sql.exec("INSERT INTO api_tokens(token_id,owner_id,name,token_hash,prefix,created_at) VALUES ('global','admin','global','global','global',1)");
  sql.exec("INSERT INTO instance_settings(key,value) VALUES ('name','Keep branding')");
  const db = {
    prepare(query) {
      const stmt = { query, args: [], bind(...args) { this.args = args; return this; },
        async all() { return { results: sql.prepare(query).all(...this.args) }; },
        async first() { return sql.prepare(query).get(...this.args) ?? null; },
        async run() { return sql.prepare(query).run(...this.args); } };
      return stmt;
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = statements.map((s) => ({ success: true, meta: sql.prepare(s.query).run(...s.args) }));
        sql.exec('COMMIT'); return results;
      } catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const deletedKeys = [];
  const env = { DB: db, HMAC_KEY: secret, SITE_CONFIG: { async delete(key) { deletedKeys.push(key); } } };
  return { sql, tables, env, deletedKeys };
}
async function request(env, { user = 'admin', site = 'testSite', name = '测试 <site>', body, requestOrigin = origin, contentType = 'application/json' } = {}) {
  const headers = { origin: requestOrigin, 'content-type': contentType };
  if (user) {
    const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 60000 })).toString('base64url');
    headers.cookie = `_pvc_s=${payload}.${await hmacSign(secret, `session|${payload}`)}`;
  }
  return consoleWorker.fetch(new Request(`${origin}/api/sites/${site}`, {
    method: 'DELETE', headers, body: body ?? JSON.stringify({ name }),
  }), env);
}

test('deletes all site-owned tables and partitions, preserving other sites and owner-wide settings', async (t) => {
  const { sql, tables, env, deletedKeys } = fixture(t);
  assert.equal((await request(env)).status, 200);
  for (const table of ['sites', ...tables]) {
    assert.equal(sql.prepare(`SELECT count(*) AS n FROM "${table}" WHERE site_id=?`).get('testSite').n, 0, table);
    assert.equal(sql.prepare(`SELECT count(*) AS n FROM "${table}" WHERE site_id=?`).get('keepSite').n, 1, table);
  }
  assert.equal(sql.prepare("SELECT count(*) AS n FROM api_tokens WHERE token_id='global'").get().n, 1);
  assert.equal(sql.prepare("SELECT value FROM instance_settings WHERE key='name'").get().value, 'Keep branding');
  assert.deepEqual(deletedKeys, ['site:testSite']);
  assert.equal((await request(env)).status, 404);
});

test('requires login, ownership, same origin, JSON and exact confirmation without modifying data', async (t) => {
  const { sql, env, deletedKeys } = fixture(t);
  for (const [options, status] of [
    [{ user: null }, 401], [{ user: 'other' }, 403], [{ requestOrigin: 'https://evil.test' }, 403],
    [{ contentType: 'text/plain' }, 415], [{ name: 'wrong' }, 400], [{ body: 'null' }, 400],
    [{ body: '{bad' }, 400], [{ body: '{"name":42}' }, 400], [{ site: 'absent' }, 404],
  ]) assert.equal((await request(env, options)).status, status, JSON.stringify(options));
  assert.equal(sql.prepare('SELECT count(*) AS n FROM sites').get().n, 2);
  assert.deepEqual(deletedKeys, []);
});

test('a database failure rolls back the entire deletion', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { sql, env, tables, deletedKeys } = fixture(t);
  sql.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.equal((await request(env)).status, 500);
  for (const table of ['sites', ...tables]) {
    assert.equal(sql.prepare(`SELECT count(*) AS n FROM "${table}" WHERE site_id='testSite'`).get().n, 1, table);
  }
  assert.deepEqual(deletedKeys, []);
});

test('queued events cannot resurrect a site, including a future partition; other sites still ingest', async (t) => {
  const { sql, env } = fixture(t);
  assert.equal((await request(env)).status, 200);
  const ts = Date.UTC(2027, 0, 2);
  const row = (site) => ({ ...Object.fromEntries(EVENT_COLUMNS.map((c) => [c, null])),
    site_id: site, eid: `queued-${site}`, event: 'pageview', visitor_id: 'visitor', session_id: 'session',
    url: 'https://example.test/', hostname: 'example.test', path: '/', ts, created_at: ts,
    bot_score: 0, bot_flags: 0, verdict: 'clean', had_interaction: 0 });
  let ack = false, retry = false;
  await consumer.queue({ messages: [{ body: row('testSite') }, { body: row('keepSite') }],
    ackAll() { ack = true; }, retryAll() { retry = true; } }, env);
  assert.equal(ack, true); assert.equal(retry, false);
  for (const table of ['events_202701', 'sessions', 'visitor_profiles']) {
    assert.equal(sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE site_id='testSite'`).get().n, 0, table);
    assert.ok(sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE site_id='keepSite'`).get().n > 0, table);
  }
  sql.exec("INSERT INTO ai_reports(site_id,content) VALUES ('testSite','late report')");
  assert.equal(sql.prepare("SELECT count(*) AS n FROM ai_reports WHERE site_id='testSite'").get().n, 0);
});

test('cache invalidation failure does not misreport a committed deletion', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { sql, env } = fixture(t);
  env.SITE_CONFIG.delete = async () => { throw new Error('KV offline'); };
  assert.equal((await request(env)).status, 200);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM sites WHERE site_id='testSite'").get().n, 0);
});
