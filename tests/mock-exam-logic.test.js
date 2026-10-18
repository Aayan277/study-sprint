// The Practice test rules: building a test, grading, scores by tag and subdeck, weakest-first order, resume state, history.
// Run with: node --test tests/test-logic.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTest, askable, cleanCfg, weakOrder, scoreRun, gradeAnswer, isAnswered, givenText, byTag, byDeck, missedIds, tagChoices, narrowByTags,
  newRun, newState, parseRun, timeLeft, retakeRun, addResult, recentResults, cleanHistory, cleanPrefs, clock, UNTAGGED, HISTORY_MAX, RUN_MAX_AGE
} from '../js/mock-exam-logic.js';

// a tiny seeded random, so the tests are repeatable
const seeded = (s = 7) => () => (s = (s * 16807) % 2147483647) / 2147483647;
const card = (i, o = {}) => ({ id: 'c' + i, deckId: 'd', front: `Term ${i}`, back: `Meaning ${i} text`, tags: [i % 2 ? 'odd' : 'even'], ...o });
const cards = n => Array.from({ length: n }, (_, i) => card(i));

test('cleanCfg keeps good choices and repairs bad ones', () => {
  const c = cleanCfg({ count: 9999, kinds: ['mc', 'nope'], limit: -3, order: 'x', counts: 'yes', tags: ['Bio', 5] });
  assert.deepEqual(c, { count: 20, kinds: ['mc'], limit: 0, order: 'random', counts: false, tags: ['bio'] });
  assert.equal(cleanCfg({ counts: true, order: 'weak', count: 'all', limit: 30 }).counts, true);
  assert.deepEqual(cleanCfg(null).kinds, ['mc', 'typing', 'cloze', 'tf']);
});

test('buildTest: the number of questions, no card twice, a mix of kinds', () => {
  const { questions, available } = buildTest(cards(30), { count: 10 }, { rnd: seeded() });
  assert.equal(questions.length, 10);
  assert.equal(available, 30);
  assert.equal(new Set(questions.map(q => q.cardId)).size, 10);
  const kinds = new Set(questions.map(q => q.kind));
  assert.ok(kinds.has('mc') && kinds.has('typing') && kinds.has('tf'), 'mixed: ' + [...kinds]);
  for (const q of questions) {
    if (q.kind === 'mc') { assert.ok(q.options.length >= 3 && q.options.includes(q.answer)); assert.equal(q.options.length, q.optIds.length); }
    if (q.kind === 'tf') assert.equal(q.truth, q.shown === q.answer);
  }
});

test('buildTest: All asks every card, and a count bigger than the deck asks all of them', () => {
  assert.equal(buildTest(cards(12), { count: 'all' }, { rnd: seeded() }).questions.length, 12);
  assert.equal(buildTest(cards(6), { count: 50 }, { rnd: seeded() }).questions.length, 6);
});

test('buildTest: All stops at 200 questions', () => {
  const { questions, available } = buildTest(cards(260), { count: 'all', kinds: ['typing'] }, { rnd: seeded() });
  assert.equal(questions.length, 200);
  assert.equal(available, 260);
});

test('buildTest: only the chosen kinds are used', () => {
  const { questions } = buildTest(cards(20), { count: 10, kinds: ['typing'] }, { rnd: seeded() });
  assert.ok(questions.length === 10 && questions.every(q => q.kind === 'typing' && q.qtype === 'typing'));
});

test('multiple choice and true or false need 4 different answers; typed questions do not', () => {
  const few = cards(3);
  const { questions } = buildTest(few, { count: 10 }, { rnd: seeded() });
  assert.equal(questions.length, 3);
  assert.ok(questions.every(q => q.kind === 'typing'));
  assert.equal(askable(few, { kinds: ['mc'] }).able.length, 0);
});

