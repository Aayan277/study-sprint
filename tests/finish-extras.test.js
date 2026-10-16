import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawFinishExtras, pairsHTML, MAX_PAIRS } from '../js/finish-extras.js';

test('ids of cards deleted mid-session do not break the finish screen', () => {
  const slot = { innerHTML: 'old', hidden: false };
  drawFinishExtras(slot, { source: 'review', cardIds: ['gone-1', 'gone-2'], leechIds: ['gone-3'], entries: [{ cardId: 'gone-1' }] });
  assert.equal(slot.hidden, true);
  assert.equal(slot.innerHTML, '');
});
test('no slot is fine', () => {
  assert.doesNotThrow(() => drawFinishExtras(null, { source: 'play' }));
});

test('pairsHTML: up to 3 pairs, a deleted card leaves its pair out, text is escaped', () => {
  const cards = new Map(['a', 'b', 'c', 'd', 'e'].map(id => [id, { id, front: id === 'a' ? '<b>A</b>' : id.toUpperCase() }]));
  const pair = (a, b, count) => ({ key: `${a}|${b}`, a, b, count, last: 1 });
  const html = pairsHTML([pair('a', 'b', 5), pair('b', 'c', 4), pair('c', 'z', 3), pair('c', 'd', 3), pair('d', 'e', 2), pair('a', 'e', 2)], cards);
  assert.equal(MAX_PAIRS, 3);
  assert.match(html, /You mix these up/);
  assert.equal(html.match(/class="mix-row"/g).length, 3);
  assert.ok(!html.includes('"z"') && !html.includes('<b>A</b>'));
  assert.match(html, /&lt;b&gt;A&lt;\/b&gt;/);
  assert.match(html, /data-mix-a="c" data-mix-b="d"/);
  assert.equal(pairsHTML([pair('x', 'y', 4)], cards), '');
  assert.equal(pairsHTML([], cards), '');
});
