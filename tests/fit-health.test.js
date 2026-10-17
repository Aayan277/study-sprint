// Tests for js/fit-health.js (the health check's verdicts and numbers) and the ignore-before date (js/sched-settings.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFit, baseLoss, healthFit, hardUse, retentionVerdict, retentionAdvice, fitAdvice, hardAdvice,
  RMSE_GOOD, RMSE_OK, HEALTH_MIN_N, HEALTH_SOFT_N
} from '../js/fit-health.js';
import { evaluate, mulberry32, forgettingCurve, initState, nextState } from '../js/fsrs-fit.js';
import { cleanIgnoreBefore, ignoreBeforeTime, rowsFrom } from '../js/sched-settings.js';
import { acceptSetting, SYNCED_SETTINGS } from '../js/sync-data.js';
import { buildHistories } from '../js/fsrs-data.js';

const DEFAULT_W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const BOUNDS = [[0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100], [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75], [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5], [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1], [1, 6], [0, 2], [0, 2], [0.01, 0.8], [0.1, 0.8]];

function synth(w, nCards, seed, spread = 400) {
  const rng = mulberry32(seed);
  const cards = [];
  for (let c = 0; c < nCards; c++) {
    const deltas = [0], ratings = [], scored = [1];
    ratings.push(3);
    let { s, d } = initState(w, 3);
    for (let i = 1; i < 8; i++) {
      const t = Math.max(1, Math.round(s * Math.exp((rng() - 0.5) * 1.2)));
      const r = forgettingCurve(w, t, s);
      const g = rng() < r ? 3 : 1;
      deltas.push(t); ratings.push(g); scored.push(1);
      ({ s, d } = nextState(w, s, d, t, g, true, r));
    }
    cards.push({ day0: Math.floor(rng() * spread), deltas: Int32Array.from(deltas), ratings: Uint8Array.from(ratings), scored: Uint8Array.from(scored) });
  }
  return cards;
}
const run = g => { for (;;) { const r = g.next(); if (r.done) return r.value; } };

test('classifyFit: thresholds on RMSE and on log loss against guessing your own average', () => {
  const p = 0.9, base = baseLoss(p);
  const mk = (rmse, excess, n = 500) => classifyFit({ logLoss: base + excess, rmse, n, recall: p });
  assert.equal(mk(0.05, 0).grade, 'good');
  assert.equal(mk(0.05, -0.02).grade, 'good');            // better than guessing the average
  assert.equal(mk(RMSE_GOOD, 0.01).grade, 'good');        // right on the limits
  assert.equal(mk(0.08, 0).grade, 'ok');                   // RMSE decides
  assert.equal(mk(0.05, 0.03).grade, 'ok');                // log loss decides
  assert.equal(mk(RMSE_OK, 0.04).grade, 'ok');
  assert.equal(mk(0.12, 0).grade, 'poor');
  assert.equal(mk(0.05, 0.06).grade, 'poor');
  assert.equal(mk(0.12, 0.06).grade, 'poor');
  // the benchmark numbers in docs/design/fsrs-research.md, for a typical user who remembers about 89%
  const typical = (logLoss, rmse) => classifyFit({ logLoss, rmse, n: 1000, recall: 0.89 }).grade;
  assert.equal(typical(0.346, 0.065), 'good');             // tuned FSRS-6
  assert.equal(typical(0.337, 0.0593), 'good');            // FSRS-7 + recency
  assert.equal(typical(0.362, 0.091), 'ok');               // FSRS-7 default parameters
  assert.equal(typical(0.469, 0.12), 'poor');              // HLR
  // few predictions: no verdict; a rough one under HEALTH_SOFT_N
  assert.equal(mk(0.05, 0, HEALTH_MIN_N - 1).grade, 'unknown');
  assert.equal(mk(0.05, 0, HEALTH_MIN_N).rough, true);
  assert.equal(mk(0.05, 0, HEALTH_SOFT_N).rough, false);
  assert.equal(classifyFit({ logLoss: NaN, rmse: 0.05, n: 500, recall: 0.9 }).grade, 'unknown');
});

test('baseLoss is the entropy of the recall rate', () => {
  assert.ok(Math.abs(baseLoss(0.5) - Math.log(2)) < 1e-12);
  assert.equal(baseLoss(1), 0);
  assert.ok(baseLoss(0.9) < baseLoss(0.8));
});

