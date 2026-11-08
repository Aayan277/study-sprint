import './rwkv-utc.mjs';
// Tests for the evaluation (tools/own-model/eval-lib.mjs, eval-core.mjs, npz.mjs): the pre-registered verdict on hand-made numbers, the seeded
// bootstrap, FSRS histories from rows, the per-learner run on tiny made-up learners, the outside-prediction alignment check, the .npz reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { bootstrapMeanCI, verdictOf, sizeBucket, summarize, BOOT, RMSE_SLACK, CONTROL_TOLERANCE } from '../tools/own-model/eval-lib.mjs';
import { evalLearner, fsrsCardsFromRows, finetuneParams, alignRwkv } from '../tools/own-model/eval-core.mjs';
import { readNpz, NpzError } from '../tools/own-model/npz.mjs';
import { loadLearner, isLong, isSame, frozenFor, scopeFrozen, FT_SCOPES } from '../tools/own-model/common.mjs';
import { paramOffsets } from '../js/own-spec.js';
import { userToLearner } from '../tools/own-model/sources/anki10k.mjs';
import { rowsOf } from '../tools/own-model/sources/index.mjs';
import { toHistories } from './realdata/lib.mjs';
import { initParams, eventsFromRows } from '../js/own-model.js';

// ---------- the verdict ----------
test('the verdict on hand-made numbers: better only when the whole interval is below 0 and RMSE is within the slack', () => {
  const good = verdictOf([-0.02, -0.01, -0.03, -0.015, -0.02, -0.025], [0.001, -0.002, 0, 0.003, 0, 0.001]);
  assert.equal(good.better, true); assert.ok(good.hi < 0); assert.equal(good.improvedShare, 1); assert.equal(good.n, 6);
  assert.ok(Math.abs(good.meanDiff - (-0.02)) < 1e-12);
  const mixed = verdictOf([-0.01, 0.02, -0.005, 0.03, -0.02, 0.01], [0, 0, 0, 0, 0, 0]);
  assert.equal(mixed.better, false); assert.ok(mixed.lo < 0 && mixed.hi > 0); assert.equal(mixed.lossOk, false);
  const worseRmse = verdictOf([-0.02, -0.02, -0.02, -0.02], [0.02, 0.02, 0.02, 0.02]);
  assert.equal(worseRmse.lossOk, true); assert.equal(worseRmse.rmseOk, false); assert.equal(worseRmse.better, false);
  const edge = verdictOf([-0.02, -0.02, -0.02], [RMSE_SLACK, RMSE_SLACK, RMSE_SLACK]);
  assert.equal(edge.better, true, 'exactly the slack is allowed');
  assert.equal(RMSE_SLACK, 0.01);
  const none = verdictOf([], []);
  assert.equal(none.better, false); assert.equal(none.n, 0);
  assert.equal(verdictOf([0, 0, 0, 0], [0, 0, 0, 0]).better, false, 'equal is not better');
});

test('the bootstrap is seeded: the same input and seed give the same interval, another seed another one', () => {
  const xs = Array.from({ length: 40 }, (_, i) => Math.sin(i) * 0.02 - 0.004);
  const a = bootstrapMeanCI(xs), b = bootstrapMeanCI(xs), c = bootstrapMeanCI(xs, { seed: 5 });
  assert.deepEqual(a, b);
  assert.notEqual(a.lo, c.lo);
  assert.ok(a.lo < a.mean && a.mean < a.hi);
  assert.equal(BOOT.resamples, 2000);
  const flat = bootstrapMeanCI([0.5, 0.5, 0.5]);
  assert.equal(flat.lo, 0.5); assert.equal(flat.hi, 0.5);
  assert.equal(bootstrapMeanCI([]).n, 0);
  // about 95%: for a normal-ish sample the interval is about +-1.96 standard errors
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - a.mean) ** 2, 0) / (xs.length - 1)), se = sd / Math.sqrt(xs.length);
  assert.ok(Math.abs((a.hi - a.lo) / 2 - 1.96 * se) < 0.4 * se, `half width ${(a.hi - a.lo) / 2} vs ${1.96 * se}`);
});

test('size groups', () => {
  assert.deepEqual([100, 4999, 5000, 50000, 50001].map(sizeBucket), ['<5k', '<5k', '5k-50k', '5k-50k', '>50k']);
});

