// Tests for js/sync-data.js and js/sync-merge.js (syncing between devices). Run with: node tests/sync.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp, tombstone, tombstoneKey, upgradeRecord, acceptSetting, SYNC_ID, SYNCED_SETTINGS, MERGED_SETTINGS } from '../js/sync-data.js';
import { mergeDayFlags, sameDayFlags, mergeIdleDays, sameIdleDays, rowFromRecord, rowFromTombstone, rowFromSetting, recordFromRow, decide, needsPush, tombstoneNeedsPush, newestOnly, chunks, parseAuthLink } from '../js/sync-merge.js';
import { DEFAULT_SETTINGS } from '../js/db.js';
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
