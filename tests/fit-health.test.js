// Tests for js/fit-health.js (the health check's verdicts and numbers) and the ignore-before date (js/sched-settings.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFit, baseLoss, healthFit, hardUse, retentionVerdict, retentionAdvice, fitAdvice, hardAdvice,
  RMSE_GOOD, RMSE_OK, HEALTH_MIN_N, HEALTH_SOFT_N, biasLine
} from '../js/fit-health.js';
import { evaluate, mulberry32, forgettingCurve, initState, nextState } from '../js/fsrs-fit.js';
import { intervalFor } from '../js/retention-sim.js';
import { cleanIgnoreBefore, ignoreBeforeTime, rowsFrom, todayISO } from '../js/sched-settings.js';
import { acceptSetting, SYNCED_SETTINGS } from '../js/sync-data.js';
import { restoredSettings } from '../js/db.js';
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

const DEFAULT_W2 = DEFAULT_W;
// People whose true memory (Wt) differs from the weights the scheduler uses (Wsched): they are reviewed when the scheduler says (90% target),
// and remember with their own curve. (The same experiment as the reviewer's rmse.mjs.)
// stretch: reviews done late (2 = twice as long after the scheduled day as the scheduler asked).
function mismatched(Wt, nCards, seed, stretch = 1) {
  const rng = mulberry32(seed); const cards = [];
  for (let c = 0; c < nCards; c++) {
    const deltas = [0], ratings = [], scored = [1];
    let g = rng() < 0.2 ? 1 : 3; ratings.push(g);
    let { s, d } = initState(Wt, g); let ss = initState(DEFAULT_W2, g).s, sd = initState(DEFAULT_W2, g).d;
    for (let k = 0; k < 8; k++) {
      const t = Math.max(1, Math.round(intervalFor(DEFAULT_W2, ss, 0.9, 36500) * stretch));
      const r = forgettingCurve(Wt, t, s);
      g = rng() < r ? (rng() < 0.2 ? 2 : 3) : 1;
      const nx = nextState(Wt, s, d, t, g, true, r); s = nx.s; d = nx.d;
      const ns = nextState(DEFAULT_W2, ss, sd, t, g, true, forgettingCurve(DEFAULT_W2, t, ss)); ss = ns.s; sd = ns.d;
      deltas.push(t); ratings.push(g); scored.push(1);
    }
    cards.push({ cardId: c, day0: 0, deltas: Int32Array.from(deltas), ratings: Uint8Array.from(ratings), scored: Uint8Array.from(scored) });
  }
  return cards;
}
const grade = cards => { const e = evaluate(cards, DEFAULT_W2); return { e, c: classifyFit({ ...e, recall: e.recalled / e.n }) }; };
const halved = (() => { const w = DEFAULT_W.slice(); for (let i = 0; i < 4; i++) w[i] *= 0.5; w[8] -= 0.4; return w; })();
const severe = (() => { const w = DEFAULT_W.slice(); for (let i = 0; i < 4; i++) w[i] *= 0.3; w[8] -= 0.7; w[20] = 0.4; return w; })();

