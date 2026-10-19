// "Suggest tags" for a deck: topic words and phrases found in the cards' text, with the same word counting as "Suggest cards"
// (js/keywords.js). It looks at what many cards, but not nearly all of them, have in common ("kidney", "cell cycle") and offers those as tags.
// There is no AI in it, so a suggestion can be wrong: the sheet (js/autotag-sheet.js) shows every tag with its cards and asks first.
//
// Pure functions only (no page, no database), so they run in a worker (js/keywords-worker.js) and in node --test.
// Tested by tests/autotag.test.js, with the fixtures in tests/fixtures/autotag/.
//
//   notesOf(cards)                 the cards as notes: one per note (cloze siblings and reverse pairs are one), with their text
//   deckWordsOf(decks, deckId)     the words of a deck's name and its parents' names (never proposed as tags)
//   autotagSteps(input)            a generator: yields { phase, progress } now and then, returns { tags, reason?, stats }
//   autotag(input)                 the same, all at once (tests)
//   applyTags(cards, plan)         the cards that change when the plan is added, with what was added to each
//   undoTags(cards, added)         the cards that change when exactly what was added is taken away again

import { words, stem, STOPWORDS, FILLER, newCounts, addPhrases, candidatePhrases, groupNear, bestForm, slugTag, isJunkTerm } from './keywords.js';
import { clozeFull, hasBlank } from './cloze.js';
import { tagWords, normTag } from './tag-tree.js';

export const MAX_TAGS = 15;
const YIELD_EVERY = 100;            // notes between two yields (the worker passes on progress at most every 100 ms)
const MAX_TOP_SHARE = 0.4;          // a word in more than this share of the notes is the subject of the deck, not a topic in it
const MAX_JACCARD = 0.6;            // two tags whose cards overlap more than this are one tag
const MIN_NEW = 0.01;               // leave out a tag that would only reach this share of the notes (at least 2) that no tag has yet
const MIN_SCORE_SHARE = 0.15;       // ... or when its score is below this share of the best one

// Plain words that are not a topic (stemmed, like the keys they are checked against): verbs, adjectives and "container" nouns that fill
// the cards' sentences in every subject.
const GENERIC = new Set(`experience system change thing part form number level kind time case area group factor role order fact way people person
place amount rate become include require produce provide contain involve develop increase decrease remain follow allow release happen
continue represent suggest depend appear present consider describe determine different important possible several another
process function type result cause effect use used make take give show find call name term word example state situation problem answer
question list set side risk main major minor common single multiple various many much more most less least first second third last next
early late high low large small big long short new old good bad best better normal general special specific particular certain
identical similar same other each every both either whole total full half one two three four five six seven eight nine ten
occur happen inhibit block lower raise reduce activate stimulate bind prevent treat give need keep leave begin start end stop move
move put get let see know think mean refer relate result lead help work build create generate carry pass join split divide separate
control control regulate increase affect influence support enable help ensure maintain remove add replace match link
action activity ability feature property structure method model pattern principle rule idea concept definition meaning purpose reason
source value variable measure sign symptom sample study test type version unit stage step phase point line side top bottom side
beginning middle edge center centre inside outside inner outer upper lower left right front back
usually often always never sometimes together also only just still even already again either neither
become becomes known called using given based related involved caused produced formed made
avoid monitor oral world largest smallest highest lowest longest shortest deepest biggest greatest oldest newest best worst strongest weakest fastest slowest`.split(/\s+/).map(w => stem(w)));
const ADVERB = /[^aeiou]ly$/;                 // ("quickly"; not "family")
const PARTICIPLE = /[^e]ed$/;                 // ("located", "called"; not "speed")
const EVERYWHERE = 0.5;                        // a word in more than this share of the notes cannot make a phrase a topic ("ribosome membrane")
const looseWord = w => w.length >= 5 && (ADVERB.test(w) || PARTICIPLE.test(w));

// ---------- the cards as notes ----------

