// Tests that run exam.js together with the real FSRS scheduling (srs.js). Run with: node tests/exam-rate.test.js
// srs.js loads ts-fsrs from a CDN, which Node can't open: tests/sim/loader.mjs points it at a local copy.
//   npm install --no-save ts-fsrs@5.4.2      (or set TS_FSRS_PATH to its dist/index.mjs)
// Without that copy these tests are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync } from 'node:fs';

const local = process.env.TS_FSRS_PATH || new URL('../node_modules/ts-fsrs/dist/index.mjs', import.meta.url).pathname;
const skip = existsSync(local) ? false : 'ts-fsrs 5.4.2 is not installed';
if (skip) console.warn('\n*** ts-fsrs not installed: the scheduler tests in exam-rate.test.js are SKIPPED. Run `npm install` (ts-fsrs 5.4.2 is a devDependency). ***\n');
if (!skip) register('./sim/loader.mjs', import.meta.url);
const load = async () => ({
  ...(await import('../js/srs.js')), ...(await import('../js/exam.js')), ...(await import('../js/queue.js')),
  ...(await import('../js/sched-settings.js')), ...(await import('../js/balance.js'))
});

const DAY = 86400000;
const NOW = new Date(2026, 9, 12, 10).getTime();

// ---------- the forgetting curve follows your own w20 (needs no ts-fsrs) ----------
import { recall, recallAt, examClamp, examGainFrom, readiness, planFinalPass, examInfo, DEFAULT_W20 } from '../js/exam.js';
const wWith20 = w20 => Array.from({ length: 21 }, (_, i) => (i === 20 ? w20 : 1));

test('recall: 90% when the days equal the stability, whatever the decay; the default is FSRS-6\'s w20', () => {
  assert.equal(DEFAULT_W20, 0.1542);
  for (const w20 of [undefined, 0.1542, 0.3, 0.8]) assert.ok(Math.abs(recall(12, 12, w20) - 0.9) < 1e-12, String(w20));
  assert.equal(recall(100, 7), recall(100, 7, 0.1542));                      // no argument = the default
  assert.equal(recall(0, 5, 0.3), 0);
  assert.equal(recall(10, -3, 0.3), 1);                                      // never before the last review
});

test('recall: your own w20 changes the curve (checked against the formula)', () => {
  for (const [s, t, w20] of [[100, 7, 0.8], [5, 30, 0.3], [40, 400, 0.12], [2, 1, 0.5]]) {
    const factor = 0.9 ** (-1 / w20) - 1;
    assert.ok(Math.abs(recall(s, t, w20) - (1 + factor * t / s) ** -w20) < 1e-12);
  }
  assert.ok(recall(5, 50, 0.5) < recall(5, 50, 0.1542));                      // a steeper curve forgets more after a long gap
  assert.ok(recall(100, 7, 0.8) > recall(100, 7, 0.1542));                    // and less during a short one
  // kept inside the range the scheduler allows, so a wild value can't give NaN or Infinity
  assert.equal(recall(10, 20, 0), recall(10, 20, 0.1));
  assert.equal(recall(10, 20, 9), recall(10, 20, 0.8));
  assert.ok(Number.isFinite(recall(10, 20, -2)));
});

test('recallAt, examGainFrom and readiness take the decay too', () => {
  const st = { stability: 20, lastReview: NOW - 5 * DAY, due: NOW + 20 * DAY, scheduledDays: 25, state: 2 };
  assert.equal(recallAt(st, NOW), recall(20, 5));
  assert.equal(recallAt(st, NOW, 0.5), recall(20, 5, 0.5));
  const gain = (w20) => examGainFrom(st, 60, 3, NOW + 30 * DAY, NOW, w20);
  assert.equal(gain(), gain(0.1542));
  assert.ok(Math.abs(gain(0.5) - gain()) > 0.01, 'a different decay gives a different gain');
  const p = recall(20, 5, 0.5);
  assert.ok(Math.abs(gain(0.5) - (p * recall(60, 30 - 0, 0.5) + (1 - p) * recall(3, 30, 0.5) - recall(20, 35, 0.5))) < 1e-12);
  const cards = [{ id: 'a' }, { id: 'b' }], states = new Map([['a', st], ['b', { ...st, stability: 3 }]]);
  assert.deepEqual(readiness(cards, states, NOW), readiness(cards, states, NOW, 0.1542));
  assert.equal(readiness(cards, states, NOW + 40 * DAY, 0.8).total, 2);
});

