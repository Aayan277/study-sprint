// SQL tests for supabase/*.sql. Run with:  node tests/sql/run.mjs   (or: npm run test:sql)
//
// Starts a throwaway local PostgreSQL (needs pg_ctl, initdb, psql and pg_dump: for example the "postgresql" package, or
// the folder /usr/lib/postgresql/<version>/bin), loads tests/sql/shim.sql (a stand-in for Supabase's "auth" and "storage"
// schemas and API roles), runs the real setup.sql / media.sql / limits.sql / ci-roles.sql on it, and checks the results.
// Without PostgreSQL it says so and exits 0 (so it is skipped, not failed). It never talks to a live Supabase project.
// It is not part of `npm test`, because that has to work on a machine without PostgreSQL.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, chownSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const SQL = resolve(here, '../../supabase');
const read = f => readFileSync(f, 'utf8');

// ---------- find PostgreSQL, or skip ----------
function findBin() {
  const dirs = (process.env.PATH || '').split(delimiter);
  const root = '/usr/lib/postgresql';
  if (existsSync(root)) {
    for (const v of readdirSync(root).sort((a, b) => parseInt(b) - parseInt(a))) dirs.push(join(root, v, 'bin'));
  }
  for (const d of dirs) if (d && ['pg_ctl', 'initdb', 'psql', 'pg_dump'].every(n => existsSync(join(d, n)))) return d;
  return null;
}
const bin = findBin();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
let pgUid = null;
if (bin && isRoot) {            // PostgreSQL refuses to run as root: use the "postgres" user if there is one
  const r = spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' });
  if (r.status === 0 && spawnSync('runuser', ['--version']).status === 0) pgUid = Number(r.stdout.trim());
}
if (!bin || (isRoot && pgUid === null)) {
  console.log('SKIP: no usable local PostgreSQL (needs pg_ctl, initdb, psql, pg_dump; and a non-root user to run it). SQL tests not run.');
  process.exit(0);
}

// ---------- the throwaway server ----------
const dir = mkdtempSync(join(tmpdir(), 'sqltest-'));
if (isRoot) chownSync(dir, pgUid, 0);
const port = String(40000 + Math.floor(Math.random() * 20000));
function runPg(cmd, args) {
  const [c, a] = isRoot ? ['runuser', ['-u', 'postgres', '--', join(bin, cmd), ...args]] : [join(bin, cmd), args];
  return spawnSync(c, a, { encoding: 'utf8' });
}
let started = false;
function cleanup() {
  if (started) { runPg('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', '-w', 'stop']); started = false; }
  rmSync(dir, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

let r = runPg('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C']);
if (r.status !== 0) { console.log('SKIP: initdb failed:', r.stderr.trim()); process.exit(0); }
r = runPg('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses='' -c fsync=off -c max_connections=60`, '-l', join(dir, 'log'), '-w', 'start']);
if (r.status !== 0) { console.log('SKIP: could not start PostgreSQL:', (r.stderr || r.stdout).trim()); process.exit(0); }
started = true;

// ---------- helpers ----------
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const env = { ...process.env, PGOPTIONS: '-c client_min_messages=warning' };
const psqlArgs = (db, user, extra = []) => ['-h', dir, '-p', port, '-U', user, '-d', db, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...extra];
function psql(db, sql, { user = 'postgres', file = null } = {}) {
  const res = spawnSync(join(bin, 'psql'), psqlArgs(db, user, file ? ['-f', file] : []), { input: file ? undefined : sql, encoding: 'utf8', env });
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim(), sql: (sql || file || '').slice(0, 160) };
}
function psqlAsync(db, sql, user = 'postgres') {
  return new Promise(done => {
    const p = spawn(join(bin, 'psql'), psqlArgs(db, user), { env });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => done({ ok: code === 0, out: out.trim(), err: err.trim() }));
    p.stdin.end(sql);
  });
}
const ok = (res, what = '') => { assert.ok(res.ok, `${what} failed: ${res.err}`); return res.out; };
const fails = (res, re, what = '') => { assert.ok(!res.ok, `${what || res.sql} should have failed`); assert.match(res.err, re, what); };
const val = (db, sql) => ok(psql(db, sql), sql);
const num = (db, sql) => Number(val(db, sql));
// Run SQL as a signed-in person (role "authenticated", with the sign-in id Supabase would put in the token) or as anon.
const asUser = (db, uid, sql, role = 'authenticated') => psql(db, `${uid ? `set request.jwt.claim.sub = '${uid}';` : ''} set role ${role}; ${sql}`);
const asUserAsync = (db, uid, sql) => psqlAsync(db, `set request.jwt.claim.sub = '${uid}'; set role authenticated; ${sql}`);

