// The account space limit and its messages (js/quota.js), the image size limit, the import warnings, and a check
// that the SQL files say the same numbers as the app. Run with: node tests/quota.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MB, DEFAULT_MEDIA_LIMIT, MAX_PICTURE, MAX_OCCLUSION_PICTURE, fmtSize, readUsage, level, dataLevel, fullMessage, warnMessage, dataFullMessage, SERVER_FULL_MESSAGE, usageLine, planUploads, pictureTooBig, importWarnings, rowBytes, rowLabel, splitOversized, bigRowsNote, pushErrorKind, capTimes, MAX_ROW_BYTES } from '../js/quota.js';
import { pushSafely } from '../js/sync-push.js';

const usage = (media, limit = 180 * MB, data = 3 * MB) => ({ data, media, limit });
const file = n => ({ id: 'm' + n, data: { byteLength: n * MB } });

test('sizes are shown in plain MB and GB', () => {
  assert.equal(fmtSize(0), '0 MB');
  assert.equal(fmtSize(30 * 1024), '<0.1 MB');
  assert.equal(fmtSize(0.4 * MB), '0.4 MB');
  assert.equal(fmtSize(34.4 * MB), '34 MB');
  assert.equal(fmtSize(180 * MB), '180 MB');
  assert.equal(fmtSize(2048 * MB), '2 GB');
  assert.equal(fmtSize(undefined), '0 MB');
});

test('the default is 180 MB, five accounts fit in the free 1 GB', () => {
  assert.equal(DEFAULT_MEDIA_LIMIT, 180 * MB);
  assert.ok(5 * DEFAULT_MEDIA_LIMIT <= 1024 * MB);
});

test('my_usage() answers are read safely', () => {
  assert.deepEqual(readUsage({ data_bytes: 5, media_bytes: 6, media_limit: 7 }), { data: 5, media: 6, limit: 7, dataLimit: null });
  assert.deepEqual(readUsage([{ data_bytes: '5', media_bytes: '6', media_limit: '7', data_limit: '9' }]), { data: 5, media: 6, limit: 7, dataLimit: 9 });   // a one-row list
  assert.equal(readUsage(null), null);
  assert.equal(readUsage({ data_bytes: 5 }), null);
  assert.equal(readUsage('nope'), null);
});

test('ok below 80%, amber from 80%, full at the limit', () => {
  assert.equal(level(usage(100 * MB)), 'ok');
  assert.equal(level(usage(143 * MB)), 'ok');
  assert.equal(level(usage(144 * MB)), 'warn');
  assert.equal(level(usage(179 * MB)), 'warn');
  assert.equal(level(usage(180 * MB)), 'full');
  assert.equal(level(usage(182 * MB)), 'full');              // one file over is allowed, then it is full
  assert.equal(level(null), 'ok');
  assert.equal(level(usage(0, 0)), 'full');                  // a limit of 0 means no media at all
});

test('the account-full message', () => {
  assert.equal(fullMessage(usage(180 * MB)),
    "Your account is full: pictures and sounds use 180 MB of 180 MB. New ones are saved on this device and will sync when there's room. Remove some, or ask the account owner for more space.");
  assert.match(fullMessage(usage(182 * MB)), /use 182 MB of 180 MB/);
  assert.match(fullMessage(usage(2000 * MB, 2048 * MB)), /of 2 GB/);
});

test('the usage line under Settings → Your data', () => {
  assert.deepEqual(usageLine(usage(34 * MB, 180 * MB, 1.2 * MB)),
    { level: 'ok', text: 'In your account: data 1.2 MB · pictures and sounds 34 MB of 180 MB', detail: '' });
  assert.equal(usageLine({ ...usage(34 * MB, 180 * MB, 1.2 * MB), dataLimit: 80 * MB }).text, 'In your account: data 1.2 MB of 80 MB · pictures and sounds 34 MB of 180 MB');
  const warn = usageLine(usage(150 * MB));
  assert.equal(warn.level, 'warn');
  assert.equal(warn.detail, 'Getting full. Pictures and sounds: 150 MB of 180 MB.');
  assert.equal(warnMessage(usage(150 * MB)), 'Pictures and sounds: 150 MB of 180 MB.');
  const full = usageLine(usage(180 * MB));
  assert.equal(full.level, 'full');
  assert.equal(full.detail, fullMessage(usage(180 * MB)));
  assert.equal(usageLine(null), null);
});