const rec = (user, own, fsrs, reviews = 1000, extra = {}) => ({ user, ok: true, reviews, hasMeta: false, n: 200, models: {
  own_ft: { long: { logLoss: own, rmse: 0.03, auc: 0.7, n: 200 }, same: { logLoss: 0.4, rmse: 0.03, auc: 0.7, n: 20 } },
  fsrs6_fitted: { long: { logLoss: fsrs, rmse: 0.03, auc: 0.68, n: 200 }, same: { logLoss: 0.5, rmse: 0.03, auc: 0.6, n: 20 } } }, ...extra });

test('the report: verdict line, groups by size, users left out, control check, no per-user numbers', () => {
  const results = Array.from({ length: 12 }, (_, i) => rec(`u${i}`, 0.30 - 0.01 * (i % 3 + 1), 0.32, [800, 20000, 90000][i % 3]));
  results.push({ user: 'tiny', ok: true, reviews: 100, n: 10, models: rec('x', 0, 0).models });     // too few held-out reviews: left out
  results.push({ user: 'bad', ok: false, error: 'x', models: {} });
  const { markdown, data } = summarize(results, { source: 'sim', split: 'test', world: 'own' });
  assert.equal(data.verdict.better, true); assert.equal(data.usable, 12); assert.equal(data.failed, 1);
  assert.match(markdown, /Verdict .*: BETTER/); assert.match(markdown, /\| <5k \| 4 \|/); assert.match(markdown, /\| 5k-50k \| 4 \|/); assert.match(markdown, />50k/);
  assert.match(markdown, /1 left out|left out of the comparison/);
  assert.ok(!/u1\b/.test(markdown), 'no per-user lines in the aggregate');
  const control = summarize(results.map(r => (r.ok && r.models.own_ft ? rec(r.user, 0.32 + 0.001, 0.32) : r)), { source: 'sim', world: 'fsrs' });
  assert.match(control.markdown, /passed, they are about equal/);
  const leak = summarize(Array.from({ length: 8 }, (_, i) => rec('l' + i, 0.30, 0.32)), { source: 'sim', world: 'fsrs' });
  assert.match(leak.markdown, /FAILED: Own beats FSRS-6 here/); assert.equal(leak.data.controlLeak, true);
  const worse = summarize(Array.from({ length: 8 }, (_, i) => rec('w' + i, 0.40, 0.32)), { source: 'sim', world: 'fsrs' });
  assert.match(worse.markdown, /clearly worse/);
  assert.equal(CONTROL_TOLERANCE, 0.005);
  const nothing = summarize([], { source: 'sim' });
  assert.match(nothing.markdown, /No verdict/);
});

test('the report includes the RWKV reference only for users that have it, on the same reviews, and splits real users by note and deck information', () => {
  const rows = Array.from({ length: 6 }, (_, i) => rec(`r${i}`, 0.29, 0.31, 1000, {
    hasMeta: i % 2 === 0, rwkv: 'used',
    models: { ...rec('x', 0.29, 0.31).models, rwkv: { long: { logLoss: 0.28, rmse: 0.02, auc: 0.72, n: 200 }, same: { logLoss: 0.3, rmse: 0.02, auc: 0.7, n: 20 } } },
    rwkvRows: { own_ft: { logLoss: 0.29, rmse: 0.03, auc: 0.7, n: 200 }, fsrs6_fitted: { logLoss: 0.31, rmse: 0.03, auc: 0.68, n: 200 }, rwkv: { logLoss: 0.28, rmse: 0.02, auc: 0.72, n: 200 } }
  }));
  const rest = Array.from({ length: 4 }, (_, i) => rec(`s${i}`, 0.29, 0.31, 1000));
  const { markdown, data } = summarize([...rows, ...rest], { source: 'anki10k', split: 'test' });
  assert.match(markdown, /RWKV reference: 6 users/);
  assert.equal(data.rwkv.users, 6);
  assert.ok(Math.abs(data.rwkv['own_ft|rwkv'].mean - 0.01) < 1e-9);
  assert.match(markdown, /has note\/deck/); assert.match(markdown, /no note\/deck/);
  assert.equal(data.byMeta['has note/deck'].users, 3);
});

