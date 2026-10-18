// Tests for js/sync-data.js and js/sync-merge.js (syncing between devices). Run with: node tests/sync.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp, tombstone, tombstoneKey, upgradeRecord, acceptSetting, SYNC_ID, SYNCED_SETTINGS, MERGED_SETTINGS } from '../js/sync-data.js';
import { MAX_FLAG_ENTRIES, mergeDayFlags, sameDayFlags, mergeIdleDays, sameIdleDays, rowFromRecord, rowFromTombstone, rowFromSetting, recordFromRow, decide, needsPush, tombstoneNeedsPush, newestOnly, chunks, parseAuthLink, getPageSafely, withSyncLock, SKIPPED, trimForPush, overLimitDayFlags } from '../js/sync-merge.js';
import { restDaySet, streakRuns, streakFromDays } from '../js/stats-calc.js';
import { DEFAULT_SETTINGS } from '../js/db.js';
import { splitOversized } from '../js/quota.js';
import { pushSafely } from '../js/sync-push.js';
import { checkPassword, passwordOk, passwordMissing } from '../js/password.js';

const NOW = 1_800_000_000_000;

test('saves are stamped with the time; review rows get a uid once', () => {
  assert.deepEqual(stamp('cards', { id: 'a', front: 'x' }, NOW), { id: 'a', front: 'x', updatedAt: NOW });
  assert.equal(stamp('cards', { id: 'a', updatedAt: 5 }, NOW).updatedAt, NOW);        // every save is a change
  const log = stamp('reviewLog', { cardId: 'a', timestamp: 1 }, NOW);
  assert.ok(log.uid && log.uid.length >= 16);
  assert.equal(stamp('reviewLog', log, NOW + 1).uid, log.uid);                     // kept, not replaced
  assert.notEqual(stamp('reviewLog', { cardId: 'b' }, NOW).uid, log.uid);
  assert.deepEqual(stamp('settings', { a: 1 }, NOW), { a: 1 });                    // not a synced store
});

test('deleted markers', () => {
  assert.deepEqual(tombstone('cards', 'abc', NOW), { key: 'cards:abc', store: 'cards', id: 'abc', deletedAt: NOW });
  assert.equal(tombstoneKey('reviewLog', 'u1'), 'reviewLog:u1');
});

test('upgrading old data keeps what is there and fills in the rest', () => {
  assert.equal(upgradeRecord('decks', { id: 'd', created: 1000 }, NOW).updatedAt, 1000);
  assert.equal(upgradeRecord('cards', { id: 'c' }, NOW).updatedAt, NOW);              // no created time
  assert.equal(upgradeRecord('cards', { id: 'c', created: NOW + 99 }, NOW).updatedAt, NOW);   // clock oddity: not in the future
  assert.equal(upgradeRecord('cardStates', { cardId: 'c', lastReview: 2000 }, NOW).updatedAt, 2000);
  assert.equal(upgradeRecord('cards', { id: 'c', updatedAt: 7 }, NOW).updatedAt, 7);
  const log = upgradeRecord('reviewLog', { id: 3, cardId: 'c', timestamp: 3000 }, NOW);
  assert.ok(log.uid); assert.equal(log.updatedAt, 3000); assert.equal(log.id, 3);
  assert.equal(upgradeRecord('reviewLog', { uid: 'keep', timestamp: 1 }, NOW).uid, 'keep');
});

test('what syncs', () => {
  assert.deepEqual(Object.keys(SYNC_ID), ['decks', 'cards', 'cardStates', 'reviewLog']);
  assert.ok(SYNCED_SETTINGS.includes('newPerDay') && !SYNCED_SETTINGS.includes('theme'));
});


test('records become server rows without device-only fields', () => {
  assert.deepEqual(rowFromRecord('cards', { id: 'c1', front: 'f', updatedAt: 5, syncedAt: 3 }),
    { store: 'cards', id: 'c1', data: { id: 'c1', front: 'f' }, deleted: false, updated_at: 5 });
  assert.deepEqual(rowFromRecord('reviewLog', { id: 42, uid: 'u9', cardId: 'c1', rating: 3, updatedAt: 6 }),
    { store: 'reviewLog', id: 'u9', data: { uid: 'u9', cardId: 'c1', rating: 3 }, deleted: false, updated_at: 6 });   // the local counter stays here
  assert.equal(rowFromRecord('cardStates', { cardId: 'c1', due: 1, updatedAt: 7 }).id, 'c1');
  assert.deepEqual(rowFromTombstone({ key: 'cards:c1', store: 'cards', id: 'c1', deletedAt: 9 }),
    { store: 'cards', id: 'c1', data: null, deleted: true, updated_at: 9 });
  assert.deepEqual(rowFromSetting('newPerDay', 30, 11), { store: 'settings', id: 'newPerDay', data: { value: 30 }, deleted: false, updated_at: 11 });
});

test('rows from the server are marked as already synced', () => {
  const rec = recordFromRow({ store: 'cards', id: 'c1', data: { id: 'c1', front: 'f' }, updated_at: 8 });
  assert.deepEqual(rec, { id: 'c1', front: 'f', updatedAt: 8, syncedAt: 8 });
  assert.equal(needsPush(rec, 0), false);                                   // not sent straight back
  assert.equal(needsPush({ ...rec, updatedAt: 12 }, 0), true);              // edited here afterwards: sent
  assert.equal(needsPush({ id: 'x', updatedAt: 5 }, 5), false);             // already pushed
  assert.equal(tombstoneNeedsPush({ deletedAt: 9 }, 5), true);
  assert.equal(tombstoneNeedsPush({ deletedAt: 9, synced: true }, 5), false);
});

test('the newest change wins, and deletes are changes too', () => {
  assert.equal(decide({ updated_at: 10, deleted: false }, 0), 'put');       // not here yet
  assert.equal(decide({ updated_at: 10, deleted: false }, 12), 'skip');     // this device's is newer
  assert.equal(decide({ updated_at: 10, deleted: false }, 10), 'skip');     // the same version
  assert.equal(decide({ updated_at: 15, deleted: true }, 12), 'delete');    // deleted elsewhere after
  assert.equal(decide({ updated_at: 11, deleted: true }, 12), 'skip');      // edited here after it was deleted elsewhere
  assert.equal(decide({ updated_at: 20, deleted: false }, 12), 'put');      // brought back elsewhere after a delete here
  assert.equal(decide({ updated_at: 2, deleted: true }, 1), 'delete');      // the sample deck (stamped 1) loses to any delete
});

test('only the newest of a record and its delete marker is sent; sending in batches', () => {
  const rows = newestOnly([
    { store: 'decks', id: 's', deleted: true, updated_at: 5 },
    { store: 'decks', id: 's', deleted: false, updated_at: 9 },
    { store: 'cards', id: 's', deleted: false, updated_at: 1 }
  ]);
  assert.deepEqual(rows.map(r => [r.store, r.deleted]), [['decks', false], ['cards', false]]);
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunks([], 2), []);
});


test('reading a password reset link', () => {
  const link = parseAuthLink('#access_token=abc&expires_at=1900000000&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery');
  assert.deepEqual(link, { session: { access_token: 'abc', refresh_token: 'r1', expires_at: 1900000000 } });
  assert.match(parseAuthLink('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid').error, /expired/);
  assert.match(parseAuthLink('#error=server_error&error_description=Click+evil.example+now').error, /^That link didn’t work/);   // the link's own text is never shown
  assert.equal(parseAuthLink('#/decks'), null);
  assert.equal(parseAuthLink(''), null);
  assert.deepEqual(parseAuthLink('#access_token=abc&type=signup'), { confirmed: true });      // the confirm-email link: nothing is kept from it
  assert.equal(parseAuthLink('#access_token=abc&type=magiclink'), null);      // anything else is ignored
});