test('uploads go while they fit in the account, and a smaller one later may still fit', () => {
  const pending = [file(1), file(1), file(1), file(1)];
  let plan = planUploads(pending, usage(100 * MB));
  assert.equal(plan.send.length, 4);
  assert.equal(plan.held.length, 0);
  plan = planUploads(pending, usage(178.5 * MB));       // room for 1.5: one goes (to 179.5), the rest wait
  assert.deepEqual(plan.send.map(m => m.id), ['m1']);
  assert.equal(plan.held.length, 3);
  plan = planUploads(pending, usage(180 * MB));         // already full: nothing goes
  assert.equal(plan.send.length, 0);
  assert.equal(plan.held.length, 4);
  assert.equal(level(plan.usage), 'full');
  plan = planUploads([file(5), file(1)], usage(176 * MB));   // the big one doesn't fit, the small one does
  assert.deepEqual(plan.send.map(m => m.id), ['m1']);
  assert.deepEqual(plan.held.map(m => m.id), ['m5']);
  plan = planUploads([file(2)], usage(178 * MB));       // exactly the limit is fine
  assert.equal(plan.send.length, 1);
});

test('synced data limit: levels and the message', () => {
  const u = (data, dataLimit = 80 * MB) => ({ ...usage(0), data, dataLimit });
  assert.equal(dataLevel(u(10 * MB)), 'ok');
  assert.equal(dataLevel(u(64 * MB)), 'warn');
  assert.equal(dataLevel(u(80 * MB)), 'full');
  assert.equal(dataLevel({ ...usage(0), dataLimit: null }), 'ok');         // an older server doesn't say
  assert.equal(dataFullMessage(u(80 * MB)), "Your account's synced data is full (80 MB of 80 MB). New changes are saved on this device and will sync when there's room. Delete some cards or old decks, or ask the account owner for more space.");
  assert.match(dataFullMessage(null), /^Your account's synced data is full\. New changes/);
  assert.equal(SERVER_FULL_MESSAGE, "The sync server is full right now. Everything is safe on this device and will sync when there's room.");
  const line = usageLine(u(80 * MB));
  assert.equal(line.level, 'full');
  assert.ok(line.detail.startsWith("Your account's synced data is full"));
});

test('when the server cannot say how much is used, everything is tried (the server still decides)', () => {
  const plan = planUploads([file(1), file(2)], null);
  assert.equal(plan.send.length, 2);
  assert.equal(plan.held.length, 0);
});

test('a picture still over 1.5 MB after shrinking is refused (3 MB for occlusion)', () => {
  assert.equal(MAX_PICTURE, 1.5 * MB);
  assert.equal(MAX_OCCLUSION_PICTURE, 3 * MB);
  assert.equal(pictureTooBig(250 * 1024), null);
  assert.equal(pictureTooBig(1.5 * MB), null);
  assert.match(pictureTooBig(1.6 * MB), /still 1\.6 MB after shrinking it, and the limit is 1\.5 MB/);
  assert.equal(pictureTooBig(2.5 * MB, { occlusion: true }), null);
  assert.match(pictureTooBig(3.2 * MB, { occlusion: true }), /limit is 3 MB/);
});

test('import warnings: media over 200 MB, more than 50,000 reviews', () => {
  assert.deepEqual(importWarnings({}), []);
  assert.deepEqual(importWarnings({ mediaBytes: 200 * MB, reviews: 50000 }), []);        // exactly at the limits is fine
  const media = importWarnings({ mediaBytes: 340 * MB });
  assert.equal(media.length, 1);
  assert.match(media[0], /pictures and sounds take about 340 MB/);
  const reviews = importWarnings({ reviews: 120000 });
  assert.equal(reviews.length, 1);
  assert.match(reviews[0], /120,000 reviews/);
  assert.match(reviews[0], /about 61 MB/);
  assert.equal(importWarnings({ mediaBytes: 300 * MB, reviews: 60000 }).length, 2);
});

test('the SQL files say the same numbers as the app', () => {
  const read = f => fs.readFileSync(new URL('../supabase/' + f, import.meta.url), 'utf8');
  const limits = read('limits.sql'), setup = read('setup.sql'), media = read('media.sql');
  assert.ok(limits.includes(String(DEFAULT_MEDIA_LIMIT)), 'limits.sql default is 180 MB');
  assert.match(limits, /media_bytes_limit bigint not null default 188743680/);
  assert.equal(3145728, MAX_OCCLUSION_PICTURE);
  assert.match(limits, /file_size_limit = 3145728/);
  assert.match(media, /3145728/);
  assert.match(limits, /octet_length\(data::text\) < 65536/);
  assert.match(limits, /create or replace function public\.my_usage\(\)/);
  assert.match(limits, /data_bytes_limit bigint not null default 83886080/);
  assert.match(limits, /\('media', 943718400\), \('sync', 440401920\)/);           // 900 MB and 420 MB
  assert.equal(900 * MB, 943718400); assert.equal(420 * MB, 440401920); assert.equal(80 * MB, 83886080);
  assert.match(limits, /revoke all on public\.quotas from anon, authenticated;\s*grant select on public\.quotas to authenticated/);
  assert.doesNotMatch(limits, /new\.data is not null/);                           // every new row is checked, "deleted" markers too
  assert.match(limits, /200 \+ 2 \* octet_length\(new\.id\) \+ greatest\(coalesce\(octet_length\(new\.data::text\), 0\), coalesce\(pg_column_size\(new\.data\), 0\)\)/);
  assert.match(limits, /200 \+ 2 \* octet_length\(s\.id\) \+ greatest\(coalesce\(octet_length\(s\.data::text\), 0\), coalesce\(pg_column_size\(s\.data\), 0\)\)/);   // recount_sync_usage counts the same way
  assert.match(limits, /octet_length\(id\) <= 200\) not valid/);
  assert.match(limits, /data_rows_limit bigint not null default 300000/);
  assert.match(limits, /pg_advisory_xact_lock/);
  assert.match(limits, /create policy "media: change own"/);
  assert.match(limits, /collate "C" like/);
  assert.match(limits, /create or replace function public\.delete_my_account\(\)/);
  // setup.sql: row rules use (select auth.uid()); equal timestamps are ignored; updated_at is capped at now + 1 day
  const policies = setup.match(/create policy[^;]+;/g);
  assert.equal(policies.length, 4);
  for (const p of policies) assert.ok(!/(?<!select )auth\.uid\(\)/.test(p), 'bare auth.uid() in: ' + p);
  assert.match(setup, /new\.updated_at <= old\.updated_at/);
  assert.match(setup, /least\(new\.updated_at, \(extract\(epoch from now\(\)\) \* 1000\)::bigint \+ 86400000\)/);
});

