import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawFinishExtras } from '../js/finish-extras.js';

test('ids of cards deleted mid-session do not break the finish screen', () => {
  const slot = { innerHTML: 'old', hidden: false };
  drawFinishExtras(slot, { source: 'review', cardIds: ['gone-1', 'gone-2'], leechIds: ['gone-3'], entries: [{ cardId: 'gone-1' }] });
  assert.equal(slot.hidden, true);
  assert.equal(slot.innerHTML, '');
});
test('no slot is fine', () => {
  assert.doesNotThrow(() => drawFinishExtras(null, { source: 'play' }));
});