test('password rules for new passwords: 8+ characters, a letter and a number', () => {
  assert.equal(passwordOk('secret123'), true);
  assert.equal(passwordOk('Ünïcode99'), true);                     // any letter counts
  assert.equal(passwordOk('abc123'), false);                        // too short
  assert.equal(passwordOk('abcdefgh'), false);                      // no number
  assert.equal(passwordOk('12345678'), false);                      // no letter
  assert.deepEqual(checkPassword('abc').map(r => r.ok), [false, true, false]);
  assert.equal(passwordMissing('abc'), 'at least 8 characters and a number');
  assert.equal(passwordMissing(''), 'at least 8 characters, a letter and a number');
  assert.equal(passwordMissing('12345678'), 'a letter');
  assert.equal(passwordMissing('secret123'), '');
});

test('cloze fields sync as they are, and siblings that diverged are healed', async () => {
  const { clozeCard, healNotes } = await import('../js/cloze.js');
  const text = 'A {{c1::b}} c {{c2::d}}';
  const card = { id: 'k1', deckId: 'd', ...clozeCard(text, 1), noteId: 'N', cloze: 1, noteText: text, noteExtra: 'x', updatedAt: NOW };
  const back = recordFromRow(rowFromRecord('cards', card));
  assert.equal(back.noteId, 'N'); assert.equal(back.cloze, 1); assert.equal(back.noteText, text); assert.equal(back.noteExtra, 'x');
  // Device A edited c1's card, device B edited c2's card: after syncing each keeps its own newest text.
  const textA = 'A {{c1::bee}} c {{c2::d}}', textB = 'A {{c1::b}} c {{c2::dee}}';
  const a = { ...card, ...clozeCard(textA, 1), noteText: textA, updatedAt: NOW + 5 };
  const b = { id: 'k2', deckId: 'd', ...clozeCard(textB, 2), noteId: 'N', cloze: 2, noteText: textB, updatedAt: NOW + 9 };
  const fixed = healNotes([a, b]);
  assert.deepEqual(fixed.map(c => c.id), ['k1']);
  assert.equal(fixed[0].noteText, textB);
  assert.equal(fixed[0].front, 'A […] c dee');
});

// ---------- days off (the restDays setting, v4.1) ----------
const T = new Date(2026, 9, 14, 12).getTime();      // Wed 14 Oct 2026
test('restDays is a synced setting that is merged, not replaced', () => {
  assert.ok(SYNCED_SETTINGS.includes('restDays'));
  assert.deepEqual(MERGED_SETTINGS, ['restDays', 'idleDays']);
});

test('rescue (the catch-up plan) is a synced setting: the newest copy wins, it is not merged', () => {
  assert.ok(SYNCED_SETTINGS.includes('rescue'));
  assert.ok(!MERGED_SETTINGS.includes('rescue'));
  assert.equal(DEFAULT_SETTINGS.rescue, null);
  const plan = { start: NOW, days: 3, backlog: 150, pauseNew: true, at: NOW };
  assert.equal(decide(rowFromSetting('rescue', plan, NOW + 5), NOW), 'put');          // a newer plan from another device is taken
  assert.equal(decide(rowFromSetting('rescue', null, NOW - 5), NOW), 'skip');         // an older "no plan" is not
  assert.equal(decide(rowFromSetting('rescue', null, NOW + 5), NOW), 'put');          // cancelling on another device cancels here
});

test('days off: two devices that each add a day keep both', () => {
  const a = { '2026-10-20': { on: true, at: 100 } };
  const b = { '2026-10-21': { on: true, at: 200 } };
  const merged = mergeDayFlags(a, b, T);
  assert.deepEqual(Object.keys(merged).sort(), ['2026-10-20', '2026-10-21']);
  assert.deepEqual(mergeDayFlags(b, a, T), merged);                       // the order does not matter
  assert.ok(sameDayFlags(mergeDayFlags(merged, a, T), merged, T));         // merging again changes nothing
});

test('days off: for one day, the newest decision wins (also a removal)', () => {
  const on = { '2026-10-20': { on: true, at: 100 } };
  const off = { '2026-10-20': { on: false, at: 200 } };
  assert.equal(mergeDayFlags(on, off, T)['2026-10-20'].on, false);
  assert.equal(mergeDayFlags(off, on, T)['2026-10-20'].on, false);
  const again = { '2026-10-20': { on: true, at: 300 } };
  assert.equal(mergeDayFlags(mergeDayFlags(on, off, T), again, T)['2026-10-20'].on, true);
  // the same time: "on" wins, on both devices
  const x = { '2026-10-20': { on: true, at: 5 } }, y = { '2026-10-20': { on: false, at: 5 } };
  assert.deepEqual(mergeDayFlags(x, y, T), mergeDayFlags(y, x, T));
});

test('days off: entries over 3650 days old (further back than the streak is walked) and junk are dropped; younger ones stay', () => {
  const old = { '2015-01-01': { on: true, at: 1 }, '2020-01-01': { on: true, at: 1 }, '2025-01-01': { on: true, at: 1 }, '2026-10-20': { on: true, at: 1 } };
  assert.deepEqual(Object.keys(mergeDayFlags(old, null, T)), ['2020-01-01', '2025-01-01', '2026-10-20']);      // (a day off 2 years back still bridges a long streak)
  const junk = { nope: { on: true, at: 1 }, '2026-13-40': { on: true, at: 1 }, '2026-10-22': { on: 'yes', at: 1 }, '2026-10-23': { on: true }, '2026-10-24': null, '2026-10-25': 7, '2026-10-26': { on: true, at: 'x' }, '2026-10-27': { on: true, at: 9 } };
  assert.deepEqual(mergeDayFlags(junk, undefined, T), { '2026-10-27': { on: true, at: 9 } });
  for (const bad of [undefined, null, 5, 'x', [], [1, 2]]) assert.deepEqual(mergeDayFlags(bad, bad, T), {});
});

