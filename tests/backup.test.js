// Tests for backup checks (js/db.js) and the starter decks (js/jlpt.js). Run with: node tests/backup.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBackup, BACKUP_FORMAT, BACKUP_VERSION } from '../js/db.js';
import { STARTER_DECKS, starterCards } from '../js/jlpt.js';
import { checkAnswer, canType } from '../js/match.js';

const good = { format: BACKUP_FORMAT, version: BACKUP_VERSION, decks: [], cards: [], cardStates: [], reviewLog: [], settings: {} };

test('a real backup passes the check', () => {
  assert.equal(checkBackup(good), null);
});

test('other files are refused with a clear message', () => {
  assert.match(checkBackup(null), /isn't a Study Sprint backup/);
  assert.match(checkBackup({ hello: 1 }), /isn't a Study Sprint backup/);
  assert.match(checkBackup([1, 2]), /isn't a Study Sprint backup/);
  assert.match(checkBackup({ ...good, version: BACKUP_VERSION + 1 }), /newer version/);
  assert.match(checkBackup({ ...good, cards: undefined }), /damaged \(missing cards\)/);
});

test('starter decks: 102 N5 and 180 N4 kanji', () => {
  assert.deepEqual(STARTER_DECKS.map(d => starterCards(d.level).length), [102, 180]);
  const all = STARTER_DECKS.flatMap(d => starterCards(d.level));
  assert.ok(all.every(c => c.front && c.back && c.tags.length === 2), 'every card has a front, back and tags');
  assert.equal(new Set(all.map(c => c.front)).size, all.length, 'no kanji appears twice');
});

test('starter cards: typing a meaning or a reading counts as right', () => {
  const one = starterCards('N5')[0];
  assert.deepEqual(one, { front: '一', back: 'one; いち / ひと(つ)', tags: ['N5', 'numbers & time'] });
  assert.ok(checkAnswer('one', one.back).correct);
  assert.ok(checkAnswer('いち', one.back).correct);
  assert.ok(checkAnswer('ひとつ', one.back).correct);
  assert.ok(checkAnswer('ひと', one.back).correct);
  assert.equal(checkAnswer('two', one.back).correct, false);
  // Most backs are short enough to type (40 characters or less).
  const typeable = STARTER_DECKS.flatMap(d => starterCards(d.level)).filter(c => canType(c.back)).length;
  assert.ok(typeable > 270, `${typeable} of 282 typeable`);
});
