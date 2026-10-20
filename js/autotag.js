// "Suggest tags" for a deck: topic words and phrases found in the cards' text, with the same word counting as "Suggest cards"
// (js/keywords.js). It looks at what many cards, but not nearly all of them, have in common ("kidney", "cell cycle") and offers those as tags.
// There is no AI in it, so a suggestion can be wrong: the sheet (js/autotag-sheet.js) shows every tag with its cards and asks first.
//
// Pure functions only (no page, no database), so they run in a worker (js/keywords-worker.js) and in node --test.
// Tested by tests/autotag.test.js, with the fixtures in tests/fixtures/autotag/.
//
//   notesOf(cards)                 the cards as notes: one per note (cloze siblings and reverse pairs are one), with their text
//
// A tag is "sure" (ticked to begin with) only when it names what the cards are about: the word is on the front of at least half of them, and
// they hang together (they share more other words than two cards of the deck do). A broad word that runs through several topics ("price",
// "artery"), or sits in the answers only, is still offered, but unticked, under "Other possible tags".
//   deckWordsOf(decks, deckId)     the words of a deck's name and its parents' names (never proposed as tags)
//   autotagSteps(input)            a generator: yields { phase, progress } now and then, returns { tags, reason?, stats }
//   autotag(input)                 the same, all at once (tests)
//   applyTags(cards, plan)         the cards that change when the plan is added, with what was added to each
//   undoTags(cards, added)         the cards that change when exactly what was added is taken away again

import { words, stem, STOPWORDS, FILLER, newCounts, addPhrases, candidatePhrases, groupNear, bestForm, slugTag, isJunkTerm } from './keywords.js';
import { NOT_TERMS } from './reading-cards.js';
import { clozeFull, hasBlank } from './cloze.js';
import { tagWords, normTag } from './tag-tree.js';

