// Tests for js/autotag.js ("Suggest tags" for a deck). Run with: node --test tests/autotag.test.js
//
// The fixtures in tests/fixtures/autotag/ are decks as a student might have made them (JSON: { name, cards }). They were written before the
// rules. The biology deck mixes three topics and each card carries a test-only `topic` field, so the tags can be measured: a tag is good when
// nearly all the cards it goes on are of one topic, and a few good tags should reach most of the topic's cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { autotag, autotagSteps, notesOf, deckWordsOf, applyTags, undoTags, MAX_TAGS } from '../js/autotag.js';
import { isJunkTerm, keyOf, words } from '../js/keywords.js';

const deck = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/autotag/${name}.json`, import.meta.url), 'utf8'));
const run = (d, extra = {}) => { const notes = notesOf(d.cards); return { notes, ...autotag({ notes, deckWords: deckWordsOf([{ id: 'd', name: d.name }], 'd'), existingTags: [], ...extra }) }; };
const BIO = deck('biology-mixed'), RESULT = run(BIO);
const topicOfNote = new Map(RESULT.notes.map(n => [n.id, BIO.cards.find(c => c.id === n.cardIds[0]).topic]));
const TOPICS = [...new Set(topicOfNote.values())];

test('the mixed biology deck: 3 to 15 tags, and they are printed so a run shows them', () => {
  const { tags } = RESULT;
  console.log('biology-mixed:', tags.map(t => `${t.name} (${t.count})`).join(', '));
  assert.ok(tags.length >= 3 && tags.length <= MAX_TAGS, 'tags: ' + tags.length);
});

test('each topic has up to 3 accurate tags (85% of their cards are of the topic) that reach most of its cards', () => {
  for (const topic of TOPICS) {
    const size = RESULT.notes.filter(n => topicOfNote.get(n.id) === topic).length;
    const good = RESULT.tags.filter(t => t.noteIds.filter(i => topicOfNote.get(i) === topic).length / t.noteIds.length >= 0.85);
    const covered = new Set(), used = [];
    for (let k = 0; k < 3; k++) {         // (the best three, one at a time)
      let best = null, most = 0;
      for (const t of good) { const n = t.noteIds.filter(i => topicOfNote.get(i) === topic && !covered.has(i)).length; if (!used.includes(t) && n > most) { best = t; most = n; } }
      if (!best) break;
      used.push(best); best.noteIds.forEach(i => covered.add(i));
    }
    const share = [...covered].length / size;
    console.log(`  ${topic}: ${used.map(t => t.name).join(', ')} reach ${Math.round(share * 100)}%`);
    assert.ok(used.length >= 2, topic + ' has accurate tags: ' + used.map(t => t.name));
    assert.ok(share >= 0.6, `${topic}: ${Math.round(share * 100)}% reached by ${used.map(t => t.name)}`);
  }
});

test('all the tags together reach at least 80% of the cards', () => {
  const reached = new Set(RESULT.tags.flatMap(t => t.noteIds));
  assert.ok(reached.size / RESULT.notes.length >= 0.8, String(reached.size / RESULT.notes.length));
});

const DECKS = ['biology-mixed', 'pharmacology', 'geography', 'french-vocab', 'cardiovascular', 'spanish-vocab-deck'];
test('no tag has fewer than 3 cards or more than 40% of the notes; no junk, digits or deck-name words; no two say the same', () => {
  for (const name of DECKS) {
    const d = deck(name), r = run(d), dw = new Set(deckWordsOf([{ id: 'd', name: d.name }], 'd'));
    const sets = r.tags.map(t => new Set(t.noteIds));
    r.tags.forEach((t, i) => {
      assert.ok(t.noteIds.length >= 3 && t.noteIds.length <= r.notes.length * 0.4, `${name}/${t.name}: ${t.noteIds.length} of ${r.notes.length}`);
      assert.ok(!isJunkTerm(t.label) && !/\d/.test(t.name) && /^[\p{L}-]+$/u.test(t.name), `${name}: junk tag ${t.name}`);
      assert.ok(t.label.replace(/-/g, ' ').length >= 4, `${name}: short tag ${t.name}`);
      assert.ok(!(t.key.split(' ').length === 1 && dw.has(t.key)), `${name}: the deck's own word ${t.name}`);
      sets.slice(0, i).forEach((s, j) => {
        const both = t.noteIds.filter(n => s.has(n)).length;
        assert.ok(both / (sets[i].size + s.size - both) <= 0.6, `${name}: ${t.name} and ${r.tags[j].name} overlap`);
        assert.notEqual(t.key, r.tags[j].key);
        assert.notEqual(t.name, r.tags[j].name);
      });
    });
  }
});

