// Tests for the pure parts of js/leech-coach.js. Run with: node tests/leech-coach.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBack, splitCards, unleeched } from '../js/leech-logic.js';

test('splitBack: on ; line breaks and bullets, always 2 to 4 pieces', () => {
  assert.deepEqual(splitBack('red; green; blue'), ['red', 'green', 'blue']);
  assert.deepEqual(splitBack('• one\n• two\n- three'), ['one', 'two', 'three']);
  assert.deepEqual(splitBack('1. a\n2) b'), ['a', 'b']);
  assert.deepEqual(splitBack('just one'), ['just one', '']);
  assert.deepEqual(splitBack(''), ['', '']);
  assert.deepEqual(splitBack('a;b;c;d;e;f'), ['a', 'b', 'c', 'd; e; f']);
  assert.deepEqual(splitBack('well-known; a-b'), ['well-known', 'a-b']);
});

test('splitCards: same deck, tags without leech, blank rows skipped', () => {
  let n = 0;
  const card = { id: 'x', deckId: 'd1', front: 'Q', back: 'a; b', tags: ['leech', 'bio'] };
  const out = splitCards(card, [{ front: 'Q', back: 'a' }, { front: 'Q', back: ' ' }, { front: 'Q2', back: 'b' }], { newId: () => 'n' + n++, now: 100 });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(c => [c.id, c.deckId, c.front, c.back, c.tags]), [['n0', 'd1', 'Q', 'a', ['bio']], ['n1', 'd1', 'Q2', 'b', ['bio']]]);
});

test('unleeched: unsuspended, tag removed, the rest untouched', () => {
  const c = { id: 'x', suspended: true, tags: ['leech', 'bio'], noteExtra: 'h' };
  assert.deepEqual(unleeched(c), { id: 'x', suspended: false, tags: ['bio'], noteExtra: 'h' });
});
