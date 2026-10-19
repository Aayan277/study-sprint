// Tests for js/game.js (Play rules). Run with: node tests/game.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  questionFor, playableCards, canMultipleChoice, similarity, pickDistractors, weightedQueue,
  timeLimit, scoreAnswer, gradeFor, bestKey, defaultQuestionType, LIGHTNING_MS
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

test('distractors from a big library: sampled, still the right count with no duplicates', () => {
  const pool = Array.from({ length: 5000 }, (_, i) => ({ ...card(`Term ${i}`, `Definition number ${i} of the course`), deckId: i % 2 ? 'a' : 'b' }));
  for (const hard of [false, true]) {
    const got = pickDistractors(pool[10], pool, 'back', { hard, rnd: seeded(9) });
    assert.equal(got.length, hard ? 5 : 3);
    assert.equal(new Set(got).size, got.length);
    assert.ok(!got.includes(pool[10].front));
  }
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

test('Play starts definition-style decks on Back → front', () => {
  const short = ['a', 'b', 'c'].map(x => card(x, 'short answer'));
  const long = ['a', 'b', 'c'].map(x => card(x, 'A definition that is clearly longer than forty characters'));
  assert.equal(defaultQuestionType(short), 'front');
  assert.equal(defaultQuestionType(long), 'back');
  assert.equal(defaultQuestionType([...long.slice(0, 1), ...short]), 'front');    // mostly short
  assert.equal(defaultQuestionType([]), 'front');
});

test('questions carry the prompt side\'s picture; a picture-only answer can\'t be asked', () => {
  const c = { id: 'p', front: 'Heart', back: 'Pumps blood', frontImage: 'img1', backImage: 'img2' };
  assert.deepEqual(questionFor(c, 'front'), { prompt: 'Heart', answer: 'Pumps blood', image: 'img1' });
  assert.deepEqual(questionFor(c, 'back'), { prompt: 'Pumps blood', answer: 'Heart', image: 'img2' });
  const picOnly = { id: 'q', front: '', back: 'Lung', frontImage: 'img3' };
  assert.equal(playableCards([picOnly], 'front').length, 1);         // see the picture, pick "Lung"
  assert.equal(playableCards([picOnly], 'back').length, 0);          // can't pick a picture from text options
});

test('a big pool mostly of Yes/No still gives enough different wrong options', () => {
  // 2000 cards: 1990 answer Yes/No, 10 have their own answers. A sample of 300 usually misses most of those 10.
  const pool = [];
  for (let i = 0; i < 1990; i++) pool.push(card(`Q${i}`, i % 2 ? 'Yes' : 'No'));
  for (let i = 0; i < 10; i++) pool.push(card(`Odd${i}`, `Other answer ${i}`));
  for (let seed = 1; seed <= 20; seed++) {
    const target = pool[seed * 7];
    assert.equal(pickDistractors(target, pool, 'front', { hard: true, rnd: seeded(seed) }).length, 5, `hard, seed ${seed}`);
    assert.equal(pickDistractors(target, pool, 'front', { rnd: seeded(seed) }).length, 3, `normal, seed ${seed}`);
  }
});

// ---------- cloze cards in Play ----------
const clz = (id, note, n, front, back, extra = {}) => ({ id, deckId: 'd', noteId: note, cloze: n, front, back, ...extra });

test('cloze cards always ask front → back', async () => {
  const { questionFor, playableCards, isCloze } = await import('../js/game.js');
  const c = clz('a', 'N', 1, 'The […] makes ATP', 'mitochondria');
  assert.ok(isCloze(c) && !isCloze({ id: 'x', front: 'a', back: 'b' }));
  assert.deepEqual(questionFor(c, 'front'), { prompt: 'The […] makes ATP', answer: 'mitochondria' });
  assert.equal(questionFor(c, 'back'), null);
  assert.deepEqual(questionFor(c, 'typing'), { prompt: 'The […] makes ATP', answer: 'mitochondria' });
  const long = clz('b', 'N', 2, 'Short front', 'x'.repeat(60));
  assert.equal(questionFor(long, 'typing'), null);          // the back is too long to type, and it is never turned round
  const basic = { id: 'p', front: 'cell', back: 'unit of life' };
  assert.deepEqual(playableCards([c, basic], 'back').map(x => x.id), ['p']);
  assert.deepEqual(playableCards([c, basic], 'front').map(x => x.id), ['a', 'p']);
});

test('cloze cards: options never include a sibling, and prefer other cloze answers', async () => {
  const { pickDistractors, canMultipleChoice, defaultQuestionType } = await import('../js/game.js');
  const cards = [
    clz('a', 'N', 1, 'The […] makes ATP', 'mitochondria'), clz('b', 'N', 2, 'The mitochondria makes […]', 'ATP'),
    clz('c', 'M', 1, 'The […] holds DNA', 'nucleus'), clz('d', 'M', 2, 'The nucleus holds […]', 'DNA'),
    clz('e', 'O', 1, 'The […] makes protein', 'ribosome'),
    { id: 'p', deckId: 'd', front: 'Cell', back: 'The basic unit of life' }
  ];
  for (let i = 0; i < 30; i++) {
    const opts = pickDistractors(cards[0], cards, 'front', { count: 3 });
    assert.ok(!opts.includes('ATP'), 'a sibling answer is never an option');
    assert.deepEqual(opts.sort(), ['DNA', 'nucleus', 'ribosome']);       // other cloze answers beat the long definition
  }
  assert.equal(canMultipleChoice(cards, 'front'), true);
  assert.equal(canMultipleChoice(cards, 'back'), false);                  // only one card can be asked back → front
  assert.equal(defaultQuestionType(cards.slice(0, 5)), 'front');
});

test('play: two cards of one note are never back to back', async () => {
  const { weightedQueue } = await import('../js/game.js');
  const cards = [clz('a', 'N', 1, 'f', 'b'), clz('b', 'N', 2, 'f', 'b'), clz('c', 'N', 3, 'f', 'b'), clz('d', 'M', 1, 'f', 'b'), clz('e', 'M', 2, 'f', 'b'), { id: 'p', front: 'x', back: 'y' }];
  for (let seed = 1; seed < 40; seed++) {
    let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const q = weightedQueue(cards, 60, () => 1, rnd);
    for (let i = 1; i < q.length; i++) assert.ok(!(q[i].noteId && q[i].noteId === q[i - 1].noteId), `seed ${seed} at ${i}`);
    // a list that continues an earlier one doesn't start with a sibling of the last card either
    const more = weightedQueue(cards, 10, () => 1, rnd, q.at(-1));
    assert.ok(!(more[0].noteId && more[0].noteId === q.at(-1).noteId));
  }
});

// ---------- image-occlusion cards in Play ----------
const occMasks = [
  { id: 'a', n: 1, shape: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'Aorta' }, { id: 'b', n: 2, shape: 'rect', x: 0.5, y: 0.1, w: 0.2, h: 0.2, label: 'Vena cava' },
  { id: 'c', n: 3, shape: 'rect', x: 0.1, y: 0.5, w: 0.2, h: 0.2, label: 'Left ventricle' }, { id: 'd', n: 4, shape: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
  { id: 'e', n: 5, shape: 'rect', x: 0.8, y: 0.5, w: 0.1, h: 0.2, label: 'Pulmonary vein' }];
const occ = (n, note = 'P', header = 'Heart', masks = occMasks) => ({ id: 'o' + n + note, deckId: 'd', noteId: note, front: `${header}: hidden part ${n}`, back: '', backImage: 'img', occlusion: { n, w: 100, h: 100, header, masks } });

test('occlusion cards: asked front → back with the picture; a label is needed; never back → front', async () => {
  const { isFrontOnly } = await import('../js/game.js');
  assert.deepEqual(questionFor(occ(1), 'front'), { prompt: 'Heart', answer: 'Aorta', occ: true });
  assert.deepEqual(questionFor(occ(1), 'typing'), { prompt: 'Heart', answer: 'Aorta', occ: true });
  assert.equal(questionFor(occ(1), 'back'), null);
  assert.equal(questionFor(occ(4), 'front'), null);                      // no label: not playable
  assert.equal(questionFor(occ(4), 'typing'), null);
  assert.equal(questionFor(occ(1, 'P', ''), 'front').prompt, 'Name the highlighted part');
  const longLabel = occ(1, 'P', 'Heart', [{ ...occMasks[0], label: 'x'.repeat(60) }]);
  assert.equal(questionFor(longLabel, 'typing'), null);                  // too long to type, but fine to pick
  assert.ok(questionFor(longLabel, 'front'));
  assert.ok(isFrontOnly(occ(1)) && !isFrontOnly({ id: 'p', front: 'a', back: 'b' }));
  const orphan = occ(9);                                                  // its group is gone: an ordinary card
  assert.ok(!isFrontOnly(orphan) && questionFor(orphan, 'front').prompt === orphan.front);
  assert.deepEqual(playableCards([occ(1), occ(4), { id: 'p', front: 'cell', back: 'unit' }], 'front').map(c => c.id), ['o1P', 'p']);
  assert.deepEqual(playableCards([occ(1)], 'back'), []);
});

test('occlusion cards: the other boxes of the picture are the best wrong options', () => {
  const pool = [1, 2, 3, 5].map(n => occ(n)).concat([
    { id: 'x', deckId: 'd', front: 'Cell', back: 'The basic unit of life' }, { id: 'y', deckId: 'd', front: 'Atom', back: 'Smallest part' }, occ(1, 'Q', 'Brain', [{ ...occMasks[0], label: 'Cortex' }])]);
  for (let i = 0; i < 20; i++) {
    const opts = pickDistractors(pool[0], pool, 'front', { count: 3, rnd: seeded(i + 1) });
    assert.deepEqual(opts.sort(), ['Left ventricle', 'Pulmonary vein', 'Vena cava']);        // siblings, not the other picture or the text cards
    assert.ok(!opts.includes('Aorta'));
  }
  // a plain card still never gets a sibling (nothing changed for cloze)
  const cl = [clz('a', 'N', 1, 'f', 'one'), clz('b', 'N', 2, 'f', 'two'), clz('c', 'M', 1, 'f', 'three')];
  assert.ok(!pickDistractors(cl[0], cl, 'front', { count: 3 }).includes('two'));
});

test('occlusion cards: a picture with 4 labelled boxes can be played as multiple choice, and back → front is never the default', () => {
  const pool = [1, 2, 3, 5].map(n => occ(n));
  assert.equal(canMultipleChoice(pool, 'front'), true);
  assert.equal(canMultipleChoice(pool, 'back'), false);
  assert.equal(defaultQuestionType([...pool, { id: 'p', front: 'a', back: 'x'.repeat(50) }]), 'back');       // only the plain card counts
  assert.equal(defaultQuestionType(pool), 'front');
});

// ---------- step-by-step cards in Play (B5) ----------
test('stepped cards are asked front → final step, never back → front', async () => {
  const { isFrontOnly, defaultQuestionType } = await import('../js/game.js');
  const withAnswer = { id: 's1', front: 'Solve 2x + 3 = 7', back: 'Step 1: subtract 3\nStep 2: divide by 2\nAnswer: x = 2' };
  const lastStep = { id: 's2', front: 'Solve 2x = 4', back: 'Step 1: halve both sides\nStep 2: x = 2' };
  const plain = { id: 'p', front: 'cell', back: 'unit of life' };
  assert.ok(isFrontOnly(withAnswer) && isFrontOnly(lastStep) && !isFrontOnly(plain));
  assert.deepEqual(questionFor(withAnswer, 'front'), { prompt: 'Solve 2x + 3 = 7', answer: 'x = 2' });
  assert.deepEqual(questionFor(withAnswer, 'typing'), { prompt: 'Solve 2x + 3 = 7', answer: 'x = 2' });
  assert.equal(questionFor(lastStep, 'front').answer, 'x = 2');             // no Answer line: the last step
  assert.equal(questionFor(withAnswer, 'back'), null);
  // a long final step can be picked from a list but not typed
  const long = { id: 's3', front: 'Why?', back: `Step 1: a\nStep 2: ${'long answer '.repeat(10)}` };
  assert.ok(questionFor(long, 'front'));
  assert.equal(questionFor(long, 'typing'), null);
  assert.equal(questionFor({ ...withAnswer, frontImage: 'm1' }, 'front').image, 'm1');
  assert.deepEqual(playableCards([withAnswer, plain], 'back').map(c => c.id), ['p']);
  assert.equal(defaultQuestionType([withAnswer, lastStep]), 'front');
  // one step only, or steps inside a formula, is an ordinary card
  assert.ok(!isFrontOnly({ id: 'o', front: 'q', back: 'Step 1: only one' }));
  assert.ok(!isFrontOnly({ id: 'm', front: 'q', back: 'Use $$\nStep 1: a\nStep 2: b\n$$ here' }));
});

test('distractors: withIds returns { label, id } of the card each option answers; the default stays labels', () => {
  const pool = ['Mitosis', 'Meiosis', 'Osmosis', 'Diffusion', 'Respiration', 'Glycolysis'].map((f, i) => card(f, `def ${i}`));
  const labels = pickDistractors(pool[0], pool, 'front', { rnd: seeded(5) });
  assert.ok(labels.every(l => typeof l === 'string'));
  const withIds = pickDistractors(pool[0], pool, 'front', { rnd: seeded(5), withIds: true });
  assert.deepEqual(withIds.map(o => o.label), labels);
  for (const o of withIds) {
    const owner = pool.find(c => c.id === o.id);
    assert.ok(owner && owner.id !== pool[0].id);
    assert.equal(questionFor(owner, 'front').answer, o.label);
  }
});

test('distractors: include forces an option in, for every seed, even from a big pool; the answer itself is never forced', () => {
  const pool = Array.from({ length: 30 }, (_, i) => card(`Term ${i}`, `definition number ${i}`));
  const want = pool[17].back;
  for (let s = 1; s <= 25; s++) {
    for (const hard of [false, true]) {
      const got = pickDistractors(pool[0], pool, 'front', { hard, rnd: seeded(s), include: [want] });
      assert.ok(got.includes(want), `seed ${s} hard ${hard}`);
      assert.equal(got.length, hard ? 5 : 3);
    }
  }
  const big = Array.from({ length: 700 }, (_, i) => card(`T${i}`, `unique answer ${i}`));
  assert.ok(pickDistractors(big[0], big, 'front', { rnd: seeded(2), include: [big[650].back] }).includes(big[650].back));
  assert.ok(!pickDistractors(pool[0], pool, 'front', { rnd: seeded(2), include: [pool[0].back] }).includes(pool[0].back));
  assert.equal(pickDistractors(pool[0], pool, 'front', { rnd: seeded(2), include: ['no such answer'] }).length, 3);
});

test('distractors: include never brings in a sibling of the card', () => {
  const a = card('{{c1::x}} and y', 'x', { noteId: 'N', cloze: 1 }), sib = card('x and {{c2::y}}', 'y', { noteId: 'N', cloze: 2 });
  const rest = Array.from({ length: 6 }, (_, i) => card(`s${i}`, `ans${i}`, { noteId: `M${i}`, cloze: 1 }));
  assert.ok(!pickDistractors(a, [a, sib, ...rest], 'front', { rnd: seeded(1), include: ['y'] }).includes('y'));
});

// ---------- "I was right" ----------
test('overrideEntry: accuracy and grade change, score, streak and lives do not', async () => {
  const { overrideEntry, canOverride, roundStats, gradeFor } = await import('../js/game.js');
  const wrong = { card: { id: 'a' }, ok: false, given: 'mi', seconds: 3, limitMs: 10000, speed: 0, mixedWith: 'b', typed: 'mi', target: 'x' };
  const rightOne = { card: { id: 'c' }, ok: true, given: 'z', seconds: 2, limitMs: 10000, speed: 0.8 };
  const round = { qtype: 'typing', fmt: 'classic', score: 480, streak: 0, bestStreak: 2, lives: 2, clock: 41000, log: [wrong, rightOne] };
  assert.equal(canOverride(round, wrong), true);
  const before = roundStats(round.log);
  assert.equal(before.accuracy, 0.5);
  const fixed = overrideEntry(round, wrong);
  assert.notEqual(fixed, wrong);                           // a new entry
  assert.equal(wrong.ok, false);                           // the old one is untouched
  assert.equal(fixed.ok, true);
  assert.equal(fixed.overridden, true);
  assert.equal(fixed.mixedWith, undefined);
  assert.equal(fixed.typed, undefined);
  assert.equal(fixed.given, 'mi');
  assert.ok(Math.abs(fixed.speed - 0.7) < 1e-9);           // 1 - 3s / 10s
  const after = roundStats([fixed, rightOne]);
  assert.equal(after.accuracy, 1);
  assert.equal(after.correct, 2);
  assert.ok(Math.abs(after.avgSpeed - 0.75) < 1e-9);          // the corrected answer's speed joins the right ones
  assert.notEqual(gradeFor(before.accuracy, before.avgSpeed).letter, gradeFor(after.accuracy, after.avgSpeed).letter);
  assert.deepEqual([round.score, round.streak, round.bestStreak, round.lives, round.clock], [480, 0, 2, 2, 41000]);
  assert.equal(canOverride(round, fixed), false);          // only once
  assert.equal(overrideEntry(round, fixed), fixed);
});

test('overrideEntry: only a typed, wrong answer that was really given', async () => {
  const { overrideEntry, canOverride } = await import('../js/game.js');
  const e = over => ({ card: { id: 'a' }, ok: false, given: 'x', seconds: 1, limitMs: 5000, speed: 0, ...over });
  assert.equal(canOverride({ qtype: 'front' }, e()), false);                         // multiple choice
  assert.equal(canOverride({ qtype: 'typing' }, e({ given: null })), false);        // out of time
  assert.equal(canOverride({ qtype: 'typing' }, e({ given: '' })), false);          // skipped
  assert.equal(canOverride({ qtype: 'typing' }, e({ given: '  ' })), false);
  assert.equal(canOverride({ qtype: 'typing' }, e({ ok: true })), false);
  assert.equal(canOverride({ qtype: 'typing' }, e()), true);
  const skip = e({ given: '' });
  assert.equal(overrideEntry({ qtype: 'typing' }, skip), skip);
  // Lightning has no per-question timer: speed is measured against 3 seconds
  const l = overrideEntry({ qtype: 'typing', fmt: 'lightning' }, e({ seconds: 1.5, limitMs: Infinity }));
  assert.ok(Math.abs(l.speed - 0.5) < 1e-9);
});

// ---------- elements cards in Play (item 4) ----------
test('elements cards are front-only; multiple choice answers with the elements joined by " · "; never typed', async () => {
  const { isFrontOnly } = await import('../js/game.js');
  const el = { id: 'e1', front: 'Negligence', back: 'Element 1: Duty\nElement 2: Breach\nElement 3: Causation\nElement 4: Damages' };
  const plain = { id: 'p', front: 'cell', back: 'unit of life' };
  assert.ok(isFrontOnly(el) && !isFrontOnly(plain));
  assert.deepEqual(questionFor(el, 'front'), { prompt: 'Negligence', answer: 'Duty · Breach · Causation · Damages' });
  assert.equal(questionFor(el, 'back'), null);
  assert.equal(questionFor(el, 'typing'), null);
  assert.equal(questionFor({ ...el, frontImage: 'm1' }, 'front').image, 'm1');
  assert.deepEqual(playableCards([el, plain], 'back').map(c => c.id), ['p']);
  assert.deepEqual(playableCards([el, plain], 'typing').map(c => c.id), ['p']);
  // one element, or "Elements: H, O", is an ordinary card
  assert.ok(!isFrontOnly({ id: 'o', front: 'q', back: 'Element 1: only one' }));
  assert.ok(!isFrontOnly({ id: 'c', front: 'Water', back: 'Elements: H, O' }));
});

test('defaultQuestionType: a pool that is mostly typing cards starts on Typing, unless you picked a type', () => {
  const mk = (n, typed) => Array.from({ length: n }, (_, i) => ({ id: `${typed ? 't' : 'f'}${i}`, front: 'q', back: 'a', typeIn: typed }));
  const isTyping = c => c.typeIn === true;
  assert.equal(defaultQuestionType([...mk(3, true), ...mk(2, false)], isTyping), 'typing');
  assert.equal(defaultQuestionType([...mk(2, true), ...mk(2, false)], isTyping), 'front', 'exactly half is not most');
  assert.equal(defaultQuestionType([...mk(1, true), ...mk(3, false)], isTyping), 'front');
  assert.equal(defaultQuestionType(mk(4, true)), 'front', 'without the predicate nothing counts');
  assert.equal(defaultQuestionType([], isTyping), 'front');
  const long = Array.from({ length: 3 }, (_, i) => ({ id: 'l' + i, front: 'q', back: 'x'.repeat(50) }));
  assert.equal(defaultQuestionType(long, isTyping), 'back', 'long definitions without typing cards keep their default');
});