// ---------- FSRS histories from rows, against the existing reader ----------
const ROWS = [   // card, day, rating, state, elapsed seconds
  [10, 0, 3, 0, -1], [11, 0, 1, 0, -1], [10, 0, 3, 1, 600], [11, 0, 3, 1, 300], [10, 3, 3, 2, 3 * 86400 - 600], [12, 1, 0, 0, -1], [12, 4, 3, 1, 3 * 86400],
  [11, 2, 1, 2, 2 * 86400 - 300], [11, 2, 3, 3, 600], [13, 2, 2, 2, 5000], [10, 9, 4, 2, 6 * 86400], [11, 9, 3, 0, -1], [11, 12, 3, 2, 3 * 86400]
];
const userOf = (rows, id = 1) => ({ user: id, card_id: rows.map(r => r[0]), day_offset: rows.map(r => r[1]), rating: rows.map(r => r[2]), state: rows.map(r => r[3]), elapsed_seconds: rows.map(r => r[4]) });

test('FSRS histories made from rows are the same as the existing reader makes from the raw columns', () => {
  const u = userOf(ROWS);
  const mine = fsrsCardsFromRows(rowsOf(userToLearner(u, { cap: 1e6, id: '1' })));
  const theirs = toHistories(u).cards;
  const norm = c => JSON.stringify({ d0: c.day0, d: Array.from(c.deltas), r: Array.from(c.ratings), t: Array.from(c.tFrac, x => +x.toFixed(6)) });
  assert.deepEqual(mine.map(norm).sort(), theirs.map(norm).sort());
});

test('with duration_ms, tFrac is elapsed minus the answer\'s duration and the FSRS day deltas are unchanged', () => {
  const u = { ...userOf(ROWS), duration_ms: ROWS.map(() => 8000), note_id: ROWS.map(() => null), deck_id: ROWS.map(() => null), preset_id: ROWS.map(() => null) };
  const mine = fsrsCardsFromRows(rowsOf(userToLearner(u, { cap: 1e6, id: '1' }))), theirs = toHistories(u).cards;
  const card10 = mine.find(c => c.cardId === 'c:c10'), ref10 = theirs.find(c => String(c.cardId) === '10');
  assert.deepEqual(mine.map(c => Array.from(c.deltas)).sort(), theirs.map(c => Array.from(c.deltas)).sort());
  assert.ok(Math.abs(card10.tFrac[1] - 592 / 86400) < 1e-9, 'same-day row: 600 s minus 8 s');
  assert.ok(Math.abs(card10.tFrac[2] - (3 * 86400 - 608) / 86400) < 1e-9);
  assert.ok(ref10 && Math.abs(ref10.tFrac[1] - 600 / 86400) < 1e-9, 'the raw reader keeps the old gap');
});

// ---------- one learner ----------
const tiny = k => loadLearner({ kind: 'sim', split: 'test', k, config: { days: [30, 40] } });

test('an ensemble of a model with itself scores exactly like that model; two different models give a row of their own', () => {
  const params = initParams('s', 7), other = initParams('s', 8);
  const own = [{ key: 'own_zero', params, size: 's' }, { key: 'm1', params, size: 's', hidden: true }, { key: 'm2', params, size: 's', hidden: true }, { key: 'm3', params: other, size: 's', hidden: true }];
  const r = evalLearner(tiny(0), { fitFsrs: false, own, ensembles: [{ key: 'e_1', members: ['m1', 'm2'] }, { key: 'e_2', members: ['m1', 'm3'] }] });
  assert.ok(!('m1' in r.models) && !('m3' in r.models), 'members are not scored by themselves');
  assert.deepEqual(r.models.e_1, r.models.own_zero);
  assert.ok(r.models.e_2.long.n === r.models.own_zero.long.n && r.models.e_2.long.logLoss !== r.models.own_zero.long.logLoss);
  assert.throws(() => evalLearner(tiny(0), { fitFsrs: false, own, ensembles: [{ key: 'e_3', members: ['nope'] }] }), /unknown member/);
});