test('cloze cards are asked as a blank, and only cloze cards', () => {
  const cl = Array.from({ length: 5 }, (_, i) => card(i, { noteId: 'n' + i, cloze: 1, front: `The […] of ${i}`, back: `answer ${i}` }));
  const mix = [...cl, ...cards(10).map(c => ({ ...c, id: 'p' + c.id }))];
  const { questions } = buildTest(mix, { count: 'all', kinds: ['cloze', 'tf'] }, { rnd: seeded() });
  const blanks = questions.filter(q => q.kind === 'cloze');
  assert.equal(blanks.length, 5);
  assert.ok(blanks.every(q => q.prompt.includes('[…]') && q.cardId.startsWith('c') && q.qtype === 'typing'));
  assert.ok(questions.filter(q => q.kind === 'tf').every(q => q.cardId.startsWith('pc')));
});

test('cloze siblings of one note: one question each when not asking for all', () => {
  const sib = Array.from({ length: 6 }, (_, i) => card(i, { noteId: 'same', cloze: i + 1, front: `[…] ${i}`, back: `a${i}` }));
  const others = cards(8).map(c => ({ ...c, id: 'o' + c.id }));
  const { questions } = buildTest([...sib, ...others], { count: 8, kinds: ['typing', 'cloze'] }, { rnd: seeded() });
  assert.equal(questions.filter(q => q.cardId.startsWith('c')).length, 1);
});

test('narrowing by tags keeps only those cards, folders included', () => {
  const cs = [card(1, { tags: ['bio::cells'] }), card(2, { tags: ['chem'] }), card(3, { tags: [] })];
  assert.deepEqual(narrowByTags(cs, ['bio']).map(c => c.id), ['c1']);
  assert.equal(narrowByTags(cs, []).length, 3);
  assert.deepEqual(tagChoices(cs).map(t => t.tag).sort(), ['bio', 'chem']);
  const { questions } = buildTest(cards(20), { count: 'all', tags: ['odd'] }, { rnd: seeded() });
  assert.equal(questions.length, 10);
  assert.ok(questions.every(q => q.tags.includes('odd')));
});

test('weakOrder: lowest recall first, never studied last, more lapses break a tie', () => {
  const cs = cards(5);
  const r = { c0: 0.9, c1: 0.4, c2: null, c3: 0.4, c4: 0.7 };
  const lapses = { c3: 3 };
  assert.deepEqual(weakOrder(cs, c => r[c.id], c => lapses[c.id] || 0, seeded()).map(c => c.id), ['c3', 'c1', 'c4', 'c0', 'c2']);
});

test('Weakest first: the test takes the weakest cards, weakest first', () => {
  const cs = cards(20);
  const { questions } = buildTest(cs, { count: 5, order: 'weak' }, { recallOf: c => (+c.id.slice(1) + 1) / 100, rnd: seeded() });
  assert.deepEqual(questions.map(q => q.cardId), ['c0', 'c1', 'c2', 'c3', 'c4']);
});

test('grading: multiple choice, true or false, typed with typos and accepted answers, blanks', () => {
  const mc = { kind: 'mc', options: ['x', 'right', 'y'], answer: 'right', tags: [] };
  assert.ok(gradeAnswer(mc, 1) && !gradeAnswer(mc, 0) && !gradeAnswer(mc, null));
  const tf = { kind: 'tf', shown: 'a', answer: 'b', truth: false, tags: [] };
  assert.ok(gradeAnswer(tf, false) && !gradeAnswer(tf, true) && !gradeAnswer(tf, null));
  const ty = { kind: 'typing', answer: 'mitochondria', accept: ['powerhouse'], tags: [] };
  assert.ok(gradeAnswer(ty, 'Mitochondria') && gradeAnswer(ty, 'mitochondra') && gradeAnswer(ty, 'powerhouse'));
  assert.ok(!gradeAnswer(ty, 'nucleus') && !gradeAnswer(ty, '   ') && !gradeAnswer(ty, null));
  assert.equal(isAnswered(ty, '  '), false);
  assert.equal(givenText(mc, 1), 'right');
  assert.equal(givenText(tf, true), 'True');
});

