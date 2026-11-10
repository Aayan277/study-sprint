import './own-utc.mjs';
// Tests for the shadow run (tools/own-model/shadow-core.mjs): the pure rules on made-up records only (no real data, no models).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halfOf, parseStart, startDay, gridVariants, variantKey, signFlip, runVariants, verdictForN, fsrsPredictions, falseBetter, returnsByWhy, logLoss } from '../tools/own-model/shadow-core.mjs';
import { liveVerdict } from '../js/own-verdict.js';
import { mulberry32 } from '../js/fsrs-fit.js';
import { DEFAULT_W } from '../tools/own-model/eval-core.mjs';

// the standard 32-bit FNV-1a, written out here so the test does not lean on the code it checks
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// made-up live records: `perDay` records a day on `days` days after day 0, over `cards` cards; Own's chance is pOwn(day), FSRS's pFsrs; y is drawn from `truth`
function makeLive({ days = 60, perDay = 12, cards = 80, pOwn = () => 0.9, pFsrs = () => 0.55, truth = () => 0.9, seed = 1 } = {}) {
  const rng = mulberry32(seed), out = [];
  for (let d = 1; d <= days; d++) for (let i = 0; i < perDay; i++) {
    out.push({ day: d, cardId: `c${Math.floor(rng() * cards)}`, pOwn: pOwn(d), pFsrs: pFsrs(d), y: rng() < truth(d) ? 1 : 0 });
  }
  return out;
}
const O = { turnDay: 0, histScored: 1000, horizon: 365, nextDays: 90 };

test('the half of a val user is the low bit of fnv1a("own-val-half|" + id): 0 is A, 1 is B', () => {
  let a = 0, b = 0;
  for (let id = 1; id <= 400; id++) {
    const h = halfOf(String(id));
    assert.equal(h, (fnv1a('own-val-half|' + id) & 1) === 0 ? 'A' : 'B');
    if (h === 'A') a++; else b++;
  }
  assert.ok(a > 120 && b > 120, `both halves are used: ${a}/${b}`);
  assert.equal(halfOf('77'), halfOf('77'));
});

test('--start: parsing and the start day (first, scored:N, cutoff)', () => {
  assert.deepEqual(parseStart('first'), { kind: 'first', n: 0 });
  assert.deepEqual(parseStart('scored:5000'), { kind: 'scored', n: 5000 });
  assert.deepEqual(parseStart('cutoff'), { kind: 'cutoff', n: 0 });
  for (const bad of ['', 'scored:0', 'scored:x', 'last', 'scored:1.5']) assert.throws(() => parseStart(bad), /--start/);
  // rows: a first answer (no dDays), later-day repeats (dDays > 0), same-day repeats (dDays 0), an unscored row
  const rows = [
    { day: 3, scored: undefined }, { day: 3, dDays: 0 }, { day: 4, dDays: 1 }, { day: 5, dDays: 2, scored: false }, { day: 6, dDays: 1 }, { day: 6, dDays: 0 }, { day: 9, dDays: 3 }
  ];
  assert.equal(startDay(rows, 'first', NaN), 3);
  assert.equal(startDay(rows, 'scored:1', NaN), 4, 'same-day, first and unscored rows are not scored reviews');
  assert.equal(startDay(rows, 'scored:2', NaN), 6);
  assert.equal(startDay(rows, 'scored:3', NaN), 9);
  assert.equal(startDay(rows, 'scored:4', NaN), null, 'never gets there');
  assert.equal(startDay(rows, 'cutoff', 6), 6);
  assert.equal(startDay(rows, 'cutoff', NaN), null);
  assert.equal(startDay([], 'first', NaN), null);
});

test('the grid: 5 N_live x 2 levels x 2 checks = 20 settings, unique keys, the shipped one flagged once', () => {
  const g = gridVariants();
  assert.equal(g.length, 20);
  assert.equal(new Set(g.map(v => v.key)).size, 20);
  assert.deepEqual([...new Set(g.map(v => v.nLive))], [50, 100, 200, 300, 500]);
  assert.deepEqual([...new Set(g.map(v => v.level))], [0.95, 0.99]);
  assert.deepEqual([...new Set(g.map(v => v.consecutive))], [1, 2]);
  const shipped = g.filter(v => v.shipped);
  assert.equal(shipped.length, 1);
  assert.equal(shipped[0].key, variantKey(300, 0.95, 2));
  assert.equal(shipped[0].key, 'n300-l95-c2');
});

