// The account space limit and its messages (js/quota.js), the image size limit, the import warnings, and a check
// that the SQL files say the same numbers as the app. Run with: node tests/quota.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MB, DEFAULT_MEDIA_LIMIT, MAX_PICTURE, MAX_OCCLUSION_PICTURE, fmtSize, readUsage, level, dataLevel, fullMessage, warnMessage, dataFullMessage, SERVER_FULL_MESSAGE, usageLine, planUploads, pictureTooBig, importWarnings, CARDS_WARN, cardsWarning, passedCardsWarning, rowBytes, rowLabel, splitOversized, bigRowsNote, pushErrorKind, capTimes, MAX_ROW_BYTES, MAX_ID_BYTES, savedTooBigNote, splitTooBig, tooLargeNote } from '../js/quota.js';
import { pushSafely, nextBackoff, activeBackoff, deletedThroughAfter } from '../js/sync-push.js';

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

test('the default is 50 MB, eighteen accounts fit in the free 1 GB', () => {
  assert.equal(DEFAULT_MEDIA_LIMIT, 50 * MB);
  assert.ok(18 * DEFAULT_MEDIA_LIMIT <= 1024 * MB);
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
  assert.ok(limits.includes(String(DEFAULT_MEDIA_LIMIT)), 'limits.sql default is 50 MB');
  assert.match(limits, /media_bytes_limit bigint not null default 52428800/);
  assert.equal(3145728, MAX_OCCLUSION_PICTURE);
  assert.match(limits, /file_size_limit = 3145728/);
  assert.match(media, /3145728/);
  assert.match(limits, /octet_length\(data::text\) < 65536/);
  assert.match(limits, /create or replace function public\.my_usage\(\)/);
  assert.match(limits, /data_bytes_limit bigint not null default 41943040/);
  assert.match(limits, /\('media', 943718400\), \('sync', 314572800\)/);           // 900 MB and 300 MB
  assert.equal(900 * MB, 943718400); assert.equal(300 * MB, 314572800); assert.equal(40 * MB, 41943040); assert.equal(50 * MB, 52428800);
  assert.match(limits, /revoke all on public\.quotas from anon, authenticated;\s*grant select on public\.quotas to authenticated/);
  assert.doesNotMatch(limits, /new\.data is not null/);                           // every new row is checked, "deleted" markers too
  // the trigger and recount_sync_usage count a row the same way: private.row_bytes (200 + twice the id + the data)
  assert.match(limits, /200 \+ 2 \* octet_length\(rid\)\s*\+ case when d is null then 0 else greatest\(octet_length\(d::text\), pg_column_size\(\(d::text\)::jsonb\)\) end/);
  assert.match(limits, /new_b := private\.row_bytes\(new\.id, new\.data\)/);
  assert.match(limits, /sum\(private\.row_bytes\(s\.id, s\.data\)\)/);
  assert.match(limits, /sync_server_full/);                                        // the project total is changed by one conditional update
  assert.match(limits, /update private\.usage_totals t set bytes = t\.bytes \+ growth\s+where t\.name = 'sync'\s+and t\.bytes \+ growth <=/);
  assert.doesNotMatch(limits, /create table[^;]*usage_cache|select public\._total_(sync|media)_bytes\(\)/);            // no more cached totals
  assert.match(limits, /raise exception 'media_left'/);
  assert.doesNotMatch(limits, /delete from storage\.objects/);                    // deleting file records with SQL would orphan the files
  assert.match(limits, /create or replace function public\.app_config\(\)/);
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

test('pushSafely: a refusal for space stops the sending at once (no splitting), and everything not sent is held', async () => {
  const calls = [];
  const out = await pushSafely(fakePut({ capped: ['r3', 'r15'], onCall: r => calls.push(r.length) }), ids(40));
  assert.deepEqual(calls, [40], 'one request, and it was refused');
  assert.equal(out.sent.length, 0);
  assert.equal(out.held.length, 40);
  assert.equal(out.full, 'data');
  assert.equal(out.bad.length, 0);
});

test('pushSafely: a full server costs one request however much is waiting', async () => {
  for (const n of [10, 200, 2000]) {
    let calls = 0;
    const put = async () => { calls++; throw Object.assign(new Error('x'), { code: 'sync_server_full' }); };
    const out = await pushSafely(put, ids(n));
    assert.equal(calls, 1, `${n} rows`);
    assert.equal(out.held.length, n);
    assert.equal(out.full, 'server');
  }
});

test('pushSafely: deletes are sent first and still go when the account is full; the puts are held', async () => {
  const seen = [];
  const rows = [...ids(30).map(r => ({ ...r, deleted: false })), ...Array.from({ length: 5 }, (_, i) => ({ id: 'd' + i, deleted: true, data: null }))];
  const put = async part => {
    seen.push(part.map(r => (r.deleted ? 'D' : 'P')).join(''));
    if (part.some(r => !r.deleted)) throw Object.assign(new Error('x'), { code: '54000', message: 'sync_data_full' });
  };
  const out = await pushSafely(put, rows);
  assert.deepEqual(seen, ['DDDDD', 'P'.repeat(30)]);
  assert.equal(out.sent.length, 5);
  assert.ok(out.sent.every(r => r.deleted));
  assert.equal(out.held.length, 30);
  assert.equal(out.full, 'data');
});

test('pushSafely: a row problem found by halving still splits, but a space refusal found on the way stops the rest', async () => {
  let calls = 0;
  const put = async part => {
    calls++;
    if (part.some(r => r.id === 'r2')) throw Object.assign(new Error('x'), { code: '23514' });
    if (part.some(r => r.id === 'r5')) throw Object.assign(new Error('x'), { code: 'sync_data_full' });
  };
  const out = await pushSafely(put, ids(8));
  assert.deepEqual(out.bad.map(b => b.row.id), ['r2']);
  assert.equal(out.full, 'data');
  assert.ok(out.held.some(r => r.id === 'r5'));
  assert.ok(calls < 8);
  assert.equal(out.sent.length + out.held.length + out.bad.length, 8);
});

test('push backoff: 15 minutes, doubling up to 6 hours, per account, and only while it lasts', () => {
  const T = 1_000_000_000_000, MIN = 60000;
  let b = nextBackoff(null, { userId: 'u', kind: 'server', note: 'full', now: T });
  assert.equal(b.wait, 15 * MIN); assert.equal(b.until, T + 15 * MIN);
  const waits = [b.wait];
  for (let i = 0; i < 6; i++) { b = nextBackoff(b, { userId: 'u', kind: 'server', now: T }); waits.push(b.wait); }
  assert.deepEqual(waits.map(w => w / MIN), [15, 30, 60, 120, 240, 360, 360]);
  assert.equal(nextBackoff(b, { userId: 'other', kind: 'data', now: T }).wait, 15 * MIN, 'another account starts over');
  const first = nextBackoff(null, { userId: 'u', kind: 'data', now: T });
  assert.ok(activeBackoff(first, 'u', T + 14 * MIN));
  assert.equal(activeBackoff(first, 'u', T + 15 * MIN), null);
  assert.equal(activeBackoff(first, 'other', T), null);
  assert.equal(activeBackoff(null, 'u', T), null);
  assert.equal(activeBackoff({ userId: 'u', until: T + 30 * 86400000, wait: 1 }, 'u', T), null, 'a clock set far back does not freeze pushing');
});

test('deletedThrough does not cover deletes that were held (equal times across a batch boundary)', async () => {
  const T = 5000;
  const dels = Array.from({ length: 700 }, (_, i) => ({ id: 'd' + i, deleted: true, data: null, updated_at: T }));
  let call = 0;
  const out = await pushSafely(async () => { if (++call === 2) throw Object.assign(new Error('x'), { code: '54000', message: 'sync_data_full' }); }, dels);
  assert.equal(out.sent.length, 500); assert.equal(out.held.length, 200);
  const through = deletedThroughAfter(0, out.sent, out.held);
  assert.equal(through, 0, 'stays where it was');
  assert.equal(dels.filter(r => !(r.deleted && r.updated_at <= through)).length, 700, 'so the 200 held deletes are sent again next time (the 500 already there are ignored by the server)');
  assert.equal(deletedThroughAfter(0, out.sent, []), T, 'once nothing is held it moves up');
  assert.equal(deletedThroughAfter(9000, [], out.held), 9000);
});

test('Postgres 25006 (read-only transaction) counts as a full server', () => {
  assert.equal(pushErrorKind({ code: '25006', message: 'cannot execute INSERT in a read-only transaction' }), 'server');
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

test('50,000 cards: a plain warning from the mark on, never before, and passing it is noticed once', () => {
  assert.equal(CARDS_WARN, 50000);
  assert.equal(cardsWarning(49999), null);
  assert.match(cardsWarning(50000), /^You have 50,000 cards\./);
  assert.match(cardsWarning(1234567), /^You have 1,234,567 cards\./);   // thousands separators
  assert.equal(passedCardsWarning(49999, 50000), true);                  // exactly one card past the line
  assert.equal(passedCardsWarning(0, 60000), true);
  assert.equal(passedCardsWarning(50000, 51000), false);                 // already past it: not "just passed"
  assert.equal(passedCardsWarning(10, 49999), false);
});

test('an over-long id is told apart from an over-big record', () => {
  const sizeErr = { code: '23514', message: 'new row for relation "sync_items" violates check constraint "sync_items_data_size"' };
  const idErr = { code: '23514', message: 'new row for relation "sync_items" violates check constraint "sync_items_id_size"' };
  assert.equal(pushErrorKind(sizeErr), 'size');
  assert.equal(pushErrorKind(idErr), 'id');
  assert.equal(pushErrorKind({ code: '23514', message: 'check' }), 'size');                // no name: treated as size, as before
  assert.equal(pushErrorKind({ code: '400', message: 'x', details: 'violates check constraint "sync_items_id_size"' }), 'id');
  const card = (id, front) => ({ store: 'cards', id, data: { front, back: 'b' }, deleted: false, updated_at: 1 });
  const { ok, big } = splitOversized([card('fine', 'Fine'), card('x'.repeat(MAX_ID_BYTES + 1), 'Long id card'), card('é'.repeat(101), 'Two-byte id')]);
  assert.deepEqual(ok.map(r => r.id), ['fine']);
  assert.deepEqual(big.map(r => r.reason), ['id', 'id']);                                   // 202 bytes in 101 characters still counts
  assert.equal(bigRowsNote([big[0]]), "1 card can't sync because its internal ID is too long: “Long id card”. Deleting it, and adding it again if you still need it, fixes that.");
  const sizeRow = { store: 'cards', id: 's', label: 'Huge' };
  assert.equal(bigRowsNote([sizeRow, big[0]]), '1 card is too large to sync: “Huge”. Shorten it to sync. 1 card can\'t sync because its internal ID is too long: “Long id card”. Deleting it, and adding it again if you still need it, fixes that.');
  assert.match(bigRowsNote(big), /^2 cards can't sync because their internal IDs are too long, for example/);
  assert.ok(!/too large/.test(bigRowsNote(big)), 'the id wording never says "too large"');
});

test('pushSafely sets aside a row with a bad id, with its kind, and sends the rest', async () => {
  const put = async rows => {
    const bad = rows.find(r => r.id === 'r4' || r.id === 'r9');
    if (bad) throw Object.assign(new Error(`violates check constraint "${bad.id === 'r4' ? 'sync_items_id_size' : 'sync_items_data_size'}"`), { code: '23514' });
  };
  const out = await pushSafely(put, ids(12));
  assert.equal(out.sent.length, 10);
  assert.deepEqual(out.bad.map(b => [b.row.id, b.kind]).sort(), [['r4', 'id'], ['r9', 'size']]);
  assert.equal(out.full, null);                                                              // neither of them means "account full"
  assert.equal(out.held.length, 0);
});

test('pushSafely tries a refused batch again in smaller pieces down to single rows', async () => {
  const sizes = [];
  const out = await pushSafely(async rows => { sizes.push(rows.length); if (rows.some(r => r.id === 'r2')) throw Object.assign(new Error('x'), { code: '23514' }); }, ids(4));
  assert.deepEqual(out.bad.map(b => b.row.id), ['r2']);
  assert.equal(out.sent.length, 3);
  assert.ok(sizes.includes(1), 'the bad row was narrowed down to a request of its own');
});

test('the editor refuses a card that would be too large to sync', () => {
  assert.equal(savedTooBigNote([{ id: 'a', front: 'Small', back: 'card' }], { tags: ['x'] }), '');
  const note = savedTooBigNote([{ id: 'a', front: 'Small', back: 'card' }, { id: 'b', front: 'Huge', back: 'x'.repeat(70000) }]);
  assert.match(note, /^This card is too large to save: it is about 70 KB and the limit is 60 KB\./);
  assert.match(savedTooBigNote([{ front: 'f', back: 'b' }], { noteExtra: 'y'.repeat(61000) }), /too large to save/);    // note-wide fields count too
  assert.match(savedTooBigNote([{ front: 'f', back: 'x'.repeat(100) }], {}, 50), /^This card is too large to save/);          // a smaller limit can be passed
  assert.equal(savedTooBigNote([{ front: 'f', back: 'b', updatedAt: 5, syncedAt: 5 }]), '');
});

test('editing a note: the new shared fields count, not the old ones', () => {
  const old = { id: 'a', front: 'f', back: 'b', noteExtra: 'short old note' };
  assert.equal(savedTooBigNote([old], { noteExtra: 'short' }), '');
  assert.match(savedTooBigNote([old], { noteExtra: 'y'.repeat(70000) }), /too large to save/);            // new long note replaces the old short one
  assert.equal(savedTooBigNote([{ ...old, noteExtra: 'y'.repeat(70000) }], { noteExtra: '' }), '');       // emptied: taken off, as saveNote does
  assert.equal(savedTooBigNote([{ ...old, noteExtra: 'y'.repeat(70000) }], { noteExtra: undefined }), '');
});

test('bulk saves: cards too large to sync are split off, the rest go ahead', () => {
  const small = { id: 'a', front: 'x', back: 'y', updatedAt: 5 }, huge = { id: 'b', front: 'x', back: 'y'.repeat(70000) };
  const { ok, big } = splitTooBig([small, huge, { ...small, id: 'c' }]);
  assert.deepEqual(ok.map(c => c.id), ['a', 'c']);
  assert.deepEqual(big.map(c => c.id), ['b']);
  assert.equal(savedTooBigNote([huge]) !== '', big.length === 1);                   // the same count as the editor's check
  assert.deepEqual(splitTooBig([small], { noteExtra: 'z'.repeat(70000) }).big.length, 1);       // extra fields count too
  assert.deepEqual(splitTooBig([{ ...small, noteExtra: 'z'.repeat(70000) }], { noteExtra: '' }).big, []);     // '' takes it off, as saving does
});

test('the words for cards left out of a bulk save', () => {
  assert.equal(tooLargeNote(0), '');
  assert.equal(tooLargeNote(1), '1 card was too large and was left unchanged');
  assert.equal(tooLargeNote(2), '2 cards were too large and were left unchanged');
  assert.equal(tooLargeNote(3, 'out'), '3 cards were too large and were left out');
});

// ---- batch size carried forward after a timeout ----
test('pushSafely: after one timeout the next batches start smaller, and no row is marked sent wrongly', async () => {
  const sizes = [], stored = new Set();
  let first = true;
  const put = async rows => {
    sizes.push(rows.length);
    if (first && rows.length === 500) { first = false; const e = new Error('slow'); e.code = 'timeout'; throw e; }
    rows.forEach(r => stored.add(r.id));
  };
  const rows = ids(2000);
  const out = await pushSafely(put, rows);
  assert.deepEqual(sizes.slice(0, 4), [500, 250, 250, 250]);       // timed out at 500, halves, then the next batch is 250 (not 500)
  assert.equal(out.sent.length, 2000);
  assert.deepEqual(new Set(out.sent.map(r => r.id)), stored);       // sent == what the server really got
  assert.ok(!sizes.slice(1).includes(500));                          // never back to 500 after the timeout (no regrowth)
});

test('pushSafely: a timeout at the bottom still throws, and size refusals do not shrink later batches', async () => {
  const slow = async () => { const e = new Error('slow'); e.code = 'timeout'; throw e; };
  await assert.rejects(pushSafely(slow, ids(60)), { code: 'timeout' });
  const sizes = [];
  await pushSafely(fakePut({ bad: ['r7'], onCall: r => sizes.push(r.length) }), ids(1000));
  assert.equal(sizes.filter(n => n === 500).length, 2);             // the second batch is still 500 long
});
