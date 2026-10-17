// Tests for which pictures and sounds a card uses (usedMediaIds in js/db.js, which cleanMedia relies on).
// Run with: node tests/media-clean.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usedMediaIds } from '../js/db.js';

test('pictures and sounds on either side count as used', () => {
  const used = usedMediaIds([
    { id: '1', frontImage: 'pf', backImage: 'pb' },
    { id: '2', frontSounds: ['s1', 's2'], backSounds: ['s3'] },
    { id: '3' }
  ]);
  assert.deepEqual([...used].sort(), ['pb', 'pf', 's1', 's2', 's3']);
});

test('cloze siblings share sounds: they stay while any card uses them', () => {
  const sibs = [1, 2, 3].map(n => ({ id: 'k' + n, noteId: 'N', cloze: n, frontSounds: ['shared'] }));
  assert.ok(usedMediaIds(sibs).has('shared'));
  assert.ok(usedMediaIds(sibs.slice(2)).has('shared'));            // two siblings were deleted: one still uses it
  assert.ok(!usedMediaIds([]).has('shared'));
});

test('junk in the sound fields is ignored', () => {
  assert.deepEqual([...usedMediaIds([{ id: 'x', frontSounds: 'abc', backSounds: null, frontImage: '' }])], []);
  assert.deepEqual([...usedMediaIds([])], []);
});
