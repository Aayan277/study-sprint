// Tests for js/autotag.js ("Suggest tags" for a deck). Run with: node --test tests/autotag.test.js
//
// The fixtures in tests/fixtures/autotag/ are decks as a student might have made them (JSON: { name, cards }). They were written before the
// rules. The biology deck mixes three topics and each card carries a test-only `topic` field, so the tags can be measured: a tag is good when
// nearly all the cards it goes on are of one topic, and a few good tags should reach most of the topic's cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { autotag, autotagSteps, notesOf, deckWordsOf, applyTags, undoTags, derives, MAX_TAGS, YIELD_EVERY } from '../js/autotag.js';
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
  assert.equal(notes[3].text, 'Back');
  assert.equal(notes[3].extra, 'More', 'the extra text is kept apart: it is not read for tags');
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

test('5,000 cards: fast, yielding often and in small steps, in every stage', () => {
  let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const syl = () => 'bcdfghklmnprstvz'[Math.floor(rnd() * 16)] + 'aeiou'[Math.floor(rnd() * 5)];
  const word = () => Array.from({ length: 4 }, syl).join('');
  const topics = Array.from({ length: 25 }, () => Array.from({ length: 6 }, word));
  const vocab = Array.from({ length: 4000 }, word), common = 'cell process during because between result structure'.split(' ');
  const cards = Array.from({ length: 5000 }, (_, i) => {
    const body = Array.from({ length: 22 }, () => rnd() < 0.3 ? topics[i % 25][Math.floor(rnd() * 6)] : rnd() < 0.4 ? common[Math.floor(rnd() * common.length)] : vocab[Math.floor(rnd() * vocab.length)]);
    return { id: 'c' + i, front: 'What is ' + body.slice(0, 8).join(' ') + '?', back: body.slice(8).join(' ') + '.' };
  });
  const notes = notesOf(cards), N = notes.length;
  const t0 = performance.now();
  const it = autotagSteps({ notes, deckWords: [] });
  let last = t0, r; const gaps = [], seen = [];
  for (;;) { r = it.next(); const now = performance.now(); gaps.push(now - last); last = now; if (r.done) break; seen.push(r.value); }
  const ms = performance.now() - t0;
  gaps.sort((a, b) => a - b);
  const p95 = gaps[Math.floor(gaps.length * 0.95)], max = gaps.at(-1);
  console.log(`5,000 cards: ${Math.round(ms)} ms, ${seen.length} yields, p95 ${Math.round(p95)} ms, longest step ${Math.round(max)} ms, ${r.value.tags.length} tags`);
  // What matters is the work between two yields, which does not depend on how busy the machine is:
  const reading = seen.filter(s => s.phase === 'reading').map(s => s.progress);
  assert.ok(reading.length >= N / YIELD_EVERY - 1, 'a yield at least every ' + YIELD_EVERY + ' notes: ' + reading.length);
  for (let i = 1; i < reading.length; i++) assert.ok(reading[i] - reading[i - 1] <= YIELD_EVERY / N * 0.7 + 1e-9, 'steps of at most ' + YIELD_EVERY + ' notes');
  const stages = [0.8, 0.82, 0.84, 0.87, 0.93, 1];
  for (const g of stages) assert.ok(seen.some(s => s.phase === 'choosing' && Math.abs(s.progress - g) < 1e-9), 'a yield at stage ' + g);
  assert.ok(seen.length >= 20);
  // The clock is only a loose check (the test runs beside others):
  assert.ok(ms < 6000, ms + ' ms');
  assert.ok(p95 < 100, 'p95 ' + p95);
  assert.ok(max < 300, 'longest ' + max);
  assert.ok(r.value.tags.length >= 3 && r.value.tags.length <= MAX_TAGS);
});