let dbCount = 0;
function newDb(label, { old = false, scripts = true } = {}) {
  const db = `t${++dbCount}_${label}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  ok(psql('postgres', `create database ${db}`), 'create database');
  ok(psql(db, '', { file: join(here, 'shim.sql') }), 'shim');
  ok(psql(db, `insert into auth.users (id, email) values ('${A}', 'a@example.test'), ('${B}', 'b@example.test'), ('${C}', 'c@example.test')`));
  if (old) for (const f of ['setup', 'media', 'limits']) ok(psql(db, '', { file: join(here, 'old', `${f}.sql`) }), `old ${f}.sql`);
  else if (scripts) runAll(db);
  return db;
}
const runAll = db => { for (const f of ['setup', 'media', 'limits']) ok(psql(db, '', { file: join(SQL, `${f}.sql`) }), `${f}.sql`); };

// A 1-row insert whose counted size we can predict: private.row_bytes(id, data).
const rowSql = (id, pad = 100, extra = '') => `insert into public.sync_items (store, id, data, updated_at) values ('cards', '${id}', jsonb_build_object('x', repeat('z', ${pad})), 1) ${extra}`;
const rowBytes = (db, id, pad = 100) => num(db, `select private.row_bytes('${id}', jsonb_build_object('x', repeat('z', ${pad})))`);
const total = (db, name = 'sync') => num(db, `select bytes from private.usage_totals where name = '${name}'`);
// Is every counter exactly what the stored rows add up to?
function assertExact(db, what = '') {
  const bad = val(db, `select
    (select bytes from private.usage_totals where name = 'sync') <> (select coalesce(sum(private.row_bytes(id, data)), 0) from public.sync_items)
    or (select bytes from private.usage_totals where name = 'sync') <> (select coalesce(sum(bytes), 0) from public.sync_usage)
    or exists (select 1 from public.sync_usage u where
         u.bytes <> (select coalesce(sum(private.row_bytes(s.id, s.data)), 0) from public.sync_items s where s.user_id = u.user_id)
      or u.rows  <> (select count(*) from public.sync_items s where s.user_id = u.user_id))
    or exists (select 1 from public.sync_items s where not exists (select 1 from public.sync_usage u where u.user_id = s.user_id))
    or (select bytes from private.usage_totals where name = 'media') <> (select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects where bucket_id = 'media')`);
  assert.equal(bad, 'f', `counters are not exact ${what}`);
}
// A picture of the whole state: structure (tables, columns, policies, grants, function bodies) and every table's content.
function snapshot(db) {
  const dump = spawnSync(join(bin, 'pg_dump'), ['-h', dir, '-p', port, '-U', 'postgres', '-d', db, '--schema-only', '-n', 'public', '-n', 'private', '-n', 'storage', '--no-owner'], { encoding: 'utf8', env });
  assert.equal(dump.status, 0, dump.stderr);
  const data = val(db, `select md5(string_agg(x, '|' order by x)) from (
    select 's' || t::text as x from public.sync_items t union all select 'u' || t::text from public.sync_usage t
    union all select 'q' || t::text from public.quotas t union all select 'g' || t::text from public.global_limits t
    union all select 'T' || t::text from private.usage_totals t union all select 'c' || t::text from private.app_config_values t
    union all select 'o' || t::text from storage.objects t union all select 'b' || t::text from storage.buckets t union all select 'a' || t::text from auth.users t) z`);
  return { schema: dump.stdout.replace(/^--.*$/gm, '').replace(/^\\(un)?restrict .*$/gm, ''), data };
}
// The status select at the end of limits.sql, as a subquery text (so a test can filter it).
const statusSql = db => { const f = read(join(SQL, 'limits.sql')); return f.slice(f.lastIndexOf('select * from (values')).replace(/\) as status\(n, what, value, result\) order by n;\s*$/, ') as status(n, what, value, result)') .replace(/^select \* from/, 'select result, what from'); };
const addObject = (db, uid, name, size) => ok(psql(db, `insert into storage.objects (bucket_id, name, metadata) values ('media', '${uid}/${name}', '{"size":${size}}')`));

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok    ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').join('\n        ')}`); }
}

// ---------- the tests ----------
console.log(`SQL tests (PostgreSQL ${runPg('postgres', ['--version']).stdout.trim().replace('postgres (PostgreSQL) ', '')}, throwaway server in ${dir})`);

await test('a fresh project: the three scripts run, and running them again (twice) changes nothing', () => {
  const db = newDb('fresh');
  ok(psql(db, `insert into public.quotas (user_id) values ('${C}')`));
  ok(asUser(db, A, rowSql('r1') + ';' + rowSql('r2', 3000)));
  addObject(db, A, 'p.png', 12345);
  const before = snapshot(db);
  const firstRows = num(db, `select count(*) from public.schema_log`.replace('public.', 'private.'));
  for (let i = 0; i < 2; i++) runAll(db);
  ok(psql(db, '', { file: join(SQL, 'owner.sql') }), 'owner.sql');
  const after = snapshot(db);
  assert.equal(after.schema, before.schema, 'structure changed on re-run');
  assert.equal(after.data, before.data, 'data changed on re-run');
  assertExact(db);
  // every file logged itself, each time it ran
  assert.equal(num(db, `select count(*) from private.schema_log where file = 'limits.sql' and version = 2`), 3);
  assert.equal(firstRows, 3);
  assert.equal(val(db, `select string_agg(distinct file, ',' order by file) from private.schema_log`), 'limits.sql,media.sql,setup.sql');
});

await test('upgrading a project that has the old scripts: no data lost, custom limits kept, new defaults', () => {
  const db = newDb('upgrade', { old: true });
  ok(psql(db, `insert into public.quotas (user_id, media_bytes_limit, data_bytes_limit, data_rows_limit) values ('${B}', 209715200, 104857600, 5000)`));
  ok(asUser(db, A, rowSql('a1', 5000) + ';' + rowSql('a2', 100) + ';' + rowSql('a3', 70000 / 2)));
  ok(asUser(db, B, rowSql('b1', 200)));
  ok(psql(db, `insert into public.sync_items (user_id, store, id, data, deleted, updated_at) values ('${B}', 'cards', 'gone', null, true, 5)`));
  addObject(db, A, 'one.png', 1000); addObject(db, B, 'two.png', 2500);
  // the old files had a one-minute cache table and the old numbers
  assert.equal(num(db, `select bytes from public.global_limits where name = 'sync'`), 440401920);
  assert.equal(num(db, `select public.default_media_limit()`), 188743680);
  const items = val(db, `select md5(string_agg(t::text, '|' order by t::text)) from public.sync_items t`);
  const seq = val(db, `select last_value from public.sync_seq`);
  runAll(db);
  assert.equal(val(db, `select md5(string_agg(t::text, '|' order by t::text)) from public.sync_items t`), items, 'synced data changed');
  assert.equal(val(db, `select last_value from public.sync_seq`), seq);
  assert.equal(num(db, `select count(*) from public.sync_items`), 5);
  assert.equal(num(db, `select public.default_media_limit()`), 52428800);
  assert.equal(num(db, `select public.default_data_limit()`), 41943040);
  assert.equal(num(db, `select bytes from public.global_limits where name = 'sync'`), 314572800);
  assert.equal(num(db, `select bytes from public.global_limits where name = 'media'`), 943718400);
  assert.equal(val(db, `select media_bytes_limit || '/' || data_bytes_limit || '/' || data_rows_limit from public.quotas where user_id = '${B}'`), '209715200/104857600/5000');
  assert.equal(num(db, `select public._media_limit('${B}')`), 209715200);
  assert.equal(num(db, `select public._data_limit('${B}')`), 104857600);
  assert.equal(num(db, `select public._media_limit('${A}')`), 52428800);
  assert.equal(val(db, `select to_regclass('public.usage_cache') is null`), 't');
  assert.equal(total(db, 'media'), 3500);
  assertExact(db, 'after the upgrade');
  // the new rules are live: a bad record is refused, a good one goes through, the old data is still readable
  fails(asUser(db, A, `insert into public.sync_items (store, id, data, updated_at) values ('cards', 'bad', '[1]', 1)`), /sync_items_data_object/);
  ok(asUser(db, A, rowSql('a4')));
  assertExact(db, 'after a new insert');
});

