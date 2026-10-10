// Tests for js/sync-data.js and js/sync-merge.js (syncing between devices). Run with: node tests/sync.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp, tombstone, tombstoneKey, upgradeRecord, SYNC_ID, SYNCED_SETTINGS } from '../js/sync-data.js';
import { rowFromRecord, rowFromTombstone, rowFromSetting, recordFromRow, decide, needsPush, tombstoneNeedsPush, newestOnly, chunks, parseAuthLink } from '../js/sync-merge.js';

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
  assert.equal(parseAuthLink('#error=server_error&error_description=Something+broke').error, 'Something broke');
  assert.equal(parseAuthLink('#/decks'), null);
  assert.equal(parseAuthLink(''), null);
  assert.equal(parseAuthLink('#access_token=abc&type=signup'), null);      // only reset links are handled
});