test('scoreRun counts blanks as wrong and rounds the percentage', () => {
  const qs = [0, 1, 2].map(i => ({ kind: 'mc', options: ['a', 'b'], answer: 'a', tags: [], cardId: 'c' + i }));
  const s = scoreRun(qs, [0, 1, null]);
  assert.deepEqual([s.total, s.correct, s.wrong, s.answered, s.unanswered, s.pct], [3, 1, 2, 2, 1, 33]);
  assert.deepEqual(missedIds(qs, s.per), ['c1', 'c2']);
  assert.equal(scoreRun([], []).pct, 0);
});

test('score by tag (a question counts in each of its tags, untagged apart) and by subdeck, weakest first', () => {
  const mk = (id, deckId, tags) => ({ kind: 'mc', options: ['a', 'b'], answer: 'a', tags, cardId: id, deckId });
  const qs = [mk('1', 'd', ['bio', 'cells']), mk('2', 'd', ['bio']), mk('3', 's', ['chem']), mk('4', 's', [])];
  const s = scoreRun(qs, [0, 1, 0, 1]);
  const t = byTag(qs, s.per);
  assert.deepEqual(t.map(g => [g.key, g.correct, g.total, g.pct]), [[UNTAGGED, 0, 1, 0], ['bio', 1, 2, 50], ['cells', 1, 1, 100], ['chem', 1, 1, 100]]);
  const d = byDeck(qs, s.per);
  assert.deepEqual(d.map(g => [g.key, g.pct]), [['d', 50], ['s', 50]]);
});

test('a test in progress: save, resume, damaged and old data, time left', () => {
  const { questions } = buildTest(cards(10), { count: 5, limit: 10 }, { rnd: seeded() });
  const now = 1_000_000;
  const run = newRun({ count: 5, limit: 10 }, questions, 'd', now, 'id1');
  const st = newState(run, now);
  st.answers[0] = questions[0].kind === 'tf' ? true : questions[0].kind === 'mc' ? 1 : 'typed';
  st.i = 2; st.elapsed = 120000; st.flags[1] = true;
  const back = parseRun(JSON.stringify(run), JSON.stringify(st), now + 1000);
  assert.deepEqual(back.state.answers, st.answers);
  assert.equal(back.state.i, 2);
  assert.equal(back.run.questions.length, 5);
  assert.equal(timeLeft(back.run, back.state), 8 * 60000);
  assert.equal(timeLeft(newRun({ limit: 0 }, questions, 'd', now), st), Infinity);
  assert.equal(parseRun('{nope', JSON.stringify(st), now), null);
  assert.equal(parseRun(JSON.stringify(run), JSON.stringify({ ...st, id: 'other' }), now), null);
  assert.equal(parseRun(JSON.stringify(run), JSON.stringify({ ...st, answers: [1] }), now), null);
  assert.equal(parseRun(JSON.stringify(run), JSON.stringify(st), now + RUN_MAX_AGE + 1), null);
  assert.equal(parseRun(null, null, now), null);
  const again = retakeRun(back.run, now + 5);
  assert.deepEqual(again.questions, back.run.questions);
  assert.notEqual(again.id, back.run.id);
});

test('results history: newest last, at most ten, junk dropped, recent ones newest first', () => {
  let h = {};
  for (let i = 0; i < 12; i++) h = addResult(h, 'd', { at: i + 1, pct: i * 5, correct: i, total: 20, secs: 60 });
  assert.equal(h.d.length, HISTORY_MAX);
  assert.equal(h.d.at(-1).at, 12);
  assert.deepEqual(recentResults(h, 'd', 3).map(r => r.at), [12, 11, 10]);
  assert.deepEqual(recentResults(h, 'other'), []);
  assert.deepEqual(cleanHistory({ d: [{ at: 1, pct: 150, correct: 3, total: 4 }, { at: 'x' }, null], e: 'junk' }), { d: [{ at: 1, pct: 100, correct: 3, total: 4, secs: 0 }] });
  assert.deepEqual(cleanPrefs({ d: { count: 30 }, e: 5 }).d.count, 30);
  assert.equal(cleanPrefs({ e: 5 }).e, undefined);
});

test('clock formats minutes and hours', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(65000), '1:05');
  assert.equal(clock(3725000), '1:02:05');
});
