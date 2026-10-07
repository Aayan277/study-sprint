// Tests for js/autograde.js (Play answers → review ratings). Run with: node tests/autograde.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoRating, scheduleDecision, applies, AGAIN, HARD, GOOD, EASY, LIGHTNING_REF_MS } from '../js/autograde.js';
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
