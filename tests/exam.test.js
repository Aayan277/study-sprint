// Tests for js/exam.js (exam date mode). Run with: node tests/exam.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { examStart, examInfo, countdown, examOptions, pullIn, examPrepQueue, EXAM_RETENTION } from '../js/exam.js';
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

test('cards scheduled after the exam are pulled in, weakest first', () => {
  const states = [
    { cardId: 'strong', state: 2, due: NOW + 60 * DAY, stability: 50, lastReview: NOW - 10 * DAY },
    { cardId: 'weak', state: 2, due: NOW + 30 * DAY, stability: 5, lastReview: NOW - 2 * DAY },
    { cardId: 'soon', state: 2, due: NOW + 2 * DAY, stability: 8 },
    { cardId: 'learning', state: 1, due: NOW + 60000, stability: 1 }
  ];
  const moved = pullIn(states, deck('2026-10-12'), NOW);
  assert.deepEqual(moved.map(s => s.cardId), ['weak', 'strong']);
  const start = examStart('2026-10-12');
  assert.ok(moved.every(s => s.due > dayEnd(NOW) && s.due < start));       // between tomorrow and the exam
  assert.ok(moved[0].due <= moved[1].due);
  assert.deepEqual(pullIn(states, deck('2026-10-07'), NOW), []);           // exam today: too late to move
  assert.deepEqual(pullIn(states, { id: 'd' }, NOW), []);
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