await test('an upgrade keeps defaults and a fuse the owner changed by hand', () => {
  const db = newDb('upgrade2', { old: true });
  ok(psql(db, `create or replace function public.default_media_limit() returns bigint language sql immutable as 'select 31457280::bigint'`));
  ok(psql(db, `update public.global_limits set bytes = 104857600 where name = 'sync'`));
  runAll(db); runAll(db);
  assert.equal(num(db, `select public.default_media_limit()`), 31457280);
  assert.equal(num(db, `select public.default_data_limit()`), 41943040);
  assert.equal(num(db, `select bytes from public.global_limits where name = 'sync'`), 104857600);
});

await test('defaults: 50 MB pictures, 40 MB data, 300 MB data fuse; a custom quota row wins; my_usage shows them', () => {
  const db = newDb('defaults');
  assert.equal(num(db, `select public.default_media_limit()`), 52428800);
  assert.equal(num(db, `select public.default_data_limit()`), 41943040);
  assert.equal(num(db, `select bytes from public.global_limits where name = 'sync'`), 314572800);
  assert.equal(num(db, `select bytes from public.global_limits where name = 'media'`), 943718400);
  ok(psql(db, `insert into public.quotas (user_id) values ('${B}')`));            // a new row gets the new defaults too
  assert.equal(val(db, `select media_bytes_limit || '/' || data_bytes_limit from public.quotas where user_id = '${B}'`), '52428800/41943040');
  // the recipe in limits.sql for giving a named person more
  ok(psql(db, `insert into public.quotas (user_id, media_bytes_limit, data_bytes_limit)
    select id, 209715200, 104857600 from auth.users where email = 'c@example.test'
    on conflict (user_id) do update set media_bytes_limit = excluded.media_bytes_limit, data_bytes_limit = excluded.data_bytes_limit`));
  runAll(db);
  assert.equal(num(db, `select public._data_limit('${C}')`), 104857600);
  assert.equal(num(db, `select public._media_limit('${C}')`), 209715200);
  assert.equal(num(db, `select public._data_limit('${A}')`), 41943040);
  const u = JSON.parse(ok(asUser(db, C, `select public.my_usage()`)));
  assert.deepEqual(u, { data_bytes: 0, data_limit: 104857600, media_bytes: 0, media_limit: 209715200 });
  fails(asUser(db, null, `select public.my_usage()`, 'anon'), /permission denied/);
});

await test('row isolation: each person sees and changes only their own rows', () => {
  const db = newDb('rls');
  ok(asUser(db, A, rowSql('mine')));
  ok(asUser(db, B, rowSql('mine')));                                  // the same id for another person is a different row
  assert.equal(num(db, `select count(*) from public.sync_items`), 2);
  assert.equal(asUser(db, B, `select count(*) from public.sync_items where user_id = '${A}'`).out, '0');
  assert.equal(asUser(db, B, `select count(*) from public.sync_items`).out, '1');
  fails(asUser(db, B, `insert into public.sync_items (user_id, store, id, data, updated_at) values ('${A}', 'cards', 'planted', '{}', 1)`), /row-level security/);
  assert.equal(asUser(db, B, `with u as (update public.sync_items set data = '{"hacked":1}', updated_at = 99 where user_id = '${A}' returning 1) select count(*) from u`).out, '0');
  assert.equal(asUser(db, B, `with d as (delete from public.sync_items where user_id = '${A}' returning 1) select count(*) from d`).out, '0');
  assert.equal(val(db, `select data::text from public.sync_items where user_id = '${A}'`), '{"x": "' + 'z'.repeat(100) + '"}');
  // moving a row to someone else is refused too
  fails(asUser(db, B, `update public.sync_items set user_id = '${A}', updated_at = 9 where user_id = '${B}'`), /row-level security/);
  // a signed-in person only sees their own quota and counters
  ok(psql(db, `insert into public.quotas (user_id) values ('${A}'), ('${B}')`));
  assert.equal(asUser(db, A, `select count(*) from public.quotas`).out, '1');
  fails(asUser(db, A, `select * from public.sync_usage`), /permission denied/);
  fails(asUser(db, A, `select * from public.global_limits`), /permission denied/);
  // no one signed in sees nothing
  assert.equal(asUser(db, null, `select 1`, 'anon').out, '1');
  fails(asUser(db, null, `select count(*) from public.sync_items`, 'anon'), /permission denied/);
  // media: only the own folder
  addObject(db, A, 'x.png', 10);
  assert.equal(asUser(db, B, `select count(*) from storage.objects`).out, '0');
  assert.equal(asUser(db, A, `select count(*) from storage.objects`).out, '1');
  fails(asUser(db, B, `insert into storage.objects (bucket_id, name, metadata) values ('media', '${A}/evil.png', '{"size":5}')`), /row-level security/);
});

await test('sanity checks: data must be a JSON object, unless the row is deleted', () => {
  const db = newDb('sanity');
  const ins = (id, data, del = 'false') => asUser(db, A, `insert into public.sync_items (store, id, data, deleted, updated_at) values ('cards', '${id}', ${data}, ${del}, 1)`);
  ok(ins('good', `'{"a":1}'`));
  fails(ins('arr', `'[1,2]'`), /sync_items_data_object/);
  fails(ins('str', `'"text"'`), /sync_items_data_object/);
  fails(ins('num', `'5'`), /sync_items_data_object/);
  fails(ins('jnull', `'null'`), /sync_items_data_object/);
  fails(ins('nul', `null`), /sync_items_data_object/);                  // not deleted, so it needs data
  ok(ins('tomb', `null`, 'true'));                                      // a deleted marker has none
  ok(ins('tomb2', `'{"old":1}'`, 'true'));
  // changes are checked too
  fails(asUser(db, A, `update public.sync_items set data = '[1]', updated_at = 2 where id = 'good'`), /sync_items_data_object/);
  fails(asUser(db, A, `update public.sync_items set data = null, updated_at = 2 where id = 'good'`), /sync_items_data_object/);
  ok(asUser(db, A, `update public.sync_items set data = null, deleted = true, updated_at = 3 where id = 'good'`));
  // 64 KB and id length
  fails(asUser(db, A, `insert into public.sync_items (store, id, data, updated_at) values ('cards', 'big', jsonb_build_object('x', repeat('z', 70000)), 1)`), /sync_items_data_size/);
  fails(asUser(db, A, `insert into public.sync_items (store, id, data, updated_at) values ('cards', repeat('i', 201), '{}', 1)`), /sync_items_id_size/);
  fails(asUser(db, A, `insert into public.sync_items (store, id, data, updated_at) values ('nope', 'x', '{}', 1)`), /check constraint/);
  assertExact(db);
  // a project whose stored rows already break the rule: the scripts still run, warn, and keep checking new rows
  const db2 = newDb('sanity-old', { old: true });
  ok(psql(db2, `insert into public.sync_items (user_id, store, id, data, updated_at) values ('${A}', 'cards', 'weird', '[1]', 1)`));
  runAll(db2);
  assert.equal(val(db2, `select convalidated from pg_constraint where conname = 'sync_items_data_object'`), 'f');
  fails(asUser(db2, A, `insert into public.sync_items (store, id, data, updated_at) values ('cards', 'new', '[2]', 1)`), /sync_items_data_object/);
  ok(psql(db2, `delete from public.sync_items where id = 'weird'; alter table public.sync_items validate constraint sync_items_data_object`));
  runAll(db2);                                                           // and now it validates by itself
  assert.equal(val(db2, `select convalidated from pg_constraint where conname = 'sync_items_data_object'`), 't');
});

