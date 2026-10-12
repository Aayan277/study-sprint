// Tests for js/balance.js (evening out reviews, easy days). Run with: node tests/balance.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzRange, loadByDay, pickDay } from '../js/balance.js';
import { dayKey } from '../js/stats-calc.js';

const NOW = new Date(2026, 9, 7, 15, 0).getTime();      // Wednesday 7 Oct 2026, 3pm
const DAY = 86400000;
const noJitter = () => 0;

test('the range FSRS allows around a gap', () => {
  assert.deepEqual(fuzzRange(1), [2, 2]);
  assert.deepEqual(fuzzRange(10), [8, 12]);
  assert.deepEqual(fuzzRange(100), [93, 107]);
  assert.deepEqual(fuzzRange(100, 101), [93, 101]);           // never past the maximum interval
});

test('picks the least busy day in the range', () => {
  const load = new Map([[dayKey(NOW + 8 * DAY), 30], [dayKey(NOW + 9 * DAY), 30], [dayKey(NOW + 10 * DAY), 25], [dayKey(NOW + 11 * DAY), 2], [dayKey(NOW + 12 * DAY), 40]]);
  assert.equal(pickDay(10, { load, now: NOW, random: noJitter }), 11);
  assert.equal(pickDay(2, { load, now: NOW }), 2);             // short gaps aren't moved
});

test('easy days count as busier', () => {
  // 10 days from Wed 7 Oct is Sat 17 Oct; the range is 8–12 days (Thu 15 – Mon 19). Nothing is due yet.
  const weekendOff = ['minimum', 'normal', 'normal', 'normal', 'normal', 'normal', 'minimum'];
  const d = pickDay(10, { easyDays: weekendOff, now: NOW, random: noJitter });
  const weekday = new Date(NOW + d * DAY).getDay();
  assert.ok(weekday !== 0 && weekday !== 6, `picked day ${d} (weekday ${weekday}), not the weekend`);
});

test('load from schedules', () => {
  const load = loadByDay([{ state: 2, due: NOW + DAY }, { state: 2, due: NOW + DAY + 3600000 }, { state: 1, due: NOW + DAY }, null]);
  assert.equal(load.get(dayKey(NOW + DAY)), 2);
});