test('sign-flip null: a flipped card has every loss difference negated, an unflipped card is untouched, and the coin is per card and seeded', () => {
  const live = makeLive({ days: 10, cards: 30, pOwn: () => 0.8, pFsrs: () => 0.6, truth: () => 0.7 });
  const f = signFlip(live, 'u1|0');
  assert.equal(f.length, live.length);
  const sign = new Map();
  live.forEach((r, i) => {
    const d0 = logLoss(r.pOwn, r.y) - logLoss(r.pFsrs, r.y), d1 = logLoss(f[i].pOwn, f[i].y) - logLoss(f[i].pFsrs, f[i].y);
    const s = Math.abs(d0 - d1) < 1e-12 ? 1 : Math.abs(d0 + d1) < 1e-12 ? -1 : 0;
    assert.notEqual(s, 0, 'each record keeps or negates its difference');
    assert.equal(f[i].cardId, r.cardId); assert.equal(f[i].y, r.y); assert.equal(f[i].day, r.day);
    if (sign.has(r.cardId)) assert.equal(sign.get(r.cardId), s, 'one coin per card'); else sign.set(r.cardId, s);
  });
  const flips = [...sign.values()].filter(s => s < 0).length;
  assert.ok(flips > 5 && flips < 25, `about half of 30 cards flip: ${flips}`);
  assert.deepEqual(signFlip(live, 'u1|0'), f, 'same seed, same flips');
  assert.notDeepEqual(signFlip(live, 'u1|1'), f, 'another draw flips other cards');
  const rev = signFlip([...live].reverse(), 'u1|0').reverse();
  assert.deepEqual(rev, f, 'the coin does not depend on the order of the records');
});

test('a smaller N_live: repeating every record k times gives the very same verdict numbers', () => {
  const all = makeLive({ days: 8, perDay: 10, cards: 25, pOwn: () => 0.85, pFsrs: () => 0.7, truth: () => 0.8 });
  const live = all.slice(0, 60), args = { level: 0.95, totalScored: 2000, daysWatching: 9 };
  const rep = k => Array.from({ length: live.length * k }, (_, i) => live[i % live.length]);
  // the same 60 records repeated 5 times (what verdictForN builds for the limit of 300) and 7 and 11 times by hand
  const a = verdictForN(live, args);
  assert.notEqual(a.status, 'few');
  for (const k of [7, 11]) {
    const b = liveVerdict(rep(k), { ...args, nLive: live.length * k });
    assert.notEqual(b.status, 'few');
    assert.equal(a.status, b.status);
    for (const f of ['meanDiff', 'lo', 'hi', 'rmseOwn', 'rmseFsrs']) assert.ok(Math.abs(a[f] - b[f]) < 1e-9, `${f} with k = ${k}: ${a[f]} vs ${b[f]}`);   // sums run in another order: equal up to rounding
  }
  assert.equal(verdictForN(live, { ...args, totalScored: 500 }).status, 'few', 'the scored and day limits still apply');
  assert.equal(verdictForN(live, { ...args, daysWatching: 3 }).status, 'few');
});

test('first Better: day and record count; a smaller N_live and a single check come first; nothing before 7 days or before the scored limit', () => {
  const live = makeLive();
  const r = runVariants(live, O);
  const k = key => r[key].firstBetter;
  for (const v of gridVariants()) {
    assert.ok(r[v.key].reached);
    assert.ok(k(v.key), `${v.key} finds Own better`);
    assert.ok(k(v.key).daysAfter >= 7, 'the 7 day limit');
    assert.equal(k(v.key).day, k(v.key).daysAfter, 'turnDay is 0');
    assert.ok(k(v.key).records >= v.nLive, 'at least N_live records');
    assert.equal(r[v.key].switches[0].to, 'own');
    assert.equal(r[v.key].switches[0].why, 'better');
  }
  assert.ok(k('n50-l95-c1').daysAfter <= k('n500-l95-c1').daysAfter);
  assert.ok(k('n300-l95-c1').daysAfter < k('n300-l95-c2').daysAfter, 'the second check comes on a later day');
  assert.ok(k('n300-l95-c2').daysAfter - k('n300-l95-c1').daysAfter <= 7);
  assert.ok(k('n300-l95-c1').records >= 300);
  // not enough scored reviews in total: never
  const long = makeLive({ days: 120, perDay: 14 });
  const few = runVariants(long, { ...O, histScored: 0 })['n50-l95-c1'], full = runVariants(long, O)['n50-l95-c1'];
  assert.ok(few.firstBetter.records >= 1000, 'the 1,000 scored limit counts history plus live');
  assert.ok(full.firstBetter.daysAfter < few.firstBetter.daysAfter, 'with 1,000 reviews of history Own can be judged sooner');
  // the next 90 days: mean loss difference of Own minus FSRS, below 0 when Own is better
  const nx = r['n300-l95-c2'].next;
  assert.ok(nx.n > 0 && nx.diff < -0.2, JSON.stringify(nx));
  assert.equal(nx.n, live.filter(x => x.day > k('n300-l95-c2').day && x.day <= k('n300-l95-c2').day + 90).length);
});

