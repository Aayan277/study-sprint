import './rwkv-utc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, headToCurve, curveToHead } from '../js/own-engine.js';
import { initParams } from '../js/own-model.js';
import { headFinite, pAt } from '../js/own-curve.js';
import { mulberry32 } from '../js/fsrs-fit.js';
import { miniRows, mk, T0, DAY } from './own-mini.mjs';

const params = () => { const p = initParams('s', 11), r = mulberry32(5); for (let i = 0; i < p.length; i++) p[i] += (r() - 0.5) * 0.3; return Float32Array.from(p); };
const run = (e, rows) => { for (const _ of e.replay(rows)) { /* drive the generator */ } return e; };
const bytes = e => JSON.stringify(e.toJSON());

test('replay-all equals replay-half then review (and a save/load in the middle)', () => {
  const rows = miniRows(), P = params();
  const full = run(new Engine(P), rows);
  const half = run(new Engine(P), rows.slice(0, 7));
  for (const r of rows.slice(7)) { const out = half.review(r, { keepToken: false }); half.preds[r.logId] = { pCurve: out.pCurve, pImm: null, elapsedDays: out.elapsedDays }; }
  assert.equal(bytes(half), bytes(full));
  assert.deepEqual(half.preds, full.preds);
  // save after the first half, load, carry on
  const mid = run(new Engine(P), rows.slice(0, 7));
  const loaded = Engine.fromJSON(JSON.parse(JSON.stringify(mid.toJSON())), P);
  for (const r of rows.slice(7)) loaded.review(r, { keepToken: false });
  assert.equal(bytes(loaded), bytes(full));
  assert.ok(Object.values(full.preds).some(p => p.pCurve !== null && p.pCurve > 0 && p.pCurve < 1));
});

test('first answers have no prediction; later ones do; score=false gives none', () => {
  const rows = miniRows(), e = new Engine(params());
  const r0 = e.review(rows[0]);
  assert.equal(r0.pCurve, null); assert.equal(r0.pImm, null); assert.equal(r0.elapsedDays, null);
  const r3 = e.review(rows[1]); assert.equal(r3.pCurve, null);                  // card 2's first answer
  const r4 = e.review(rows[3]);
  assert.ok(r4.pCurve > 0 && r4.pCurve < 1);
  assert.ok(Math.abs(r4.elapsedDays - 600 / 86400) < 1e-9);
  const q = new Engine(params()); q.review(rows[0], { score: false });
  assert.equal(q.review(rows[3], { score: false }).pCurve, null);
});

test('the prediction ignores the current rating, time taken and replay flag', () => {
  const rows = miniRows(), P = params(), probe = 10;
  const at = change => {
    const e = new Engine(P);
    for (const r of rows.slice(0, probe)) e.review(r);
    return e.review({ ...rows[probe], ...change }).pCurve;
  };
  const p = at({});
  for (const c of [{ rating: 1 }, { rating: 4 }, { ms: 10 }, { ms: 1e6 }, { kind: 'replay' }]) assert.equal(at(c), p);
  // but what follows does depend on it
  const after = rating => { const e = new Engine(P); for (const r of rows.slice(0, probe)) e.review(r); e.review({ ...rows[probe], rating }); return bytes(e); };
  assert.notEqual(after(1), after(4));
});

test('undo restores the exact bytes (state, curves, features), newest first', () => {
  const rows = miniRows(), e = new Engine(params());
  run(e, rows.slice(0, 8));
  const before = bytes(e);
  const r = e.review(rows[8]);
  assert.notEqual(bytes(e), before);
  assert.equal(e.undo(rows[7].logId), false);                                   // not the newest
  assert.equal(e.undo(r.token.logId), true);
  assert.equal(bytes(e), before);
  assert.equal(e.undo(r.token.logId), false);
  // a brand-new card, entity and day: undo removes them again
  const fresh = mk(99, 77, 5, T0 + 20 * DAY, 3);
  const empty = bytes(e);
  const t = e.review(fresh).token;
  assert.ok(e.hasCard('c:99'));
  assert.equal(e.undo(t.logId), true);
  assert.equal(bytes(e), empty);
  assert.equal(e.hasCard('c:99'), false);
  assert.equal(e.cards.has('c:99') || e.notes.has('n:77') || e.shared.has('d:5'), false);
  // undo marks what changed so a worker saves it
  e.snapshotDirty();
  const t2 = e.review(rows[8]).token; e.snapshotDirty();
  e.undo(t2.logId);
  const snap = e.snapshotDirty();
  assert.ok(snap.cards.length >= 1 && snap.shared.length >= 1);
});

