// Tests for js/import-draft.js. Run with: node tests/import-draft.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.sessionStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const { keepDraft, takeDraft, clearDraft } = await import('../js/import-draft.js');

test('the draft keeps the text with how it is read', () => {
  keepDraft({ text: 'Page 1\nText', blocks: true, aiMade: false, noCloze: true });
  assert.deepEqual(takeDraft(), { text: 'Page 1\nText', blocks: true, aiMade: false, noCloze: true, suggest: false, sug: null });
  keepDraft({ text: 'a | b', aiMade: true });
  assert.deepEqual(takeDraft(), { text: 'a | b', blocks: false, aiMade: true, noCloze: false, suggest: false, sug: null });
});
test('empty text, null and clearDraft remove it', () => {
  keepDraft({ text: 'x' }); keepDraft({ text: '   ' });
  assert.equal(takeDraft(), null);
  keepDraft({ text: 'x' }); keepDraft(null);
  assert.equal(takeDraft(), null);
  keepDraft({ text: 'x' }); clearDraft();
  assert.equal(takeDraft(), null);
});
test('a draft kept by an older version (plain text) still comes back', () => {
  store.set('study-sprint-import-draft', 'old text');
  assert.deepEqual(takeDraft(), { text: 'old text', blocks: false, aiMade: false, noCloze: false, suggest: false, sug: null });
});
test('suggest mode and the changes made to the suggestions come back', () => {
  const sug = { 'definition|osmosis|': { pick: false }, 'fact||x': { front: 'Edited', back: 'b', cloze: 'a {{c1::b}}' } };
  keepDraft({ text: 'Some notes.', suggest: true, sug });
  assert.deepEqual(takeDraft(), { text: 'Some notes.', blocks: false, aiMade: false, noCloze: false, suggest: true, sug });
  keepDraft({ text: 'Some notes.', suggest: true });
  assert.deepEqual(takeDraft(), { text: 'Some notes.', blocks: false, aiMade: false, noCloze: false, suggest: true, sug: null });
  keepDraft({ text: 'Some notes.', suggest: false, sug });
  assert.equal(takeDraft().sug, null, 'changes are only kept in suggest mode');
  keepDraft({ text: 'x', suggest: true, sug: ['not', 'an', 'object'] });
  assert.equal(takeDraft().sug, null);
});
test('a draft kept before suggest mode existed comes back as an ordinary draft', () => {
  store.set('study-sprint-import-draft', JSON.stringify({ text: 'kept', blocks: true, aiMade: false, noCloze: false }));
  assert.deepEqual(takeDraft(), { text: 'kept', blocks: true, aiMade: false, noCloze: false, suggest: false, sug: null });
});
