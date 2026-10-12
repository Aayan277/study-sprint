// Tests for js/exam.js (exam date mode). Run with: node tests/exam.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { examStart, examInfo, countdown, examOptions, pullIn, examPrepQueue, EXAM_RETENTION, recall, recallAt, finalWindow, planFinalPass, examSchedule, examGainFrom, examClamp, FINAL_DAYS } from '../js/exam.js';
import { dayStart, dayEnd } from '../js/days.js';

const NOW = new Date(2026, 9, 7, 15, 0).getTime();     // Wed 7 Oct 2026, 3pm
const DAY = 86400000;
const deck = examDate => ({ id: 'd', examDate });
const opts = { retention: 0.9, maxInterval: 36500, learningSteps: ['1m'], relearningSteps: ['10m'], fuzz: true };

test('exam day and countdown', () => {
  assert.equal(new Date(examStart('2026-10-20')).getDate(), 20);
  assert.equal(new Date(examStart('2026-10-20')).getHours(), 4);            // study days start at 4am
  assert.equal(examStart('nonsense'), null);
  assert.equal(countdown(examInfo(deck('2026-10-07'), NOW)), 'Exam today');
  assert.equal(countdown(examInfo(deck('2026-10-08'), NOW)), 'Exam tomorrow');
  assert.equal(countdown(examInfo(deck('2026-10-20'), NOW)), 'Exam in 13 days');
  assert.equal(examInfo(deck('2026-10-06'), NOW), null);                     // past: back to normal
  assert.equal(examInfo({ id: 'd' }, NOW), null);
});

test('scheduling options near the exam', () => {
  assert.deepEqual(examOptions(opts, { id: 'd' }, NOW), opts);              // no exam: unchanged
  const far = examOptions(opts, deck('2026-12-20'), NOW);
  assert.equal(far.retention, 0.9);                                         // more than 2 weeks out
  assert.equal(far.maxDue, examStart('2026-12-20'));                        // but nothing scheduled past it
  const near = examOptions(opts, deck('2026-10-12'), NOW);                  // 5 days to go
  assert.ok(near.retention > 0.9 && near.retention < EXAM_RETENTION);
  assert.equal(examOptions(opts, deck('2026-10-08'), NOW).retention, EXAM_RETENTION);   // the day before
  assert.equal(examOptions({ ...opts, retention: 0.97 }, deck('2026-10-08'), NOW).retention, 0.97);   // never lowered
  assert.equal(examOptions(opts, deck('2026-10-07'), NOW).maxDue, undefined);          // exam day itself
});

test('recall: 90% when a gap equals the stability, falling slowly', () => {
  assert.ok(Math.abs(recall(10, 10) - 0.9) < 1e-9);
  assert.equal(recall(10, 0), 1);
  assert.ok(recall(10, 30) < recall(10, 10) && recall(10, 30) > 0.5);
  assert.ok(recall(50, 10) > recall(5, 10));
  assert.equal(recallAt({ stability: 10, lastReview: NOW - 10 * DAY }, NOW), recall(10, 10));
});

test('the final pass window: the last 5 days, fewer when the exam is closer', () => {
  assert.equal(FINAL_DAYS, 5);
  assert.deepEqual(finalWindow(30), { first: 25, last: 29 });
  assert.deepEqual(finalWindow(5), { first: 0, last: 4 });
  assert.deepEqual(finalWindow(3), { first: 0, last: 2 });
  assert.deepEqual(finalWindow(1), { first: 0, last: 0 });
  assert.deepEqual(finalWindow(3, 1), { first: 1, last: 2 });
  assert.ok(finalWindow(1, 1).first > finalWindow(1, 1).last);          // nothing fits
});

// A review card seen `ago` days ago with the given stability, due `dueIn` days from now.
const review = (cardId, stability, ago, dueIn) => ({ cardId, state: 2, stability, lastReview: NOW - ago * DAY, due: NOW + dueIn * DAY });

test('cards scheduled after the exam are pulled in, weakest closest to the exam', () => {
  const states = [
    { ...review('strong', 50, 10, 60) },             // ~96% on exam day: needs nothing
    { ...review('weak', 5, 2, 30) },
    { ...review('weaker', 2, 1, 40) },
    { ...review('soon', 8, 0, 2) },                  // due before the exam anyway
    { cardId: 'learning', state: 1, due: NOW + 60000, stability: 1 }
  ];
  const moved = pullIn(states, deck('2026-10-12'), NOW);
  assert.deepEqual(moved.map(s => s.cardId), ['weak', 'weaker']);          // in day order; 'strong' stays where it is
  const start = examStart('2026-10-12');
  assert.ok(moved.every(s => s.due > dayEnd(NOW) && s.due < start));       // between tomorrow and the exam
  assert.ok(moved[0].due < moved[1].due);                                   // the weaker one is closer to the exam
  assert.deepEqual(pullIn(states, deck('2026-10-07'), NOW), []);           // exam today: too late to move
  assert.deepEqual(pullIn(states, deck('2026-10-08'), NOW), []);           // tomorrow is exam day: no day left
  assert.deepEqual(pullIn(states, { id: 'd' }, NOW), []);
});

