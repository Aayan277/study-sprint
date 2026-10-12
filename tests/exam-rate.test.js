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
if (!skip) register('./sim/loader.mjs', import.meta.url);
const load = async () => ({
  ...(await import('../js/srs.js')), ...(await import('../js/exam.js')), ...(await import('../js/queue.js')),
  ...(await import('../js/sched-settings.js')), ...(await import('../js/balance.js'))
});

const DAY = 86400000;
const NOW = new Date(2026, 9, 12, 10).getTime();

test('final pass: answering today\'s share does not make the next queue build pull more cards in', { skip }, async () => {
  const { rate, examOptions, examSchedule, splitCards, schedulerOptions } = await load();
  const deck = { id: 'd', examDate: '2026-10-17' };                      // 5 days left: the pass covers today and 4 more days
  const cards = [], states = new Map();
  for (let i = 0; i < 100; i++) {
    const id = 'c' + i;
    cards.push({ id, deckId: 'd' });
    states.set(id, { cardId: id, state: 2, stability: 4 + i * 0.05, difficulty: 5, reps: 3, lapses: 0, lastReview: NOW - 3 * DAY, due: NOW + 20 * DAY, scheduledDays: 23, elapsedDays: 0, learningSteps: 0 });
  }
  let t = NOW, reviewed = 0;
  for (let build = 0; build < 6; build++) {
    const due = splitCards(cards, states, t, examSchedule([deck], cards, states, t)).reviews;
    if (build === 0) assert.equal(due.length, 20);                       // 100 cards over 5 days
    else assert.equal(due.length, 0, `build ${build} found ${due.length} more`);
    for (const x of due) { states.set(x.card.id, rate(x.card.id, states.get(x.card.id), 3, examOptions(schedulerOptions({}), deck, t), t)); reviewed++; t += 1000; }
  }
  assert.equal(reviewed, 20);
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
  const deck = { id: 'd', examDate: '2026-10-17' };                      // 5 days left: the cards go on days 1..4
  const state = { cardId: 'c', state: 2, stability: 4, difficulty: 5, reps: 3, lapses: 0, lastReview: NOW - 2 * DAY, due: NOW, scheduledDays: 2, elapsedDays: 2, learningSteps: 0 };
  const loadMap = new Map([[dayKey(NOW + 4 * DAY), 9]]);                 // the last day is busy: Good goes to day 3 instead of day 4
  const opts = { ...examOptions(schedulerOptions({}), deck, NOW), balance: { load: loadMap } };
  const shown = previewIntervals(state, opts, NOW)[3];
  const real = rate('c', state, 3, { ...opts, balance: { load: new Map(loadMap) } }, NOW).due - NOW;
  assert.ok(real < 3 * DAY);                                             // day 3 at 6am, not day 4
  assert.equal(shown, real);
});