test('classifyFit: calibration, luck-free RMSE and skill over guessing the average, each judged, the worst one wins', () => {
  const base = { n: 2000, recall: 0.9, noise: 0 };
  const mk = (extra, over = {}) => classifyFit({ ...base, logLoss: baseLoss(0.9) * 0.97, rmse: 0.01, meanPred: 0.9, ...extra, ...over });
  assert.equal(mk({}).grade, 'good');
  assert.equal(mk({ rmse: RMSE_GOOD }).grade, 'good');                  // right on a limit counts as the better side
  assert.equal(mk({ rmse: 0.03 }).grade, 'ok');
  assert.equal(mk({ rmse: RMSE_OK }).grade, 'ok');
  assert.equal(mk({ rmse: 0.05 }).grade, 'poor');
  // luck is taken out: the same RMSE is fine on few reviews (noise 0.04) and Poor on many (noise 0.005)
  assert.equal(mk({ rmse: 0.05, noise: 0.04 }, { n: 300 }).rmseGrade, 'good');
  assert.equal(mk({ rmse: 0.05, noise: 0.005 }).rmseGrade, 'poor');
  // no better than guessing your average cannot be Good (skill 0), a bit worse is OK, clearly worse is Poor
  assert.equal(mk({ logLoss: baseLoss(0.9) }).lossGrade, 'ok');
  assert.equal(mk({ logLoss: baseLoss(0.9) * 1.01 }).lossGrade, 'ok');
  assert.equal(mk({ logLoss: baseLoss(0.9) * 1.05 }).lossGrade, 'poor');
  assert.equal(mk({ logLoss: baseLoss(0.9) * 0.99 }).lossGrade, 'good');
  assert.equal(mk({ logLoss: baseLoss(0.9) }).grade, 'ok');
  // calibration: the average prediction 5 points away from what happened is Poor whatever else looks fine
  const off = mk({ meanPred: 0.95 });
  assert.equal(off.calibGrade, 'poor');
  assert.equal(off.grade, 'poor');
  assert.ok(Math.abs(off.bias - 0.05) < 1e-12);
  assert.equal(mk({ meanPred: 0.92 }).calibGrade, 'good');                 // 2 points: within the limit
  assert.equal(mk({ meanPred: 0.935 }, { n: 100 }).calibGrade, 'good');    // 3.5 points, but on 100 reviews that is within chance (se 0.03)
  assert.equal(mk({ meanPred: 0.97 }, { n: 100 }).calibGrade, 'poor');
  // few predictions: no verdict; a rough one under HEALTH_SOFT_N
  assert.equal(mk({}, { n: HEALTH_MIN_N - 1 }).grade, 'unknown');
  assert.equal(mk({}, { n: HEALTH_MIN_N }).rough, true);
  assert.equal(mk({}, { n: HEALTH_SOFT_N }).rough, false);
  assert.equal(classifyFit({ logLoss: NaN, rmse: 0.05, n: 500, recall: 0.9 }).grade, 'unknown');
});

test('a model whose weights do not match the person is not Good: stability x0.5, a wrong curve, a severe mismatch', () => {
  // memory that matches the scheduler's weights: Good
  const same = grade(mismatched(DEFAULT_W, 1500, 3));
  assert.equal(same.c.grade, 'good', JSON.stringify(same.c));
  // the person forgets twice as fast as the weights think: they remember about 85%, the scheduler expects 90%
  const half = grade(mismatched(halved, 1500, 3));
  const recall = half.e.recalled / half.e.n;
  assert.ok(recall < 0.87 && recall > 0.83, String(recall));
  assert.notEqual(half.c.grade, 'good', JSON.stringify(half.c));
  assert.equal(half.c.calibGrade, 'poor');
  assert.ok(half.c.bias > 0.03);
  assert.match(biasLine(half.c), /expect you to remember \d+ points more often than you do/);
  // the reviewer's case, in words: the fit does not say Good, and neither section tells you to change nothing
  const verdict = retentionVerdict({ n: 400, ok: 340 }, 0.9);
  assert.equal(verdict.verdict, 'under');
  const fitLine = fitAdvice(half.c, { usingOwn: false, canOptimize: true, retention: verdict.verdict });
  const retLine = retentionAdvice({ n: 400, ok: 340 }, { n: 200, ok: 170 }, { n: 200, ok: 170 }, 0.9, { canOptimize: true });
  assert.doesNotMatch(fitLine + ' ' + retLine, /Nothing to change|You.re on target/);
  assert.match(fitLine, /Run Optimize/);
  // a severe mismatch is Poor on every count
  const bad = grade(mismatched(severe, 1500, 3));
  assert.equal(bad.c.grade, 'poor');
  assert.equal(bad.c.rmseGrade, 'poor');
  // the same mismatch seen on few reviews is not called Poor by luck alone (60 cards, 480 predictions, matching weights)
  for (const seed of [1, 2, 3, 4, 5, 6]) assert.notEqual(grade(mismatched(DEFAULT_W, 60, seed)).c.grade, 'poor', `seed ${seed}`);
});