test('examClamp: whether a card still needs a review before the exam follows your w20', () => {
  const maxDue = new Date(2026, 9, 19, 4).getTime(), now = maxDue - 7 * DAY;           // the exam is 7 days away
  const run = opts => {
    const card = { due: new Date(maxDue + 5 * DAY), stability: 100, scheduled_days: 40 };
    const before = card.due.getTime();
    return examClamp(card, now, { maxDue, ...opts }).due.getTime() !== before;
  };
  assert.ok(recall(100, 7) < 0.99 && recall(100, 7, 0.8) >= 0.99);                  // 98.98% with the default curve, 99.2% with a w20 of 0.8
  assert.equal(run({}), true, 'with the standard curve it is brought forward');
  assert.equal(run({ w: wWith20(0.8) }), false, 'with this learner\'s flatter early curve it can wait');
  assert.equal(run({ w: wWith20(0.1542) }), true);
});

test('planFinalPass: which cards need a final review follows your w20', () => {
  const info = examInfo({ examDate: '2026-10-15' }, NOW);
  const mk = id => ({ cardId: id, state: 2, stability: 53, lastReview: NOW - DAY, due: info.start + 3 * DAY, scheduledDays: 20 });
  const states = [mk('a'), mk('b')];
  const onExamDay = w20 => recallAt(states[0], info.start, w20);
  assert.ok(onExamDay() < 0.99 && onExamDay(0.8) >= 0.99, `${onExamDay()} ${onExamDay(0.8)}`);
  assert.equal(planFinalPass(states, info, NOW, 0).size, 2);                    // the standard curve: both cards get a last review
  assert.equal(planFinalPass(states, info, NOW, 0, undefined, 0.1542).size, 2);
  assert.equal(planFinalPass(states, info, NOW, 0, undefined, 0.8).size, 0);    // a flatter early curve: they will still be remembered
});

// ---------- the scheduler really uses your weights (needs ts-fsrs) ----------
test('rate and previewIntervals use the weights in the options; the default weights give the same answers as none', { skip }, async () => {
  const { rate, previewIntervals, schedulerOptions } = await load();
  const lib = await import(new URL('file://' + local).href);
  const state = { cardId: 'c', state: 2, stability: 10, difficulty: 5, reps: 3, lapses: 0, lastReview: NOW - 10 * DAY, due: NOW, scheduledDays: 10, elapsedDays: 10, learningSteps: 0 };
  const base = { ...schedulerOptions({}), fuzz: false };
  const fsrsParams = w => ({ w, at: 1, version: 'fsrs-6' });
  const same = { ...schedulerOptions({ fsrsParams: fsrsParams([...lib.default_w]) }), fuzz: false };
  const mine = { ...schedulerOptions({ fsrsParams: fsrsParams([...lib.default_w].map((x, i) => (i === 8 ? 2.6 : i === 20 ? 0.3 : x))) }), fuzz: false };
  assert.deepEqual(previewIntervals(state, same, NOW), previewIntervals(state, base, NOW));
  assert.deepEqual(rate('c', state, 3, same, NOW), rate('c', state, 3, base, NOW));
  const a = rate('c', state, 3, base, NOW), b = rate('c', state, 3, mine, NOW);
  assert.notEqual(a.stability, b.stability);
  assert.notDeepEqual(previewIntervals(state, mine, NOW), previewIntervals(state, base, NOW));
  // switching back to the standard weights switches the scheduler back (the cache follows the options)
  assert.deepEqual(rate('c', state, 3, base, NOW), a);
});