// Local noon, n days before T, as a day key (what the app calls a dayKey).
const keyBack = n => { const d = new Date(T); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('days off: when over the cap, switched-off days go first (oldest first) and streak results do not change', () => {
  const flags = {};
  for (let i = 1; i <= 1400; i++) flags[keyBack(i)] = { on: i % 3 === 0, at: 1000 + i };     // a mix of on and off, 1400 days back
  const merged = mergeDayFlags(flags, null, T);
  assert.equal(Object.keys(merged).length, MAX_FLAG_ENTRIES);
  const offLeft = Object.values(merged).filter(v => !v.on).length;
  assert.ok(offLeft < 1400 - 466 && merged[keyBack(1)] && !merged[keyBack(1)].on);          // the newest "off" days stay, the oldest are gone
  assert.equal(Object.values(merged).filter(v => v.on).length, 466);                       // every day that is on is still there
  const before = restDaySet({ restDays: flags }), after = restDaySet({ restDays: merged });
  assert.deepEqual([...after].sort(), [...before].sort());
  const perDay = new Map();
  for (let i = 0; i < 400; i++) if (i % 3 !== 1) perDay.set(keyBack(i), 5);
  assert.deepEqual(streakRuns(perDay, T, { rest: after }), streakRuns(perDay, T, { rest: before }));
  const studied = new Set([...perDay.keys()]);
  assert.equal(streakFromDays(studied, T, { rest: after }).days, streakFromDays(studied, T, { rest: before }).days);
  // under the cap nothing is dropped, however old the "off" entries are
  const small = { [keyBack(200)]: { on: false, at: 5 }, [keyBack(100)]: { on: true, at: 5 } };
  assert.deepEqual(mergeDayFlags(small, null, T), small);
});

test('days off: an old "off" still beats an older "on" from a device that was offline (no resurrection)', () => {
  const D = keyBack(45);
  const phone = { [D]: { on: false, at: T - 50 * 86400000 } }, tablet = { [D]: { on: true, at: T - 60 * 86400000 } };
  assert.equal(mergeDayFlags(phone, tablet, T)[D].on, false);
  assert.equal(mergeDayFlags(tablet, phone, T)[D].on, false);
});

test('days off: a stored value over the cap is seen as different from its trimmed version, so it gets rewritten', () => {
  const big = {};
  for (let i = 1; i <= 1461; i++) big[keyBack(i)] = { on: i % 2 === 0, at: 1000 + i };
  const trimmed = mergeDayFlags(big, null, T);
  assert.equal(Object.keys(trimmed).length, MAX_FLAG_ENTRIES);
  assert.equal(sameDayFlags(trimmed, big, T), false);                                    // db.js then stores `trimmed` and sends it
  assert.ok(sameDayFlags(trimmed, mergeDayFlags(trimmed, big, T), T));                   // and it settles there
  assert.ok(JSON.stringify({ restDays: trimmed }).length < 60 * 1024);
});

test('days off: the stored entries are capped so the settings row stays under the 60 KB push limit', () => {
  const flags = {};
  for (let i = 1; i <= 3000; i++) flags[keyBack(i)] = { on: true, at: 1000 + i };
  const merged = mergeDayFlags(flags, null, T);
  assert.equal(Object.keys(merged).length, MAX_FLAG_ENTRIES);
  assert.ok(merged[keyBack(1)] && merged[keyBack(MAX_FLAG_ENTRIES)] && !merged[keyBack(MAX_FLAG_ENTRIES + 1)]);   // the oldest go first
  assert.ok(JSON.stringify({ restDays: merged }).length < 60 * 1024);
  // with the cap not reached, nothing that is on is ever lost
  const few = {};
  for (let i = 1; i <= 900; i++) few[keyBack(i)] = { on: true, at: 5 };
  assert.equal(Object.keys(mergeDayFlags(few, null, T)).length, 900);
});

test('days off: sameDayFlags compares what the merge would keep', () => {
  const a = { '2026-10-20': { on: true, at: 1 } };
  assert.ok(sameDayFlags(a, { ...a, junk: 1 }, T));
  assert.ok(sameDayFlags({}, null, T));
  assert.ok(!sameDayFlags(a, {}, T));
  assert.ok(!sameDayFlags(a, { '2026-10-20': { on: false, at: 1 } }, T));
  assert.ok(!sameDayFlags(a, { '2026-10-20': { on: true, at: 2 } }, T));
});


// ---------- v4.2.1: junk in day flags ----------
test('days off: a huge or unsafe decision time is dropped, so a day off can always be removed', () => {
  const key = '2026-10-20';
  for (const at of [1e308, Infinity, 2 ** 53, -5, 0, 1.5, T + 2 * 86400000]) assert.deepEqual(mergeDayFlags({ [key]: { on: true, at } }, null, T), {}, 'at = ' + at);
  const kept = { [key]: { on: true, at: T + 3600000 } };           // a clock an hour ahead is fine
  assert.deepEqual(mergeDayFlags(kept, null, T), kept);
  // so removing it later works: the removal's time is just a normal time
  assert.equal(mergeDayFlags({ [key]: { on: true, at: 1e308 } }, { [key]: { on: false, at: T } }, T)[key].on, false);
});

test('days off: keys beyond what can be planned are dropped and the number of future entries is capped', () => {
  const day = n => { const d = new Date(T); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const many = {};
  for (let n = 1; n <= 400; n++) many[day(n)] = { on: true, at: 5 };
  const out = Object.keys(mergeDayFlags(many, null, T));
  assert.ok(out.length <= 63, 'at most 63 future entries, got ' + out.length);
  assert.ok(out.includes(day(60)) && out.includes(day(62)) && !out.includes(day(63)) && !out.includes(day(399)));
  assert.ok(!Object.keys(mergeDayFlags({ '9999-12-31': { on: true, at: 5 } }, null, T)).length);
  assert.ok(sameDayFlags(many, Object.fromEntries(Object.entries(many).slice(0, 62)), T));     // the junk beyond is ignored when comparing
});

// ---------- pictures and sounds (files in Supabase Storage) ----------
import { uploadMediaFiles, runPool, isSoundRow, SOUNDS_BLOCKED_NOTE } from '../js/sync-merge.js';
import * as supa from '../js/supa.js';

const file = (id, type = 'image/jpeg') => ({ id, type });
const rejection = () => Object.assign(new Error('nope'), { code: 'media_type' });

test('files: one file failing on its own never stops the others', async () => {
  const rows = [file('a'), file('b'), file('c'), file('s1', 'audio/mpeg'), file('s2', 'audio/wav')];
  const tried = [], sentNow = [];
  const out = await uploadMediaFiles(rows, async m => { tried.push(m.id); if (m.id === 'b' || m.id === 's1') throw new Error('flaky'); }, { onSent: m => sentNow.push(m.id) });
  assert.deepEqual(tried, ['a', 'b', 'c', 's1', 's2']);
  assert.deepEqual(out.sent, ['a', 'c', 's2']);
  assert.deepEqual(sentNow, ['a', 'c', 's2']);
  assert.deepEqual(out.failed.map(f => f.id), ['b', 's1']);
  assert.deepEqual(out.blocked, []);
});

test('files: a type rejection never stops pictures; the sounds wait (blocked) and are not tried again in that run', async () => {
  const rows = [file('s1', 'audio/mpeg'), file('p1'), file('s2', 'audio/ogg'), file('p2', 'image/png'), file('s3', 'audio/wav')];
  const tried = [];
  const out = await uploadMediaFiles(rows, async m => { tried.push(m.id); if (isSoundRow(m)) throw rejection(); });
  assert.deepEqual(tried, ['p1', 'p2', 's1']);                       // pictures first, then one sound is tried, which tells us all sounds are turned away
  assert.deepEqual(out.sent, ['p1', 'p2']);
  assert.deepEqual(out.blocked, ['s1', 's2', 's3']);
  assert.deepEqual(out.failed, []);
});

test('files: a problem with the whole storage (not set up, offline, signed out) stops the run, after keeping what already went', async () => {
  for (const err of [Object.assign(new Error('x'), { code: 'bucket_missing' }), Object.assign(new Error('x'), { code: 'network' }), Object.assign(new Error('x'), { status: 401 })]) {
    const sentNow = [];
    await assert.rejects(uploadMediaFiles([file('a'), file('b'), file('c')], async m => { if (m.id === 'b') throw err; }, { onSent: m => sentNow.push(m.id) }), e => e === err);
    assert.deepEqual(sentNow, ['a']);
  }
  assert.match(SOUNDS_BLOCKED_NOTE, /Sounds can.t sync yet.*media\.sql.*docs\/sync-setup\.md.*Pictures and everything else are syncing/);
});

test('downloads: four at a time; a file that fails is skipped, a whole-storage problem stops the rest', async () => {
  let running = 0, most = 0;
  const seen = [];
  const out = await runPool(Array.from({ length: 12 }, (_, i) => i), async i => {
    running++; most = Math.max(most, running);
    await new Promise(r => setTimeout(r, 2));
    running--;
    if (i === 5) throw new Error('missing on the server');
    seen.push(i);
  });
  assert.equal(most, 4);
  assert.deepEqual(out, { done: 11, failed: 1 });
  assert.equal(seen.length, 11);
  const progress = [];
  await runPool([1, 2, 3], async () => {}, { onProgress: (n, total) => progress.push(`${n}/${total}`) });
  assert.deepEqual(progress, ['1/3', '2/3', '3/3']);
  const fatal = Object.assign(new Error('offline'), { code: 'network' });
  await assert.rejects(runPool([1, 2, 3, 4, 5, 6, 7, 8], async i => { if (i === 2) throw fatal; await new Promise(r => setTimeout(r, 5)); }), e => e === fatal);
});

test('the sync server turning a sound away for its type is reported as media_type', async () => {
  const realFetch = globalThis.fetch;
  const answer = (status, body) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); };
  try {
    answer(415, { statusCode: '415', error: 'invalid_mime_type', message: 'mime type audio/mpeg is not supported' });
    await assert.rejects(supa.uploadMedia('tok', 'uid', 'id1', 'audio/mpeg', new ArrayBuffer(4)), e => e.code === 'media_type');
    answer(400, { statusCode: '415', error: 'invalid_mime_type', message: 'mime type audio/ogg is not supported' });      // (some versions answer 400 with the code inside)
    await assert.rejects(supa.uploadMedia('tok', 'uid', 'id1', 'audio/ogg', new ArrayBuffer(4)), e => e.code === 'media_type');
    answer(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
    await assert.rejects(supa.uploadMedia('tok', 'uid', 'id1', 'image/jpeg', new ArrayBuffer(4)), e => e.code === 'bucket_missing');
    answer(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    await assert.rejects(supa.uploadMedia('tok', 'uid', 'id1', 'image/jpeg', new ArrayBuffer(4)), e => e.code === 'media_policy');
  } finally { globalThis.fetch = realFetch; }
});

test('glossary terms are synced settings, one per term (gloss:<id>), and the newest copy of each wins', async () => {
  const { isSyncedSetting } = await import('../js/sync-data.js');
  assert.ok(isSyncedSetting('gloss:abc') && isSyncedSetting('newPerDay'));
  assert.ok(!isSyncedSetting('theme') && !isSyncedSetting('glossaryUnderline') && !isSyncedSetting('_times') && !isSyncedSetting(undefined));
  assert.ok(!SYNCED_SETTINGS.some(k => k.startsWith('gloss:')));                    // the fixed list is untouched
  // two devices adding different terms keep both (separate rows); the same term: the later change wins, and a delete (null) is a change
  assert.equal(decide({ updated_at: 20, deleted: false }, 10), 'put');
  assert.equal(decide({ updated_at: 10, deleted: false }, 20), 'skip');
  assert.deepEqual(rowFromSetting('gloss:x', null, 7), { store: 'settings', id: 'gloss:x', data: { value: null }, deleted: false, updated_at: 7 });
});

// ---------- your own FSRS parameters (fsrsParams, v4.10) ----------
test('fsrsParams is a synced setting: the newest copy wins as a whole, it is not merged', () => {
  assert.ok(SYNCED_SETTINGS.includes('fsrsParams'));
  assert.ok(!MERGED_SETTINGS.includes('fsrsParams'));
  assert.equal(DEFAULT_SETTINGS.fsrsParams, null);
  const mine = { w: Array(21).fill(0.5), at: NOW, version: 'fsrs-6' };
  assert.equal(decide(rowFromSetting('fsrsParams', mine, NOW + 5), NOW), 'put');            // a newer fit from another device is taken
  assert.equal(decide(rowFromSetting('fsrsParams', mine, NOW - 5), NOW), 'skip');           // an older one is not
  assert.equal(decide(rowFromSetting('fsrsParams', { w: null, at: NOW + 5, version: 'fsrs-6' }, NOW + 5), NOW), 'put');   // a reset elsewhere resets here
});

test('fsrsParams from the server: a good value is kept (cleaned), null means the standard settings, junk is ignored', () => {
  const mine = { w: Array(21).fill(0.5), at: NOW, reviews: 500, version: 'fsrs-6', extra: 'x' };
  assert.deepEqual(acceptSetting('fsrsParams', mine), { ok: true, value: { w: mine.w, at: NOW, reviews: 500, version: 'fsrs-6' } });
  assert.deepEqual(acceptSetting('fsrsParams', null), { ok: true, value: null });
  assert.deepEqual(acceptSetting('fsrsParams', undefined), { ok: true, value: null });
  for (const bad of [{ ...mine, version: 'fsrs-7' }, { ...mine, w: [1, 2, 3] }, { ...mine, w: Array(21).fill('a') }, 'x', 5, [], { w: Array(21).fill(NaN), version: 'fsrs-6' }]) {
    assert.deepEqual(acceptSetting('fsrsParams', bad), { ok: false }, JSON.stringify(bad));
  }
  // other settings are not touched
  assert.deepEqual(acceptSetting('dailyGoal', 'anything'), { ok: true, value: 'anything' });
});

// ---------- days with nothing due (the idleDays setting) ----------
const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
test('idleDays is a synced, merged setting: the union of two devices, pruned only past 3650 days (a long streak keeps its quiet days)', () => {
  assert.ok(SYNCED_SETTINGS.includes('idleDays') && MERGED_SETTINGS.includes('idleDays'));
  const a = { '2026-10-10': true, '2026-10-11': true }, b = { '2026-10-11': true, '2026-10-12': true };
  const merged = mergeIdleDays(a, b, T);
  assert.deepEqual(Object.keys(merged).sort(), ['2026-10-10', '2026-10-11', '2026-10-12']);
  assert.deepEqual(mergeIdleDays(b, a, T), merged);                         // the order does not matter
  assert.ok(sameIdleDays(mergeIdleDays(merged, a, T), merged, T));          // merging again changes nothing
  assert.ok(!sameIdleDays(a, merged, T));
  assert.ok(sameIdleDays(a, { ...a, junk: true, '2026-10-13': false, '2026-10-09': 1 }, T));
  const old = { '2010-01-01': true, '2020-01-01': true, [ymd(T - 199 * 86400000)]: true, [ymd(T - 230 * 86400000)]: true };
  assert.equal(Object.keys(mergeIdleDays(old, null, T)).length, 3);          // only the one over 3650 days old goes
  assert.deepEqual(Object.keys(mergeIdleDays({ [ymd(T + 86400000)]: true, [ymd(T + 2 * 86400000)]: true }, null, T)), [ymd(T + 86400000)]);      // one day ahead at most (time zones)
  for (const bad of [undefined, null, 5, 'x', [], [1, 2]]) assert.deepEqual(mergeIdleDays(bad, bad, T), {});
});

// ---------- the overlap when pulling ----------
import { pullStart, startPull, logPull, pullPages, OVERLAP_MS, MAX_BACK } from '../js/sync-merge.js';

const PAGE = 1000, T0 = 2_000_000_000;
// A tiny model of the server and of sync.js's pull loop. seq is taken when a transaction writes; rows show up when it commits.
function fakeServer() {
  let seq = 0; const visible = [];
  return {
    begin(...ids) { return { rows: ids.map(id => ({ id, seq: ++seq })) }; },
    commit(tx) { visible.push(...tx.rows); },
    add(n, prefix = 'r') { for (let i = 0; i < n; i++) visible.push({ id: prefix + (seq + 1), seq: ++seq }); },
    read(after, limit = PAGE) { return visible.filter(r => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit); }
  };
}
// One pull as sync.js does it. clock: { now } advances 1 s per request. maxPages cuts it off midway. Returns the state; stats.downloaded counts rows.
function pull(server, st, clock, seen = new Set(), { maxPages = Infinity, stats = {} } = {}) {
  st = startPull(st, clock.now);
  let from = pullStart(st), pages = 0;
  const t0 = clock.now, from0 = from;
  for (;;) {
    const at = clock.now, after = from;
    const rows = server.read(from); clock.now += 1000;
    stats.downloaded = (stats.downloaded || 0) + rows.length;
    rows.forEach(r => seen.add(r.id));
    if (rows.length) from = Math.max(from, ...rows.map(r => r.seq));
    const lastSeq = Math.max(st.lastSeq, from);
    st = { ...st, lastSeq, seqLog: logPull(st.seqLog, { t: at, seq: lastSeq, from: after, to: rows.length ? Math.max(...rows.map(r => r.seq)) : after, n: rows.length }, { t0, from: from0, reach: rows.length < PAGE ? Infinity : from }) };
    if (rows.length < PAGE || ++pages >= maxPages) break;
  }
  return st;
}
const dl = (server, st, clock, opts) => { const stats = {}; const out = pull(server, st, clock, opts?.seen, { ...opts, stats }); return [out, stats.downloaded || 0]; };

test('overlap: no log yet (first sync, or an update from an older version) means no overlap', () => {
  assert.equal(pullStart({ lastSeq: 500 }), 500);
  assert.equal(pullStart({ lastSeq: 0, seqLog: [] }), 0);
  assert.equal(pullStart(undefined), 0);
  assert.equal(pullStart({ lastSeq: 7, seqLog: [{ t: 'x', seq: 'y' }, null] }), 7);       // junk is ignored
  assert.equal(pullStart(startPull({ lastSeq: 500 }, T0)), 500);
});

test('overlap: a pull starts at the bookmark that was current OVERLAP_MS before the previous pull, never above the bookmark', () => {
  const e = (t, seq) => ({ t, seq, from: seq, n: 0 });
  let log = logPull([], e(T0, 100));
  assert.equal(pullStart({ lastSeq: 120, seqLog: log }), 100);              // young history: the oldest entry
  log = logPull(log, e(T0 + 60_000, 120));
  assert.equal(pullStart({ lastSeq: 150, seqLog: log }), 100);
  log = logPull(log, e(T0 + OVERLAP_MS + 1000, 150));
  assert.equal(pullStart({ lastSeq: 180, seqLog: log }), 100);              // T0 is more than 2 minutes before the latest: 100 is the anchor
  log = logPull(log, e(T0 + 2 * OVERLAP_MS + 5000, 180));
  assert.equal(pullStart({ lastSeq: 200, seqLog: log }), 150);
  assert.equal(pullStart({ lastSeq: 110, seqLog: log }), 110);              // never above the bookmark (e.g. after a reset)
});

test('overlap: a stale log (the bookmark moved without it, e.g. after a downgrade) is replaced by a fresh start', () => {
  const st = { lastSeq: 900, seqLog: [{ t: T0, seq: 100, from: 0, n: 100 }, { t: T0 + 1000, seq: 120, from: 100, n: 20 }] };
  const fresh = startPull(st, T0 + 9_000_000);
  assert.equal(pullStart(fresh), 900);
  assert.equal(startPull(fresh, T0 + 9_000_001), fresh);                    // a log that ends at the bookmark is kept
});

test('overlap: a change numbered below the bookmark that becomes visible late is still picked up', () => {
  const server = fakeServer(), seen = new Set(), clock = { now: T0 };
  let st = { lastSeq: 0 };
  const a = server.begin('late'), b = server.begin('early');
  server.commit(b);
  st = pull(server, st, clock, seen);
  assert.equal(st.lastSeq, 2); assert.deepEqual([...seen], ['early']);
  server.commit(a); clock.now += 30_000;
  st = pull(server, st, clock, seen);
  assert.ok(seen.has('late'));
  assert.equal(st.lastSeq, 2);                                              // the bookmark did not move backwards
});

test('overlap: it is picked up even when the next pull comes much later', () => {
  const server = fakeServer(), seen = new Set(), clock = { now: T0 };
  let st = { lastSeq: 0 };
  server.add(3);
  st = pull(server, st, clock, seen); clock.now += 5 * 60_000;
  st = pull(server, st, clock, seen); clock.now += 5 * 60_000;               // a quiet pull: the log now reaches back over the window
  const a = server.begin('late'), b = server.begin('early');
  server.commit(b);
  st = pull(server, st, clock, seen);
  server.commit(a); clock.now += 3 * 24 * 3600_000;                          // three days on
  st = pull(server, st, clock, seen);
  assert.ok(seen.has('late'));
});

test('overlap: a multi-page first download where an early page passes a row that is not saved yet', () => {
  const server = fakeServer(), seen = new Set(), clock = { now: T0 };
  server.add(1500);
  const slow = server.begin('slow');            // numbered 1501, saving
  server.add(1000);                              // numbered above it, visible
  let st = pull(server, { lastSeq: 0 }, clock, seen);       // pages 1..3 pass 'slow'
  assert.ok(!seen.has('slow'));
  server.commit(slow); clock.now += 10_000;
  st = pull(server, st, clock, seen);
  assert.ok(seen.has('slow'), 'the first-sync log has a seed entry, so the next pull covers it');
});

test('overlap: a pull cut off midway carries on near where it stopped, and the bookmark moves up page by page', () => {
  const server = fakeServer(), clock = { now: T0 };
  server.add(50);
  let st = pull(server, { lastSeq: 0 }, clock); clock.now += 5 * 60_000;
  st = pull(server, st, clock); clock.now += 5 * 60_000;
  server.add(100_000);
  const marks = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const [next, got] = dl(server, st, clock, { maxPages: 60 });
    assert.ok(next.lastSeq >= st.lastSeq);
    st = next; marks.push(st.lastSeq); clock.now += 60_000;
    assert.ok(got <= 60_000 + 1000);
  }
  assert.ok(marks[3] > 90_000 && marks[1] > marks[0] + 20_000, 'progress each attempt: ' + marks);
});

test('overlap: after a big pull, quick syncs read at most MAX_BACK rows again', () => {
  const server = fakeServer(), clock = { now: T0 };
  server.add(50);
  let st = pull(server, { lastSeq: 0 }, clock); clock.now += 5 * 60_000;
  st = pull(server, st, clock); clock.now += 5 * 60_000;
  server.add(100_000);
  let got;
  [st, got] = dl(server, st, clock); assert.equal(got, 100_000);
  for (let i = 0; i < 6; i++) { clock.now += 10_000; [st, got] = dl(server, st, clock); assert.ok(got <= Math.max(MAX_BACK, 31 * PAGE), `sync ${i}: ${got}`); }   // (1 s per page here: the last 30 s are always read again)
  // and a device's very first download, then a quick sync
  let fresh;
  [fresh, got] = dl(server, { lastSeq: 0 }, { now: T0 }); assert.equal(got, 100_050);
  [, got] = dl(server, fresh, { now: T0 + 200_000 }); assert.ok(got <= 31 * PAGE, 'quick sync after a first download: ' + got);
});

test('overlap: steady state at 5-minute spacing reads each new row about twice', () => {
  const server = fakeServer(), clock = { now: T0 };
  let st = { lastSeq: 0 }, total = 0, runs = 0;
  server.add(100); st = pull(server, st, clock);
  for (let i = 0; i < 20; i++) {
    clock.now += 5 * 60_000; server.add(100);
    let got; [st, got] = dl(server, st, clock);
    if (i >= 3) { total += got; runs++; }
  }
  assert.ok(total / runs <= 250, 'rows per sync: ' + total / runs);
});

test('overlap: a clock that went backwards does not make the re-reads grow', () => {
  const server = fakeServer(), clock = { now: T0 + 7 * 24 * 3600_000 };
  server.add(10);
  let st = pull(server, { lastSeq: 0 }, clock);
  clock.now -= 7 * 24 * 3600_000;                                            // a week back
  for (let i = 0; i < 6; i++) {
    clock.now += 5 * 60_000; server.add(200);
    let got; [st, got] = dl(server, st, clock);
    assert.ok(got <= 700, `sync ${i}: ${got}`);
  }
  assert.ok(st.seqLog.length <= 4);
});

test('overlap: the bookmark never moves backwards, and a quiet server stops re-reading', () => {
  const server = fakeServer(), seen = new Set(), clock = { now: T0 };
  let st = { lastSeq: 0 };
  server.add(5);
  let prev = 0;
  for (let i = 0; i < 8; i++) { st = pull(server, st, clock, seen); clock.now += 20_000; assert.ok(st.lastSeq >= prev); prev = st.lastSeq; }
  assert.equal(st.lastSeq, 5);
  clock.now += 10 * 60_000; st = pull(server, st, clock, seen);
  clock.now += 10 * 60_000; st = pull(server, st, clock, seen);
  assert.equal(pullStart(st), 5);
  assert.deepEqual(server.read(pullStart(st)), []);
});

test('overlap: a missed page followed by many full pages in the same pull is still read again (the cap never skips the last 30 s)', () => {
  const server = fakeServer(), seen = new Set(), clock = { now: T0 };
  server.add(500);
  let st = pull(server, { lastSeq: 0 }, clock, seen); clock.now += 600_000;
  st = startPull(st, clock.now);
  let from = pullStart(st);
  const t0 = clock.now, from0 = from;
  const late = server.begin('R');                 // numbered 501, still being saved
  server.add(1000);                                // another device's import commits 1000 rows after it
  const req = () => {
    const at = clock.now, after = from, rows = server.read(from); clock.now += 1000;
    rows.forEach(r => seen.add(r.id));
    if (rows.length) from = Math.max(from, ...rows.map(r => r.seq));
    st = { ...st, lastSeq: Math.max(st.lastSeq, from), seqLog: logPull(st.seqLog, { t: at, seq: Math.max(st.lastSeq, from), from: after, to: rows.length ? Math.max(...rows.map(r => r.seq)) : after, n: rows.length }, { t0, from: from0, reach: rows.length < PAGE ? Infinity : from }) };
    return rows.length;
  };
  req();                                           // the page that passes R
  for (let k = 0; k < 4; k++) { server.add(1000); req(); }      // the import outpaces the save: 4 more full pages
  req();
  server.commit(late); clock.now += 5000;
  st = pull(server, st, clock, seen);
  assert.ok(seen.has('R'), 'R must be picked up');
});

test('overlap: a pull cut off every 20 seconds, attempts 30+ seconds apart, still moves forward and finishes', () => {
  const server = fakeServer(), clock = { now: T0 };
  server.add(50);
  let st = pull(server, { lastSeq: 0 }, clock); clock.now += 5 * 60_000;
  st = pull(server, st, clock); clock.now += 5 * 60_000;
  server.add(100_000);
  let done = -1;
  for (let attempt = 0; attempt < 40 && done < 0; attempt++) {
    const [next, got] = dl(server, st, clock, { maxPages: 20 });
    assert.ok(next.lastSeq >= st.lastSeq);
    st = next; clock.now += 31_000;
    if (st.lastSeq >= 100_050) done = attempt;
  }
  assert.ok(done >= 0 && done <= 12, 'finished after attempts: ' + done);
});

test('overlap: a missed page is not forgotten if the attempt that settles it is itself cut off', () => {
  const server = fakeServer(), seen = new Set(), clock = { now: T0 };
  server.add(100);
  let st = pull(server, { lastSeq: 0 }, clock, seen); clock.now += 600_000;
  const late = server.begin('R');
  server.add(10_000);
  st = pull(server, st, clock, seen, { maxPages: 6 });          // passes R
  server.commit(late);
  for (let i = 0; i < 4; i++) { clock.now += 31_000; st = pull(server, st, clock, seen, { maxPages: 4 }); }
  assert.ok(seen.has('R'));
});

test('overlap: fast pages (300 ms) do not lose the entries that liveness needs when the log is trimmed', () => {
  let log = [];
  for (let i = 0; i < 400; i++) log = logPull(log, { t: T0 + i * 300, seq: (i + 1) * 1000, from: i * 1000, to: (i + 1) * 1000, n: 1000 });
  const last = T0 + 399 * 300;
  assert.ok(log.filter(e => e.t >= last - 30_000).length >= 99, 'the last 30 s are all kept');
  assert.ok(log.some(e => e.t <= last - 30_000 && e.t > last - 31_000), 'and the newest entry at least 30 s old');
  assert.ok(log.length < 160);
});

test('overlap: a pull cut off after a few fast pages each time still finishes', () => {
  const server = fakeServer(), clock = { now: T0 };
  server.add(50);
  let st = pull(server, { lastSeq: 0 }, clock); clock.now += 600_000;
  server.add(30_000);
  let done = -1;
  for (let a = 0; a < 40 && done < 0; a++) {
    st = pull(server, st, clock, new Set(), { maxPages: 10 }); clock.now += 31_000;
    if (st.lastSeq >= 30_050) done = a;
  }
  assert.ok(done >= 0 && done <= 12, 'attempts: ' + done);
});

// ---------- taking turns between tabs, giving up a failing re-upload, trimming days off on push ----------
// A fake of navigator.locks: one holder at a time; ifAvailable gives null when held; signal aborts the wait.
function fakeLocks() {
  let held = null; const waiting = [];
  const grant = async (fn) => { const p = (async () => fn({})) (); held = p.catch(() => {}).finally(() => { held = null; const next = waiting.shift(); if (next) next(); }); return p; };
  return {
    request(name, opts, fn) {
      if (opts.ifAvailable) return held ? Promise.resolve(fn(null)) : grant(fn);
      if (!held) return grant(fn);
      return new Promise((resolve, reject) => {
        const go = () => resolve(grant(fn));
        waiting.push(go);
        opts.signal?.addEventListener('abort', () => { const i = waiting.indexOf(go); if (i >= 0) waiting.splice(i, 1); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    }
  };
}

test('sync lock: a routine sync is skipped while another tab syncs, and runs when nobody does', async () => {
  const locks = fakeLocks(); let release; const ran = [];
  const frozen = withSyncLock(() => new Promise(r => { release = r; ran.push('other tab'); }), { locks });
  assert.equal(await withSyncLock(() => { ran.push('routine'); return 'x'; }, { skipIfBusy: true, locks }), SKIPPED);
  assert.deepEqual(ran, ['other tab']);
  release(); await frozen;
  assert.equal(await withSyncLock(() => { ran.push('routine'); return 'x'; }, { skipIfBusy: true, locks }), 'x');
});

test('sync lock: a sync that must run waits its turn, but not for ever (a frozen tab), and the timeout has its own code', async () => {
  const locks = fakeLocks(); let release;
  const frozen = withSyncLock(() => new Promise(r => { release = r; }), { locks });
  let ran = false;
  await assert.rejects(withSyncLock(() => { ran = true; }, { waitMs: 20, locks }), { code: 'lock-timeout' });
  assert.equal(ran, false);
  const waiter = withSyncLock(() => 'second', { waitMs: 1000, locks });
  release(); await frozen;
  assert.equal(await waiter, 'second');
});

test('sync lock: a database AbortError from the sync itself (disk full) is not taken for a lock timeout', async () => {
  const idb = Object.assign(new Error('QuotaExceededError'), { name: 'AbortError' });
  await assert.rejects(withSyncLock(async () => { throw idb; }, { locks: fakeLocks() }), err => err === idb && err.code !== 'lock-timeout');
  await assert.rejects(withSyncLock(async () => { throw idb; }, { locks: fakeLocks(), skipIfBusy: true }), err => err === idb);
});

test('sync lock: without Web Locks the sync just runs', async () => {
  assert.equal(await withSyncLock(() => 'ran', { locks: undefined, skipIfBusy: true }), 'ran');
  assert.equal(await withSyncLock(() => 'ran', { locks: null }), 'ran');
});

// syncNow itself, with a fake navigator.locks. (There is no database in node: a sync that does get the lock fails at once, which is fine here.)
async function withFakeLocks(fn) {
  const locks = fakeLocks();
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  try { return await fn(locks); } finally { delete globalThis.navigator.locks; }
}
const holdLock = locks => { let release; const held = locks.request('x', {}, () => new Promise(r => { release = r; })); return async () => { release(); await held; }; };

test('syncNow: a routine sync that finds the lock taken says "skipped", tries again later, and tells after a long run of skips', async () => {
  const sync = await import('../js/sync.js');
  const old = { ...sync.timing };
  Object.assign(sync.timing, { skipRetry: 15, busyNoteAfter: 40 });
  try {
    await withFakeLocks(async locks => {
      const free = holdLock(locks);
      assert.deepEqual(await sync.syncNow({ skipIfBusy: true }), { ok: false, reason: 'skipped' });
      await new Promise(r => setTimeout(r, 150));                       // it came back by itself, found the lock taken again, and finally said so
      assert.equal(sync.lastStatus().state, 'syncing');           // (not an error: it is waiting)
      assert.match(sync.lastStatus().progress, /another window of the app, which is syncing or paused/);
      await free();
      await new Promise(r => setTimeout(r, 100));                       // the next retry gets the lock (and then fails at once: no database here)
      assert.match(sync.lastStatus().error || '', /indexedDB/);          // it ran this time (and failed: no database in node)
    });
  } finally { Object.assign(sync.timing, old); }
});

test('syncNow: a sync that must run and waits too long says "busy" (for the callers that must not go on)', async () => {
  const sync = await import('../js/sync.js');
  const old = sync.timing.lockWait; sync.timing.lockWait = 20;
  try {
    await withFakeLocks(async locks => {
      const free = holdLock(locks);
      assert.deepEqual(await sync.syncNow(), { ok: false, reason: 'busy' });
      assert.match(sync.lastStatus().error, /Another window is still syncing/);
      await free();
    });
  } finally { sync.timing.lockWait = old; }
});

test('re-upload start-over: counting, giving up, and the note', async () => {
  const sync = await import('../js/sync.js');
  const failing = async () => { throw new Error('QuotaExceededError'); };
  sync.forgetResendFailures();
  await assert.rejects(sync.tryStartOver('u1', failing), /QuotaExceeded/);
  await assert.rejects(sync.tryStartOver('u1', failing), /QuotaExceeded/);
  assert.equal(sync.resendGivenUp(), false);
  assert.match(await sync.tryStartOver('u1', failing), /re-upload couldn’t finish/);          // the third failure in a row
  assert.equal(sync.resendGivenUp(), true);

  // the note outlives a sync that fails right after: it is in that error too
  await sync.syncNow().catch(() => {});                              // (no database in node: this sync fails)
  assert.match(sync.lastStatus().error, /re-upload couldn’t finish/);

  // pressing the button starts the counting again
  sync.forgetResendFailures();                                       // (what resendEverything does first; it can't run here: no sign-in or database in node)
  assert.equal(sync.resendGivenUp(), false);

  // fail, fail, success, fail: the success clears the count, so this is no give-up
  await assert.rejects(sync.tryStartOver('u1', failing));
  await assert.rejects(sync.tryStartOver('u1', failing));
  assert.equal(await sync.tryStartOver('u1', async () => {}), null);
  await assert.rejects(sync.tryStartOver('u1', failing), /QuotaExceeded/);
  assert.equal(sync.resendGivenUp(), false);
  sync.forgetResendFailures();
});

// n real day keys ending yesterday (junk keys would be cleaned away)
const dayKeys = n => Array.from({ length: n }, (_, i) => { const d = new Date(Date.now() - (i + 1) * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
test('days off: a stored value over the limit is found and trimmed (the stuck case: its change was already marked as sent)', () => {
  const big = {};
  dayKeys(1100).forEach((k, i) => { big[k] = { on: i % 2 === 0, at: 5 }; });
  const trimmed = overLimitDayFlags(big);
  assert.equal(Object.keys(trimmed).length, MAX_FLAG_ENTRIES);
  assert.equal(Object.keys(big).length, 1100);
  assert.equal(overLimitDayFlags({ '2026-01-01': { on: true, at: 5 } }), null);
  assert.equal(overLimitDayFlags(undefined), null);
  // the trimmed copy is a row that fits, so saving it (a new change) gets it sent and clears the set-aside entry
  assert.equal(splitOversized([rowFromSetting('restDays', trimmed, 7)]).big.length, 0);
});

test('days off: an oversized stored value is trimmed on the way out; other settings are untouched', () => {
  const big = {};
  dayKeys(1200).forEach((k, i) => { big[k] = { on: i % 2 === 0, at: 5 }; });
  const out = trimForPush('restDays', big);
  assert.equal(Object.keys(out).length, MAX_FLAG_ENTRIES);
  assert.equal(Object.keys(big).length, 1200);                         // the stored value itself is not changed
  const small = { '2026-01-01': { on: true, at: 5 } };
  assert.deepEqual(trimForPush('restDays', small), small);
  assert.equal(trimForPush('newPerDay', 30), 30);
  assert.equal(trimForPush('restDays', null), null);
});

test('days off: a junk entry next to an oversized stored value does not break the trim', () => {
  const big = { '2024-01-bad': null, 'x': 5 };
  dayKeys(1100).forEach(k => { big[k] = { on: false, at: 5 }; });
  const stored = { ...big, '2026-01-01': { on: true, at: 5 }, '2026-01-02': null, '2026-01-03': 'junk' };
  const trimmed = overLimitDayFlags(stored);
  assert.ok(trimmed && Object.keys(trimmed).length <= MAX_FLAG_ENTRIES);
  assert.ok(!('2026-01-02' in trimmed) && !('2026-01-03' in trimmed) && !('x' in trimmed));
  assert.doesNotThrow(() => trimForPush('restDays', stored));
  assert.ok(Object.keys(trimForPush('restDays', stored)).length <= MAX_FLAG_ENTRIES);
});

test('a page of changes that times out is asked for again half as big, down to 50 rows', async () => {
  const timeout = () => Object.assign(new Error('slow'), { code: 'timeout' });
  const asked = [];
  const out = await getPageSafely(async (seq, n) => { asked.push(n); if (n > 200) throw timeout(); return ['row']; }, 7, 1000);
  assert.deepEqual(asked, [1000, 500, 250, 125]);
  assert.equal(out.size, 125);                                     // kept for the rest of the sync
  await assert.rejects(getPageSafely(async () => { throw timeout(); }, 0, 1000), { code: 'timeout' });      // gives up at 50
  await assert.rejects(getPageSafely(async () => { throw Object.assign(new Error('x'), { code: 'network' }); }, 0, 1000), { code: 'network' });     // other errors are not retried
});

test('a push batch that times out is sent in halves, down to 50 rows, and a timeout at the bottom is thrown', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ store: 'cards', id: 'c' + i, data: { id: 'c' + i }, deleted: false, updated_at: 1 }));
  const sizes = [];
  const out = await pushSafely(async part => { sizes.push(part.length); if (part.length > 100) throw Object.assign(new Error('slow'), { code: 'timeout' }); }, rows);
  assert.equal(out.sent.length, 400);
  assert.deepEqual(sizes.slice(0, 3), [400, 200, 100]);
  await assert.rejects(pushSafely(async () => { throw Object.assign(new Error('slow'), { code: 'timeout' }); }, rows), { code: 'timeout' });
});

test('overlap: a page that was asked for again half as big and came back full is a full page, not a short one', async () => {
  const timeout = () => Object.assign(new Error('slow'), { code: 'timeout' });
  const rowsOf = (from, n) => Array.from({ length: n }, (_, i) => ({ seq: from + i + 1 }));
  const get = async (seq, n) => { if (n > 200) throw timeout(); return rowsOf(seq, n); };
  const server = { top: 5000 };
  let st = startPull({ lastSeq: 0 }, T0), from = pullStart(st), size = PAGE, pages = 0, short = false;
  const t0 = T0, from0 = from;
  for (;;) {
    const page = await getPageSafely((seq, n) => get(seq, Math.min(n, server.top - seq)), from, size);
    assert.ok(page.at > 0);
    size = page.size;
    if (page.rows.length) from = page.rows.at(-1).seq;
    const reach = page.rows.length < size ? Infinity : from;
    if (page.rows.length === size) assert.notEqual(reach, Infinity);        // 200 rows when 200 were asked for: more to come
    else short = true;
    st = { ...st, lastSeq: from, seqLog: logPull(st.seqLog, { t: page.at, seq: from, from, to: from, n: page.rows.length }, { t0, from: from0, reach }) };
    if (page.rows.length < size || ++pages > 50) break;
  }
  assert.equal(size, 125);
  assert.equal(from, 5000); assert.ok(short && pages >= 20);
});

// ---------- the pull loop asks for the next page while the last one is being saved ----------
// A server whose answers and saves take (fake) time, so the order of events can be checked. Every event is written to `events`.
function pipeServer(total, { saveFails = null, size = PAGE, halveAt = null } = {}) {
  const server = fakeServer(); server.add(total);
  const events = [], clock = { now: T0 };
  let n = 0;
  const get = async (after, want) => {
    const at = clock.now; clock.now += 1000; n++;
    const mine = n;
    events.push(`ask ${after}`);
    await new Promise(r => setTimeout(r, 2));                         // the network
    if (halveAt === mine) want = want >> 1;                          // like getPageSafely after a timeout
    const rows = server.read(after, want);
    events.push(`got ${rows.length}`);
    return { rows, size: want, at };
  };
  const apply = async rows => {
    events.push(`save ${rows.length}`);
    await new Promise(r => setTimeout(r, 8));                         // the database
    if (saveFails === events.filter(e => e.startsWith('save')).length) throw new Error('disk full');
  };
  const saved = [];
  const save = async st => { saved.push(st.lastSeq); events.push(`mark ${st.lastSeq}`); };
  return { server, events, clock, get, apply, save, saved, size };
}

test('pull: the next request is sent when a page arrives, while it is saved; each asks after the page before it', async () => {
  const p = pipeServer(3500);
  const { st, pages } = await pullPages(startPull({ lastSeq: 0 }, T0), 0, PAGE, { get: p.get, apply: p.apply, save: p.save, now: () => p.clock.now });
  assert.equal(pages, 4);
  assert.deepEqual(p.events.filter(e => e.startsWith('ask')), ['ask 0', 'ask 1000', 'ask 2000', 'ask 3000'], 'one request per page, each after the highest number of the page before');
  const at = k => p.events.indexOf(k);
  assert.ok(at('ask 1000') < at('save 1000'), 'page 2 is asked for before page 1 is saved');
  assert.ok(at('ask 1000') > at('got 1000'), '...but only after page 1 has arrived');
  assert.ok(at('mark 1000') < at('mark 2000') && at('save 1000') < at('mark 1000'), 'a page is marked only after it is saved, in order');
  assert.deepEqual(p.saved, [1000, 2000, 3000, 3500]);
  assert.equal(st.lastSeq, 3500);
  assert.equal(p.events.filter(e => e.startsWith('ask')).length, 4, 'no request after the short page');
});

test('pull: the same state at the end as asking one page at a time (log, bookmark, ok marks)', async () => {
  for (const total of [0, 1, 999, 1000, 1001, 2500, 5000]) {
    const a = fakeServer(), b = pipeServer(total), clock = { now: T0 };
    a.add(total);
    const expected = pull(a, { lastSeq: 0 }, clock);
    const { st } = await pullPages(startPull({ lastSeq: 0 }, T0), 0, PAGE, { get: b.get, apply: b.apply, save: b.save, now: () => b.clock.now });
    assert.deepEqual(st, expected, 'total ' + total);
  }
});

test('pull: a page that fails to save is not marked, nor is the page asked for meanwhile; the next pull starts at the old bookmark', async () => {
  const p = pipeServer(3500, { saveFails: 2 });
  await assert.rejects(pullPages(startPull({ lastSeq: 0 }, T0), 0, PAGE, { get: p.get, apply: p.apply, save: p.save, now: () => p.clock.now }), /disk full/);
  assert.deepEqual(p.saved, [1000], 'only page 1 was marked');
  await new Promise(r => setTimeout(r, 30));                         // the request that was already on its way ends quietly
  assert.equal(p.saved.length, 1);
});

test('pull: a request that fails while the page before is still being saved is reported after that page is marked', async () => {
  const p = pipeServer(3500);
  let calls = 0;
  const get = async (after, n) => { if (++calls === 2) { await new Promise(r => setTimeout(r, 1)); throw Object.assign(new Error('offline'), { code: 'network' }); } return p.get(after, n); };
  await assert.rejects(pullPages(startPull({ lastSeq: 0 }, T0), 0, PAGE, { get, apply: p.apply, save: p.save, now: () => p.clock.now }), /offline/);
  assert.deepEqual(p.saved, [1000], 'page 1 is kept: the bookmark is saved with it');
});

test('pull: after a request had to be made smaller, the next ones are too, and a short page is judged by its own size', async () => {
  const p = pipeServer(2400, { halveAt: 2 });                         // the second request times out and is sent again at half the size
  const asked = [];
  const get = (after, n) => { asked.push([after, n]); return p.get(after, n); };
  const { st, pages } = await pullPages(startPull({ lastSeq: 0 }, T0), 0, PAGE, { get, apply: p.apply, save: p.save, now: () => p.clock.now });
  assert.deepEqual(asked.slice(0, 3), [[0, 1000], [1000, 1000], [1500, 500]], 'a half page counts as full for its own size, and the size stays smaller');
  assert.equal(st.lastSeq, 2400);
  assert.ok(pages >= 4);
});

test('pull: from an existing log with older, not yet settled entries, the end state is the same as one page at a time', async () => {
  for (const total of [1500, 3200]) {
    const a = fakeServer(), b = pipeServer(total), clock = { now: T0 };
    a.add(total);
    // a first pull, then a cut-off one, leaving a log with entries that are not ok yet, then more rows arrive
    let st0 = pull(a, { lastSeq: 0 }, clock, new Set(), { maxPages: 1 });
    clock.now += 5_000;
    st0 = pull(a, st0, clock, new Set(), { maxPages: 1 });
    assert.ok(st0.seqLog.some(e => !e.ok), 'set up: the log holds entries that are not settled');
    clock.now += 10_000;
    b.clock.now = clock.now;
    const expected = pull(a, st0, clock);
    const start = startPull(st0, b.clock.now);
    const { st } = await pullPages(start, pullStart(start), PAGE, { get: b.get, apply: b.apply, save: b.save, now: () => b.clock.now });
    assert.deepEqual(st, expected, 'total ' + total);
  }
});