test('settings that fit but reviews done late: the fit is Good, you are under target, and both lines blame how you review, never the settings', () => {
  const late = grade(mismatched(DEFAULT_W, 1500, 3, 2.2));
  const recall = late.e.recalled / late.e.n;
  assert.ok(recall < 0.86 && recall > 0.7, String(recall));                       // true recall well under the 90% target
  assert.equal(late.c.grade, 'good', JSON.stringify(late.c));                      // the predictions use the real gaps, so they match
  const n = 400, ok = Math.round(n * recall);
  const verdict = retentionVerdict({ n, ok }, 0.9).verdict;
  assert.equal(verdict, 'under');
  const fitLine = fitAdvice(late.c, { usingOwn: true, canOptimize: true, retention: verdict });
  for (const split of [[{ n: 200, ok: Math.round(200 * recall) }, { n: 200, ok: Math.round(200 * recall) }], [{ n: 300, ok: Math.round(300 * 0.95) }, { n: 100, ok: Math.round(100 * 0.5) }]]) {
    const retLine = retentionAdvice({ n, ok }, split[0], split[1], 0.9, { canOptimize: true, fit: late.c.grade });
    assert.doesNotMatch(fitLine + ' ' + retLine, /Nothing to change|You.re on target|Optimize|maximum interval|higher target|raise the target/, retLine);
    assert.match(retLine, /under your target/);
  }
  assert.match(fitLine, /how you study, not from the settings/);
});

test('settings that do not fit: Poor, and the retention line agrees that tuning is the way out', () => {
  const half = grade(mismatched(halved, 1500, 3));
  const verdict = retentionVerdict({ n: 400, ok: 340 }, 0.9).verdict;
  const retLine = retentionAdvice({ n: 400, ok: 340 }, { n: 200, ok: 170 }, { n: 200, ok: 170 }, 0.9, { canOptimize: true, fit: half.c.grade });
  assert.match(retLine, /Optimize/);
  assert.match(fitAdvice(half.c, { canOptimize: true, retention: verdict }), /Run Optimize/);
  // on target with a fit that is not Good: the retention line does not claim there is nothing to change
  const onLine = retentionAdvice({ n: 400, ok: 360 }, { n: 200, ok: 180 }, { n: 200, ok: 180 }, 0.9, { fit: 'poor' });
  assert.match(onLine, /on target/);
  assert.doesNotMatch(onLine, /Nothing to change/);
  assert.match(retentionAdvice({ n: 400, ok: 360 }, { n: 200, ok: 180 }, { n: 200, ok: 180 }, 0.9, { fit: 'good' }), /Nothing to change/);
});

