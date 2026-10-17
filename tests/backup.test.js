// Tests for backup checks (js/db.js) and the starter decks (js/jlpt.js). Run with: node tests/backup.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBackup, BACKUP_FORMAT, BACKUP_VERSION, cleanMixedWith, restoredSettings } from '../js/db.js';
import { STARTER_DECKS, starterCards } from '../js/jlpt.js';
import { checkAnswer, canType } from '../js/match.js';

const good = { format: BACKUP_FORMAT, version: BACKUP_VERSION, decks: [], cards: [], cardStates: [], reviewLog: [], settings: {} };

test('cloze fields must have the right type', () => {
  const card = extra => ({ id: 'c', front: 'f', back: 'b', ...extra });
  const bad = /invalid cloze fields/;
  assert.equal(checkBackup({ ...good, cards: [card({ noteId: 'N', cloze: 2, noteText: '{{c2::x}}' }), card({ id: 'd' })] }), null);
  assert.match(checkBackup({ ...good, cards: [card({ cloze: '1" onmouseover="alert(1)' })] }), bad);
  for (const cloze of [0, -1, 1.5, null, NaN, '2']) assert.match(checkBackup({ ...good, cards: [card({ cloze })] }), bad);
  assert.match(checkBackup({ ...good, cards: [card({ noteId: 5 })] }), bad);
  assert.match(checkBackup({ ...good, cards: [card({ noteText: { a: 1 } })] }), bad);
});

test('image-occlusion fields: a valid card passes; bad numbers, style tricks and a missing noteId are refused', () => {
  const m = extra => ({ id: 'm1', n: 1, shape: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2, ...extra });
  const card = (occ = {}, extra = {}) => ({ id: 'c', noteId: 'N', front: 'f', back: 'b', occlusion: { n: 1, w: 2048, h: 1365, header: 'Heart', masks: [m()], ...occ }, ...extra });
  const bad = /invalid image-occlusion fields/;
  assert.equal(checkBackup({ ...good, cards: [card(), card({ n: 2, masks: [m({ shape: 'ellipse', label: 'Aorta' }), m({ id: 'm2', n: 2, shape: 'polygon', points: [[0.1, 0.1], [0.3, 0.1], [0.2, 0.3]] })] }), { id: 'plain', front: 'a', back: 'b' }] }), null);
  assert.match(checkBackup({ ...good, cards: [card({ n: 0 })] }), bad);
  assert.match(checkBackup({ ...good, cards: [card({ n: 1.5 })] }), bad);
  assert.match(checkBackup({ ...good, cards: [card({ w: 0 })] }), bad);
  assert.match(checkBackup({ ...good, cards: [card({ masks: [] })] }), bad);
  assert.match(checkBackup({ ...good, cards: [card({ masks: [m({ x: 1.5 })] })] }), bad);                 // out of range
  assert.match(checkBackup({ ...good, cards: [card({ masks: [m({ x: '0.1;background:url(//evil)' })] })] }), bad);   // style injection
  assert.match(checkBackup({ ...good, cards: [card({ masks: [m({ shape: 'star' })] })] }), bad);
  assert.match(checkBackup({ ...good, cards: [card({ masks: [m({ label: 5 })] })] }), bad);
  assert.match(checkBackup({ ...good, cards: [card({}, { noteId: undefined })] }), bad);
  assert.match(checkBackup({ ...good, cards: [card({}, { noteId: 5 })] }), /cloze|image-occlusion/);
  assert.match(checkBackup({ ...good, cards: [card({ header: 5 })] }), bad);
  assert.match(checkBackup({ ...good, cards: [{ id: 'c', front: 'f', back: 'b', occlusion: 'x' }] }), bad);
});

test('a real backup passes the check', () => {
  assert.equal(checkBackup(good), null);
});

