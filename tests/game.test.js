// Tests for js/game.js (Play rules). Run with: node tests/game.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  questionFor, playableCards, canMultipleChoice, similarity, pickDistractors, weightedQueue,
  timeLimit, scoreAnswer, gradeFor, bestKey, LIGHTNING_MS
} from '../js/game.js';

// A repeatable "random" number source so tests always give the same result.
const seeded = (seed = 1) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let n = 0;
const card = (front, back, extra = {}) => ({ id: `c${n++}`, deckId: 'd1', front, back, tags: [], ...extra });

test('question types: front→back, back→front, typing uses the short side', () => {
  const c = card('Mitosis', 'Cell division into two identical cells');
  assert.deepEqual(questionFor(c, 'front'), { prompt: 'Mitosis', answer: 'Cell division into two identical cells' });
  assert.deepEqual(questionFor(c, 'back'), { prompt: 'Cell division into two identical cells', answer: 'Mitosis' });
  assert.deepEqual(questionFor(c, 'typing'), { prompt: 'Mitosis', answer: 'Cell division into two identical cells' });
  const longBack = card('ATP', 'x'.repeat(60));
  assert.deepEqual(questionFor(longBack, 'typing'), { prompt: 'x'.repeat(60), answer: 'ATP' });   // types the front instead
  const bothLong = card('y'.repeat(50), 'x'.repeat(60));
  assert.equal(questionFor(bothLong, 'typing'), null);
  assert.equal(playableCards([c, longBack, bothLong], 'typing').length, 2);
});

test('multiple choice needs 4 different answers', () => {
  const three = [card('a', '1'), card('b', '2'), card('c', '3')];
  assert.equal(canMultipleChoice(three, 'front'), false);
  assert.equal(canMultipleChoice([...three, card('d', '3!')], 'front'), false);   // "3!" counts as the same as "3"
  assert.equal(canMultipleChoice([...three, card('d', '4')], 'front'), true);
});

test('similarity', () => {
  assert.equal(similarity('mitosis', 'mitosis'), 1);
  assert.ok(similarity('mitosis', 'meiosis') > similarity('mitosis', 'photosynthesis'));
  assert.equal(similarity('ab', 'cd'), 0);
});

test('distractors: no duplicates, never the right answer, right count', () => {
  const pool = ['Mitosis', 'Meiosis', 'Osmosis', 'Diffusion', 'Mitosis!', 'Photosynthesis', 'Respiration', 'Glycolysis']
    .map((f, i) => card(f, `def ${i}`));
  const item = pool[0];
  const normal = pickDistractors(item, pool, 'back', { rnd: seeded(3) });
  assert.equal(normal.length, 3);
  assert.ok(!normal.some(l => /^mitosis/i.test(l)), 'the answer (or a duplicate of it) is never a wrong option');
  assert.equal(new Set(normal).size, 3);
  const hard = pickDistractors(item, pool, 'back', { hard: true, rnd: seeded(3) });
  assert.equal(hard.length, 5);
  assert.ok(hard.slice(0, 2).includes('Meiosis') && hard.slice(0, 2).includes('Osmosis'), 'Hard puts lookalikes first: ' + hard);
});

test('distractors prefer similar length and shared words on Normal', () => {
  const item = card('Supply', 'Amount of a good sellers offer at a price');
  const pool = [item,
    card('Demand', 'Amount of a good buyers want at a price'),
    card('Q1', 'Short'), card('Q2', 'No'), card('Q3', 'x'.repeat(200)),
    card('Elasticity', 'How much the amount bought changes with price')];
  const counts = {};
  for (let s = 1; s <= 40; s++) for (const l of pickDistractors(item, pool, 'front', { rnd: seeded(s) })) counts[l] = (counts[l] || 0) + 1;
  assert.ok(counts['Amount of a good buyers want at a price'] >= 35, JSON.stringify(counts));
});

test('weighted queue: right length, no back-to-back repeats, weak cards more often', () => {
  const items = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  const q = weightedQueue(items, 40, it => (it.id === 'a' ? 7 : 1), seeded(5));
  assert.equal(q.length, 40);
  for (let i = 1; i < q.length; i++) assert.notEqual(q[i].id, q[i - 1].id);
  // every card is used once before any repeats
  assert.deepEqual(new Set(q.slice(0, 4).map(x => x.id)).size, 4);
  assert.deepEqual(weightedQueue([], 5), []);
});

test('timers: classic, typing 1.8×, survival shrinks 3% with a 2s floor, lightning has none', () => {
  assert.equal(timeLimit({ fmt: 'classic', pace: 8 }), 8000);
  assert.equal(timeLimit({ fmt: 'classic', pace: 8, typing: true }), 14400);
  assert.equal(Math.round(timeLimit({ fmt: 'survival', pace: 8, i: 1 })), 7760);
  assert.equal(timeLimit({ fmt: 'survival', pace: 3, i: 200 }), 2000);
  assert.equal(timeLimit({ fmt: 'survival', pace: 3, i: 200, typing: true }), 3600);
  assert.equal(timeLimit({ fmt: 'lightning', pace: 8 }), Infinity);
  assert.equal(LIGHTNING_MS, 60000);
});

test('scoring matches Kanji Sprint', () => {
  // instant answer: 100 + 100 speed
  assert.equal(scoreAnswer({ ok: true, seconds: 0, limitMs: 8000, fmt: 'classic', streak: 0, score: 0 }).pts, 200);
  // half the time used, streak of 5 or more caps at ×1.5
  assert.equal(scoreAnswer({ ok: true, seconds: 4, limitMs: 8000, fmt: 'classic', streak: 9, score: 0 }).pts, 225);
  // Hard ×1.25 and Flash ×1.2
  assert.equal(scoreAnswer({ ok: true, seconds: 8, limitMs: 8000, fmt: 'classic', streak: 0, hard: true, flash: 800, score: 0 }).pts, 150);
  // Lightning speed bonus runs out after 3 seconds
  assert.equal(scoreAnswer({ ok: true, seconds: 1.5, limitMs: Infinity, fmt: 'lightning', streak: 0, score: 0 }).pts, 150);
  // wrong: 0 on Normal, −50 on Hard but never below 0
  assert.equal(scoreAnswer({ ok: false, score: 500 }).pts, 0);
  assert.equal(scoreAnswer({ ok: false, hard: true, score: 500 }).pts, -50);
  assert.equal(scoreAnswer({ ok: false, hard: true, score: 20 }).pts, -20);
});

test('grade stamp letters', () => {
  assert.deepEqual(gradeFor(1, 1), { letter: 'S', label: 'Outstanding' });
  assert.equal(gradeFor(0.9, 0.5).letter, 'A');
  assert.equal(gradeFor(0.7, 0.4).letter, 'B');
  assert.equal(gradeFor(0.62, 0.2).letter, 'C');
  assert.equal(gradeFor(0.3, 0).letter, 'D');
});

test('best score keys', () => {
  assert.equal(bestKey({ deckId: 'd1', fmt: 'classic', qtype: 'front', hard: true, flash: 800, len: 20 }), 'd1|classic|front|hard|800|20');
  assert.equal(bestKey({ fmt: 'survival', qtype: 'typing', len: 20 }), 'all|survival|typing|normal|0|-');
});