export const MAX_TAGS = 15;
export const YIELD_EVERY = 100;            // notes between two yields while counting (the worker passes on progress at most every 100 ms)
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
avoid monitor oral world theme quote character largest smallest highest lowest longest shortest deepest biggest greatest oldest newest best worst strongest weakest fastest slowest`.split(/\s+/).map(w => stem(w)));
const ADVERB = /[^aeiou]ly$/;                 // ("quickly"; not "family")
const PARTICIPLE = /[^e]ed$/;                 // ("located", "called"; not "speed")
const EVERYWHERE = 0.5;                        // a word in more than this share of the notes cannot make a phrase a topic ("ribosome membrane")
const looseWord = w => w.length >= 5 && (ADVERB.test(w) || PARTICIPLE.test(w));

// Function words of German, French and Spanish: in a language deck they are on every card and are never a topic.
const FOREIGN = new Set(`ich du er sie es wir ihr der die das den dem des ein eine einen einem einer und oder aber nicht ist sind bin bist habe hast hat haben
mit von zu zur zum auf für im an bei nach aus wie was wer wo auch noch nur sehr mein dein sein
le la les un une des du de et ou est sont je tu il elle nous vous ils elles ne pas que qui dans sur avec pour au aux ce cette ces mon ma mes ton ta tes
el los las unos unas y o son yo tú él ella nosotros ellos por para se lo al su sus mi tu`.split(/\s+/));
// Places and peoples: a single one ("france", "german") is too broad to be a topic on its own.
const PLACES = new Set(`america american britain british england english france french germany german italy italian spain spanish russia russian
china chinese japan japanese india indian europe european africa african asia asian australia australian canada mexico brazil ireland irish scotland
poland polish turkey turkish egypt egyptian greece greek rome roman austria hungary belgium netherlands dutch sweden norway denmark switzerland israel
iran iraq korea vietnam cuba western eastern northern southern`.split(/\s+/));
// A derived form of a word ("bonding", "ventricular", "historic"): the same topic, so it joins the tag of the shorter word.
const SUFFIX = ['ing', 'ed', 'ar', 'ular', 'al', 'ial', 'ic', 'ical', 'ous'];
export function derives(a, b) {
  if (a.length > b.length) [a, b] = [b, a];
  if (a.includes(' ') || b.includes(' ') || a.length < 4) return false;
  for (const base of new Set([a, a.replace(/e$/, ''), a.replace(/y$/, ''), a.replace(/le$/, '')])) {
    const rest = b.slice(base.length);
    if (base.length >= 4 && b.startsWith(base) && (SUFFIX.includes(rest) || (rest === 'l' && base.endsWith('a')))) return true;      // bacteria, bacterial
  }
  return false;
}
// A spelling variant, not a different word: colour/color, analyse/analyze, oesophagus/esophagus (but alkene/alkane, ileum/ilium are two words).
function variant(a, b) {
  if (a.length < b.length) [a, b] = [b, a];
  if (a.length === b.length) {
    let d = -1;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (d >= 0) return false; d = i; }
    return d < 0 || ('sz'.includes(a[d]) && 'sz'.includes(b[d]));
  }
  for (let i = 0; i < a.length; i++) if (a.slice(0, i) + a.slice(i + 1) === b) return (a[i] === 'u' && a[i + 1] === 'r') || ((a[i] === 'o' || a[i] === 'a') && a[i + 1] === 'e');
  return false;
}

// ---------- the cards as notes ----------

// Take away what is not words: **bold**, $maths$, {{c1::hidden}} marks, [sound:x.mp3] and <tags>.
const plain = s => String(s ?? '').replace(/\*\*/g, '').replace(/\[sound:[^\]]*\]/g, ' ').replace(/\$(?!\d)[^$\n]*\$/g, ' ').replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/g, '$1').replace(/\{\{[^}]*\}\}/g, ' ').replace(/<[^>]*>/g, ' ');

// The cards as notes: [{ id, front, text, extra, cardIds }]. A note is its cards that share a noteId (the blanks of a cloze note, a card and its
// reverse); a card with no noteId is a note by itself.
//   front   what names the thing (the front; for a cloze note the sentence with its blanks filled; for image occlusion the heading)
//   text    the back
//   tags    the tags its cards have now (so a tag the student already uses can be told from a new one)
//   extra   the note's extra text. It is NOT read for tags: it holds grammar notes, mnemonics and the like, not what the card is about.
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
    out.push({ id, front: front.trim(), text: text.trim(), extra: c.occlusion ? '' : plain(c.noteExtra).trim(), tags: [...new Set(list.flatMap(x => tagWords(x.tags).map(normTag)))], cardIds: list.map(x => x.id) });
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
const union = (a, b) => [...new Set([...a, ...b])].sort((x, y) => x - y);
const isGeneric = w => GENERIC.has(w) || STOPWORDS.has(w) || FILLER.has(w) || FOREIGN.has(w);
const sub = (small, big) => big.includes(' ' + small + ' ') || big.startsWith(small + ' ') || big.endsWith(' ' + small) || big === small;
const MIN_COHESION = 1.5;                  // how much more the cards of a tag share than two cards of the deck do, to be "sure" (unless it is on nearly every front)
const PIECE = 0.6;                         // a word that is this share of the time next to the same other word is not a topic of its own
const MIN_SURE_NOTES = 4;                  // a tag on fewer notes than this is offered, but unticked
const MIN_FRONT = 0.5;                     // the share of a tag's cards that have the word on the front (it names the thing)
const PAIRS_FROM = 40, BASE_NOTES = 60;                 // notes looked at to measure it

// input: { notes, deckWords = [], existingTags = [], max = 15 }   notes: from notesOf()
// Yields { phase, progress } at least every 100 notes while counting and often in each later stage. Returns { tags, reason?, stats }
//   tag: { key, name, label, noteIds, cardIds, count, sample, exists, sure, aliases }
//   sure    the tag is ticked to begin with; the others are offered under "Other possible tags"
//   reason: 'none' when no tag is sure (tags may still hold less sure ones)
export function* autotagSteps({ notes, deckWords = [], existingTags = [], max = MAX_TAGS }) {
  const N = notes.length;
  const none = { tags: [], reason: 'none', stats: { notes: N } };
  const minDf = Math.max(3, Math.ceil(N * 0.02)), maxDf = Math.floor(N * MAX_TOP_SHARE);
  if (N < 6 || maxDf < minDf) return none;

  // 1. Count the phrases of every note. A phrase counts once for a note, however often it is said.
  const counts = newCounts(), inFront = new Map();
  const pairs = new Map();                              // "a b" → notes where b comes straight after a
  for (let i = 0; i < N; i++) {
    const n = notes[i];
    const ft = words(n.front), front = candidatePhrases(ft, { text: n.front });
    addPhrases(counts, front, i);
    for (const k of new Set(front.map(p => p.key))) inFront.set(k, (inFront.get(k) || 0) + 1);
    const tt = n.text ? words(n.text) : [];
    if (tt.length) addPhrases(counts, candidatePhrases(tt, { text: n.text }), i);
    const pr = new Set();
    for (const toks of [ft, tt]) for (let k = 0; k + 1 < toks.length; k++) {
      const a = toks[k].w, b = toks[k + 1].w;
      if (toks[k + 1].brk || STOPWORDS.has(a) || FOREIGN.has(a) || FOREIGN.has(b) || a.includes('-') || b.includes('-')) continue;
      if (!STOPWORDS.has(b)) pr.add(stem(a) + ' ' + stem(b));
      const c = toks[k + 2]?.w;                      // "Pride and Prejudice": "pride" is next to "prejudice" too
      if ((b === 'and' || b === 'of') && c && !toks[k + 2].brk && !STOPWORDS.has(c) && !FOREIGN.has(c)) pr.add(stem(a) + ' ' + stem(c));
    }
    for (const x of pr) pairs.set(x, (pairs.get(x) || 0) + 1);
    if (i % YIELD_EVERY === YIELD_EVERY - 1) yield { phase: 'reading', progress: (i + 1) / N * 0.7 };
  }

  // 2. The phrases that could be a tag: in enough notes but not nearly all, a topic word and not a filler.
  const dw = new Set(deckWords.map(w => stem(w)));
  const cand = [];
  const followedBy = new Map(), precededBy = new Map(), precededAll = new Map();      // word → the most notes in which one other word comes straight after it / before it
  for (const [x, df] of pairs) {
    const sp = x.indexOf(' '), a = x.slice(0, sp), b = x.slice(sp + 1);
    if (df > (followedBy.get(a) || 0)) followedBy.set(a, df);
    if (df > (precededBy.get(b) || 0)) precededBy.set(b, df);
    precededAll.set(b, (precededAll.get(b) || 0) + df);
  }
  let seen = 0;
  for (const [key, e] of counts) {
    if (++seen % 5000 === 0) yield { phase: 'choosing', progress: 0.7 + 0.1 * seen / counts.size };
    const ws = key.split(' ');
    if (e.df < minDf || e.df > maxDf) continue;
    const first = ws[0], last = ws[ws.length - 1];
    const prefixed = ws.length === 2 && first.length === 1 && [...e.forms.keys()].some(f => /^\p{L}-/u.test(f));      // "i-adjective": a hyphenated word with a one-letter start (not "a priori")
    if (NOT_TERMS.test(key) || ws.some(w => NOT_TERMS.test(w))) continue;                // months and weekdays say when, not what
    if (ws.length === 1) {
      if (first.length < 4 || looseWord(first) || isGeneric(first) || dw.has(first) || /\d/.test(first)) continue;
    } else if (prefixed) {
      if (isGeneric(last) || looseWord(last) || last.length < 4 || dw.has(last)) continue;
    } else {
      if (isGeneric(first) || isGeneric(last) || looseWord(first) || looseWord(last) || ws.some(w => (counts.get(w)?.df ?? 0) > N * EVERYWHERE) || ws.every(w => dw.has(w) || isGeneric(w)) || ws.some(w => /\d/.test(w) && !/[a-z]/.test(w))) continue;
    }
    cand.push(key);
  }
  if (cand.length < 3) return none;
  // A word that is mostly followed by the same other word is a modifier ("aggregate" in "aggregate demand"); one that mostly comes after the same
  // other word is a piece of that phrase ("third party" → "party"). The phrases stay as candidates; the lone word goes.
  for (let i = cand.length - 1; i >= 0; i--) {
    const key = cand[i];
    if (key.includes(' ')) continue;
    const df = counts.get(key).df;
    if ((followedBy.get(key) || 0) >= df * PIECE || (precededBy.get(key) || 0) >= df * PIECE) cand.splice(i, 1);
  }
  yield { phase: 'choosing', progress: 0.8 };
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
  yield { phase: 'choosing', progress: 0.82 };
  // Only plurals, hyphen forms and real spelling variants are one word; "alkene" and "alkane" are two.
  const near = groupNear(cand);
  const group = new Map(cand.map(k => { const r = near.get(k); return [k, k === r || k.includes(' ') || r.includes(' ') || variant(k, r) ? r : k]; }));
  yield { phase: 'choosing', progress: 0.84 };
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
  let k = 0;
  for (const m of merged.values()) {
    if (++k % 2000 === 0) yield { phase: 'choosing', progress: 0.85 };
    const df = m.docs.size;
    if (df < minDf || df > maxDf) continue;
    // How specific it is (TF-IDF: more notes is better, but less so as it nears every note), a little more for a phrase, and for a word that
    // is often on the front of a card (the front names the thing).
    m.score = df * Math.log(N / df) * (1 + 0.3 * (m.n - 1)) * (1 + 0.5 * Math.min(1, m.front / df));
    m.docs = [...m.docs].sort((a, b) => a - b);
    m.label = bestForm(m.forms).replace(/['’]s\b/g, '');            // ("Earth's" is "earth")
    if (isJunkTerm(m.label) || !slugTag(m.label)) continue;
    scored.push(m);
  }
  yield { phase: 'choosing', progress: 0.87 };
  if (scored.length < 3) return none;
  scored.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));

  // 3. Decide how sure each tag is, then pick. A tag is sure when it names what the cards are about: the word is on the front of at least half
  // of them, there are 4 or more, it is not a place, and the cards hang together (two cards of one topic share other words besides the tag's
  // own, "preload" and "afterload"; a broad word like "price" sits on cards of different topics that share nothing, measured against two cards
  // of the deck at random). A tag the student already has is sure only if most of its cards carry it already.
  // Only sure tags count toward coverage, so a broad unticked word ("assets") can't use up the cards of a clear topic ("depreciation").
  const termsOf = new Map();
  const terms = i => {
    let t = termsOf.get(i);
    if (!t) {
      t = new Map();
      for (const p of candidatePhrases(words(notes[i].front + '\n' + notes[i].text))) {
        if (p.n !== 1 || p.key.length < 4 || isGeneric(p.key)) continue;
        const df = counts.get(p.key)?.df ?? 0;
        if (df >= 2 && df <= maxDf) t.set(p.key, Math.log(N / df));
      }
      termsOf.set(i, t);
    }
    return t;
  };
  const sim = (a, b, skip) => { let s = 0; const tb = terms(b); for (const [key, w] of terms(a)) if (tb.has(key) && !skip.has(key)) s += w; return s; };
  const pick = (list, n) => list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor(i * list.length / n)]);
  const meanSim = (list, skip) => { let s = 0, c = 0; for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) { s += sim(list[a], list[b], skip); c++; } return c ? s / c : 0; };
  const base = meanSim(pick(Array.from({ length: N }, (_, i) => i), BASE_NOTES), new Set()) || 0.01;
  // A tag the student already has is a tag of the collection ("have"). One kept in a folder ("mktg::pricing") is the same tag as "pricing" when most of
  // THIS tag's own cards carry that one path: then the cards join it (see judge). Folders of other decks, or two folders that tie, change nothing.
  const have = new Set([...existingTags].map(t => normTag(t)));
  const tagged = notes.map(n => new Set(n.tags || []));
  const judge = c => {
    c.name = slugTag(c.label);
    const leaf = c.name, byPath = new Map();
    for (const d of c.docs) for (const t of tagged[d]) if (t.includes('::') && t.split('::').pop() === leaf) byPath.set(t, (byPath.get(t) || 0) + 1);
    const top = [...byPath].sort((a, b) => b[1] - a[1]);
    if (top.length && top[0][1] >= c.docs.length / 2 && (top.length === 1 || top[1][1] < top[0][1])) c.name = top[0][0];
    c.frontShare = Math.min(1, c.front / c.docs.length);
    c.cohesion = null; c.sure = false;
    const place = c.n === 1 && c.key.split(' ').some(w => PLACES.has(w));
    if (place || c.docs.length < MIN_SURE_NOTES || c.frontShare < MIN_FRONT) return;
    if (have.has(c.name) && c.docs.filter(d => tagged[d].has(c.name)).length < c.docs.length / 2) return;
    const own = new Set(c.key.split(' '));
    c.cohesion = meanSim(pick(c.docs, PAIRS_FROM), own) / base;
    // On nearly every front is enough without the cohesion, unless it is the end of many different compounds ("demand curve", "supply curve",
    // "water cycle", "carbon cycle"): then it names no one topic.
    const df = c.docs.length, key = c.key;
    const compoundEnd = c.n === 1 && (precededAll.get(key) || 0) >= df * 0.75 && (precededBy.get(key) || 0) <= df * 0.5;
    c.sure = c.cohesion >= MIN_COHESION || (c.frontShare >= 0.8 && !compoundEnd);
    if (c.frontShare < 0.6 && c.cohesion < 2) c.sure = false;
  };
  const similar = (c, picked) => {
    for (const p of picked) {
      if (derives(c.key, p.key)) { p.docs = union(p.docs, c.docs); p.aliases.push(c.label); return true; }      // "bonding" joins "bond"
      const both = overlap(c.docs, p.docs);
      if (both / (c.docs.length + p.docs.length - both) > MAX_JACCARD) return true;
      // a word of a picked phrase that is nearly always in it (or the other way round) is an alias of it
      if ((c.n < p.n && sub(c.key, p.key) || c.n > p.n && sub(p.key, c.key)) && both / Math.min(c.docs.length, p.docs.length) >= 0.8) return true;
      if (slugTag(c.label) === slugTag(p.label)) return true;
    }
    return false;
  };
  const picked = [], covered = new Uint8Array(N);
  let coveredN = 0, step = 0;
  const take = c => {
    for (const d of c.docs) if (!covered[d]) { covered[d] = 1; coveredN++; }
    c.aliases = [];
    picked.push(c);
  };
  const floor = scored[0].score * MIN_SCORE_SHARE;
  const rest = [];
  for (const c of scored) {                                       // the sure tags first
    if (++step % 100 === 0) yield { phase: 'choosing', progress: 0.9 };
    if (picked.length >= max) break;
    if (c.score < floor) break;
    if (similar(c, picked)) continue;
    judge(c);
    if (!c.sure) { rest.push(c); continue; }
    let fresh = 0;
    for (const d of c.docs) if (!covered[d]) fresh++;
    if (fresh < Math.max(2, N * MIN_NEW)) continue;
    take(c);
  }
  const nSure = picked.length;
  for (const c of rest) {                                         // then the others, for the cards no sure tag reached
    if (picked.length >= max) break;
    if (similar(c, picked)) continue;
    let fresh = 0;
    for (const d of c.docs) if (!covered[d]) fresh++;
    if (fresh < Math.max(2, N * MIN_NEW)) continue;
    take(c);
  }
  if (!picked.length) return none;
  yield { phase: 'choosing', progress: 0.93 };
  const tags = picked.map(p => {
    const ns = p.docs.map(i => notes[i]);
    return {
      key: p.key, name: p.name, label: p.label, aliases: p.aliases,
      noteIds: ns.map(n => n.id), cardIds: ns.flatMap(n => n.cardIds), count: ns.reduce((t, n) => t + n.cardIds.length, 0),
      sample: ns.slice(0, 2).map(n => n.front.replace(/\s+/g, ' ').slice(0, 80)),
      exists: have.has(p.name), cohesion: p.cohesion == null ? null : Math.round(p.cohesion * 10) / 10, front: Math.round(p.frontShare * 100) / 100, sure: p.sure
    };
  });
  const others = tags.slice(nSure).sort((a, b) => b.noteIds.length - a.noteIds.length);       // (the biggest topics first)
  tags.splice(nSure, tags.length, ...others);
  yield { phase: 'choosing', progress: 1 };
  return { tags, ...(nSure ? {} : { reason: 'none' }), stats: { notes: N, covered: coveredN, candidates: scored.length, sure: nSure } };
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
    // (A card already in another folder for the same word, "b::kidney", is in the minority of the majority-folder tag "a::kidney": it keeps its own and gets no second one. A plain "kidney" does join the folder.)
    const leafOf = t => normTag(t).split('::').pop();
    const sameWord = t => own.some(o => { const n = normTag(o); return leafOf(o) === leafOf(t) && n !== normTag(t) && n.includes('::'); });
    for (const t of wanted) { const k = normTag(t); if (!has.has(k) && !sameWord(t)) { has.add(k); add.push(t); } }
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