test('other files are refused with a clear message', () => {
  assert.match(checkBackup(null), /isn't a Study Sprint backup/);
  assert.match(checkBackup({ hello: 1 }), /isn't a Study Sprint backup/);
  assert.match(checkBackup([1, 2]), /isn't a Study Sprint backup/);
  assert.match(checkBackup({ ...good, version: BACKUP_VERSION + 1 }), /newer version/);
  assert.match(checkBackup({ ...good, cards: undefined }), /damaged \(missing cards\)/);
});

test('a backup with a broken record, bad color or SVG picture is refused', () => {
  assert.match(checkBackup({ ...good, cards: [{ front: 'no id' }] }), /record in cards has no id/);
  assert.match(checkBackup({ ...good, cardStates: [{ id: 'x' }] }), /cardStates has no cardId/);
  assert.match(checkBackup({ ...good, decks: [null] }), /record in decks/);
  assert.match(checkBackup({ ...good, decks: [{ id: 'd', color: 'red;position:fixed' }] }), /invalid color/);
  assert.equal(checkBackup({ ...good, decks: [{ id: 'd', color: '#3E63DD' }], cards: [{ id: 'c' }], cardStates: [{ cardId: 'c' }] }), null);
  assert.match(checkBackup({ ...good, media: [{ id: 'm', type: 'image/svg+xml', data: '' }] }), /not a supported image/);
  assert.equal(checkBackup({ ...good, media: [{ id: 'm', type: 'image/jpeg', data: '' }] }), null);
});

test('starter decks: 102 N5 and 180 N4 kanji', () => {
  assert.deepEqual(STARTER_DECKS.map(d => starterCards(d.level).length), [102, 180]);
  const all = STARTER_DECKS.flatMap(d => starterCards(d.level));
  assert.ok(all.every(c => c.front && c.back && c.tags.length === 2), 'every card has a front, back and tags');
  assert.equal(new Set(all.map(c => c.front)).size, all.length, 'no kanji appears twice');
});

test('starter cards: typing a meaning or a reading counts as right', () => {
  const one = starterCards('N5')[0];
  assert.deepEqual(one, { front: '一', back: 'one; いち / ひと(つ)', tags: ['N5', 'numbers & time'] });
  assert.ok(checkAnswer('one', one.back).correct);
  assert.ok(checkAnswer('いち', one.back).correct);
  assert.ok(checkAnswer('ひとつ', one.back).correct);
  assert.ok(checkAnswer('ひと', one.back).correct);
  assert.equal(checkAnswer('two', one.back).correct, false);
  // Most backs are short enough to type (40 characters or less).
  const typeable = STARTER_DECKS.flatMap(d => starterCards(d.level)).filter(c => canType(c.back)).length;
  assert.ok(typeable > 270, `${typeable} of 282 typeable`);
});

test('the catch-up plan in a backup: a good one (or none) passes, a damaged one is refused', () => {
  const plan = { start: 1_800_000_000_000, days: 3, backlog: 150, pauseNew: true, at: 1_800_000_000_000 };
  const withPlan = rescue => ({ ...good, settings: { rescue } });
  assert.equal(checkBackup(withPlan(plan)), null);
  assert.equal(checkBackup(withPlan(null)), null);
  assert.equal(checkBackup(good), null);
  assert.equal(checkBackup(withPlan({ ...plan, pauseNew: undefined })), null);
  const bad = /catch-up plan/;
  for (const r of [{ ...plan, start: 'x' }, { ...plan, days: 0 }, { ...plan, days: 2.5 }, { ...plan, days: 99 }, { ...plan, backlog: -1 }, { ...plan, backlog: '5' },
    { ...plan, pauseNew: 'yes' }, { ...plan, at: NaN }, '<img src=x>', 7, [plan]]) assert.match(checkBackup(withPlan(r)), bad);
});

test('mixedWith on a log row is accepted by the check, and cleaned to a string of 1 to 200 characters', () => {
  const row = extra => ({ cardId: 'c', timestamp: 1, correct: false, ...extra });
  assert.equal(checkBackup({ ...good, reviewLog: [row({ mixedWith: 'card-b' }), row({ mixedWith: 5 }), row({ mixedWith: '' }), row()] }), null);
  assert.equal(cleanMixedWith(row({ mixedWith: 'card-b' })).mixedWith, 'card-b');
  assert.equal(cleanMixedWith(row({ mixedWith: 'x'.repeat(200) })).mixedWith.length, 200);
  for (const bad of ['', 'x'.repeat(201), 5, null, ['a'], { a: 1 }, true]) {
    const cleaned = cleanMixedWith(row({ mixedWith: bad }));
    assert.ok(!('mixedWith' in cleaned), String(bad).slice(0, 10));
    assert.equal(cleaned.cardId, 'c');
  }
  const plain = row();
  assert.equal(cleanMixedWith(plain), plain);
});

test('dailyGoal in a backup: a whole number from 1 to 500 (or none) passes, anything else is refused', () => {
  const withGoal = dailyGoal => ({ ...good, settings: { dailyGoal } });
  for (const g of [1, 20, 500, null, undefined]) assert.equal(checkBackup(withGoal(g)), null);        // null or missing means the default
  for (const g of [0, -5, 501, 2.5, '20', NaN, [20], {}, true]) assert.match(checkBackup(withGoal(g)), /daily goal/);
});

test('glossary terms in a backup: the backup still passes, and bad terms are dropped on restore (cleanGlossary)', async () => {
  const { cleanGlossary } = await import('../js/glossary.js');
  const settings = { 'gloss:a': { term: 'ATP', aliases: ['adenosine triphosphate'], def: 'energy', at: 5 }, 'gloss:b': { nope: 1 }, 'gloss:c': null, dailyGoal: 20 };
  assert.equal(checkBackup({ ...good, settings }), null);
  const out = cleanGlossary(settings);
  assert.deepEqual(out['gloss:a'], settings['gloss:a']);            // a good term round-trips unchanged
  assert.ok(!('gloss:b' in out) && out['gloss:c'] === null && out.dailyGoal === 20);
});

test('fsrsParams in a backup: a good value, a reset or none passes; a restore keeps the good one and leaves junk out', () => {
  const mine = { w: Array(21).fill(0.5), at: 1, reviews: 450, cards: 90, version: 'fsrs-6' };
  const withParams = fsrsParams => ({ ...good, settings: { fsrsParams } });
  for (const v of [mine, { w: null, at: 2, version: 'fsrs-6' }, null, undefined]) assert.equal(checkBackup(withParams(v)), null);
  assert.equal(checkBackup({ ...good, settings: { fsrsParams: { w: [1], version: 'fsrs-9' } } }), null);       // not fatal: the weights are derived data
  const restore = settings => Object.fromEntries(restoredSettings(settings));
  assert.deepEqual(restore({ fsrsParams: mine, dailyGoal: 30 }), { fsrsParams: mine, dailyGoal: 30 });
  assert.equal(restore({ fsrsParams: null }).fsrsParams, null);
  for (const bad of [{ ...mine, version: 'fsrs-7' }, { ...mine, w: mine.w.slice(1) }, { ...mine, w: Array(21).fill(Infinity) }, 'x', 7, []]) {
    const out = restore({ fsrsParams: bad, dailyGoal: 30 });
    assert.ok(!('fsrsParams' in out), 'a value that does not clean is left out, not stored as null (that could wipe synced weights)');
    assert.equal(out.dailyGoal, 30);                                                                            // the rest of the settings still come back
  }
  // this device's sign-in and sync bookmarks are never restored
  assert.deepEqual(restore({ syncAuth: { a: 1 }, syncState: { b: 2 }, theme: 'x' }), { theme: 'x' });
  assert.deepEqual(restore(undefined), {});
});