// Take away what is not words: **bold**, $maths$, {{c1::hidden}} marks and <tags>.
const plain = s => String(s ?? '').replace(/\*\*/g, '').replace(/\$[^$\n]*\$/g, ' ').replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/g, '$1').replace(/\{\{[^}]*\}\}/g, ' ').replace(/<[^>]*>/g, ' ');

// The cards as notes: [{ id, front, text, cardIds }]. A note is its cards that share a noteId (the blanks of a cloze note, a card and its
// reverse); a card with no noteId is a note by itself.
//   front   what names the thing (the front; for a cloze note the sentence with its blanks filled; for image occlusion the heading)
//   text    the rest (the back and the note's extra text)
// An image-occlusion note is read from its heading only (the picture and the box labels say little).
export function notesOf(cards) {
  const byNote = new Map();
  for (const c of cards) {
    const key = c.noteId || c.id;
    let n = byNote.get(key);
    if (!n) byNote.set(key, n = { id: key, cards: [] });
    n.cards.push(c);
  }
  const out = [];
  for (const { id, cards: list } of byNote.values()) {
    const c = list.find(x => !x.reverse) || list[0];
    let front = '', text = '';
    if (c.occlusion) front = plain(c.occlusion.header);
    else if (hasBlank(c)) front = plain(clozeFull(c.noteText));
    else { front = plain(c.front); text = plain(c.back); }
    if (!c.occlusion) { const extra = plain(c.noteExtra); if (extra.trim()) text += '\n' + extra; }
    out.push({ id, front: front.trim(), text: text.trim(), cardIds: list.map(x => x.id) });
  }
  return out;
}

// The words of a deck's name and its parents' names, as the keys that candidate phrases have ("Cell Biology" → cell, biology).
export function deckWordsOf(decks, deckId) {
  const byId = new Map(decks.map(d => [d.id, d]));
  const out = new Set(), seen = new Set();
  for (let d = byId.get(deckId); d && !seen.has(d.id); d = byId.get(d.parentId)) {
    seen.add(d.id);
    for (const w of words(d.name)) for (const part of w.w.split('-')) if (part) out.add(stem(part));
  }
  return [...out];
}

// ---------- finding the tags ----------

const overlap = (a, b) => {                 // sorted arrays of note numbers → how many are in both
  let i = 0, j = 0, n = 0;
  while (i < a.length && j < b.length) { if (a[i] === b[j]) { n++; i++; j++; } else if (a[i] < b[j]) i++; else j++; }
  return n;
};
const isGeneric = w => GENERIC.has(w) || STOPWORDS.has(w) || FILLER.has(w);
const sub = (small, big) => big.includes(' ' + small + ' ') || big.startsWith(small + ' ') || big.endsWith(' ' + small) || big === small;

