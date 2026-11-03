import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness, rowHash } from '../js/rwkv-fresh.js';

const row = (id, timestamp) => ({ id, timestamp });
const sumOf = rows => rows.reduce((a, r) => (a + rowHash(r.id, r.timestamp)) >>> 0, 0);
// the lab has been told about rows 1..10 (time = id * 100), and row 7 is the newest
const told = Array.from({ length: 10 }, (_, i) => row(i + 1, (i + 1) * 100));
const state = { modelSha: 'abc', stateFormat: 's8-v1', featureVersion: 1, rows: 10, lastTs: 1000, lastLogId: 10, totalLogRows: 10, hash: sumOf(told), rebuilding: false };
const now = (over = {}) => ({ sha: 'abc', stateFormat: 's8-v1', featureVersion: 1, count: 10, hash: sumOf(told), newRows: [row(10, 1000)], ...over });
const hashPlus = (...rows) => sumOf([...told, ...rows]);

test('rowHash: the same row gives the same number, a different id or time gives another', () => {
  assert.equal(rowHash(5, 1700000000000), rowHash(5, 1700000000000));
  assert.notEqual(rowHash(5, 1700000000000), rowHash(6, 1700000000000));
  assert.notEqual(rowHash(5, 1700000000000), rowHash(5, 1700000000001));
  assert.ok(Number.isInteger(rowHash(1, 1)) && rowHash(1, 1) >= 0 && rowHash(1, 1) < 2 ** 32);
});

test('nothing built yet', () => {
  assert.equal(freshness(null, now()).status, 'none');
  assert.equal(freshness({}, now()).status, 'none');
});

test('fresh: nothing new, the last handled row may be read again', () => {
  assert.equal(freshness(state, now()).status, 'fresh');
  assert.equal(freshness(state, now({ newRows: [] })).status, 'fresh');
});

test('catching up: only newer answers were added, in time order', () => {
  const r = freshness(state, now({ count: 12, hash: hashPlus(row(12, 2000), row(11, 1500)), newRows: [row(10, 1000), row(12, 2000), row(11, 1500)] }));
  assert.equal(r.status, 'catching-up');
  assert.deepEqual(r.rows.map(x => x.id), [11, 12]);
  // same time as the bookmark but a higher id also counts as new
  assert.equal(freshness(state, now({ count: 11, hash: hashPlus(row(11, 1000)), newRows: [row(10, 1000), row(11, 1000)] })).status, 'catching-up');
});

test('stale: a deleted row, an old row added (import), or a count that does not add up', () => {
  assert.deepEqual(freshness(state, now({ count: 9, hash: sumOf(told.slice(1)) })), { status: 'stale', reason: 'changed' });
  assert.equal(freshness(state, now({ count: 11, hash: hashPlus(row(11, 50)), newRows: [] })).status, 'stale');                 // one added in the past
  assert.equal(freshness(state, now({ count: 12, hash: hashPlus(row(11, 2000), row(12, 2100)), newRows: [row(11, 2000), row(12, 2100)] })).status, 'catching-up');
  assert.equal(freshness(state, now({ count: 10, hash: hashPlus(row(11, 2000)), newRows: [row(11, 2000)] })).status, 'stale');   // one added, one deleted
  // the count is right but the rows are not: one deleted and one added (a deleted card plus a new answer)
  assert.equal(freshness(state, now({ count: 11, hash: sumOf([...told.slice(1), row(11, 2000), row(12, 2100)]), newRows: [row(10, 1000), row(12, 2100)] })).status, 'stale');
  assert.equal(freshness(state, now({ hash: (state.hash + 1) >>> 0 })).reason, 'changed');                                       // same count, a row swapped
});

test('stale: a backup restore from another device, whose ids repeat but whose times differ', () => {
  // the lab was told about ids 1..100 (time = id) and then 101@2000, 102@2001; the restored log has other rows under ids 101 and 102
  const base = Array.from({ length: 100 }, (_, i) => row(i + 1, i + 1));
  const lab = { modelSha: 's', stateFormat: 'f', featureVersion: 1, rows: 102, totalLogRows: 102, lastTs: 2001, lastLogId: 102, hash: sumOf([...base, row(101, 2000), row(102, 2001)]) };
  const env = over => ({ sha: 's', stateFormat: 'f', featureVersion: 1, ...over });
  // the phone had two earlier answers (101@1500, 102@1600) and one later (103@2500): count and the id range look like "one new row"
  const later = [...base, row(101, 1500), row(102, 1600), row(103, 2500)];
  assert.equal(freshness(lab, env({ count: 103, hash: sumOf(later), newRows: [row(103, 2500)] })).status, 'stale');
  // the phone had exactly two other answers under the same ids: same count, same id sum, but not the same rows
  const same = [...base, row(101, 1500), row(102, 1600)];
  assert.equal(freshness(lab, env({ count: 102, hash: sumOf(same), newRows: [] })).status, 'stale');
  // while the real log, as the lab knows it, is fresh
  assert.equal(freshness(lab, env({ count: 102, hash: lab.hash, newRows: [row(102, 2001)] })).status, 'fresh');
});

test('stale: an interrupted rebuild, another model, another format or feature version', () => {
  assert.deepEqual(freshness({ ...state, rebuilding: true }, now()), { status: 'stale', reason: 'interrupted' });
  assert.equal(freshness(state, now({ sha: 'other' })).reason, 'model');
  assert.equal(freshness(state, now({ stateFormat: 's8-v2' })).reason, 'format');
  assert.equal(freshness(state, now({ featureVersion: 2 })).reason, 'format');
});

test('stale: a state saved before the lab hashed the rows', () => {
  const { hash, ...old } = state;
  assert.deepEqual(freshness({ ...old, idSum: 55 }, now()), { status: 'stale', reason: 'format' });
});