test('a tiny learner is scored by every model on the same reviews, with finite numbers', () => {
  const params = initParams('s', 7);
  const l = tiny(0), r = evalLearner(l, { own: [{ key: 'own_zero', params, size: 's', finetune: 'own_ft' }, { key: 'x_1', params: initParams('s', 8), size: 's' }] });
  assert.equal(r.ok, true);
  for (const k of ['fsrs6_default', 'fsrs6_fitted', 'own_zero', 'own_ft', 'x_1']) assert.ok(r.models[k], k);
  assert.equal(r.countMismatch, undefined, 'FSRS and Own scored the same number of reviews');
  const n = r.models.fsrs6_default.long.n;
  assert.ok(n > 0);
  for (const k of ['own_zero', 'own_ft', 'fsrs6_fitted']) { assert.equal(r.models[k].long.n, n); assert.ok(Number.isFinite(r.models[k].long.logLoss)); }
  assert.equal(r.n, n);
  assert.ok(r.ft && r.ft.epochsRun >= 0);
  assert.ok(r.models.own_zero.same.n >= 0);
  assert.equal(r.reviews, l.rows.length);
});

test('per-user fine-tuning: it never ends worse than where it started on its own check days, and with a very strong leash it stays put', () => {
  const l = tiny(1), events = eventsFromRows(l.rows), params = initParams('s', 7);
  const cards = fsrsCardsFromRows(l.rows);
  const days = []; for (const c of cards) { let d = c.day0; for (let i = 0; i < c.ratings.length; i++) { d += c.deltas[i]; if (i > 0 && c.deltas[i] > 0) days.push(d); } }
  days.sort((a, b) => a - b);
  const cutoff = days[Math.floor(days.length * 0.8)];
  const free = finetuneParams({ params, size: 's', events, rows: l.rows, cutoff, cfg: { epochs: 3, l2: 0 } });
  if (free.skipped) return;
  assert.ok(free.valBest <= free.valStart + 1e-12, 'the best epoch is never worse than the start (epoch 0 is the start)');
  const leashed = finetuneParams({ params, size: 's', events, rows: l.rows, cutoff, cfg: { epochs: 3, l2: 1e6 } });
  let far = 0, near = 0;
  for (let i = 0; i < params.length; i++) { far = Math.max(far, Math.abs(free.params[i] - params[i])); near = Math.max(near, Math.abs(leashed.params[i] - params[i])); }
  assert.ok(near <= far + 1e-12);
  const fz = frozenFor('s', ['note']);
  const kept = finetuneParams({ params: (() => { const p = Float64Array.from(params); for (let i = 0; i < fz.idx.length; i++) p[fz.idx[i]] = fz.val[i]; return p; })(), size: 's', events, rows: l.rows, cutoff, frozen: fz, cfg: { epochs: 2 } });
  for (let i = 0; i < fz.idx.length; i++) assert.equal(kept.params[fz.idx[i]], fz.val[i]);
});

test('fine-tune scope: head frees only the head, states frees only the you and deck starting vectors, all frees everything', () => {
  const params = initParams('s', 7), off = paramOffsets('s');
  const freeOf = scope => { const fz = scopeFrozen('s', scope, params, null), fixed = new Set(fz.idx); return Object.entries(off).filter(([, o]) => { for (let i = 0; i < o.length; i++) if (fixed.has(o.offset + i)) return false; return true; }).map(([name]) => name).sort(); };
  assert.deepEqual(FT_SCOPES, ['all', 'head', 'states']);
  assert.equal(scopeFrozen('s', 'all', params, null).idx.length, 0);
  assert.deepEqual(freeOf('head'), ['head.W1', 'head.W2', 'head.b1', 'head.b2']);
  assert.deepEqual(freeOf('states'), ['deck.h0', 'user.h0']);
  for (const scope of ['head', 'states']) { const fz = scopeFrozen('s', scope, params, null); for (let k = 0; k < fz.idx.length; k++) assert.equal(fz.val[k], params[fz.idx[k]], 'held at the starting value'); }
  const ab = frozenFor('s', ['user']), both = scopeFrozen('s', 'states', params, ab), at = new Map(); for (let k = 0; k < both.idx.length; k++) at.set(both.idx[k], both.val[k]);
  for (let k = 0; k < ab.idx.length; k++) assert.equal(at.get(ab.idx[k]), ab.val[k], 'an ablation stays frozen at its own value and wins');
  assert.throws(() => scopeFrozen('s', 'nope', params, null), /Unknown fine-tune scope/);
});