test('no tag is a stopword or a plain filler word, on any deck', () => {
  const BAD = new Set('what which when where this that these with from have been called known used result type process function'.split(' '));
  for (const name of DECKS) for (const t of run(deck(name)).tags) assert.ok(!t.name.split('-').some(w => BAD.has(w)), `${name}: ${t.name}`);
});

test('a note gets a tag only when its text has the phrase, and a cloze note or reverse pair is tagged as one note', () => {
  for (const t of RESULT.tags) {
    const key = t.key;
    for (const nid of t.noteIds) {
      const n = RESULT.notes.find(x => x.id === nid);
      assert.ok(keyOf(words(n.front + '\n' + n.text)).includes(key.split(' ')[0]), `${t.name} is in note ${nid}`);
      for (const id of n.cardIds) assert.ok(t.cardIds.includes(id), 'every card of the note');
    }
    assert.equal(t.count, t.cardIds.length);
  }
  const cloze = BIO.cards.filter(c => c.cloze), rev = BIO.cards.filter(c => c.reverse);
  assert.ok(cloze.length >= 6 && rev.length === 4);
  for (const c of [...cloze, ...rev]) {
    const mine = RESULT.tags.filter(t => t.cardIds.includes(c.id)).map(t => t.name).sort();
    for (const s of BIO.cards.filter(x => x.noteId === c.noteId)) assert.deepEqual(RESULT.tags.filter(t => t.cardIds.includes(s.id)).map(t => t.name).sort(), mine, 'siblings of ' + c.id);
  }
});

test('the notes: cloze siblings and reverse pairs are one note; a cloze note is read with its blanks filled; image occlusion by its heading', () => {
  const notes = notesOf([
    { id: 'a', front: 'Q [...]', back: 'x', noteId: 'n1', noteText: 'The {{c1::kidney}} filters {{c2::blood}}.', cloze: 1 },
    { id: 'b', front: 'Q2', back: 'y', noteId: 'n1', noteText: 'The {{c1::kidney}} filters {{c2::blood}}.', cloze: 2 },
    { id: 'c', front: 'Term', back: 'Meaning', noteId: 'n2' }, { id: 'd', front: 'Meaning', back: 'Term', noteId: 'n2', reverse: true },
    { id: 'e', front: 'Diagram: hidden part 1 of 2', back: 'lbl', noteId: 'n3', occlusion: { n: 1, w: 1, h: 1, header: 'Nephron', masks: [] } },
    { id: 'f', front: 'Plain **bold** and $x^2$ text', back: 'Back', noteExtra: 'More' }]);
  assert.equal(notes.length, 4);
  assert.deepEqual(notes[0].cardIds, ['a', 'b']);
  assert.equal(notes[0].front, 'The kidney filters blood.');
  assert.deepEqual([notes[1].front, notes[1].text], ['Term', 'Meaning'], 'the front of the first, not the reverse');
  assert.deepEqual([notes[2].front, notes[2].text], ['Nephron', '']);
  assert.ok(!/\*\*|\$/.test(notes[3].front));
  assert.equal(notes[3].text, 'Back\nMore');
});

test('deckWordsOf: the deck and its parents', () => {
  const decks = [{ id: 'p', name: 'Renal Physiology' }, { id: 'c', name: 'Kidney-stones', parentId: 'p' }];
  assert.deepEqual(deckWordsOf(decks, 'c').sort(), ['kidney', 'physiology', 'renal', 'stone'].sort());
});

test('a deck with a name word: that word is not proposed', () => {
  const d = deck('cardiovascular');
  const without = run(d, { deckWords: [] }).tags.map(t => t.key), withHeart = run(d, { deckWords: ['heart'] }).tags.map(t => t.key);
  assert.ok(without.includes('heart') && !withHeart.includes('heart'));
});

