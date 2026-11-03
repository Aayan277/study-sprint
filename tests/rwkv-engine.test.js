import './rwkv-utc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseWeights } from '../js/rwkv-weights.js';
import { Engine } from '../js/rwkv-engine.js';
import { modelRows } from '../js/rwkv-features.js';
import { fakeWeights } from './rwkv-fake-weights.mjs';

const tensors = parseWeights(fakeWeights({ seed: 12, format: 'int8' }).buffer).tensors;
const g = JSON.parse(fs.readFileSync(new URL('./fixtures/rwkv/golden.json', import.meta.url), 'utf8'));
const rows = modelRows(g.logs, g.cards, g.decks).slice(0, 120);

const hex = buf => (buf instanceof ArrayBuffer ? Buffer.from(buf) : Buffer.from(JSON.stringify(buf, (k, v) => (v instanceof Float32Array ? Array.from(v) : v)))).toString('hex');
// everything an engine remembers, as one comparable string
function dump(e) {
  const part = m => [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '=' + hex(v)).join(';');
  return [part(e.cards), part(e.notes), part(e.shared), part(e.curves), JSON.stringify(e.builder)].join('\n');
}
const replayAll = (e, rs) => { for (const _ of e.replay(rs)) { /* run to the end */ } };

for (const stateBits of [8, 0]) {
  test(`replaying everything equals replaying half and then answering one by one (stateBits ${stateBits})`, () => {
    const a = new Engine(tensors, { stateBits });
    replayAll(a, rows);
    const b = new Engine(tensors, { stateBits });
    replayAll(b, rows.slice(0, 60));
    const live = rows.slice(60).map(r => b.review(r));
    assert.equal(dump(a), dump(b));
    // and the predictions agree
    const predsB = Object.fromEntries(rows.slice(60).map((r, i) => [r.logId, { pCurve: live[i].pCurve, pImm: live[i].pImm, elapsedDays: live[i].elapsedDays }]));
    for (const [id, p] of Object.entries(predsB)) assert.deepEqual(a.preds[id], p, 'log ' + id);
  });
}

test('replay reports progress and gives a prediction for every row but never a first review\'s', () => {
  const many = Array.from({ length: 501 }, (_, i) => ({ ...rows[i % 100], cardKey: 'c:x' + i, noteKey: 'c:x' + i, logId: 5000 + i, t: rows[0].t + i * 60000, day: rows[0].day }));
  assert.deepEqual([...new Engine(tensors).replay(many)], [{ done: 500, total: 501 }, { done: 501, total: 501 }]);
  const e = new Engine(tensors);
  assert.deepEqual([...e.replay(rows)], [{ done: rows.length, total: rows.length }]);
  const first = rows.find(r => !rows.some(o => o.cardKey === r.cardKey && o.t < r.t));
  assert.equal(e.preds[first.logId].pImm, null);
  assert.equal(e.preds[first.logId].elapsedDays, -1);
  const later = rows[rows.length - 1];
  assert.ok(e.preds[later.logId].pImm > 0 && e.preds[later.logId].pImm < 1);
});

test('undo puts back exactly the same bytes (a card seen before, and a brand-new card)', () => {
  const e = new Engine(tensors);
  replayAll(e, rows.slice(0, 100));
  const before = dump(e);
  const seen = e.review(rows[100]);
  assert.notEqual(dump(e), before);
  assert.equal(e.undo(rows[100].logId), true);
  assert.equal(dump(e), before);
  const fresh = { ...rows[0], cardKey: 'c:brand-new', noteKey: 'c:brand-new', logId: 9001, t: rows[99].t + 1000, day: rows[99].day };
  e.review(fresh);
  assert.ok(e.cards.has('c:brand-new'));
  assert.equal(e.undo(9001), true);
  assert.equal(dump(e), before);
  assert.ok(!e.cards.has('c:brand-new') && !e.curves.has('c:brand-new'));
  assert.equal(e.undo(123456), false);
  assert.ok(seen.token);
});

