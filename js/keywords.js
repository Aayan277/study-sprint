// Finding the key words and phrases of a text: splitting it into words, folding plurals, finding candidate phrases, counting them and
// weighing them (TF-IDF). Shared by "Suggest cards" (js/reading-cards.js) and, later, "Suggest tags" for a deck.
// Pure functions only (no page, no database), so they run in a worker (js/keywords-worker.js) and in node --test.
// Tested by tests/keywords.test.js.

import { editDistance } from './match.js';

// Function words that never make a good key term on their own (English).
export const STOPWORDS = new Set(`a about above after again against all also am an and any are aren't as at be because been before being below
between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each either else even ever every few for
from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm
i've if in into is isn't it it's its itself just let's like many may me might more most much must mustn't my myself neither no nor not of off on
once one only onto or other ought our ours ourselves out over own per rather same shall shan't she she'd she'll she's should shouldn't so some
such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those though through
thus to too under until up upon us very via was wasn't we we'd we'll we're we've were weren't what what's when when's where where's whether
which while who who's whom whose why why's will with within without won't would wouldn't yet you you'd you'll you're you've your yours yourself
yourselves something anything everything nothing someone anyone everyone nobody`.split(/\s+/));

// Words that say where something is in a document or who is talking, not what it is about.
export const FILLER = new Set(`example examples e.g eg i.e ie etc figure fig table page slide chapter lecture lec note notes week today important
following also used use called question answer card front back todo see ref`.split(/\s+/));

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const TRAIL = /['’-]+$/;
const NUMERIC = /^[\p{N}][\p{N}.,'’-]*$/u;
const SENTENCE_GAP = /[.!?\n]/;
const BREAK_GAP = /[.,;:!?()[\]{}"“”\n–—/|•]/;

// The words of a text: [{ w, raw, start, end, first, brk }]
//   w     lower case, accents kept, ’ written as '
//   raw   as written
//   first the word starts a sentence (or a line)
//   brk   something other than a space or hyphen sits between this word and the one before (a comma, a bracket, a line end…), so a
//         phrase cannot run across it
export function words(text) {
  const s = String(text ?? '');
  const out = [];
  let prevEnd = 0;
  for (const m of s.matchAll(WORD)) {
    let raw = m[0];
    const t = raw.match(TRAIL);
    if (t && t.index > 0) raw = raw.slice(0, t.index);
    const start = m.index, end = start + raw.length;
    const gap = s.slice(prevEnd, start);
    out.push({ w: raw.toLowerCase().replace(/’/g, "'"), raw, start, end, first: !out.length || SENTENCE_GAP.test(gap), brk: !out.length || BREAK_GAP.test(gap) });
    prevEnd = end;
  }
  return out;
}

// A light fold of plurals and possessives: "cells" → "cell", "studies" → "study", "glasses" → "glass", "boxes" → "box".
// A word that ends in ss, us, is, ous, ics or as (or is 3 letters or fewer) keeps its s: "virus", "analysis", "physics", "bus".
export function stem(w) {
  w = String(w).toLowerCase().replace(/’/g, "'");
  w = w.replace(/'s$/, '').replace(/s'$/, 's');
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (/(?:x|ch|sh|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 3 && !/(?:ss|us|is|ous|ics|as)$/.test(w)) return w.slice(0, -1);
  return w;
}

// The key of a phrase: stemmed words joined by a space ('-' counts as a space). Words can be strings or tokens from words().
export function keyOf(ws) {
  return ws.map(x => (typeof x === 'string' ? x : x.w)).join(' ').split(/[\s-]+/).filter(Boolean).map(stem).join(' ');
}

const isStop = w => STOPWORDS.has(w) || FILLER.has(w);
const isNumeric = w => NUMERIC.test(w);

// Phrases of 1 to maxN words that could be a key term: no stopword (or filler, or number) in them, except an inner "of" in a 3-word phrase
// ("treaty of versailles"); they never run across a comma, bracket or line end.
//   → [{ key, text, start, end, n, caps }]   caps: every word is capitalised and the phrase does not start a sentence (a proper noun)
export function candidatePhrases(tokens, { maxN = 3, text = null } = {}) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (isStop(a.w) || isNumeric(a.w)) continue;
    for (let n = 1; n <= maxN && i + n <= tokens.length; n++) {
      const last = tokens[i + n - 1];
      if (n > 1 && last.brk) break;
      if (isStop(last.w) || isNumeric(last.w)) {
        continue;
      }
      let ok = true;
      for (let k = 1; k < n - 1; k++) {
        const t = tokens[i + k];
        if (t.brk) { ok = false; break; }
        if (isNumeric(t.w) || (isStop(t.w) && !(n === 3 && t.w === 'of'))) { ok = false; break; }
      }
      if (!ok) continue;
      const slice = tokens.slice(i, i + n);
      const caps = !a.first && slice.every(t => /^\p{Lu}/u.test(t.raw) || (t.w === 'of' && t !== a && t !== last));
      out.push({ key: keyOf(slice), text: text ? text.slice(a.start, last.end) : slice.map(t => t.raw).join(' '), start: a.start, end: last.end, n, caps });
    }
  }
  return out;
}

// ---------- counting ----------

export const newCounts = () => new Map();
// Count the phrases of one document (already split into phrases by candidatePhrases) as document number `at`.
export function addPhrases(counts, phrases, at) {
  for (const p of phrases) {
    let e = counts.get(p.key);
    if (!e) counts.set(p.key, e = { df: 0, tf: 0, forms: new Map(), docs: [] });
    e.tf++;
    e.forms.set(p.text, (e.forms.get(p.text) || 0) + 1);
    if (e.docs[e.docs.length - 1] !== at) { e.docs.push(at); e.df++; }
  }
  return counts;
}
// Add documents (strings) to the counts. `base` is the index the first one has. → counts
export function addDocs(counts, docs, base = 0, opts) {
  docs.forEach((doc, d) => addPhrases(counts, candidatePhrases(words(doc), opts), base + d));
  return counts;
}
// docs: string[]  → Map key → { df: documents it is in, tf: times it appears, forms: Map(text → n), docs: [document indexes] }
export function countPhrases(docs, opts) {
  return addDocs(newCounts(), docs, 0, opts);
}

// How specific each phrase is to the text: key → 0..1. A phrase that is in a few of the documents scores well; one that is in nearly all
// of them (the subject of the whole text, like "cell" in a biology chapter) scores low, and so does a one-off. (A phrase said twice in
// one document counts once: it is the wording of that document, not a term of the text.)
export function termWeights(counts, nDocs) {
  const raw = new Map();
  let max = 0;
  for (const [key, e] of counts) {
    const idf = Math.log(1 + nDocs / e.df);
    const w = (1 + Math.log(e.df)) * idf * idf;
    raw.set(key, w);
    if (w > max) max = w;
  }
  const out = new Map();
  for (const [key, w] of raw) out.set(key, max ? w / max : 0);
  return out;
}

const SMALL = new Set(['of', 'the', 'and', 'de', 'la', 'von', 'van', 'for', 'in']);        // (small words inside a name: "Treaty of Versailles")
// The way a phrase is usually written: the most frequent form, in lower case unless it is always written with capitals.
export function bestForm(forms) {
  let best = '', n = -1, allCaps = true;
  for (const [t, c] of forms) {
    if (c > n || (c === n && t < best)) { best = t; n = c; }
    if (!t.split(/\s+/).every(x => /^\p{Lu}/u.test(x) || SMALL.has(x))) allCaps = false;
  }
  return allCaps ? best : best.toLowerCase();
}

// ---------- near-duplicates ----------

// The same phrase, or two single words of 5 letters or more one letter apart (color / colour).
export function near(a, b) {
  if (a === b) return true;
  const x = a.replace(/-/g, ' '), y = b.replace(/-/g, ' ');
  if (x === y) return true;
  if (x.includes(' ') || y.includes(' ') || x.length < 5 || y.length < 5 || Math.abs(x.length - y.length) > 1) return false;
  return editDistance(x, y) <= 1;
}
// key → the key it is grouped under (the first of its group, in the order given)
export function groupNear(keys) {
  const list = [...new Set(keys)];
  const parent = new Map(list.map(k => [k, k]));
  const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const buckets = new Map();
  for (const k of list) {
    const flat = k.replace(/-/g, ' ');
    if (flat !== k && parent.has(flat)) parent.set(find(k), find(flat));
    if (flat.includes(" ") || flat.length < 5) continue;
    for (const len of [flat.length - 1, flat.length, flat.length + 1]) {
      for (const other of buckets.get(flat[0] + len) || []) if (near(flat, other)) parent.set(find(k), find(other));
    }
    const slot = flat[0] + flat.length;
    if (!buckets.has(slot)) buckets.set(slot, []);
    buckets.get(slot).push(flat);
  }
  const order = new Map(list.map((k, i) => [k, i]));
  const best = new Map();
  for (const k of list) {
    const r = find(k);
    if (!best.has(r) || order.get(k) < order.get(best.get(r))) best.set(r, k);
  }
  return new Map(list.map(k => [k, best.get(find(k))]));
}

// ---------- tags and junk ----------

// "Cell cycle" → "cell-cycle": lower case, spaces to '-', letters, digits, '-' and '_' kept, at most 40 characters, '' when nothing is left.
export function slugTag(text) {
  return String(text ?? '').toLowerCase().normalize('NFC').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

// Not worth a card or a tag: only stopwords or filler, fewer than 3 letters, only digits, or mostly not letters.
export function isJunkTerm(text) {
  const s = String(text ?? '').trim();
  if (!s) return true;
  const letters = (s.match(/\p{L}/gu) || []).length;
  if (letters < 3) return true;
  if (/^[\p{N}\s.,%-]+$/u.test(s)) return true;
  if (letters < s.replace(/\s/g, '').length / 2) return true;
  const ws = words(s);
  return !ws.length || ws.every(t => STOPWORDS.has(t.w) || FILLER.has(t.w));
}
