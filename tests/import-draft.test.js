// Tests for js/import-draft.js. Run with: node tests/import-draft.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.sessionStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const { keepDraft, takeDraft, clearDraft } = await import('../js/import-draft.js');

test('the draft keeps the text with how it is read', () => {
  keepDraft({ text: 'Page 1\nText', blocks: true, aiMade: false, noCloze: true });
  assert.deepEqual(takeDraft(), { text: 'Page 1\nText', blocks: true, aiMade: false, noCloze: true });
  keepDraft({ text: 'a | b', aiMade: true });
  assert.deepEqual(takeDraft(), { text: 'a | b', blocks: false, aiMade: true, noCloze: false });
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
  assert.deepEqual(takeDraft(), { text: 'old text', blocks: false, aiMade: false, noCloze: false });
});