await test('totals stay exact after inserts, updates, upserts, ignored older changes and deletes', () => {
  const db = newDb('exact');
  assert.equal(total(db), 0);
  const noisy = `jsonb_build_object('x', (select string_agg(md5(i::text), '') from generate_series(1, 1500) i))`;
  ok(asUser(db, A, `${rowSql('s1')}; ${rowSql('s2', 30)}; ${rowSql('big', 60000)};
    insert into public.sync_items (store, id, data, updated_at) values ('cards', 'noisy', ${noisy}, 1), ('reviewLog', 'many1', '{"a":[1,2,3,4,5,6,7,8,9,10]}', 1)`));
  ok(asUser(db, B, `${rowSql('s1')}; ${rowSql('b2', 500)}`));
  assertExact(db, 'after inserts');
  assert.ok(total(db) > 100000);
  // grow, shrink, tombstone, and a newer upsert
  ok(asUser(db, A, `update public.sync_items set data = jsonb_build_object('x', repeat('q', 9000)), updated_at = 5 where id = 's1'`));
  assertExact(db, 'after growing');
  ok(asUser(db, A, `update public.sync_items set data = jsonb_build_object('x', 'tiny'), updated_at = 6 where id = 'big'`));
  assertExact(db, 'after shrinking');
  ok(asUser(db, A, `update public.sync_items set data = null, deleted = true, updated_at = 7 where id = 'noisy'`));
  assertExact(db, 'after a tombstone');
  ok(asUser(db, A, rowSql('s2', 4000, "on conflict (user_id, store, id) do update set data = excluded.data, updated_at = 9")));
  assertExact(db, 'after an upsert');
  // an older or identical change is ignored and must not move any counter
  const t0 = total(db);
  ok(asUser(db, A, rowSql('s2', 20000, "on conflict (user_id, store, id) do update set data = excluded.data, updated_at = 3")));
  ok(asUser(db, A, `update public.sync_items set data = jsonb_build_object('x', repeat('r', 50000)), updated_at = 9 where id = 's2'`));
  assert.equal(total(db), t0);
  assertExact(db, 'after ignored changes');
  // deletes
  ok(asUser(db, A, `delete from public.sync_items where id = 's1'`));
  assertExact(db, 'after a delete');
  ok(asUser(db, A, `delete from public.sync_items`));                   // "Delete my synced data"
  assertExact(db, 'after deleting all of one person\'s data');
  assert.equal(num(db, `select bytes from public.sync_usage where user_id = '${A}'`), 0);
  assert.equal(num(db, `select rows from public.sync_usage where user_id = '${A}'`), 0);
  assert.equal(num(db, `select count(*) from public.sync_items where user_id = '${B}'`), 2);
  // removing a person as the owner (dashboard) takes their bytes off the total too
  ok(psql(db, `delete from auth.users where id = '${B}'`));
  assert.equal(total(db), 0);
  assertExact(db, 'after the owner removed an account');
  // a recount agrees with the running totals
  ok(asUser(db, C, `${rowSql('c1', 800)}; ${rowSql('c2', 80)}`));
  const before = total(db);
  ok(psql(db, `select public.recount_sync_usage()`));
  assert.equal(total(db), before);
  // a damaged total is repaired by the recount
  ok(psql(db, `update private.usage_totals set bytes = 7 where name = 'sync'`));
  ok(psql(db, `select public.recount_sync_usage()`));
  assert.equal(total(db), before);
  assertExact(db, 'after a recount');
});

await test('the project-wide data fuse cannot be passed, and deleting makes room again', () => {
  const db = newDb('fuse');
  const R = rowBytes(db, 'f000');
  ok(psql(db, `update public.global_limits set bytes = ${3 * R + 10} where name = 'sync'`));
  for (const i of [1, 2, 3]) ok(asUser(db, A, rowSql(`f00${i}`)), `row ${i}`);
  assert.equal(total(db), 3 * R);
  fails(asUser(db, B, rowSql('f004')), /sync_server_full/, 'the fourth row');
  fails(asUser(db, A, rowSql('f004')), /sync_server_full/);
  fails(asUser(db, A, `insert into public.sync_items (store, id, data, deleted, updated_at) values ('cards', 'f004', null, true, 1)`), /sync_server_full/, 'a deleted marker is a row too');
  fails(asUser(db, A, `update public.sync_items set data = jsonb_build_object('x', repeat('z', 200)), updated_at = 5 where id = 'f001'`), /sync_server_full/, 'growing a row');
  assert.equal(total(db), 3 * R);
  // smaller is always allowed, even when full; so is deleting; then there is room
  ok(asUser(db, A, `update public.sync_items set data = '{"x":"s"}', updated_at = 5 where id = 'f001'`));
  ok(asUser(db, A, `delete from public.sync_items where id = 'f002'`));
  ok(asUser(db, B, rowSql('f005')));
  assertExact(db);
  // lowering the fuse below what is stored refuses all growth but still allows deleting
  ok(psql(db, `update public.global_limits set bytes = 1 where name = 'sync'`));
  fails(asUser(db, A, rowSql('f006')), /sync_server_full/);
  ok(asUser(db, A, `delete from public.sync_items where id = 'f003'`));
  assertExact(db);
});