const NB = ['function', 'location', 'history', 'damage', 'origin', 'repair', 'count'];
test('a plural and its singular are one tag', () => {
  const T = [['ribosome', 'ribosomes'], ['nucleolus', 'nucleoli'], ['vacuole', 'vacuoles']];
  const notes = Array.from({ length: 36 }, (_, i) => ({ id: 'n' + i, front: `Describe the ${T[i % 3][i % 2 ? 1 : 0]} ${NB[i % 5]}? Item${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${i}x`, text: `Unique${'qwxz'[i % 4]}${i}y`, cardIds: ['c' + i] }));
  const names = autotag({ notes }).tags.map(t => t.name);
  assert.ok(names.includes('ribosome') || names.includes('ribosomes'), names.join());
  assert.equal(names.filter(n => n.startsWith('ribosome')).length, 1);
  assert.equal(names.filter(n => n.startsWith('vacuole')).length, 1);
});

// ---------- quality: what is ticked to begin with ----------

const ALL = ['biology-mixed', 'pharmacology', 'geography', 'french-vocab', 'cardiovascular', 'spanish-vocab-deck', 'computer-science', 'geology', 'german-vocab-notes',
  'review-anatomy', 'review-chemistry', 'review-econ', 'review-german', 'review-history', 'review-psych',
  'review2-acct', 'review2-englit', 'review2-messy', 'review2-micro', 'review2-physics', 'review2-spanish',
  'review3-derm', 'review3-japanese', 'review3-mktg-messy', 'review3-music', 'review3-phil', 'review3-stats'];
const RUNS = Object.fromEntries(ALL.map(n => [n, run(deck(n))]));

test('every deck: the tags, ticked (sure) first, then the less sure ones (printed so a run shows them)', () => {
  for (const [name, r] of Object.entries(RUNS)) {
    console.log(`${name}: ${r.tags.map(t => (t.sure ? '[x] ' : '[ ] ') + t.name).join(', ') || '(none)'}${r.reason ? ' · reason ' + r.reason : ''}`);
    const firstLess = r.tags.findIndex(t => !t.sure);
    if (firstLess >= 0) assert.ok(r.tags.slice(firstLess).every(t => !t.sure), name + ': sure tags come first');
    assert.equal(!!r.reason, !r.tags.some(t => t.sure), name + ': reason "none" exactly when nothing is sure');
  }
});

test('broad, vague or misleading words are never ticked to begin with', () => {
  const VAGUE = new Set(`price market government income muscles artery molecules reaction france german germany ventricle august november western negative aggregate cognitive
    party plural pair alkanes soviet education`.split(/\s+/));
  for (const [name, r] of Object.entries(RUNS)) for (const t of r.tags) if (t.sure) assert.ok(!VAGUE.has(t.name), `${name}: ${t.name} is ticked`);
});