// input: { notes, deckWords = [], existingTags = [], max = 15 }   notes: from notesOf()
// Yields { phase, progress } about every 250 notes. Returns { tags, reason?, stats }
//   tag: { key, name, label, noteIds, cardIds, count, sample, exists }
//   reason: 'none' when nothing clear was found
export function* autotagSteps({ notes, deckWords = [], existingTags = [], max = MAX_TAGS }) {
  const N = notes.length;
  const none = { tags: [], reason: 'none', stats: { notes: N } };
  const minDf = Math.max(3, Math.ceil(N * 0.02)), maxDf = Math.floor(N * MAX_TOP_SHARE);
  if (N < 6 || maxDf < minDf) return none;

  // 1. Count the phrases of every note. A phrase counts once for a note, however often it is said.
  const counts = newCounts(), inFront = new Map();
  for (let i = 0; i < N; i++) {
    const n = notes[i];
    const front = candidatePhrases(words(n.front), { text: n.front });
    addPhrases(counts, front, i);
    for (const k of new Set(front.map(p => p.key))) inFront.set(k, (inFront.get(k) || 0) + 1);
    if (n.text) addPhrases(counts, candidatePhrases(words(n.text), { text: n.text }), i);
    if (i % YIELD_EVERY === YIELD_EVERY - 1) yield { phase: 'reading', progress: (i + 1) / N * 0.7 };
  }

  // 2. The phrases that could be a tag: in enough notes but not nearly all, a topic word and not a filler.
  const dw = new Set(deckWords.map(w => stem(w)));
  const cand = [];
  let seen = 0;
  for (const [key, e] of counts) {
    if (++seen % 5000 === 0) yield { phase: 'choosing', progress: 0.7 + 0.1 * seen / counts.size };
    if (e.df < minDf || e.df > maxDf) continue;
    const ws = key.split(' ');
    const first = ws[0], last = ws[ws.length - 1];
    if (ws.length === 1) {
      if (first.length < 4 || looseWord(first) || isGeneric(first) || dw.has(first) || /\d/.test(first)) continue;
    } else {
      if (isGeneric(first) || isGeneric(last) || looseWord(first) || looseWord(last) || ws.some(w => (counts.get(w)?.df ?? 0) > N * EVERYWHERE) || ws.every(w => dw.has(w) || isGeneric(w)) || ws.some(w => /\d/.test(w) && !/[a-z]/.test(w))) continue;
    }
    cand.push(key);
  }
  if (cand.length < 3) return none;
  // A word that mostly appears inside two different phrases ("cycle" in "cell cycle" and "calvin cycle") is not one topic: the phrases are.
  const phrasesOf = new Map();
  for (const key of cand) {
    const ws = key.split(' ');
    if (ws.length > 1) for (const w of new Set(ws)) { if (!phrasesOf.has(w)) phrasesOf.set(w, []); phrasesOf.get(w).push(counts.get(key)); }
  }
  const ambiguous = key => {
    const ps = (phrasesOf.get(key) || []).sort((a, b) => b.df - a.df);
    if (ps.length < 2) return false;
    const together = new Set([...ps[0].docs, ...ps[1].docs]);
    const shared = ps[0].docs.filter(d => ps[1].docs.includes(d)).length;
    return shared <= Math.min(ps[0].df, ps[1].df) / 2 && together.size >= counts.get(key).df * 0.5;
  };
  for (let i = cand.length - 1; i >= 0; i--) if (!cand[i].includes(' ') && ambiguous(cand[i])) cand.splice(i, 1);
  if (cand.length < 3) return none;
  const group = groupNear(cand);
  const merged = new Map();                // the first key of each group → its notes and forms together
  for (const key of cand) {
    const root = group.get(key), e = counts.get(key);
    let m = merged.get(root);
    if (!m) merged.set(root, m = { key: root, docs: new Set(), forms: new Map(), front: 0, n: root.split(' ').length });
    for (const d of e.docs) m.docs.add(d);
    for (const [t, c] of e.forms) m.forms.set(t, (m.forms.get(t) || 0) + c);
    m.front += inFront.get(key) || 0;
  }
  const scored = [];
  for (const m of merged.values()) {
    const df = m.docs.size;
    if (df < minDf || df > maxDf) continue;
    // How specific it is (TF-IDF: more notes is better, but less so as it nears every note), a little more for a phrase, and for a word that
    // is often on the front of a card (the front names the thing).
    m.score = df * Math.log(N / df) * (1 + 0.3 * (m.n - 1)) * (1 + 0.5 * Math.min(1, m.front / df));
    m.docs = [...m.docs].sort((a, b) => a - b);
    m.label = bestForm(m.forms);
    if (isJunkTerm(m.label) || !slugTag(m.label)) continue;
    scored.push(m);
  }
  yield { phase: 'choosing', progress: 0.85 };
  if (scored.length < 3) return none;
  scored.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));

  // 3. Pick the best, one at a time, leaving out what says the same as a tag already picked.
  const picked = [], covered = new Uint8Array(N);
  let coveredN = 0;
  for (const c of scored) {
    if (picked.length >= max) break;
    if (c.score < scored[0].score * MIN_SCORE_SHARE) break;
    let dup = false;
    for (const p of picked) {
      const both = overlap(c.docs, p.docs);
      if (both / (c.docs.length + p.docs.length - both) > MAX_JACCARD) { dup = true; break; }
      // a word of a picked phrase that is nearly always in it (or the other way round) is an alias of it
      if ((c.n < p.n && sub(c.key, p.key) || c.n > p.n && sub(p.key, c.key)) && both / Math.min(c.docs.length, p.docs.length) >= 0.8) { dup = true; break; }
      if (slugTag(c.label) === slugTag(p.label)) { dup = true; break; }
    }
    if (dup) continue;
    let fresh = 0;
    for (const d of c.docs) if (!covered[d]) fresh++;
    if (fresh < Math.max(2, N * MIN_NEW)) continue;
    for (const d of c.docs) if (!covered[d]) { covered[d] = 1; coveredN++; }
    picked.push(c);
  }
  if (!picked.length) return none;

  const have = new Set([...existingTags].map(t => normTag(t)));
  const tags = picked.map(p => {
    const name = slugTag(p.label);
    const ns = p.docs.map(i => notes[i]);
    return {
      key: p.key, name, label: p.label,
      noteIds: ns.map(n => n.id), cardIds: ns.flatMap(n => n.cardIds), count: ns.reduce((t, n) => t + n.cardIds.length, 0),
      sample: ns.slice(0, 2).map(n => n.front.replace(/\s+/g, ' ').slice(0, 80)),
      exists: have.has(name)
    };
  });
  yield { phase: 'choosing', progress: 1 };
  return { tags, stats: { notes: N, covered: coveredN, candidates: scored.length } };
}

