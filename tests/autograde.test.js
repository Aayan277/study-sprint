// Tests for js/autograde.js (Play answers → review ratings). Run with: node tests/autograde.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoRating, scheduleDecision, applies, appliedRating, speedProfiles, speedKey, SPEED, AGAIN, HARD, GOOD, EASY, LIGHTNING_REF_MS } from '../js/autograde.js';
import { dayEnd } from '../js/days.js';

const NOW = new Date(2026, 9, 7, 15, 0).getTime();
const DAY = 86400000;

test('wrong or timed out is Again', () => {
  assert.equal(autoRating({ ok: false, ms: 1000, limitMs: 8000, typing: false }), AGAIN);
  assert.equal(autoRating({ ok: false, ms: 8000, limitMs: 8000, typing: true }), AGAIN);
});

test('multiple choice: slow is Hard, otherwise Good, never Easy', () => {
  assert.equal(autoRating({ ok: true, ms: 6000, limitMs: 8000, typing: false }), HARD);   // 75% used
  assert.equal(autoRating({ ok: true, ms: 4000, limitMs: 8000, typing: false }), GOOD);   // 50%
  assert.equal(autoRating({ ok: true, ms: 500, limitMs: 8000, typing: false }), GOOD);    // fast, still Good
});

test('typing: fast is Easy, normal Good, slow Hard', () => {
  assert.equal(autoRating({ ok: true, ms: 2000, limitMs: 14400, typing: true }), EASY);   // 14% used
  assert.equal(autoRating({ ok: true, ms: 7000, limitMs: 14400, typing: true }), GOOD);
  assert.equal(autoRating({ ok: true, ms: 12000, limitMs: 14400, typing: true }), HARD);
});

test('exactly 30% and 70% count as normal', () => {
  assert.equal(autoRating({ ok: true, ms: 3000, limitMs: 10000, typing: true }), GOOD);
  assert.equal(autoRating({ ok: true, ms: 7000, limitMs: 10000, typing: true }), GOOD);
});

test('Lightning (no per-question timer) measures against a fixed reference', () => {
  assert.equal(autoRating({ ok: true, ms: LIGHTNING_REF_MS * 0.8, limitMs: Infinity, typing: false }), HARD);
  assert.equal(autoRating({ ok: true, ms: 1000, limitMs: Infinity, typing: true }), EASY);
  assert.equal(autoRating({ ok: true, ms: 3000, limitMs: Infinity, typing: false }), GOOD);
});

test('due or overdue cards get the rating applied', () => {
  const overdue = { state: 2, due: NOW - 3 * DAY };
  const laterToday = { state: 2, due: dayEnd(NOW) - 1000 };
  assert.equal(scheduleDecision({ state: overdue, rating: GOOD, now: NOW }), 'due');
  assert.equal(scheduleDecision({ state: laterToday, rating: EASY, now: NOW }), 'due');
  assert.equal(scheduleDecision({ state: { state: 1, due: NOW + 5 * 60000 }, rating: HARD, now: NOW }), 'due');   // learning card
});

test('not due yet: only Again changes the schedule', () => {
  const future = { state: 2, due: NOW + 5 * DAY };
  assert.equal(scheduleDecision({ state: future, rating: GOOD, now: NOW }), 'not-due');
  assert.equal(scheduleDecision({ state: future, rating: EASY, now: NOW }), 'not-due');
  assert.equal(scheduleDecision({ state: future, rating: AGAIN, now: NOW }), 'again');
  assert.equal(applies('not-due'), false);
  assert.equal(applies('again'), true);
  assert.equal(applies('due'), true);
});

test('at most one change per card per day from Play', () => {
  const overdue = { state: 2, due: NOW - DAY };
  assert.equal(scheduleDecision({ state: overdue, rating: AGAIN, alreadyToday: true, now: NOW }), 'already');
  assert.equal(applies('already'), false);
});

test('new cards are left for Review', () => {
  assert.equal(scheduleDecision({ state: undefined, rating: AGAIN, now: NOW }), 'new');
  assert.equal(scheduleDecision({ state: { state: 0, due: NOW }, rating: GOOD, now: NOW }), 'new');
  assert.equal(applies('new'), false);
});

// ---- Play starts new cards in decks with an exam ----
test('new card, no exam: log only, it starts in Review', () => {
  assert.equal(scheduleDecision({ state: null, rating: GOOD, now: NOW }), 'new');
  assert.equal(scheduleDecision({ state: { state: 0 }, rating: AGAIN, now: NOW, examDeck: false }), 'new');
  assert.equal(applies('new'), false);
});