test('months and weekdays, pieces of phrases, derived forms and words of another language are not tags at all', () => {
  const all = Object.entries(RUNS).flatMap(([name, r]) => r.tags.map(t => [name, t.name]));
  for (const [name, t] of all) {
    assert.ok(!/^(?:january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.test(t), `${name}: ${t}`);
    assert.ok(!['aggregate', 'ich-habe', 'plural', 'party', 'bonding'].includes(t), `${name}: ${t}`);
  }
});

test('alkene, alkane and alkyne are three words; ileum and ilium are two; a plural and a spelling variant are one', () => {
  const T = ['alkene', 'alkane', 'alkyne'];
  const notes = Array.from({ length: 30 }, (_, i) => ({ id: 'n' + i, front: `Name the ${T[i % 3]} ${NB[i % 7]} ${'abcdefghij'[i % 10]}${i}z`, text: `Unique${'qwxz'[i % 4]}${i}y`, cardIds: ['c' + i] }));
  const keys = autotag({ notes }).tags.map(t => t.key);
  assert.deepEqual(T.filter(k => keys.includes(k)).length, 3, keys.join());
  const V = Array.from({ length: 30 }, (_, i) => ({ id: 'v' + i, front: `Describe the ${['colour', 'color', 'colours'][i % 3]} ${NB[i % 7]} of the ${['pigment', 'texture', 'density', 'lattice'][i % 4]} and ${['mixture', 'solvent', 'crystal', 'powder', 'liquid'][i % 5]} sample${'abcdefghij'[i % 10]}${i}z`, text: `Other${'qwxz'[i % 4]}${i}y`, cardIds: ['d' + i] }));
  assert.equal(autotag({ notes: V }).tags.filter(t => /^colou?r/.test(t.key)).length, 1);
});

test('derived forms join the tag of the shorter word', () => {
  assert.ok(derives('bond', 'bonding') && derives('ventricle', 'ventricular') && derives('history', 'historic') && derives('cell', 'cellular'));
  assert.ok(!derives('cat', 'catalog') && !derives('port', 'portal x') && !derives('plate', 'plateau'));
  const r = RUNS['review-chemistry'];
  assert.ok(!r.tags.some(t => t.name === 'bonding'), 'bonding is not a tag of its own');
  assert.ok(RUNS['cardiovascular'].tags.find(t => t.name === 'ventricle')?.aliases.includes('ventricular'), 'ventricular joined ventricle');
  assert.ok(!RUNS['cardiovascular'].tags.some(t => t.name === 'ventricular'));
});

test('language decks: function words, [sound:] marks and grammar notes (the extra text) make no tags', () => {
  const r = RUNS['german-vocab-notes'];
  assert.ok(!r.tags.some(t => /sound|mp3|plural|grammar|dative|accusative|umlaut|noun|note/.test(t.name)), r.tags.map(t => t.name).join());
  const notes = notesOf([{ id: 'a', front: 'der Hund', back: 'dog [sound:hund.mp3]', noteExtra: 'Grammar note: dative' }]);
  assert.equal(notes[0].text.includes('sound'), false);
  const F = Array.from({ length: 24 }, (_, i) => ({ id: 'f' + i, front: `ich habe ${['einen', 'eine', 'ein'][i % 3]} wort${'abcdefghij'[i % 10]}${i}x`, text: `und die das der ${i}`, cardIds: ['g' + i] }));
  assert.deepEqual(autotag({ notes: F }).tags.map(t => t.name).filter(n => /ich|habe|und|die|das|der|ein/.test(n)), []);
});

test('what is ticked to begin with is almost never junk: every ticked tag has 4 or more cards and is on the front of half of them', () => {
  let ticked = 0;
  for (const [name, r] of Object.entries(RUNS)) for (const t of r.tags.filter(x => x.sure)) { ticked++; assert.ok(t.noteIds.length >= 4 && t.front >= 0.5, `${name}: ${t.name}`); }
  console.log('ticked tags over all decks:', ticked);
  assert.ok(ticked >= 8, 'some tags are still sure: ' + ticked);
});

test('a clear topic is not lost to broad unticked words that cover its cards (depreciation), and a foreign word is not a modifier (pretérito)', () => {
  const acct = RUNS['review2-acct'];
  assert.ok(acct.tags.find(t => t.name === 'depreciation')?.sure, 'depreciation is ticked: ' + acct.tags.map(t => t.name));
  const es = RUNS['review2-spanish'];
  assert.ok(es.tags.some(t => /pret[eé]rito/.test(t.name)), 'pretérito is a tag: ' + es.tags.map(t => t.name));
});

test('a word of a title is not a topic ("pride" in "Pride and Prejudice"); big back-only topics come first among the unticked', () => {
  const lit = RUNS['review2-englit'];
  assert.ok(!lit.tags.some(t => t.name === 'pride' && t.sure), 'pride is not ticked');
  const less = lit.tags.filter(t => !t.sure).map(t => t.noteIds.length);
  assert.deepEqual(less, [...less].sort((a, b) => b - a), 'unticked tags are sorted by size');
  assert.ok(!lit.tags.some(t => t.sure && ['theme', 'character', 'moral', 'quote'].includes(t.name)));
});

test('bacteria and bacterial are one tag', () => {
  assert.ok(derives('bacteria', 'bacterial'));
  const m = RUNS['review2-micro'];
  assert.equal(m.tags.filter(t => /^bacteri/.test(t.name)).length, 1, m.tags.map(t => t.name).join());
});

test('a tag the student already has starts unticked unless most of its cards already carry it', () => {
  const d = deck('review2-messy');
  const withTag = (share) => {
    const cards = structuredClone(d.cards);
    for (const c of cards) c.tags = (c.tags || []).filter(t => t !== 'energy');
    const notes0 = notesOf(cards), en = autotag({ notes: notes0, deckWords: [] }).tags.find(t => t.name === 'energy');
    if (!en) return null;
    const ids = new Set(en.cardIds.slice(0, Math.ceil(en.cardIds.length * share)));
    for (const c of cards) if (ids.has(c.id)) c.tags = [...(c.tags || []), 'energy'];
    return autotag({ notes: notesOf(cards), deckWords: [], existingTags: ['energy'] }).tags.find(t => t.name === 'energy');
  };
  const few = withTag(0.1), most = withTag(1);
  assert.ok(few && few.exists && !few.sure, 'few cards have it: unticked');
  assert.ok(most && most.exists && most.sure, 'all cards have it: ticked');
});

test('a tag the student already has as a folder ("mktg::pricing") is the same tag as "pricing": the cards join it', () => {
  const d = deck('review3-mktg-messy');
  const cards = d.cards.map(c => ({ ...c, tags: (c.tags || []).map(t => (t === 'pricing' ? 'mktg::pricing' : t)) }));
  const existing = [...new Set(cards.flatMap(c => c.tags))];
  const r = autotag({ notes: notesOf(cards), deckWords: [], existingTags: existing });
  assert.ok(!r.tags.some(t => t.name === 'pricing'), 'no new top-level pricing: ' + r.tags.map(t => t.name));
  const t = r.tags.find(x => x.name === 'mktg::pricing');
  assert.ok(t && t.exists && t.sure, 'mktg::pricing is proposed, as an existing tag');
});

test('a vague word on few fronts with little in common is not ticked (patch); "i-adjective" is kept; "moral realism" is not blocked; $ prices are kept', () => {
  assert.ok(!RUNS['review3-derm'].tags.some(t => t.sure && t.name === 'patch'));
  assert.ok(RUNS['review3-japanese'].tags.some(t => t.name === 'i-adjective'), RUNS['review3-japanese'].tags.map(t => t.name).join());
  const phil = RUNS['review3-phil'].tags.map(t => t.name).join();
  assert.ok(/moral/.test(phil), phil);
  assert.equal(notesOf([{ id: 'a', front: 'Sale: $9.99 instead of $10', back: 'price' }])[0].front, 'Sale: $9.99 instead of $10');
  assert.equal(notesOf([{ id: 'b', front: 'Solve $x^2$ now', back: 'b' }])[0].front.includes('x^2'), false);
});

test('folder tags: only this deck\'s own cards decide, a tie or a stranger folder renames nothing', () => {
  const T = ['kidney', 'spleen', 'thyroid', 'pancreas'], NB = ['function', 'location', 'damage', 'origin', 'repair', 'growth', 'scan', 'disease', 'surgery', 'hormone'];
  // 40 notes, 10 on each organ; tagOf(organ, k) is the tag of the k-th note on that organ
  const make = tagOf => Array.from({ length: 40 }, (_, i) => { const o = T[i % 4], k = Math.floor(i / 4); return { id: 'c' + i, front: `Describe the ${o} ${NB[k]} for case ${'abcdefghij'[k]}${i}z`, back: `Answer${'qwxz'[i % 4]}${i}y`, tags: tagOf(o, k) ? [tagOf(o, k)] : [] }; });
  const run2 = (cards, extra = []) => autotag({ notes: notesOf(cards), deckWords: [], existingTags: [...new Set([...cards.flatMap(c => c.tags), ...extra])] }).tags;
  const tie = run2(make((o, k) => (o === 'kidney' ? (k % 2 ? 'a::kidney' : 'b::kidney') : null)));
  assert.ok(tie.some(t => t.name === 'kidney') && !tie.some(t => t.name.includes('::')), 'a tie renames nothing: ' + tie.map(t => t.name));
  const win = run2(make((o, k) => (o === 'kidney' ? (k < 7 ? 'a::kidney' : 'b::kidney') : null)));
  assert.ok(win.some(t => t.name === 'a::kidney' && t.exists) && !win.some(t => t.name === 'b::kidney'), win.map(t => t.name).join());
  // the original case: all on one folder
  const one = run2(make((o, k) => (o === 'kidney' && k < 8 ? 'renal::kidney' : null)));
  assert.ok(one.some(t => t.name === 'renal::kidney' && t.exists) && !one.some(t => t.name === 'kidney'));
  // a folder elsewhere in the collection (no card of this deck has it) changes nothing
  const plain = make(() => null), base = run2(plain), other = run2(plain, ['psych::defence::kidney', 'chem::titration::spleen']);
  assert.deepEqual(other.map(t => [t.name, t.exists, t.sure]), base.map(t => [t.name, t.exists, t.sure]));
  assert.ok(base.some(t => t.name === 'kidney') && base.some(t => t.name === 'spleen'));
  // a plain existing tag still matches
  assert.ok(run2(make((o, k) => (o === 'kidney' ? 'kidney' : null))).some(t => t.name === 'kidney' && t.exists));
});

test('the real decks: another deck\'s folder does not rename or hide tags', () => {
  const stats = notesOf(deck('review3-stats').cards);
  const base = autotag({ notes: stats, deckWords: [], existingTags: [] }).tags, other = autotag({ notes: stats, deckWords: [], existingTags: ['psych::defence::regression', 'chem::titration::residual'] }).tags;
  assert.deepEqual(other.map(t => [t.name, t.exists, t.sure]), base.map(t => [t.name, t.exists, t.sure]));
  assert.ok(base.some(t => t.name === 'residual') && base.some(t => t.name === 'regression'));
});

test('"a priori" is not a hyphenated one-letter prefix', () => {
  const notes = Array.from({ length: 12 }, (_, i) => ({ id: 'n' + i, front: `What is a priori knowledge ${'abcdefghijkl'[i]}${i}x?`, text: `Answer${'qwxz'[i % 4]}${i}y`, cardIds: ['c' + i] }));
  assert.ok(!autotag({ notes }).tags.some(t => t.name === 'a-priori'));
});

test('a card in the minority folder gets no second "kidney" tag from the majority folder (and none it already has)', () => {
  const cards = [
    ...Array.from({ length: 7 }, (_, i) => ({ id: 'a' + i, noteId: 'a' + i, tags: ['a::kidney'] })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: 'b' + i, noteId: 'b' + i, tags: ['b::kidney'] })),
    { id: 'p', noteId: 'p', tags: ['kidney'] }, { id: 'n', noteId: 'n', tags: ['other'] }
  ];
  const { changed, added } = applyTags(cards, [{ name: 'a::kidney', cardIds: cards.map(c => c.id) }]);
  assert.deepEqual(changed.map(c => c.id), ['p', 'n'], 'the b:: cards and the a:: cards are left alone; a plain kidney joins the folder');
  assert.deepEqual(changed[1].tags, ['other', 'a::kidney']);
  assert.deepEqual([...added.keys()], ['p', 'n']);
  // a tie renames nothing: the plain "kidney" does not double up on a card that is already in a folder
  const r = applyTags([{ id: 'x', noteId: 'x', tags: ['b::kidney'] }, { id: 'y', noteId: 'y', tags: [] }], [{ name: 'kidney', cardIds: ['x', 'y'] }]);
  assert.deepEqual(r.changed.map(c => [c.id, c.tags]), [['y', ['kidney']]]);
  // different leaves are unaffected
  assert.equal(applyTags([{ id: 'z', noteId: 'z', tags: ['a::spleen'] }], [{ name: 'a::kidney', cardIds: ['z'] }]).changed.length, 1);
});