for (const scope of ['head', 'states']) {
  test(`per-user fine-tune with scope ${scope}: numbers outside the scope really stay unchanged, and the ones inside move`, () => {
    const l = tiny(1), events = eventsFromRows(l.rows), params = initParams('s', 7), off = paramOffsets('s');
    const cards = fsrsCardsFromRows(l.rows);
    const days = []; for (const c of cards) { let d = c.day0; for (let i = 0; i < c.ratings.length; i++) { d += c.deltas[i]; if (i > 0 && c.deltas[i] > 0) days.push(d); } }
    days.sort((a, b) => a - b);
    const cutoff = days[Math.floor(days.length * 0.8)];
    const r = finetuneParams({ params, size: 's', events, rows: l.rows, cutoff, cfg: { epochs: 3, lr: 1e-2, l2: 0, patience: 3, minVal: 1, minFit: 1, scope } });
    assert.ok(!r.skipped, 'the tiny learner is big enough with the small minimums');
    const free = new Set(), names = scope === 'head' ? ['head.W1', 'head.b1', 'head.W2', 'head.b2'] : ['user.h0', 'deck.h0'];
    for (const nm of names) for (let i = 0; i < off[nm].length; i++) free.add(off[nm].offset + i);
    let moved = 0;
    for (let i = 0; i < params.length; i++) { if (!free.has(i)) assert.equal(r.params[i], params[i], `number ${i} is outside the scope and must not change`); else if (r.params[i] !== params[i]) moved++; }
    if (r.bestEpoch > 0) assert.ok(moved > 0, 'a kept epoch changed something inside the scope');
  });
}

test('a learner too small to fine-tune says so and keeps the starting weights', () => {
  const l = loadLearner({ kind: 'sim', split: 'test', k: 2, config: { days: [3, 4], newPerDay: [2, 3] } });
  const r = evalLearner(l, { own: [{ key: 'own_zero', params: initParams('s', 7), size: 's', finetune: 'own_ft' }] });
  assert.equal(r.ft.skipped, 'little');
  assert.equal(r.models.own_ft.long.logLoss, r.models.own_zero.long.logLoss);
});

test('row groups: later-day and same-day, scored only', () => {
  assert.equal(isLong({ dDays: 2 }), true); assert.equal(isLong({ dDays: 0 }), false); assert.equal(isLong({ dDays: undefined }), false);
  assert.equal(isLong({ dDays: 2, scored: false }), false); assert.equal(isSame({ dDays: 0 }), true); assert.equal(isSame({ dDays: 0, scored: false }), false);
});

// ---------- outside predictions ----------
function aligned() {
  const rows = [];
  for (let c = 0; c < 40; c++) for (const [d, st] of [[0, 0], [2, 1], [5, 2]]) rows.push([100 + c, d, 3, st, d === 0 ? -1 : d === 2 ? 2 * 86400 : 3 * 86400]);
  const u = userOf(rows), l = userToLearner(u, { cap: 1e6, id: '1' }), rr = rowsOf(l);
  const p = new Float64Array(rows.length).fill(NaN);
  rows.forEach((r, i) => { if (r[1] > 0) p[i] = 0.9; });
  return { rr, meta: l.meta, p };
}

test('outside predictions are used only when they line up with the rows exactly; otherwise they are refused, not guessed', () => {
  const { rr, meta, p } = aligned();
  assert.equal(alignRwkv(rr, meta, { n: p.length, p }).ok, true);
  assert.equal(alignRwkv(rr, meta, { n: p.length + 1, p }).ok, false);
  assert.equal(alignRwkv(rr, meta, null).ok, false);
  const shifted = new Float64Array(p.length); shifted.set(p.subarray(0, p.length - 1), 1); shifted[0] = NaN;
  assert.equal(alignRwkv(rr, meta, { n: p.length, p: shifted }).ok, false);
  const reversed = Float64Array.from(p).reverse();
  assert.equal(alignRwkv(rr, meta, { n: p.length, p: reversed }).ok, false);
  const allNumbers = new Float64Array(p.length).fill(0.9);
  assert.equal(alignRwkv(rr, meta, { n: p.length, p: allNumbers }).ok, false, 'a prediction for first answers means it is not the same kind of rows');
});