test('healthFit scores the current weights on the recent reviews only', () => {
  const cards = synth(DEFAULT_W, 300, 11);
  let latest = 0;
  for (const c of cards) { let d = c.day0; for (let i = 0; i < c.deltas.length; i++) { d += c.deltas[i]; latest = Math.max(latest, d); } }
  const r = run(healthFit({ cards, steps: cards.map(() => 1), w: DEFAULT_W, bounds: BOUNDS, today: latest }));
  assert.equal(r.status, 'ok');
  assert.ok(r.n >= HEALTH_SOFT_N);                          // widened to the latest 300 when the last 90 days hold fewer
  // data that follows the weights fits well
  assert.equal(classifyFit(r).grade, 'good', JSON.stringify(r));
  // the numbers are the ones evaluate() gives for the same reviews
  const masked = cards.map(c => { let d = c.day0; return { ...c, scored: c.scored.map((x, i) => { d += c.deltas[i]; return d >= r.sinceDay ? x : 0; }) }; });
  const e = evaluate(masked, DEFAULT_W);
  assert.equal(e.n, r.n);
  assert.ok(Math.abs(e.logLoss - r.logLoss) < 1e-12);
  assert.ok(Math.abs(e.rmse - r.rmse) < 1e-12);
  // weights far from the truth are judged worse
  const wrong = DEFAULT_W.slice(); wrong[20] = 0.7; wrong[8] = 0.2;
  const bad = run(healthFit({ cards, steps: cards.map(() => 1), w: wrong, bounds: BOUNDS, today: latest }));
  assert.ok(bad.rmse > r.rmse && bad.logLoss > r.logLoss);
  assert.notEqual(classifyFit(bad).grade, 'good');
  // too few reviews
  const few = run(healthFit({ cards: cards.slice(0, 5), steps: [1, 1, 1, 1, 1], w: DEFAULT_W, bounds: BOUNDS, today: latest }));
  assert.equal(few.status, 'not-enough');
});

test('healthFit: a short window of recent days is used when it holds enough predictions', () => {
  const cards = synth(DEFAULT_W, 600, 12, 200);
  let latest = 0;
  for (const c of cards) { let d = c.day0; for (let i = 0; i < c.deltas.length; i++) { d += c.deltas[i]; latest = Math.max(latest, d); } }
  const r = run(healthFit({ cards, steps: cards.map(() => 1), w: DEFAULT_W, bounds: BOUNDS, today: latest }));
  assert.ok(r.sinceDay <= latest - 89);
});

test('hardUse: the share of Hard among remembered Review answers, flagged at 40% from 50 answers', () => {
  const now = Date.UTC(2026, 9, 17);
  const row = (rating, extra = {}) => ({ source: 'review', state: 2, rating, timestamp: now - 86400000, ...extra });
  const mk = (hard, rest) => [...Array(hard).fill(0).map(() => row(2)), ...Array(rest).fill(0).map(() => row(3))];
  assert.deepEqual(hardUse(mk(10, 90), now), { hard: 10, passes: 100, share: 0.1, overuse: false });
  assert.equal(hardUse(mk(40, 60), now).overuse, true);
  assert.equal(hardUse(mk(39, 61), now).overuse, false);
  assert.equal(hardUse(mk(20, 20), now).overuse, false);              // too few answers (40) to say
  // not counted: Again, learning cards, game answers, old answers
  const noise = [row(1), row(2, { state: 1 }), row(2, { source: 'play' }), row(2, { timestamp: now - 200 * 86400000 })];
  assert.equal(hardUse([...mk(5, 5), ...noise], now).passes, 10);
  assert.equal(hardUse([], now).share, null);
});

test('retentionVerdict: needs enough reviews and a gap beyond the noise', () => {
  assert.equal(retentionVerdict({ n: 10, ok: 5 }, 0.9).verdict, 'few');
  assert.equal(retentionVerdict({ n: 300, ok: 270 }, 0.9).verdict, 'on');
  assert.equal(retentionVerdict({ n: 300, ok: 240 }, 0.9).verdict, 'under');       // 80%
  assert.equal(retentionVerdict({ n: 300, ok: 297 }, 0.9).verdict, 'over');        // 99%
  assert.equal(retentionVerdict({ n: 300, ok: 258 }, 0.9).verdict, 'under');       // 86%: 4 points under, beyond the noise
  assert.equal(retentionVerdict({ n: 40, ok: 34 }, 0.9).verdict, 'on');            // 85% of 40 is within the noise
  assert.ok(Math.abs(retentionVerdict({ n: 100, ok: 84 }, 0.9).gap + 0.06) < 1e-12);
});

