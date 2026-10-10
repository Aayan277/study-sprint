// Tests for js/sync-data.js (sync groundwork). Run with: node tests/sync.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp, tombstone, tombstoneKey, upgradeRecord, SYNC_ID, SYNCED_SETTINGS } from '../js/sync-data.js';

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