test('existing tags are marked, and the rest of the result does not change', () => {
  const a = run(BIO, { existingTags: ['light', 'Week1'] });
  assert.equal(a.tags.find(t => t.name === 'light')?.exists, true);
  assert.equal(a.tags.find(t => t.name === 'alleles')?.exists, false);
  assert.deepEqual(a.tags.map(t => t.name), RESULT.tags.map(t => t.name));
});

test('the same input gives the same output', () => {
  assert.deepEqual(run(BIO).tags, RESULT.tags);
});

test('a deck of vocabulary pairs gets no tags (or only a few clean ones)', () => {
  for (const name of ['spanish-vocab-deck', 'french-vocab']) {
    const r = run(deck(name));
    assert.ok(r.tags.length === 0 || r.tags.length <= MAX_TAGS, name);
    console.log(`${name}: ${r.tags.length ? r.tags.map(t => t.name).join(', ') : 'no tags (' + r.reason + ')'}`);
    for (const t of r.tags) assert.ok(!isJunkTerm(t.label));
  }
});

test('a deck about one thing: no tag over 40% (the deck is about it, not a topic in it)', () => {
  const r = run(deck('cardiovascular'));
  console.log('cardiovascular:', r.tags.map(t => `${t.name} (${t.count})`).join(', '));
  for (const t of r.tags) assert.ok(t.noteIds.length <= r.notes.length * 0.4);
  assert.ok(r.tags.length >= 3, 'the parts of the subject are still found');
});

test('few cards, or text with nothing in common: { tags: [], reason: "none" }', () => {
  assert.deepEqual(autotag({ notes: [] }), { tags: [], reason: 'none', stats: { notes: 0 } });
  const odd = Array.from({ length: 30 }, (_, i) => ({ id: 'n' + i, front: `Alpha${'bcdefghijklmnopqrstuvwxyz'[i % 25]}x${i} wordq${i}z`, text: '', cardIds: ['c' + i] }));
  assert.equal(autotag({ notes: odd }).reason, 'none');
});

test('max tags is respected', () => {
  assert.ok(run(BIO, { max: 4 }).tags.length <= 4);
});

// ---------- adding and undoing ----------

const cardsOfBio = () => structuredClone(BIO.cards).map(({ topic, ...c }) => c);
test('applyTags: adds to every card of a note, keeps the tags the cards have, and says what it added', () => {
  const cards = cardsOfBio();
  const plan = RESULT.tags.slice(0, 3).map(t => ({ name: t.name, cardIds: t.cardIds }));
  const { changed, added } = applyTags(cards, plan);
  assert.ok(changed.length > 0 && changed.length === added.size);
  const before = new Map(cards.map(c => [c.id, c]));
  for (const c of changed) {
    for (const t of before.get(c.id).tags || []) assert.ok(c.tags.includes(t), 'kept ' + t);
    assert.deepEqual(c.tags.filter(t => !(before.get(c.id).tags || []).includes(t)), added.get(c.id));
  }
  assert.ok(changed.some(c => c.tags.includes('week1')) || !cards.some(c => (c.tags || []).includes('week1')), 'week1 is still on the cards that had it');
  // the cards given are not touched
  assert.deepEqual(cards, cardsOfBio());
  // siblings agree
  const tagsOf = id => (changed.find(c => c.id === id) || before.get(id)).tags || [];
  for (const c of cards.filter(x => x.noteId)) for (const s of cards.filter(x => x.noteId === c.noteId)) assert.deepEqual([...tagsOf(s.id)].sort(), [...tagsOf(c.id)].sort());
});

test('applyTags: a tag already on a card (in any capitals), folders, and a card the plan does not name', () => {
  const cards = [{ id: 'a', tags: ['Kidney'] }, { id: 'b', tags: ['other'] }, { id: 'c' }];
  const { changed, added } = applyTags(cards, [{ name: 'renal::kidney', cardIds: ['a', 'b'] }, { name: 'kidney', cardIds: ['a', 'b'] }, { name: '  ', cardIds: ['c'] }]);
  assert.deepEqual(changed.map(c => c.id), ['a', 'b']);
  assert.deepEqual(changed[0].tags, ['Kidney', 'renal::kidney'], 'Kidney was there, so only the folder tag is new');
  assert.deepEqual(added.get('b'), ['renal::kidney', 'kidney']);
  assert.deepEqual(changed[1].tags, ['other', 'renal::kidney', 'kidney']);
});