test('the one-line advice uses plain words and names the way out', () => {
  const t = 0.9;
  const under = retentionAdvice({ n: 200, ok: 168 }, { n: 100, ok: 80 }, { n: 100, ok: 88 }, t, { canOptimize: true });
  assert.match(under, /Retention is 6 points under your target: consider fewer new cards or running Optimize/);
  assert.match(retentionAdvice({ n: 200, ok: 199 }, { n: 100, ok: 99 }, { n: 100, ok: 100 }, t), /above your target/);
  assert.match(retentionAdvice({ n: 200, ok: 180 }, { n: 100, ok: 90 }, { n: 100, ok: 90 }, t), /on target/);
  assert.match(retentionAdvice({ n: 5, ok: 5 }, { n: 5, ok: 5 }, { n: 0, ok: 0 }, t), /Not enough reviews/);
  assert.match(retentionAdvice({ n: 200, ok: 180 }, { n: 100, ok: 90 }, { n: 100, ok: 90 }, t), /Nothing to change/);
  assert.match(fitAdvice({ grade: 'poor' }, { usingOwn: false, canOptimize: true }), /Run Optimize/);
  assert.match(fitAdvice({ grade: 'good' }, {}), /Nothing to change/);
  assert.match(hardAdvice({ passes: 100, share: 0.5, overuse: true }), /press Good/);
  assert.match(hardAdvice({ passes: 100, share: 0.2, overuse: false }), /normal/);
});

test('ignore-before: a valid local date, the start of that day, and rows before it dropped', () => {
  assert.equal(cleanIgnoreBefore('2026-03-05'), '2026-03-05');
  for (const bad of ['2026-02-30', '2026-13-01', '05/03/2026', '', null, undefined, 20260305, '2026-3-5']) assert.equal(cleanIgnoreBefore(bad), null, String(bad));
  assert.equal(ignoreBeforeTime(null), 0);
  assert.equal(ignoreBeforeTime('2026-03-05'), new Date(2026, 2, 5).getTime());
  const rows = [{ timestamp: new Date(2026, 2, 4, 23, 59).getTime() }, { timestamp: new Date(2026, 2, 5, 0, 0).getTime() }, { timestamp: new Date(2026, 2, 6).getTime() }];
  assert.equal(rowsFrom(rows, '2026-03-05').length, 2);
  assert.equal(rowsFrom(rows, null), rows);
  // it is a synced setting and a bad value from outside is refused
  assert.ok(SYNCED_SETTINGS.includes('ignoreBefore'));
  assert.deepEqual(acceptSetting('ignoreBefore', '2026-03-05'), { ok: true, value: '2026-03-05' });
  assert.deepEqual(acceptSetting('ignoreBefore', null), { ok: true, value: null });
  assert.equal(acceptSetting('ignoreBefore', 'soon').ok, false);
});

test('ignore-before leaves out the early reviews of a card, and the optimizer skips cards that no longer start at "new"', () => {
  const day = 86400000, t0 = Date.UTC(2026, 0, 1, 12);
  const rows = [];
  const add = (cardId, d, rating, state) => rows.push({ cardId, timestamp: t0 + d * day, source: 'review', rating, state, correct: rating > 1 });
  add('old', 0, 3, 0); add('old', 3, 3, 1); add('old', 10, 3, 2); add('old', 30, 3, 2);       // started before the cut
  add('new', 40, 3, 0); add('new', 42, 3, 1); add('new', 50, 3, 2);                             // started after it
  const all = buildHistories(rows);
  assert.equal(all.cards.length, 2);
  const cut = buildHistories(rowsFrom(rows, new Date(t0 + 20 * day).toISOString().slice(0, 10)));
  assert.equal(cut.cards.length, 1);
  assert.equal(cut.cards[0].cardId, 'new');
  assert.equal(cut.skipped, 1);
});