test('only the newest answer can be undone, and only the last 50 are kept', () => {
  const e = new Engine(tensors);
  replayAll(e, rows.slice(0, 20));
  e.review(rows[20]); e.review(rows[21]);
  assert.equal(e.undo(rows[20].logId), false);
  assert.equal(e.undo(rows[21].logId), true);
  assert.equal(e.undo(rows[20].logId), true);
  const f = new Engine(tensors);
  for (const r of rows.slice(0, 60)) f.review(r);
  assert.equal(f.undos.length, 50);
});

test('what-if gives four curves and changes nothing', () => {
  const e = new Engine(tensors);
  replayAll(e, rows);
  e.snapshotDirty();
  const before = dump(e), last = rows[rows.length - 1];
  const now = { ...last, t: last.t + 3 * 86400000, day: last.day + 3 };
  const w = e.whatIf(now, 6000);
  assert.deepEqual(Object.keys(w), ['1', '2', '3', '4']);
  for (const k of [1, 2, 3, 4]) assert.ok([...w[k].w, ...w[k].s, ...w[k].d].every(Number.isFinite));
  assert.notDeepEqual(w[1].w, w[4].w);                           // the answer matters
  assert.equal(dump(e), before);
  assert.equal(e.snapshotDirty().cards.length, 0);
  assert.deepEqual(e.whatIf(now, 6000), w);                       // repeatable
});

test('snapshotDirty lists what changed since the last call, and what was removed', () => {
  const e = new Engine(tensors);
  e.review(rows[0]);
  const s = e.snapshotDirty();
  assert.equal(s.cards.length, 1);
  assert.equal(s.cards[0][0], rows[0].cardKey);
  assert.equal(s.cards[0][2].length, 9);
  assert.ok(s.shared.length >= 3);
  assert.equal(e.snapshotDirty().cards.length, 0);
  e.undo(rows[0].logId);
  assert.deepEqual(e.snapshotDirty().removed.cards, [rows[0].cardKey]);
});

test('int8 card and note states are small', () => {
  const e = new Engine(tensors);
  replayAll(e, rows);
  const [k, v] = [...e.cards][0];
  assert.equal(v.byteLength, 2944);
  assert.equal([...e.notes.values()][0].byteLength, 1536);
  assert.ok(k.startsWith('c:'));
});

test('output numbers that are not real numbers give no answer, so FSRS takes over', () => {
  // a broken model: the curve layer's biases are not numbers (a damaged or runaway file), so every output is NaN
  const huge = parseWeights(fakeWeights({ seed: 3, format: 'f32', mutate: list => { for (const t of list) if (/^head_[wsd]\.4\.bias$/.test(t.name)) t.data.fill(NaN); } }).buffer).tensors;
  const e = new Engine(huge);
  replayAll(e, rows.slice(0, 40));
  const last = rows[39];
  const now = { ...last, t: last.t + 3 * 86400000, day: last.day + 3 };
  assert.equal(e.whatIf(now, 6000), null);
  const r = e.review({ ...now, logId: 99999 });
  assert.ok(r.pCurve === null || Number.isFinite(r.pCurve));
  assert.ok(r.pImm === null || Number.isFinite(r.pImm));
});

test('a replay forgets the undo list, and undoing a review restores the builder day counts', () => {
  const e = new Engine(tensors);
  e.review(rows[0]);
  for (const _ of e.replay(rows.slice(0, 5))) { /* run */ }
  assert.equal(e.undos.length, 0);
  const b = new Engine(tensors);
  b.review(rows[0]);
  const before = JSON.stringify(b.builder);
  const token = b.builder.commit(rows[1]);
  b.builder.today.reviews += 5;                                   // must not leak into the saved copy
  b.builder.undo(token);
  assert.equal(JSON.stringify(b.builder), before);
});