await test('two sessions at once cannot both squeeze past the data fuse', async () => {
  const db = newDb('conc');
  const R = rowBytes(db, 'k1');
  // room for one more row, not two: both sessions are different people, so only the project total can stop the second
  ok(psql(db, `update public.global_limits set bytes = ${Math.floor(R * 1.5)} where name = 'sync'`));
  const job = (uid, id) => asUserAsync(db, uid, `begin; ${rowSql(id)}; select pg_sleep(1.5); commit;`);
  const [x, y] = await Promise.all([job(A, 'k1'), job(B, 'k1')]);
  assert.equal([x, y].filter(o => o.ok).length, 1, `exactly one should win: ${x.err} / ${y.err}`);
  assert.match((x.ok ? y : x).err, /sync_server_full/);
  assert.equal(total(db), R);
  assertExact(db, 'after the race');
  // many small sessions: the number that fit is exactly the number that got in
  const R2 = rowBytes(db, 'w0_01');          // (every worker row has an id of 5 characters and the same data, so the same size)
  ok(psql(db, `delete from public.sync_items; update public.global_limits set bytes = ${25 * R2} where name = 'sync'`));
  const worker = (uid, n) => asUserAsync(db, uid, `do $$ declare i int; begin for i in 1..10 loop begin
      insert into public.sync_items (store, id, data, updated_at) values ('cards', 'w${n}_' || lpad(i::text, 2, '0'), jsonb_build_object('x', repeat('z', 100)), 1);
      exception when sqlstate '54000' then null; end; end loop; end $$;`);
  const outs = await Promise.all([A, B, C, A, B, C].map((u, i) => worker(u, i)));
  for (const o of outs) assert.ok(o.ok, o.err);
  const rows = num(db, `select count(*) from public.sync_items`);
  assert.equal(rows, 25, 'every row that fit got in, none beyond');
  assert.equal(total(db), 25 * R2);
  assertExact(db, 'after many sessions');
});

await test("each person's own limits (data size, number of rows) still apply and are counted exactly", () => {
  const db = newDb('perperson');
  const R = rowBytes(db, 'p001');
  ok(psql(db, `insert into public.quotas (user_id, data_bytes_limit, data_rows_limit) values ('${A}', ${2 * R + 5}, 100), ('${B}', 1000000, 2)`));
  ok(asUser(db, A, rowSql('p001') + ';' + rowSql('p002')));
  fails(asUser(db, A, rowSql('p003')), /sync_data_full/);
  ok(asUser(db, B, rowSql('p001') + ';' + rowSql('p002')));
  fails(asUser(db, B, rowSql('p003')), /sync_data_full/, 'the row limit');
  ok(asUser(db, C, rowSql('p001')));                                   // someone else is not affected
  fails(asUser(db, A, `update public.sync_items set data = jsonb_build_object('x', repeat('z', 500)), updated_at = 5 where id = 'p001'`), /sync_data_full/);
  assertExact(db);
  ok(psql(db, `update public.quotas set data_bytes_limit = 100000 where user_id = '${A}'`));       // the owner gives A more
  ok(asUser(db, A, rowSql('p003')));
  assertExact(db);
});

await test('pictures and sounds: per-person limit, project fuse, exact total, refused over it', () => {
  const db = newDb('media');
  const up = (uid, name, size) => asUser(db, uid, `insert into storage.objects (bucket_id, name, metadata) values ('media', '${uid}/${name}', '{"size":${size}}')`);
  ok(up(A, 'a.png', 30 * 1048576));
  assert.equal(total(db, 'media'), 30 * 1048576);
  fails(up(A, 'b.png', 21 * 1048576), /row-level security/, 'over the 50 MB default');
  ok(up(A, 'c.png', 20 * 1048576));                                    // exactly 50 MB
  fails(up(A, 'd.png', 1), /row-level security/);
  assert.equal(JSON.parse(ok(asUser(db, A, `select public.my_usage()`))).media_bytes, 50 * 1048576);
  // replacing a file counts only the difference
  ok(asUser(db, A, `update storage.objects set metadata = '{"size":1000}' where name = '${A}/a.png'`));
  assert.equal(total(db, 'media'), 20 * 1048576 + 1000);
  ok(up(B, 'x.png', 3 * 1048576));
  // a custom person limit
  ok(psql(db, `insert into public.quotas (user_id, media_bytes_limit) values ('${C}', 1000)`));
  fails(up(C, 'big.png', 1001), /row-level security/);
  ok(up(C, 'ok.png', 1000));
  // deleting gives the bytes back (through the app's own rule, and as the owner)
  ok(asUser(db, A, `delete from storage.objects where name = '${A}/c.png'`));
  ok(psql(db, `delete from storage.objects where name = '${B}/x.png'`));
  assert.equal(total(db, 'media'), 1000 + 1000);
  assertExact(db);
  // project fuse: the third person is turned away when the bucket is full
  ok(psql(db, `update public.global_limits set bytes = ${total(db, 'media') + 5000} where name = 'media'`));
  fails(up(B, 'y.png', 5001), /row-level security/, 'checked up front');
  ok(up(B, 'y.png', 5000));
  fails(up(B, 'z.png', 1), /row-level security/);
  // and the atomic last word, which even the owner's direct inserts hit (the up-front check is bypassed here)
  fails(psql(db, `insert into storage.objects (bucket_id, name, metadata) values ('media', '${B}/z.png', '{"size":1}')`), /media_server_full/);
  assert.equal(num(db, `select count(*) from storage.objects where name = '${B}/z.png'`), 0);
  // other buckets do not count
  ok(psql(db, `insert into storage.buckets (id, name) values ('other', 'other'); insert into storage.objects (bucket_id, name, metadata) values ('other', 'o', '{"size":999999999}')`));
  assertExact(db);
  // replacing a file when the bucket is full is fine as long as it doesn't grow
  ok(asUser(db, B, `update storage.objects set metadata = '{"size":4000}' where name = '${B}/y.png'`));
  assertExact(db);
});

await test('uploads whose size is not known yet: fine for the person under their limit, 3 MB assumed for the project ceiling', () => {
  const db = newDb('nullsize');
  const chk = (uid, size) => asUser(db, uid, `select private.media_may_store('${uid}/n.png', ${size})`).out;
  assert.equal(chk(A, 'null'), 't');
  // per person: an unknown size is allowed while under the limit (48 of 50 MB), and refused only when they are at it
  addObject(db, A, 'big.png', 48 * 1048576);
  assert.equal(chk(A, 'null'), 't');
  assert.equal(chk(A, `'3145728'`), 'f');                                 // a known 3 MB would not fit
  assert.equal(chk(A, `'1048576'`), 't');
  addObject(db, A, 'more.png', 2 * 1048576);
  assert.equal(chk(A, 'null'), 'f');
  // project: the pictures ceiling assumes 3 MB for an unknown size
  ok(psql(db, `update public.global_limits set bytes = ${total(db, 'media') + 3 * 1048576 - 1} where name = 'media'`));
  assert.equal(chk(B, 'null'), 'f');
  assert.equal(chk(B, `'3145000'`), 't');
  ok(psql(db, `update public.global_limits set bytes = ${total(db, 'media') + 3 * 1048576} where name = 'media'`));
  assert.equal(chk(B, 'null'), 't');
  // and through the real rule: an insert whose metadata has no size is refused when the unknown file might not fit
  ok(psql(db, `update public.global_limits set bytes = ${total(db, 'media') + 1000} where name = 'media'`));
  fails(asUser(db, B, `insert into storage.objects (bucket_id, name, metadata) values ('media', '${B}/z.png', null)`), /row-level security/);
});