test('final pass: answering today\'s share does not make the next queue build pull more cards in', { skip }, async () => {
  const { rate, examOptions, examSchedule, splitCards, schedulerOptions } = await load();
  const deck = { id: 'd', examDate: '2026-10-15' };                      // 3 days left: the pass covers today and 2 more days
  const cards = [], states = new Map();
  for (let i = 0; i < 100; i++) {
    const id = 'c' + i;
    cards.push({ id, deckId: 'd' });
    states.set(id, { cardId: id, state: 2, stability: 30 + i * 0.05, difficulty: 5, reps: 3, lapses: 0, lastReview: NOW - 3 * DAY, due: NOW + 20 * DAY, scheduledDays: 23, elapsedDays: 0, learningSteps: 0 });
  }
  // ~98% on exam day, so all are in the pass; a Good answer makes a card sure enough (99%) to leave it, so it isn't planned again.
  let t = NOW, reviewed = 0;
  for (let build = 0; build < 6; build++) {
    const due = splitCards(cards, states, t, examSchedule([deck], cards, states, t)).reviews;
    if (build === 0) assert.equal(due.length, 34);                       // 100 cards over 3 days (34, 33, 33)
    else assert.equal(due.length, 0, `build ${build} found ${due.length} more`);
    for (const x of due) { states.set(x.card.id, rate(x.card.id, states.get(x.card.id), 3, examOptions(schedulerOptions({}), deck, t), t)); reviewed++; t += 1000; }
  }
  assert.equal(reviewed, 34);
});

test('rating: a card the exam moves is only taken off the day balancing put it on if balancing counted it there', { skip }, async () => {
  const { rate, examOptions, schedulerOptions, dayKey } = { ...(await load()), ...(await import('../js/stats-calc.js')) };
  const deck = { id: 'd', examDate: '2026-10-14' };                      // 2 days left
  // A Hard answer on a shaky card gives a gap of 2 days: too short for balancing (it needs 3), so it isn't counted
  // on that day. The exam then moves it to tomorrow.
  const state = { cardId: 'c', state: 2, stability: 1.5, difficulty: 5, reps: 3, lapses: 0, lastReview: NOW - DAY, due: NOW, scheduledDays: 1, elapsedDays: 1, learningSteps: 0 };
  const loadMap = new Map([[dayKey(NOW + 2 * DAY), 3]]);                 // 3 other cards due in 2 days
  const next = rate('c', state, 2, { ...examOptions(schedulerOptions({}), deck, NOW), balance: { load: loadMap } }, NOW);
  assert.equal(next.scheduledDays, 1);
  assert.equal(loadMap.get(dayKey(NOW + 2 * DAY)), 3);                   // untouched
  assert.equal(loadMap.get(dayKey(NOW + DAY)), 1);                       // the card is counted where it went
});

test('preview: the button labels show the day the exam will put the card on, given the busy days', { skip }, async () => {
  const { rate, previewIntervals, examOptions, schedulerOptions, dayKey } = { ...(await load()), ...(await import('../js/stats-calc.js')) };
  const deck = { id: 'd', examDate: '2026-10-15' };                      // 3 days left: the cards go on days 1..2
  const state = { cardId: 'c', state: 2, stability: 4, difficulty: 5, reps: 3, lapses: 0, lastReview: NOW - 2 * DAY, due: NOW, scheduledDays: 2, elapsedDays: 2, learningSteps: 0 };
  const loadMap = new Map([[dayKey(NOW + 2 * DAY), 9]]);                 // the last day is busy: Good goes to day 1 instead of day 2
  const opts = { ...examOptions(schedulerOptions({}), deck, NOW), balance: { load: loadMap } };
  const shown = previewIntervals(state, opts, NOW)[3];
  const real = rate('c', state, 3, { ...opts, balance: { load: new Map(loadMap) } }, NOW).due - NOW;
  assert.ok(real < 2 * DAY);                                             // day 1 at 6am, not day 2
  assert.equal(shown, real);
});