test('new card in an exam deck: the answer is its first review', () => {
  assert.equal(scheduleDecision({ state: null, rating: GOOD, now: NOW, examDeck: true }), 'first');
  assert.equal(scheduleDecision({ state: { state: 0 }, rating: AGAIN, now: NOW, examDeck: true }), 'first');
  assert.equal(applies('first'), true);
});

test('exam deck: the first review uses the usual rating (typing fast Easy, multiple choice never Easy, wrong Again)', () => {
  assert.equal(autoRating({ ok: true, ms: 1000, limitMs: 14400, typing: true }), EASY);
  assert.equal(autoRating({ ok: true, ms: 500, limitMs: 8000, typing: false }), GOOD);
  assert.equal(autoRating({ ok: false, ms: 500, limitMs: 8000, typing: false }), AGAIN);
});

test('exam deck: over the new-card limit it is only logged', () => {
  assert.equal(scheduleDecision({ state: null, rating: GOOD, now: NOW, examDeck: true, newRoom: false }), 'new-limit');
  assert.equal(applies('new-limit'), false);
});

test('exam deck: studied cards follow the old rules, and a new card already changed today is left alone', () => {
  const overdue = { state: 2, due: NOW - DAY };
  assert.equal(scheduleDecision({ state: overdue, rating: GOOD, now: NOW, examDeck: true }), 'due');
  assert.equal(scheduleDecision({ state: overdue, rating: GOOD, alreadyToday: true, now: NOW, examDeck: true }), 'already');
  assert.equal(scheduleDecision({ state: null, rating: GOOD, alreadyToday: true, now: NOW, examDeck: true }), 'already');
});

// ---- Survival's short timer ----
test('Survival: running out of time with under 3 seconds allowed is only logged', () => {
  const overdue = { state: 2, due: NOW - DAY }, future = { state: 2, due: NOW + 5 * DAY };
  const miss = { rating: AGAIN, now: NOW, timedOut: true, fmt: 'survival', limitMs: 2000 };
  assert.equal(scheduleDecision({ ...miss, state: overdue }), 'short-time');
  assert.equal(scheduleDecision({ ...miss, state: future }), 'short-time');
  assert.equal(scheduleDecision({ ...miss, state: null, examDeck: true }), 'short-time');
  assert.equal(applies('short-time'), false);
});

test('a timeout with 3 seconds or more, a wrong answer, or another format still counts', () => {
  const future = { state: 2, due: NOW + 5 * DAY }, overdue = { state: 2, due: NOW - DAY };
  assert.equal(scheduleDecision({ state: future, rating: AGAIN, now: NOW, timedOut: true, fmt: 'survival', limitMs: 3000 }), 'again');
  assert.equal(scheduleDecision({ state: overdue, rating: AGAIN, now: NOW, timedOut: true, fmt: 'survival', limitMs: 5000 }), 'due');
  assert.equal(scheduleDecision({ state: future, rating: AGAIN, now: NOW, timedOut: false, fmt: 'survival', limitMs: 2000 }), 'again');   // a wrong tap
  assert.equal(scheduleDecision({ state: future, rating: AGAIN, now: NOW, timedOut: true, fmt: 'classic', limitMs: 2000 }), 'again');
});

test('with a speed profile, answers are judged against your own usual time, not the timer', () => {
  const speed = 100;                                   // 100 ms per unit of text
  const chars = 15, expected = speed * (SPEED.c0 + chars);
  assert.equal(autoRating({ ok: true, ms: expected, limitMs: 1000, typing: true, speed, chars }), GOOD, 'usual pace = Good, even past the timer share');
  assert.equal(autoRating({ ok: true, ms: SPEED.hardX * expected + 1, limitMs: 1e9, typing: true, speed, chars }), HARD);
  assert.equal(autoRating({ ok: true, ms: SPEED.easyX * expected - 1, limitMs: 1e9, typing: true, speed, chars }), EASY);
  assert.equal(autoRating({ ok: true, ms: SPEED.easyX * expected - 1, limitMs: 1e9, typing: false, speed, chars }), GOOD, 'multiple choice is never Easy');
  assert.equal(autoRating({ ok: false, ms: 10, limitMs: 1e9, typing: true, speed, chars }), AGAIN);
});

test('a right multiple-choice answer on a due card counts at most as Hard; typing and other decisions are unchanged', () => {
  assert.equal(appliedRating({ decision: 'due', rating: GOOD, mc: true }), HARD);
  assert.equal(appliedRating({ decision: 'due', rating: HARD, mc: true }), HARD);
  assert.equal(appliedRating({ decision: 'due', rating: AGAIN, mc: true }), AGAIN);
  assert.equal(appliedRating({ decision: 'due', rating: EASY, mc: false }), EASY);
  assert.equal(appliedRating({ decision: 'first', rating: GOOD, mc: true }), GOOD);
});