test('the fit line and the retention line never contradict each other', () => {
  const good = { grade: 'good' };
  assert.doesNotMatch(fitAdvice(good, { retention: 'on' }), /study|gap/);
  assert.match(fitAdvice(good, { retention: 'under' }), /comes from how you study, not from the settings/);
  assert.match(fitAdvice(good, { retention: 'over' }), /comes from how you study/);
  assert.match(fitAdvice({ grade: 'ok' }, { usingOwn: true }), /acceptable/);
  assert.match(fitAdvice({ grade: 'poor' }, { usingOwn: false, canOptimize: true }), /Run Optimize/);
  assert.match(fitAdvice({ grade: 'unknown' }), /Keep reviewing/);
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
  assert.notEqual(classifyFit(r).grade, 'poor', JSON.stringify([r, classifyFit(r)]));
  assert.equal(classifyFit(r).calibGrade, 'good');
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
  // both kinds of card equally under: the general line, with the way out
  const under = retentionAdvice({ n: 200, ok: 168 }, { n: 100, ok: 84 }, { n: 100, ok: 84 }, t, { canOptimize: true });
  assert.match(under, /Retention is 6 points under your target: consider fewer new cards or running Optimize/);
  // only the mature cards slip: the advice is about long gaps; only the young ones: about new cards
  assert.match(retentionAdvice({ n: 300, ok: 250 }, { n: 100, ok: 92 }, { n: 200, ok: 158 }, t), /mature cards \(21 days or more\) that slip.*maximum interval/);
  assert.match(retentionAdvice({ n: 300, ok: 250 }, { n: 200, ok: 158 }, { n: 100, ok: 92 }, t), /newer cards that slip.*fewer new cards/);
  // on target overall, but one kind slipping
  assert.match(retentionAdvice({ n: 400, ok: 358 }, { n: 100, ok: 98 }, { n: 300, ok: 260 }, t), /mature cards \(21 days or more\) are slipping/);
  assert.match(retentionAdvice({ n: 200, ok: 199 }, { n: 100, ok: 99 }, { n: 100, ok: 100 }, t), /above your target/);
  assert.match(retentionAdvice({ n: 200, ok: 180 }, { n: 100, ok: 90 }, { n: 100, ok: 90 }, t), /on target/);
  assert.match(retentionAdvice({ n: 5, ok: 5 }, { n: 5, ok: 5 }, { n: 0, ok: 0 }, t), /Not enough reviews/);
  assert.match(retentionAdvice({ n: 200, ok: 180 }, { n: 100, ok: 90 }, { n: 100, ok: 90 }, t), /Nothing to change/);
  assert.match(fitAdvice({ grade: 'poor' }, { usingOwn: false, canOptimize: true }), /Run Optimize/);
  assert.match(fitAdvice({ grade: 'good' }, {}), /predict your reviews well/);
  assert.match(hardAdvice({ passes: 100, share: 0.5, overuse: true }), /press Good/);
  assert.match(hardAdvice({ passes: 100, share: 0.2, overuse: false }), /normal/);
});

test('ignore-before: a valid local date no later than today, the start of that day, and rows before it dropped', () => {
  assert.equal(cleanIgnoreBefore('2026-03-05', new Date(2026, 5, 1).getTime()), '2026-03-05');
  assert.equal(cleanIgnoreBefore('2026-06-01', new Date(2026, 5, 1, 9).getTime()), '2026-06-01');          // today is allowed
  assert.equal(cleanIgnoreBefore('2026-06-02', new Date(2026, 5, 1, 23).getTime()), null);                  // tomorrow is not
  assert.equal(todayISO(new Date(2026, 5, 1, 23).getTime()), '2026-06-01');
  for (const bad of ['2026-02-30', '2999-01-01', '2026-13-01', '05/03/2026', '', null, undefined, 20260305, '2026-3-5']) assert.equal(cleanIgnoreBefore(bad), null, String(bad));
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
  assert.equal(acceptSetting('ignoreBefore', '2999-01-01').ok, false);                       // after today: refused
  assert.equal(acceptSetting('ignoreBefore', 20260305).ok, false);
  // a backup keeps a good date, drops a junk or future one (the rest of the backup still restores), and keeps null
  const keys = settings => restoredSettings(settings).map(([k]) => k);
  assert.ok(keys({ ignoreBefore: '2026-03-05', fuzz: true }).includes('ignoreBefore'));
  assert.ok(keys({ ignoreBefore: null }).includes('ignoreBefore'));
  assert.ok(!keys({ ignoreBefore: 'last week', fuzz: true }).includes('ignoreBefore'));
  assert.ok(keys({ ignoreBefore: 'last week', fuzz: true }).includes('fuzz'));
  assert.ok(!keys({ ignoreBefore: '2999-01-01' }).includes('ignoreBefore'));
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
