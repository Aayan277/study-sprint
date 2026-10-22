// Run with: node --test tests/nav.test.js
// The pure helpers behind js/nav.js (the history rules are exercised in a real browser by tests/browser/e2e-nav.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeName, isTabRoot, readEntry, makeEntry, isStale, popsFor } from '../js/nav.js';

test('routeName reads the screen from the address', () => {
  assert.equal(routeName('#/deck/abc'), 'deck');
  assert.equal(routeName('#/review'), 'review');
  assert.equal(routeName(''), 'today');
  assert.equal(routeName(undefined), 'today');
});

test('only the five bottom-tab destinations are tab roots', () => {
  for (const h of ['#/today', '#/decks', '#/play', '#/stats', '#/settings', '#/today/', '']) assert.ok(isTabRoot(h), h);
  // drill-downs, sessions and sub-views push one entry
  for (const h of ['#/deck/x', '#/browse', '#/browse/leech', '#/import', '#/import/x', '#/review', '#/review/x', '#/welcome', '#/welcome/review/sample']) assert.ok(!isTabRoot(h), h);
});

test('history.state is read back only when the app made it', () => {
  assert.equal(readEntry(null), null);
  assert.equal(readEntry({}), null);
  assert.equal(readEntry({ ss: 'x' }), null);
  assert.deepEqual(readEntry(makeEntry(2, 'ov', 7, '#/decks')), { depth: 2, kind: 'ov', id: 7, from: '#/decks' });
  assert.deepEqual(readEntry(makeEntry(0)), { depth: 0, kind: 'page', id: 0, from: '' });
  assert.equal(readEntry({ ss: 1, k: 'weird' }).kind, 'page');
});

test('an overlay entry is stale once its owner is gone', () => {
  const live = new Set([3]);
  assert.equal(isStale(readEntry(makeEntry(1, 'ov', 3)), live), false);
  assert.equal(isStale(readEntry(makeEntry(1, 'ov', 4)), live), true);
  assert.equal(isStale(readEntry(makeEntry(1, 'page')), live), false);
  assert.equal(isStale(null, live), false);
});

test('popsFor counts the steps down to the first entry', () => {
  assert.equal(popsFor(0), 0);   // a tab to a tab: replace in place
  assert.equal(popsFor(2), 2);   // from two levels deep
  assert.equal(popsFor(-1), 0);
});