test('final pass: cards that will still be 95% on exam day are left alone', () => {
  const info = examInfo(deck('2026-10-12'), NOW);                          // 5 days left
  const sure = review('sure', 200, 3, 100);
  assert.ok(recallAt(sure, info.start) >= EXAM_RETENTION);
  const plan = planFinalPass([sure, review('unsure', 3, 1, 100)], info, NOW);
  assert.deepEqual([...plan.keys()], ['unsure']);
});

test('final pass: spread evenly over the window, strongest first, weakest on the last days', () => {
  const info = examInfo(deck('2026-10-12'), NOW);                          // days 0..4 are the window
  const states = Array.from({ length: 10 }, (_, i) => review('c' + i, 1 + i * 0.5, 1, 90));    // c0 is the weakest
  const plan = planFinalPass(states, info, NOW);
  assert.equal(plan.size, 10);
  const perDay = [0, 0, 0, 0, 0];
  for (const d of plan.values()) perDay[d]++;
  assert.deepEqual(perDay, [2, 2, 2, 2, 2]);
  assert.ok(plan.get('c0') >= plan.get('c9'));                              // weakest no earlier than the strongest
  assert.equal(plan.get('c0'), 4);
  assert.equal(plan.get('c9'), 0);
});

test('final pass: reviews already due on a day count toward its share', () => {
  const info = examInfo(deck('2026-10-10'), NOW);                          // 3 days left: days 0..2
  const busy = Array.from({ length: 4 }, (_, i) => review('due' + i, 5, 3, -1));       // all overdue: day 0
  const late = Array.from({ length: 4 }, (_, i) => review('late' + i, 2 + i, 1, 90));
  const plan = planFinalPass([...busy, ...late], info, NOW);
  const perDay = [0, 0, 0];
  for (const d of plan.values()) perDay[d]++;
  assert.equal(perDay[0], 0);                                               // today is already full (4 of a target of 3)
  assert.equal(perDay[1] + perDay[2], 4);
});

test('final pass: nothing before the window, nothing for the exam day, learning cards left out', () => {
  const states = [review('a', 3, 1, 90), { ...review('b', 3, 1, 90), state: 3 }];
  const decks = [{ id: 'd', examDate: '2026-10-20' }];                      // 13 days away: window starts on day 8
  const far = examSchedule(decks, [{ id: 'a', deckId: 'd' }], new Map(states.map(s => [s.cardId, s])), NOW);
  assert.equal(far.caps.size, 0);
  const today = examSchedule([{ id: 'd', examDate: '2026-10-07' }], [{ id: 'a', deckId: 'd' }], new Map([['a', states[0]]]), NOW);
  assert.equal(today.caps.size, 0);
  const near = examSchedule([{ id: 'd', examDate: '2026-10-09' }], [{ id: 'a', deckId: 'd' }, { id: 'b', deckId: 'd' }], new Map(states.map(s => [s.cardId, s])), NOW);
  assert.deepEqual([...near.caps.keys()], ['a']);
});

test('examSchedule: a subdeck uses its parent\'s exam, and cards in no exam deck are untouched', () => {
  const decks = [{ id: 'p', examDate: '2026-10-09' }, { id: 'k', parentId: 'p' }, { id: 'other' }];
  const cards = [{ id: 'a', deckId: 'k' }, { id: 'b', deckId: 'other' }];
  const states = new Map([['a', review('a', 3, 1, 90)], ['b', review('b', 3, 1, 90)]]);
  const { caps } = examSchedule(decks, cards, states, NOW);
  assert.deepEqual([...caps.keys()], ['a']);
  assert.ok(caps.get('a') <= dayEnd(NOW) && caps.get('a') >= NOW - DAY);       // planned for today or tomorrow, as a start of day
});

test('examSchedule: the gain of each due review comes from gainOf', () => {
  const decks = [{ id: 'd', examDate: '2026-10-12' }];
  const cards = [{ id: 'a', deckId: 'd' }, { id: 'b', deckId: 'd' }];
  const states = new Map([['a', review('a', 3, 5, -1)], ['b', review('b', 3, 1, 30)]]);
  const { gain } = examSchedule(decks, cards, states, NOW, (card, st, start) => (start === examStart('2026-10-12') ? 0.1 : -1));
  assert.deepEqual([...gain], [['a', 0.1]]);                    // b isn't due today (and isn't planned for it either)
});

test('exam-day gain: a review helps weak, long-unseen cards most', () => {
  const start = examStart('2026-10-12');
  const gain = (st, good, again) => examGainFrom(st, good, again, start, NOW);
  const weak = { stability: 2, lastReview: NOW - 4 * DAY, due: NOW }, strong = { stability: 40, lastReview: NOW - 4 * DAY, due: NOW + 30 * DAY };
  assert.ok(gain(weak, 6, 1) > gain(strong, 100, 5));
  assert.ok(gain(weak, 6, 1) > 0);
  assert.ok(Math.abs(gain(strong, 40, 40)) < 0.05);                       // a review that changes nothing gains ~nothing
});