test('applyTags: a tag stored with a space in it is read as the separate tags it was meant to be', () => {
  const { changed } = applyTags([{ id: 'a', tags: ['one two'] }], [{ name: 'three', cardIds: ['a'] }]);
  assert.deepEqual(changed[0].tags, ['one', 'two', 'three']);
});

test('undoTags removes only what was added, and keeps a tag the student added later', () => {
  const cards = cardsOfBio();
  const plan = RESULT.tags.slice(0, 3).map(t => ({ name: t.name, cardIds: t.cardIds }));
  const { changed, added } = applyTags(cards, plan);
  const now = changed.map(c => ({ ...c, tags: [...c.tags, 'mine'] }));
  const back = undoTags(now, added);
  assert.equal(back.length, changed.length);
  const orig = new Map(cards.map(c => [c.id, c]));
  for (const c of back) assert.deepEqual(c.tags, [...(orig.get(c.id).tags || []), 'mine']);
  // a card that lost the tag meanwhile is left alone; one not in the map is left alone
  const [first] = changed;
  assert.deepEqual(undoTags([{ ...first, tags: ['x'] }, { id: 'zzz', tags: ['a'] }], added), []);
  // undoing straight away restores the original tags exactly
  for (const c of undoTags(changed, added)) assert.deepEqual(c.tags, orig.get(c.id).tags || []);
});

// ---------- speed ----------

test('5,000 cards in under 3 seconds, yielding often and in small steps', () => {
  let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const syl = () => 'bcdfghklmnprstvz'[Math.floor(rnd() * 16)] + 'aeiou'[Math.floor(rnd() * 5)];
  const word = () => Array.from({ length: 4 }, syl).join('');
  const topics = Array.from({ length: 25 }, () => Array.from({ length: 6 }, word));
  const vocab = Array.from({ length: 4000 }, word), common = 'cell process during because between result structure'.split(' ');
  const cards = Array.from({ length: 5000 }, (_, i) => {
    const body = Array.from({ length: 22 }, () => rnd() < 0.3 ? topics[i % 25][Math.floor(rnd() * 6)] : rnd() < 0.4 ? common[Math.floor(rnd() * common.length)] : vocab[Math.floor(rnd() * vocab.length)]);
    return { id: 'c' + i, front: 'What is ' + body.slice(0, 8).join(' ') + '?', back: body.slice(8).join(' ') + '.' };
  });
  const t0 = performance.now();
  const it = autotagSteps({ notes: notesOf(cards), deckWords: [] });
  let last = t0, gap = 0, yields = 0, r;
  for (;;) { r = it.next(); const now = performance.now(); gap = Math.max(gap, now - last); last = now; if (r.done) break; yields++; }
  const ms = performance.now() - t0;
  console.log(`5,000 cards: ${Math.round(ms)} ms, ${yields} yields, longest step ${Math.round(gap)} ms, ${r.value.tags.length} tags`);
  assert.ok(ms < 3000, ms + ' ms');
  assert.ok(yields >= 20, yields + ' yields');
  assert.ok(gap < 100, gap + ' ms between yields');
  assert.ok(r.value.tags.length >= 3 && r.value.tags.length <= MAX_TAGS);
});

test('a plural and its singular are one tag', () => {
  const T = [['ribosome', 'ribosomes'], ['nucleolus', 'nucleoli'], ['vacuole', 'vacuoles']];
  const notes = Array.from({ length: 36 }, (_, i) => ({ id: 'n' + i, front: `Describe the ${T[i % 3][i % 2 ? 1 : 0]} membrane? Item${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${i}x`, text: `Unique${'qwxz'[i % 4]}${i}y`, cardIds: ['c' + i] }));
  const names = autotag({ notes }).tags.map(t => t.name);
  assert.ok(names.includes('ribosome') || names.includes('ribosomes'), names.join());
  assert.equal(names.filter(n => n.startsWith('ribosome')).length, 1);
  assert.equal(names.filter(n => n.startsWith('vacuole')).length, 1);
});