test('whatIf does not change anything and gives four sensible curves', () => {
  const rows = miniRows(), e = run(new Engine(params()), rows.slice(0, 10));
  e.snapshotDirty();
  const before = bytes(e), preds = JSON.stringify(e.preds);
  const row = rows[10], w = e.whatIf(row, 8000);
  assert.equal(bytes(e), before);
  assert.equal(JSON.stringify(e.preds), preds);
  assert.equal(e.undos.length, 0);
  const snap = e.snapshotDirty();
  assert.equal(snap.cards.length + snap.notes.length + snap.shared.length, 0);
  assert.deepEqual(Object.keys(w), ['1', '2', '3', '4']);
  for (const r of [1, 2, 3, 4]) { assert.ok(headFinite(w[r])); assert.ok(pAt(w[r], 1) <= pAt(w[r], 0.1)); }
  assert.notDeepEqual(w[1], w[4]);
  // it is exactly the curve a real answer would leave behind
  for (const rating of [1, 2, 3, 4]) {
    const twin = run(new Engine(params()), rows.slice(0, 10));
    twin.review({ ...row, rating, ms: 8000 });
    assert.deepEqual(Array.from(twin.curves.get(row.cardKey)), Array.from(headToCurve(w[rating])));
  }
  // the row's own rating and ms do not matter for what-if
  assert.deepEqual(e.whatIf({ ...row, rating: 1, ms: 99 }, 8000), w);
});

test('daysForButtons and intervalDays use the faded prediction: whole days, ordered, the prediction at review time meets R, nothing changes', () => {
  const rows = miniRows(), e = run(new Engine(params()), rows.slice(0, 10));
  e.snapshotDirty();
  const before = bytes(e), row = rows[10], m = e.model;
  for (const R of [0.7, 0.9]) {
    const d = e.daysForButtons(row, 8000, R, 365);
    assert.deepEqual(Object.keys(d), ['2', '3', '4']);
    for (const r of [2, 3, 4]) assert.ok(Number.isInteger(d[r]) && d[r] >= 1 && d[r] <= 365);
    assert.ok(d[2] <= d[3] && d[3] <= d[4]);
    // Good: the same states the engine reads for a real answer; the model's own prediction at the chosen day is at or above R (unless it is floored at 1)
    const dec = m.decayAll(e._states(row), e.builder.gaps(row)), fq = e.builder.features(row, true);
    const next = m.advance(e.builder.features({ ...row, rating: 3, ms: 8000 }, false), dec);
    const p = t => pAt(m.headOf(m.decayAll(next, { note: t, deck: 0, user: 0 }), fq), t);
    if (d[3] > 1 && d[3] === m.fadedDays(next, fq, R, 365)) assert.ok(p(d[3]) >= R);
  }
  assert.deepEqual(e.daysForButtons(row, 8000, 0.9, 365), e.daysForButtons({ ...row, rating: 1, ms: 5 }, 8000, 0.9, 365));
  assert.equal(bytes(e), before);
  assert.equal(e.snapshotDirty().cards.length, 0);
  const g = e.intervalDays(rows[9], 0.8, 365);                                    // from the stored states of a known card
  assert.ok(Number.isInteger(g) && g >= 1 && g <= 365);
  assert.equal(e.intervalDays({ ...rows[9], cardKey: 'c:unknown' }, 0.8, 365), null);
  assert.equal(bytes(e), before);
});

test('saved states are float32 of the right sizes, and the curve round-trips', () => {
  const e = run(new Engine(params()), miniRows());
  assert.ok(e.cards.get('c:1') instanceof Float32Array); assert.equal(e.cards.get('c:1').length, 32);
  assert.equal(e.notes.get('n:1').length, 16);
  assert.equal(e.shared.get('d:1').length, 16); assert.equal(e.shared.get('u').length, 16);
  assert.equal(e.curves.get('c:1').length, 10);
  const h = curveToHead(e.curves.get('c:1'));
  assert.ok(headFinite(h) && Math.abs(h.pi[0] + h.pi[1] + h.pi[2] - 1) < 1e-6);
  const snap = e.snapshotDirty();
  assert.equal(snap.cards.length, 3);
  assert.equal(snap.shared.length, 3);                                            // d:1, d:2, u
  assert.equal(e.snapshotDirty().cards.length, 0);
});

test('the engine and the model agree (engine prediction == model prediction)', async () => {
  const { createOwnModel, StateStore, eventsFromRows } = await import('../js/own-model.js');
  const rows = miniRows(), P = params();
  const e = new Engine(P), got = [];
  for (const r of rows) { const o = e.review(r); if (o.pCurve !== null) got.push(o.pCurve); }
  const want = createOwnModel(P, 's').predictChunk(eventsFromRows(rows), new StateStore());
  assert.equal(got.length, want.length);
  got.forEach((p, i) => assert.ok(Math.abs(p - want[i]) < 1e-12));
});

test('determinism: the same params and rows give the same saved bytes; different seeds do not', () => {
  const mkE = seed => run(new Engine(Float32Array.from(initParams('s', seed))), miniRows());
  assert.equal(bytes(mkE(3)), bytes(mkE(3)));
  assert.notEqual(bytes(mkE(3)), bytes(mkE(4)));
});

test('fromJSON refuses a state from another version; whatIf gives null for broken parameters', () => {
  const e = run(new Engine(params()), miniRows());
  const j = e.toJSON();
  assert.throws(() => Engine.fromJSON({ ...j, format: 'other' }, params()), /different version/);
  assert.throws(() => Engine.fromJSON({ ...j, featureVersion: 99 }, params()), /different version/);
  const bad = params(); bad.fill(NaN);
  const be = new Engine(bad); be.review(miniRows()[0]);
  assert.equal(be.whatIf(miniRows()[1], 8000), null);
  assert.equal(be.review(miniRows()[3]).pCurve, null);
});