// A card as the FSRS library hands it back after a rating: just reviewed at NOW, next due `gap` days later.
const justRated = (stability, gap) => ({ stability, due: new Date(NOW + gap * DAY), scheduled_days: gap });

test('after a rating: a gap past the exam moves to the final days only when the card needs it', () => {
  const opts = { maxDue: examStart('2026-10-12') };                          // exam in 5 days
  const weak = examClamp(justRated(3, 20), NOW, opts);
  assert.ok(weak.due.getTime() > dayEnd(NOW) && weak.due.getTime() < opts.maxDue);       // on one of the days before the exam
  assert.equal(weak.scheduled_days, 4);                                      // no load given: the last day, the weakest's place
  const strong = examClamp(justRated(120, 200), NOW, opts);
  assert.equal(strong.due.getTime(), NOW + 200 * DAY);                       // still 95% on exam day: left alone
  const before = examClamp(justRated(3, 2), NOW, opts);
  assert.equal(before.due.getTime(), NOW + 2 * DAY);                         // comes back before the exam anyway
  assert.equal(examClamp(justRated(3, 20), NOW, {}).due.getTime(), NOW + 20 * DAY);       // no exam
  assert.equal(examClamp(justRated(3, 20), NOW, { maxDue: examStart('2026-10-07') }).due.getTime(), NOW + 20 * DAY);   // exam day itself
});

test('after a rating: the least busy of the final days', () => {
  const opts = { maxDue: examStart('2026-10-12') };
  const load = new Map([['2026-10-08', 5], ['2026-10-09', 0], ['2026-10-10', 3], ['2026-10-11', 3]]);
  const card = examClamp(justRated(3, 20), NOW, opts, load);
  assert.equal(new Date(card.due).getDate(), 9);
  // the day before the exam leaves no day to put it on
  assert.equal(examClamp(justRated(0.5, 20), NOW, { maxDue: examStart('2026-10-08') }).due.getTime(), NOW + 20 * DAY);
});

test('exam prep: not seen lately, weakest first, then new cards', () => {
  const card = id => ({ id, deckId: 'd' });
  const cards = ['recent', 'old-strong', 'old-weak', 'new1', 'new2'].map(card);
  const states = new Map([
    ['recent', { state: 2, stability: 3, lastReview: NOW - DAY }],
    ['old-strong', { state: 2, stability: 40, lastReview: NOW - 9 * DAY }],
    ['old-weak', { state: 3, stability: 2, lastReview: NOW - 5 * DAY }]
  ]);
  const { queue } = examPrepQueue(cards, states, NOW);
  assert.deepEqual(queue.map(q => [q.card.id, q.kind]), [['old-weak', 'learn'], ['old-strong', 'review'], ['new1', 'new'], ['new2', 'new']]);
});

test('exam prep orders by the chance of remembering now, not by stability', () => {
  const card = id => ({ id, deckId: 'd' });
  const states = new Map([
    ['shaky-yesterday', { state: 2, stability: 3, lastReview: NOW - 4 * DAY }],       // R = 0.80
    ['solid-long-ago', { state: 2, stability: 12, lastReview: NOW - 90 * DAY }]       // R = 0.65: weaker, though more stable
  ]);
  const { queue } = examPrepQueue(['shaky-yesterday', 'solid-long-ago'].map(card), states, NOW);
  assert.deepEqual(queue.map(q => q.card.id), ['solid-long-ago', 'shaky-yesterday']);
});

test('nearestExamDeck: nearest upcoming exam with cards, subdecks inherit, null without one', async () => {
  const { nearestExamDeck } = await import('../js/exam.js');
  const NOWT = new Date(2026, 9, 7, 15, 0).getTime();
  const iso = d => { const x = new Date(NOWT + d * 86400000); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const decks = [{ id: 'a', created: 1, examDate: iso(20) }, { id: 'b', created: 2, examDate: iso(5) }, { id: 'c', created: 3 }, { id: 'old', created: 4, examDate: iso(-3) }, { id: 'empty', created: 5, examDate: iso(1) }];
  const cards = ['a', 'b', 'c', 'old'].map(d => ({ id: 'x' + d, deckId: d }));
  assert.equal(nearestExamDeck(decks, cards, NOWT), 'b');
  assert.equal(nearestExamDeck([{ id: 'c', created: 1 }], [{ id: 'k', deckId: 'c' }], NOWT), null);
  // a subdeck uses its parent's exam; the parent wins the tie
  const tree = [{ id: 'p', created: 1, examDate: iso(9) }, { id: 'k', created: 2, parentId: 'p' }];
  assert.equal(nearestExamDeck(tree, [{ id: 'z', deckId: 'k' }], NOWT), 'p');
});
