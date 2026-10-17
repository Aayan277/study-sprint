// Tests for js/postpone.js (Postpone reviews). Run with: node tests/postpone.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { postponeCandidates, postponeStates, defaultCount, averages, KEEP_R } from '../js/postpone.js';
import { recallAt } from '../js/exam.js';
import { dayEnd, dayStart } from '../js/days.js';

const NOW = new Date(2026, 9, 14, 15, 0).getTime();       // Wed 14 Oct 2026, 3pm
const DAY = 86400000;
const card = (id, extra = {}) => ({ id, deckId: 'd', front: id, back: id, ...extra });
// A review card last seen `ago` days ago with `stability` days; due `dueIn` days from now (negative = overdue).
const state = (id, stability, { ago = stability, dueIn = 0, st = 2 } = {}) =>
  ({ cardId: id, state: st, stability, difficulty: 5, lastReview: NOW - ago * DAY, due: NOW + dueIn * DAY, scheduledDays: Math.round(stability) });
const byId = list => new Map(list.map(s => [s.cardId, s]));

test('candidates: due reviews only, the most stable first', () => {
  const cards = ['a', 'b', 'c'].map(id => card(id));
  const states = byId([state('a', 5), state('b', 200, { ago: 30 }), state('c', 40, { ago: 10 })]);
  const list = postponeCandidates(cards, states, { days: 2, now: NOW, recallAt });
  assert.deepEqual(list.map(x => x.card.id), ['b', 'c', 'a']);
  assert.ok(list.every(x => x.before >= x.after && Math.abs(x.damage - (x.before - x.after)) < 1e-12));
});

test('candidates: leaves out new, learning, relearning, not-yet-due, suspended, buried and skipped cards', () => {
  const cards = [card('rev'), card('new'), card('learn'), card('relearn'), card('later'), card('susp', { suspended: true }), card('bury', { buriedUntil: NOW + DAY }), card('skip'), card('nostate')];
  const states = byId([state('rev', 30), state('new', 30, { st: 0 }), state('learn', 30, { st: 1 }), state('relearn', 30, { st: 3 }), state('later', 30, { dueIn: 3 }),
    state('susp', 30), state('bury', 30), state('skip', 30)]);
  const list = postponeCandidates(cards, states, { days: 1, now: NOW, recallAt, skip: c => c.id === 'skip' });
  assert.deepEqual(list.map(x => x.card.id), ['rev']);
});

test('candidates: due later today and overdue cards both count; due after today does not', () => {
  const cards = [card('today'), card('over'), card('tomorrow')];
  const states = byId([state('today', 30, { dueIn: 0.2 }), state('over', 30, { dueIn: -9 }), state('tomorrow', 30, { dueIn: (dayEnd(NOW) - NOW) / DAY + 0.01 })]);
  const ids = postponeCandidates(cards, states, { days: 1, now: NOW, recallAt }).map(x => x.card.id).sort();
  assert.deepEqual(ids, ['over', 'today']);
});

test('candidates: those that stay at 80% or better come first, so the default count is a prefix', () => {
  const cards = ['strong', 'weak', 'mid'].map(id => card(id));
  // weak: seen long ago with a small stability, so it is under 80% already
  const states = byId([state('strong', 300, { ago: 20 }), state('weak', 2, { ago: 12, dueIn: -10 }), state('mid', 60, { ago: 40 })]);
  const list = postponeCandidates(cards, states, { days: 3, now: NOW, recallAt });
  const n = defaultCount(list);
  assert.ok(list.slice(0, n).every(x => x.after >= KEEP_R));
  assert.ok(list.slice(n).every(x => x.after < KEEP_R));
  assert.equal(list[list.length - 1].card.id, 'weak');
  assert.equal(n, list.filter(x => x.after >= KEEP_R).length);
  assert.ok(n >= 1 && n < list.length);
});

test('averages: recall before and after for the first N', () => {
  const cards = ['a', 'b'].map(id => card(id));
  const list = postponeCandidates(cards, byId([state('a', 100, { ago: 50 }), state('b', 100, { ago: 50 })]), { days: 2, now: NOW, recallAt });
  const a = averages(list, 2);
  assert.ok(a.before > a.after && a.after > 0.8 && a.before < 1);
  assert.equal(averages(list, 0), null);
  assert.equal(averages([], 5), null);
});

test('postponeStates: due at 4am, N days ahead; scheduledDays worked out again; nothing else changes', () => {
  const cards = [card('a')];
  const st = state('a', 30, { ago: 25, dueIn: -1 });
  const list = postponeCandidates(cards, byId([st]), { days: 3, now: NOW, recallAt });
  const [next] = postponeStates(list, 3, NOW);
  const due = new Date(next.due);
  assert.equal(due.getHours(), 4);
  assert.equal(due.getMinutes(), 0);
  assert.equal(next.due, dayEnd(NOW, 2));
  assert.equal(next.due, dayStart(NOW) + 3 * DAY);                     // (no clock change in October)
  assert.equal(next.scheduledDays, Math.round((next.due - st.lastReview) / DAY));
  assert.equal(next.stability, st.stability);
  assert.equal(next.lastReview, st.lastReview);
  assert.equal(next.state, 2);
  assert.notEqual(next, st);                                           // a copy, not the same object
  assert.equal(postponeStates(list, 1, NOW)[0].due, dayEnd(NOW));
  assert.equal(postponeStates(list, 7, NOW)[0].due, dayEnd(NOW, 6));
});

test('postponeStates: 4am holds across a daylight-saving change', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./postpone-dst.child.mjs', import.meta.url))], { env: { ...process.env, TZ: 'Europe/London' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a card with no memory strength (stability 0) is still handled', () => {
  const list = postponeCandidates([card('z')], byId([{ ...state('z', 1), stability: 0 }]), { days: 1, now: NOW, recallAt });
  assert.equal(list.length, 1);
  assert.equal(list[0].after, 0);
});