test('rows too big for the server are left out and named', () => {
  const card = (id, front, size) => ({ store: 'cards', id, data: { front, back: 'x'.repeat(size) }, deleted: false, updated_at: 1 });
  const rows = [card('a', 'Small', 100), card('b', '<b>The   big</b> card with a very long title that goes on and on', 70000), { store: 'cards', id: 'c', data: null, deleted: true, updated_at: 2 }];
  assert.ok(rowBytes(rows[0]) < 200 && rowBytes(rows[1]) > MAX_ROW_BYTES);
  const { ok, big } = splitOversized(rows);
  assert.deepEqual(ok.map(r => r.id), ['a', 'c']);                           // a deleted marker is never "too big"
  assert.equal(big.length, 1);
  assert.equal(big[0].label, 'The big card with a very long title that…');
  assert.equal(bigRowsNote(big), '1 card is too large to sync: “The big card with a very long title that…”. Shorten it to sync.');
  assert.equal(bigRowsNote([...big, { store: 'cards', id: 'z', label: 'Other' }]), '2 cards are too large to sync, for example “The big card with a very long title that…”. Shorten them to sync.');
  assert.equal(bigRowsNote([{ store: 'decks', id: 'd', label: '' }]), '1 deck is too large to sync: a deck. Shorten it to sync.');
  assert.equal(bigRowsNote([]), '');
  assert.equal(rowLabel({ data: { name: 'Biology' } }), 'Biology');
  assert.equal(rowBytes({ data: { v: 'é' } }), JSON.stringify({ v: 'é' }).length + 2);       // bytes, not characters, plus Postgres's space after ":"
  assert.equal(rowBytes({ data: [1, 2, 3] }), '[1, 2, 3]'.length);                            // jsonb text puts a space after each comma
  assert.equal(rowBytes({ data: { a: [1, { b: null }], c: 'x' } }), '{"a": [1, {"b": null}], "c": "x"}'.length);
});

