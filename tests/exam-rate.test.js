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