await test('without the storage trigger the pictures ceiling uses a live count; re-running keeps the trigger as it is', () => {
  const db = newDb('notrigger');
  const oid = () => val(db, `select oid from pg_trigger where tgname = 'media_total_track'`);
  const before = oid();
  runAll(db);
  assert.equal(oid(), before, 'the trigger must not be dropped and made again');
  addObject(db, A, 'a.png', 5000);
  ok(psql(db, `drop trigger media_total_track on storage.objects`));
  addObject(db, B, 'b.png', 7000);                                          // not counted: the total is now stale
  assert.equal(total(db, 'media'), 5000);
  ok(psql(db, `update public.global_limits set bytes = 12500 where name = 'media'`));
  assert.equal(asUser(db, C, `select private.media_may_store('${C}/c.png', '600')`).out, 'f', 'live count 12000 + 600 > 12500');
  assert.equal(asUser(db, C, `select private.media_may_store('${C}/c.png', '500')`).out, 't');
  // the status table says NO, and running the script puts the trigger back
  assert.match(val(db, `select string_agg(result, '|') from (${statusSql(db)}) x where what like 'media total kept%'`), /^NO/);
  runAll(db);
  assert.ok(oid());
});

await test('the status tables at the end of each script', () => {
  const db = newDb('status');
  const out = f => ok(psql(db, '', { file: join(SQL, f) }), f).split('\n').filter(l => l.includes('|'));
  for (const f of ['setup.sql', 'media.sql', 'limits.sql']) {
    const rows = out(f);
    assert.ok(rows.length >= 2, f);
    for (const r of rows) assert.ok(r.endsWith('|ok'), `${f}: ${r}`);
  }
  // a data ceiling that cannot be lowered yet says so
  const db2 = newDb('status-old', { old: true });
  ok(psql(db2, `set session_replication_role = replica; insert into public.sync_items (user_id, store, id, data, updated_at) select '${A}', 'cards', 'r' || g, jsonb_build_object('x', repeat('z', 60000)), 1 from generate_series(1, 5000) g`));
  ok(psql(db2, `update public.global_limits set bytes = 440401920 where name = 'sync'`));
  // (5000 rows of ~60 KB are counted as about 300 MB, above 280 MB)
  for (const f of ['setup', 'media', 'limits']) {
    const res = ok(psql(db2, '', { file: join(SQL, `${f}.sql`) }), f);
    if (f === 'limits') {
      assert.equal(num(db2, `select bytes from public.global_limits where name = 'sync'`), 440401920, 'not lowered while the stored data is over 280 MB');
      assert.match(res, /NOT lowered to 300/);
    }
  }
  ok(psql(db2, `delete from public.sync_items where id not like 'r1%'`));
  runAll(db2);
  assert.equal(num(db2, `select bytes from public.global_limits where name = 'sync'`), 314572800, 'lowered once there is room');
  // the CI script's status
  const withPw = read(join(SQL, 'ci-roles.sql')).replaceAll('PASTE-A-LONG-PASSWORD-HERE', 'a-test-password-0123456789-abcdef');
  const ci = ok(psql(db, withPw), 'ci-roles.sql').split('\n').filter(l => l.includes('|'));
  assert.equal(ci.length, 8);
  for (const r of ci) assert.ok(r.endsWith('|ok'), r);
  ok(psql(db, `revoke select on auth.identities from study_sprint_ci`));
  const ciFile = read(join(SQL, 'ci-roles.sql'));
  assert.match(ok(psql(db, ciFile.slice(ciFile.lastIndexOf('select * from (values')))), /can read auth.identities\|NO\|NO/);
  ok(psql(db, `drop owned by study_sprint_ci; drop role study_sprint_ci`));      // (roles belong to the whole server, not one database)
});

await test('owner.sql runs on a project that still has the old scripts, and on the new one', () => {
  const db = newDb('owner-old', { old: true });
  ok(asUser(db, A, rowSql('o1')));
  addObject(db, A, 'o.png', 1234);
  const res = ok(psql(db, '', { file: join(SQL, 'owner.sql') }), 'owner.sql on v1');
  assert.match(res, /sync\|0\.0\|420\.0/);
  runAll(db);
  assert.match(ok(psql(db, '', { file: join(SQL, 'owner.sql') }), 'owner.sql on v2'), /sync\|0\.0\|300\.0/);
});

await test('a change that does not change a record\'s size touches no counter row', () => {
  const db = newDb('nogrowth');
  ok(asUser(db, A, rowSql('g1', 100)));
  const x = () => val(db, `select xmin::text from public.sync_usage where user_id = '${A}'`);
  const before = x();
  ok(asUser(db, A, `update public.sync_items set data = jsonb_build_object('x', repeat('y', 100)), updated_at = 5 where id = 'g1'`));
  assert.equal(x(), before);
  assertExact(db);
  ok(asUser(db, A, `update public.sync_items set data = jsonb_build_object('x', repeat('y', 101)), updated_at = 6 where id = 'g1'`));
  assert.notEqual(x(), before);
  assertExact(db);
});

await test('two uploads at once cannot both squeeze past the pictures fuse', async () => {
  const db = newDb('mediaconc');
  ok(psql(db, `update public.global_limits set bytes = 1500 where name = 'media'`));
  const job = (uid) => asUserAsync(db, uid, `begin; insert into storage.objects (bucket_id, name, metadata) values ('media', '${uid}/p.png', '{"size":1000}'); select pg_sleep(1.5); commit;`);
  const [x, y] = await Promise.all([job(A), job(B)]);
  assert.equal([x, y].filter(o => o.ok).length, 1, `exactly one should win: ${x.err} / ${y.err}`);
  assert.match((x.ok ? y : x).err, /media_server_full/);
  assert.equal(total(db, 'media'), 1000);
  assertExact(db);
});

