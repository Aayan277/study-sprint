import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness } from '../js/rwkv-fresh.js';

const state = { modelSha: 'abc', stateFormat: 's8-v1', featureVersion: 1, rows: 10, lastTs: 1000, lastLogId: 7, totalLogRows: 12, idSum: 100, rebuilding: false };
const now = (over = {}) => ({ sha: 'abc', stateFormat: 's8-v1', featureVersion: 1, count: 12, idSum: 100, newRows: [{ id: 7, timestamp: 1000 }], ...over });
const row = (id, timestamp) => ({ id, timestamp });

test('nothing built yet', () => {
  assert.equal(freshness(null, now()).status, 'none');
  assert.equal(freshness({}, now()).status, 'none');
});

test('fresh: nothing new, the last handled row may be read again', () => {
  assert.equal(freshness(state, now()).status, 'fresh');
  assert.equal(freshness(state, now({ newRows: [] })).status, 'fresh');
});

test('catching up: only newer answers were added, in time order', () => {
  const r = freshness(state, now({ count: 14, idSum: 117, newRows: [row(7, 1000), row(9, 2000), row(8, 1500)] }));
  assert.equal(r.status, 'catching-up');
  assert.deepEqual(r.rows.map(x => x.id), [8, 9]);
  // same time as the bookmark but a higher id also counts as new
  assert.equal(freshness(state, now({ count: 13, idSum: 108, newRows: [row(7, 1000), row(8, 1000)] })).status, 'catching-up');
});

test('stale: a deleted row, an old row added (import), or a count that does not add up', () => {
  assert.deepEqual(freshness(state, now({ count: 11 })), { status: 'stale', reason: 'changed' });
  assert.equal(freshness(state, now({ count: 13, newRows: [] })).status, 'stale');                 // one added in the past
  assert.equal(freshness(state, now({ count: 13, newRows: [row(8, 2000), row(9, 2100)] })).status, 'stale');
  assert.equal(freshness(state, now({ count: 12, newRows: [row(8, 2000)] })).status, 'stale');    // one added, one deleted
  // the count is right but the rows are not: one deleted and one added (what a deleted card plus a new answer looks like)
  assert.equal(freshness(state, now({ count: 13, idSum: 105, newRows: [row(7, 1000), row(13, 2000)] })).status, 'stale');
  assert.equal(freshness(state, now({ idSum: 99 })).reason, 'changed');                                // same count, a row swapped for another
});

test('stale: a state saved before the lab kept the row ids', () => {
  const { idSum, ...old } = state;
  assert.deepEqual(freshness(old, now()), { status: 'stale', reason: 'format' });
});

test('stale: an interrupted rebuild, another model, another format or feature version', () => {
  assert.deepEqual(freshness({ ...state, rebuilding: true }, now()), { status: 'stale', reason: 'interrupted' });
  assert.equal(freshness(state, now({ sha: 'other' })).reason, 'model');
  assert.equal(freshness(state, now({ stateFormat: 's8-v2' })).reason, 'format');
  assert.equal(freshness(state, now({ featureVersion: 2 })).reason, 'format');
});