export function autotag(input) {
  const it = autotagSteps(input);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

// ---------- adding and taking away ----------

// plan: [{ name, cardIds }] (name may have folders: "renal::kidney"). Returns { changed, added }
//   changed   the cards that get a new tag (a copy of each; the cards given are not touched)
//   added     Map(card id → the tags that were really added to it), for Undo
// Tags the cards have stay as they are, a tag a card already has (in any capitals) is not added again, and every card of a note gets the
// tags of the note's other cards too, so that a cloze note or a reverse pair is never half tagged.
export function applyTags(cards, plan) {
  const want = new Map();                                         // card id → tags to add (in order)
  for (const { name, cardIds } of plan) {
    const tag = String(name ?? '').trim().toLowerCase();
    if (!normTag(tag)) continue;
    for (const id of cardIds) { if (!want.has(id)) want.set(id, []); want.get(id).push(tag); }
  }
  const byNote = new Map();                                       // note id → every tag wanted by any of its cards
  for (const c of cards) {
    if (!c.noteId || !want.has(c.id)) continue;
    if (!byNote.has(c.noteId)) byNote.set(c.noteId, []);
    byNote.get(c.noteId).push(...want.get(c.id));
  }
  const changed = [], added = new Map();
  for (const c of cards) {
    const wanted = c.noteId && byNote.has(c.noteId) ? byNote.get(c.noteId) : want.get(c.id);
    if (!wanted) continue;
    const own = tagWords(c.tags), has = new Set(own.map(normTag));
    const add = [];
    for (const t of wanted) { const k = normTag(t); if (!has.has(k)) { has.add(k); add.push(t); } }
    if (!add.length) continue;
    changed.push({ ...c, tags: [...new Set([...own, ...add])] });
    added.set(c.id, add);
  }
  return { changed, added };
}

// Take back what applyTags added: only those tags, and only from cards that still have them. Returns the cards that change.
export function undoTags(cards, added) {
  const out = [];
  for (const c of cards) {
    const gone = added.get(c.id);
    if (!gone) continue;
    const drop = new Set(gone.map(normTag));
    const own = tagWords(c.tags);
    if (!own.some(t => drop.has(normTag(t)))) continue;
    out.push({ ...c, tags: own.filter(t => !drop.has(normTag(t))) });
  }
  return out;
}