await test('delete_my_account: refuses with media_left while files remain, then deletes everything', () => {
  const db = newDb('delacct');
  ok(psql(db, `insert into public.quotas (user_id) values ('${A}'), ('${B}')`));
  ok(asUser(db, A, rowSql('a1') + ';' + rowSql('a2', 900)));
  ok(asUser(db, B, rowSql('b1')));
  addObject(db, A, 'pic.png', 4000); addObject(db, B, 'pic.png', 100);
  const mine = total(db);
  fails(asUser(db, A, `select public.delete_my_account()`), /media_left/);
  // nothing was touched
  assert.equal(num(db, `select count(*) from public.sync_items where user_id = '${A}'`), 2);
  assert.equal(num(db, `select count(*) from auth.users where id = '${A}'`), 1);
  assert.equal(num(db, `select count(*) from storage.objects where name like '${A}/%'`), 1, 'the SQL must not delete file records (it would orphan the file)');
  assert.equal(total(db), mine);
  fails(asUser(db, null, `select public.delete_my_account()`, 'anon'), /permission denied/);
  fails(asUser(db, A, `select public.delete_my_account()`), /media_left/, 'still refused on a second try');
  // the app deletes the files through the Storage API (which deletes the records), then asks again
  ok(asUser(db, A, `delete from storage.objects where name like '${A}/%'`));
  assert.equal(total(db, 'media'), 100);
  ok(asUser(db, A, `select public.delete_my_account()`));
  assert.equal(num(db, `select count(*) from auth.users where id = '${A}'`), 0);
  assert.equal(num(db, `select count(*) from public.sync_items where user_id = '${A}'`), 0);
  assert.equal(num(db, `select count(*) from public.quotas where user_id = '${A}'`), 0);
  assert.equal(num(db, `select count(*) from public.sync_usage where user_id = '${A}'`), 0);
  assert.equal(num(db, `select count(*) from public.sync_items where user_id = '${B}'`), 1, 'someone else is untouched');
  assert.equal(num(db, `select count(*) from storage.objects where name like '${B}/%'`), 1);
  assertExact(db, 'after the account went');
  // someone with no files and no data can delete too
  ok(asUser(db, C, `select public.delete_my_account()`));
  assert.equal(num(db, `select count(*) from auth.users where id = '${C}'`), 0);
});

await test('app_config(): min_client and schema, for anon and signed-in people; the owner can edit min_client', () => {
  const db = newDb('config');
  assert.deepEqual(JSON.parse(ok(asUser(db, null, `select public.app_config()`, 'anon'))), { min_client: '4.36', schema: 2 });
  assert.deepEqual(JSON.parse(ok(asUser(db, A, `select public.app_config()`))), { min_client: '4.36', schema: 2 });
  assert.equal(typeof JSON.parse(ok(psql(db, `select public.app_config()`))).schema, 'number');
  ok(psql(db, `update private.app_config_values set value = '4.40' where key = 'min_client'`));
  assert.equal(JSON.parse(ok(asUser(db, null, `select public.app_config()`, 'anon'))).min_client, '4.40');
  runAll(db);                                                           // running the scripts again keeps the owner's value
  assert.equal(JSON.parse(ok(asUser(db, null, `select public.app_config()`, 'anon'))).min_client, '4.40');
  // a project where a core script never ran reports schema 0
  const db2 = newDb('config-partial');
  ok(psql(db2, `delete from private.schema_log where file = 'media.sql'`));
  assert.equal(JSON.parse(ok(psql(db2, `select public.app_config()`))).schema, 0);
  // the log: which file, which version, when
  assert.equal(val(db, `select count(*) filter (where file is not null and version = 2 and ran_at <= now()) = count(*) from private.schema_log`), 't');
  // the app (and anyone else) can't read or write the log, the totals or the settings
  for (const t of ['private.schema_log', 'private.usage_totals', 'private.app_config_values']) {
    fails(asUser(db, A, `select * from ${t}`), /permission denied/, t);
    fails(asUser(db, null, `select * from ${t}`, 'anon'), /permission denied/, t);
    fails(asUser(db, A, `update ${t} set bytes = 0`), /permission denied|does not exist/, t);
  }
});

await test('grants: nothing for anon on the data tables; no TRUNCATE/TRIGGER/REFERENCES for anyone; the app still works', () => {
  const db = newDb('grants');
  ok(psql(db, `insert into public.quotas (user_id) values ('${A}')`));
  const tables = ['public.sync_items', 'public.quotas', 'public.global_limits', 'public.sync_usage'];
  for (const t of tables) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal(val(db, `select has_table_privilege('anon', '${t}', '${p}')`), 'f', `anon ${p} on ${t}`);
    }
    for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal(val(db, `select has_table_privilege('authenticated', '${t}', '${p}')`), 'f', `authenticated ${p} on ${t}`);
  }
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal(val(db, `select has_table_privilege('authenticated', 'public.sync_items', '${p}')`), 't', `authenticated ${p} on sync_items`);
  assert.equal(val(db, `select has_table_privilege('authenticated', 'public.quotas', 'SELECT')`), 't');
  for (const p of ['INSERT', 'UPDATE', 'DELETE']) assert.equal(val(db, `select has_table_privilege('authenticated', 'public.quotas', '${p}')`), 'f');
  for (const t of ['public.global_limits', 'public.sync_usage']) assert.equal(val(db, `select has_table_privilege('authenticated', '${t}', 'SELECT')`), 'f');
  assert.equal(val(db, `select has_sequence_privilege('anon', 'public.sync_seq', 'USAGE')`), 'f');
  fails(asUser(db, null, `select * from public.sync_items`, 'anon'), /permission denied/);
  fails(asUser(db, null, `insert into public.sync_items (store, id, data, updated_at) values ('cards','x','{}',1)`, 'anon'), /permission denied/);
  fails(asUser(db, A, `truncate public.sync_items`), /permission denied/);
  fails(asUser(db, A, `create trigger evil after insert on public.sync_items for each row execute function public.sync_items_on_change()`), /permission denied|must be owner/);
  fails(asUser(db, A, `update public.quotas set media_bytes_limit = 99999999999`), /permission denied/);
  fails(asUser(db, A, `insert into public.quotas (user_id) values ('${B}')`), /permission denied/);
  // functions: the helpers, the triggers and the recounts are not callable from the API
  for (const f of ['public._media_limit(uuid)', 'public._data_limit(uuid)', 'public._rows_limit(uuid)', 'public._media_used(uuid, text)', 'public.recount_sync_usage()', 'public.recount_media_usage()', 'public.sync_items_quota()', 'public.sync_items_on_change()', 'public.default_media_limit()', 'public.default_data_limit()']) {
    for (const who of ['anon', 'authenticated']) assert.equal(val(db, `select has_function_privilege('${who}', '${f}', 'EXECUTE')`), 'f', `${who} runs ${f}`);
  }
  for (const f of ['private.row_bytes(text, jsonb)', 'private.media_total_track()']) {
    for (const who of ['anon', 'authenticated']) assert.equal(val(db, `select has_function_privilege('${who}', '${f}', 'EXECUTE')`), 'f', `${who} runs ${f}`);
  }
  assert.equal(val(db, `select has_function_privilege('anon', 'private.media_may_store(text, text)', 'EXECUTE')`), 'f');
  assert.equal(val(db, `select has_function_privilege('authenticated', 'private.media_may_store(text, text)', 'EXECUTE')`), 't');
  assert.equal(val(db, `select has_function_privilege('anon', 'public.my_usage()', 'EXECUTE')`), 'f');
  assert.equal(val(db, `select has_function_privilege('anon', 'public.delete_my_account()', 'EXECUTE')`), 'f');
  assert.equal(val(db, `select has_function_privilege('anon', 'public.app_config()', 'EXECUTE')`), 't');
  assert.equal(val(db, `select has_function_privilege('authenticated', 'public.app_config()', 'EXECUTE')`), 't');
  assert.equal(val(db, `select has_schema_privilege('anon', 'private', 'USAGE')`), 'f');
  // ... and the normal sync cycle works as a signed-in person
  ok(asUser(db, A, `${rowSql('g1')}; ${rowSql('g1', 100, 'on conflict (user_id, store, id) do update set data = excluded.data, updated_at = 4')}`));
  ok(asUser(db, A, `update public.sync_items set updated_at = 9, seq = 1 where id = 'g1'`));
  assert.equal(asUser(db, A, `select count(*) from public.sync_items where seq > 0`).out, '1');
  assert.ok(Number(asUser(db, A, `select (public.my_usage() ->> 'data_bytes')::bigint`).out) > 0);
  ok(asUser(db, A, `select count(*) from public.quotas`));
  ok(asUser(db, A, `delete from public.sync_items where id = 'g1'`));
  // and the files keep working
  ok(asUser(db, A, `insert into storage.objects (bucket_id, name, metadata) values ('media', '${A}/f.png', '{"size":9}')`));
  ok(asUser(db, A, `select count(*) from storage.objects`));
  assertExact(db);
});