test('flip-flop bookkeeping: Own is better, then clearly worse; the rule goes back (not before the dwell) and counts it', () => {
  // good for 40 days, then Own predicts the opposite of what happens
  const live = makeLive({ days: 110, perDay: 14, pOwn: d => (d <= 40 ? 0.9 : 0.15), truth: () => 0.9 });
  const r = runVariants(live, O)['n300-l95-c2'];
  assert.ok(r.firstBetter);
  assert.ok(r.returns >= 1, JSON.stringify(r.switches));
  const back = r.switches.find(s => s.to === 'fsrs');
  assert.ok(back.day - r.switches[0].day >= 14, 'the 14 day dwell');
  assert.ok(['worse', 'rmse'].includes(back.why));
  assert.equal(r.flips, r.switches.length - 1);
  assert.ok(Number.isFinite(r.next.diff));
  // a rule that never saw anything good never switches
  const none = runVariants(makeLive({ pOwn: () => 0.55, pFsrs: () => 0.9 }), O);
  for (const v of gridVariants()) { assert.equal(none[v.key].firstBetter, null); assert.equal(none[v.key].flips, 0); assert.equal(none[v.key].final, 'fsrs'); assert.equal(none[v.key].next, null); }
});

test('horizon: days after the horizon are not checked', () => {
  const live = makeLive({ days: 60 });
  const r = runVariants(live, { ...O, horizon: 5 });
  for (const v of gridVariants()) assert.equal(r[v.key].firstBetter, null, 'the 7 day limit cannot be met within 5 days');
});

test('the null gives a false-Better rate near 0 for the shipped rule while real signal gives Better; falseBetter pools users x draws', () => {
  const live = makeLive({ days: 80, perDay: 10, cards: 120, pOwn: () => 0.9, pFsrs: () => 0.5 });
  const real = runVariants(live, O);
  assert.ok(real['n300-l95-c2'].firstBetter);
  const draws = 20;
  let better = 0;
  for (let j = 0; j < draws; j++) if (runVariants(signFlip(live, `x|${j}`), { ...O, stopAtFirst: true, skipNext: true })['n300-l95-c2'].firstBetter) better++;
  assert.ok(better / draws <= 0.1, `flipped signs: ${better} of ${draws} draws`);
  const rec = (b, d = 20) => ({ ok: true, variants: { k: { firstBetter: null } }, null: { k: { draws: d, better: b, days: [] } }, oracle: false });
  const f = falseBetter([rec(2), rec(0), rec(1), { ok: true, skipped: 'x' }], 'k');
  assert.equal(f.users, 3); assert.equal(f.nullDraws, 60); assert.equal(f.nullBetter, 3); assert.equal(f.nullRate, 0.05); assert.equal(f.nullUsersAny, 2);
  // the rate among users who reached the checks: only those whose real run reached them
  const rr = (reached, b) => ({ ok: true, variants: { k: { reached, firstBetter: null } }, null: { k: { draws: 20, better: b, days: [] } } });
  const g = falseBetter([rr(true, 2), rr(false, 0), rr(false, 0), rr(true, 0)], 'k');
  assert.equal(g.nullRate, 2 / 80); assert.equal(g.nullReachedUsers, 2); assert.equal(g.nullReachedDraws, 40); assert.equal(g.nullReachedRate, 0.05);
  assert.deepEqual(returnsByWhy({ switches: [{ to: 'own', why: 'better' }, { to: 'fsrs', why: 'rmse' }, { to: 'own', why: 'better' }, { to: 'fsrs', why: 'worse' }, { to: 'fsrs', why: 'worse' }] }), { rmse: 1, worse: 2, other: 0 });
  const orc = [{ ok: true, oracle: true, variants: { k: { firstBetter: { day: 9 } } } }, { ok: true, oracle: true, variants: { k: { firstBetter: null } } }];
  assert.equal(falseBetter(orc, 'k').oracleRate, 0.5);
});

test('FSRS replay for the shadow run: p only on later-day scored reviews, from the state before the answer', () => {
  const w = Float64Array.from(DEFAULT_W);
  const rows = [
    { cardKey: 'a', day: 1, rating: 3 }, { cardKey: 'a', day: 1, rating: 3 }, { cardKey: 'a', day: 5, rating: 3 }, { cardKey: 'b', day: 2, rating: 1 },
    { cardKey: 'b', day: 3, rating: 3, scored: false }, { cardKey: 'a', day: 20, rating: 1 }
  ];
  const p = fsrsPredictions(rows, w);
  assert.ok(Number.isNaN(p[0]) && Number.isNaN(p[1]) && Number.isNaN(p[3]));
  assert.ok(p[2] > 0 && p[2] < 1 && p[5] > 0 && p[5] < 1);
  assert.ok(Number.isNaN(p[4]), 'an unscored row gives no prediction');
  assert.deepEqual(Array.from(fsrsPredictions(rows, w)), Array.from(p), 'deterministic');
});