test('which push errors can be worked around', () => {
  assert.equal(pushErrorKind({ code: '23514', message: 'x' }), 'size');
  assert.equal(pushErrorKind({ code: '400', message: 'violates check constraint "sync_items_data_size"' }), 'size');
  assert.equal(pushErrorKind({ code: 'sync_data_full', message: 'Your account’s synced data is full.' }), 'data');
  assert.equal(pushErrorKind({ code: 'sync_server_full' }), 'server');
  assert.equal(pushErrorKind({ code: 'network', message: 'offline' }), null);
  assert.equal(pushErrorKind(null), null);
});

test('a time far ahead is sent as at most a day ahead', () => {
  const now = 1_000_000_000_000;
  const out = capTimes([{ updated_at: now + 5 * 86400000 }, { updated_at: now - 5 }, { updated_at: now + 86400000 }], now);
  assert.deepEqual(out.map(r => r.updated_at), [now + 86400000, now - 5, now + 86400000]);
});

// A fake put: refuses a batch containing a row id from `bad` (kind 'size') or `capped` (kind 'data').
const fakePut = ({ bad = [], capped = [], onCall } = {}) => async rows => {
  onCall?.(rows);
  const err = (code, message) => Object.assign(new Error(message), { code });
  if (rows.some(r => bad.includes(r.id))) throw err('23514', 'check');
  if (rows.some(r => capped.includes(r.id))) throw err('sync_data_full', 'sync_data_full');
};
const ids = n => Array.from({ length: n }, (_, i) => ({ id: 'r' + i }));

test('pushSafely: one refused row does not block the batch', async () => {
  const calls = [];
  const out = await pushSafely(fakePut({ bad: ['r7'], onCall: r => calls.push(r.length) }), ids(20));
  assert.equal(out.sent.length, 19);
  assert.deepEqual(out.bad.map(b => b.row.id), ['r7']);
  assert.equal(out.held.length, 0);
  assert.ok(calls.length < 20, 'found it by halving, not one request per row: ' + calls.length);
});

test('pushSafely: rows over the data limit are held, the rest go', async () => {
  const out = await pushSafely(fakePut({ capped: ['r3', 'r15'] }), ids(40));
  assert.equal(out.sent.length, 38);
  assert.deepEqual(out.held.map(r => r.id).sort(), ['r15', 'r3']);
  assert.equal(out.full, 'data');
  assert.equal(out.bad.length, 0);
});

test('pushSafely: other errors are thrown, big pushes go in batches, and the splitting is limited', async () => {
  await assert.rejects(pushSafely(async () => { throw Object.assign(new Error('offline'), { code: 'network' }); }, ids(5)), /offline/);
  const sizes = [];
  const out = await pushSafely(fakePut({ onCall: r => sizes.push(r.length) }), ids(1200));
  assert.deepEqual(sizes, [500, 500, 200]);
  assert.equal(out.sent.length, 1200);
  const all = await pushSafely(fakePut({ capped: ids(1000).map(r => r.id) }), ids(1000), { budget: 10 });
  assert.equal(all.held.length + all.sent.length, 1000);                      // nothing lost: what couldn't be tried is held
  assert.ok(all.held.length >= 900);
});