await test('read-only CI login: exactly what backup.yml and fuse-watch.yml need, and no writing', () => {
  const db = newDb('ci');
  ok(asUser(db, A, rowSql('ci1')));
  ok(psql(db, `insert into public.quotas (user_id) values ('${A}'); insert into auth.identities (user_id) values ('${A}')`));
  addObject(db, A, 'p.png', 777);
  const file = read(join(SQL, 'ci-roles.sql'));
  // the placeholder password is refused
  fails(psql(db, file), /long password/);
  assert.equal(val(db, `select count(*) from pg_roles where rolname = 'study_sprint_ci'`), '0');
  const withPw = file.replaceAll('PASTE-A-LONG-PASSWORD-HERE', 'a-test-password-0123456789-abcdef');
  assert.notEqual(withPw, file);
  ok(psql(db, withPw), 'ci-roles.sql');
  const snap1 = val(db, `select md5(r::text) from pg_authid r where rolname = 'study_sprint_ci'`);
  ok(psql(db, withPw.replaceAll('a-test-password-0123456789-abcdef', 'a-different-password-0123456789')), 'again');
  assert.equal(val(db, `select md5(r::text) from pg_authid r where rolname = 'study_sprint_ci'`), snap1, 'running it again must not change the password');
  ok(psql(db, '', { file: join(SQL, 'ci-roles.sql') }), 'the unedited file is fine once the role exists');
  // the backup, with the options backup.yml uses
  const dump = spawnSync(join(bin, 'pg_dump'), ['-h', dir, '-p', port, '-U', 'study_sprint_ci', '-d', db, '--data-only', '--no-owner', '--table=auth.users', '--table=auth.identities', '--table=public.*', '--exclude-table-data=public.sync_usage'], { encoding: 'utf8', env });
  assert.equal(dump.status, 0, dump.stderr);
  assert.match(dump.stdout, /COPY public\.sync_items /);
  assert.match(dump.stdout, /COPY auth\.users /);
  assert.match(dump.stdout, /COPY auth\.identities /);
  assert.match(dump.stdout, /COPY public\.quotas /);
  assert.match(dump.stdout, /ci1/, 'the dump must contain the rows (it has to bypass row security)');
  // the daily space check, exactly as fuse-watch.yml asks it
  const watch = read(join(here, '../../.github/workflows/fuse-watch.yml'));
  const q = watch.match(/<<'SQL' > totals\.txt\n([\s\S]*?)\n\s*SQL\n/)[1].replace(/^ {10}/gm, '');
  const res = psql(db, q, { user: 'study_sprint_ci' });
  assert.ok(res.ok, res.err);
  const [dataB, dataL, mediaB, mediaL, dbB, bypass] = res.out.split('|');
  assert.equal(Number(dataB), total(db)); assert.equal(Number(dataL), 314572800);
  assert.equal(Number(mediaB), 777); assert.equal(Number(mediaL), 943718400);
  assert.ok(Number(dbB) > 0); assert.equal(bypass, 'true');
  // read-only
  // (it starts read-only; these also switch that off first, to show the missing rights stop it too)
  const asCi = s => psql(db, s, { user: 'study_sprint_ci' });
  const asCiRw = s => asCi(`set default_transaction_read_only = off; ${s}`);
  fails(asCi(`insert into public.sync_items (user_id, store, id, data, updated_at) values ('${A}', 'cards', 'evil', '{}', 1)`), /read-only transaction/);
  fails(asCiRw(`insert into public.sync_items (user_id, store, id, data, updated_at) values ('${A}', 'cards', 'evil', '{}', 1)`), /permission denied/);
  fails(asCiRw(`delete from public.sync_items`), /permission denied/);
  fails(asCiRw(`update public.quotas set media_bytes_limit = 0`), /permission denied/);
  fails(asCiRw(`update public.global_limits set bytes = 0`), /permission denied/);
  fails(asCiRw(`delete from auth.users`), /permission denied/);
  fails(asCiRw(`update storage.objects set metadata = '{}'`), /permission denied/);
  fails(asCiRw(`truncate public.sync_items`), /permission denied/);
  fails(asCiRw(`create table public.evil (a int)`), /permission denied/);
  fails(asCiRw(`select public.recount_sync_usage()`), /permission denied/);
  fails(asCi(`select name from storage.objects`), /permission denied/, 'only the size columns');
  fails(asCi(`select * from private.usage_totals`), /permission denied/);
  assert.equal(val(db, `select count(*) from public.sync_items`), '1');
  ok(psql(db, `drop owned by study_sprint_ci; drop role study_sprint_ci`));
});

// ---------- the end ----------
const bad = results.filter(x => !x.ok);
console.log(`\n${results.length - bad.length} of ${results.length} SQL tests passed${bad.length ? `; ${bad.length} FAILED` : ''}`);
process.exit(bad.length ? 1 : 0);