test('a user with outside predictions gets an RWKV row scored on the same reviews', () => {
  const rows = [];
  for (let c = 0; c < 60; c++) for (const [d, st] of [[0, 0], [2, 1], [5, 2], [11, 2], [20, 2]]) rows.push([100 + c, d, (c + d) % 5 === 0 ? 1 : 3, st, d === 0 ? -1 : [0, 0, 2, 3, 6, 9][[0, 2, 5, 11, 20].indexOf(d) + 1] * 86400]);
  const u = userOf(rows), l = userToLearner(u, { cap: 1e6, id: '5' }), rr = rowsOf(l);
  const p = new Float64Array(rows.length).fill(NaN);
  rows.forEach((r, i) => { if (r[1] > 0) p[i] = 0.8; });
  const r = evalLearner({ id: '5', rows: rr, meta: l.meta }, { own: [{ key: 'own_zero', params: initParams('s', 3), size: 's' }], rwkv: () => ({ n: rows.length, p }) });
  assert.equal(r.rwkv, 'used');
  assert.equal(r.models.rwkv.long.n, r.models.fsrs6_default.long.n);
  assert.ok(r.rwkvRows.own_zero && r.rwkvRows.fsrs6_fitted && r.rwkvRows.rwkv);
  const no = evalLearner({ id: '5', rows: rr, meta: l.meta }, { own: [], rwkv: () => ({ n: rows.length - 1, p: p.subarray(1) }) });
  assert.match(no.rwkv, /not used/); assert.equal(no.models.rwkv, undefined);
});

// ---------- the .npz reader ----------
function npy(values, type = 'f8') {
  const descr = type === 'f8' ? '<f8' : '<i8', n = values.length;
  let h = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${n},), }`;
  while ((10 + h.length + 1) % 64) h += ' ';
  h += '\n';
  const body = type === 'f8' ? Buffer.from(Float64Array.from(values).buffer) : Buffer.from(BigInt64Array.from(values.map(BigInt)).buffer);
  const head = Buffer.alloc(10); head.write('\x93NUMPY', 0, 'latin1'); head[6] = 1; head[7] = 0; head.writeUInt16LE(h.length, 8);
  return Buffer.concat([head, Buffer.from(h, 'latin1'), body]);
}
function zip(entries, deflate = false) {
  const parts = [], central = [];
  let at = 0;
  for (const [name, data] of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data, crc = zlib.crc32(data), nm = Buffer.from(name, 'latin1');
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(at, 42);
    parts.push(lh, nm, body); central.push(ch, nm);
    at += 30 + nm.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, cd, end]);
}

test('the .npz reader reads stored and compressed arrays, and refuses everything odd', () => {
  const entries = [['p_curve.npy', npy([NaN, 0.5, 0.25])], ['n.npy', npy([3], 'i8')]];
  for (const deflate of [false, true]) {
    const z = readNpz(zip(entries, deflate));
    assert.equal(z.p_curve.data.length, 3); assert.ok(Number.isNaN(z.p_curve.data[0])); assert.equal(z.p_curve.data[2], 0.25); assert.equal(z.n.data[0], 3);
  }
  assert.throws(() => readNpz(Buffer.from('not a zip at all, just text')), NpzError);
  assert.throws(() => readNpz(zip(entries).subarray(0, 60)), NpzError);
  assert.throws(() => readNpz(zip([['../evil.npy', npy([1])]])), /entry name/);
  assert.throws(() => readNpz(zip([['a.txt', Buffer.from('hi')]])), /entry name/);
  assert.throws(() => readNpz(zip([['a.npy', Buffer.from('garbage garbage garbage')]])), NpzError);
  const lying = npy([1, 2, 3]); lying.writeUInt16LE(lying.readUInt16LE(8), 8);
  assert.throws(() => readNpz(zip([['a.npy', lying.subarray(0, lying.length - 8)]])), /size/);
  const obj = npy([1]); const text = obj.toString('latin1').replace('<f8', '|O ');
  assert.throws(() => readNpz(zip([['a.npy', Buffer.from(text, 'latin1')]])), /unsupported/);
});
