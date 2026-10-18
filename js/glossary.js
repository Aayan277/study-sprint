// Your own glossary (item 12). Pure functions (no page, no database), tested by tests/glossary.test.js.
//
// Each term is its own synced setting: the key is "gloss:<id>" and the value { term, aliases: [], def, at }, or null once it is
// deleted. Because every term is a separate setting, the newest copy of each term wins and two devices that add different terms
// keep both. db.js and sync-data.js treat any key starting "gloss:" as a synced setting (isSyncedSetting).
//
//   entriesFrom(settings)            the terms in a settings object → [{ id, term, aliases, def, at }], A to Z
//   cleanEntry / cleanGlossary       check what came from outside (a backup, another device): bad entries are dropped
//   buildMatcher(entries)            one regular expression for the whole glossary (cached per glossary version)
//   findTerms(text, matcher, opts)   where the terms are in a piece of text (each term only the first time)

export const GLOSS_PREFIX = 'gloss:';
export const isGlossKey = key => typeof key === 'string' && key.startsWith(GLOSS_PREFIX);
export const LIMITS = { term: 80, aliases: 5, alias: 80, def: 1000, terms: 2000 };

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// → a good entry { term, aliases, def, at }, or null. The definition keeps its line breaks and card marks (bold, maths…).
export function cleanEntry(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const term = str(v.term, LIMITS.term);
  if (!term) return null;
  const def = typeof v.def === 'string' ? v.def.replace(/\r\n?/g, '\n').trim().slice(0, LIMITS.def) : '';
  const seen = new Set([term.toLowerCase()]);
  const aliases = [];
  for (const a of Array.isArray(v.aliases) ? v.aliases : []) {
    const alias = str(a, LIMITS.alias);
    if (alias && !seen.has(alias.toLowerCase()) && aliases.length < LIMITS.aliases) { seen.add(alias.toLowerCase()); aliases.push(alias); }
  }
  return { term, aliases, def, at: Number.isFinite(v.at) ? v.at : 0 };
}

// A settings object (or the entries of one) with the glossary part checked: a deleted term (null) stays, a broken one goes,
// and only the first `limit` terms are kept. Everything that is not a "gloss:" key passes through untouched.
//   limit: how many terms to keep (a restore passes Infinity: a backup is never cut down)
export function cleanGlossary(settings, { limit = LIMITS.terms } = {}) {
  const out = {};
  let terms = 0;
  for (const [k, v] of Object.entries(settings || {})) {
    if (!isGlossKey(k)) { out[k] = v; continue; }
    if (v === null) { out[k] = null; continue; }
    const e = cleanEntry(v);
    if (e && k.length > GLOSS_PREFIX.length && terms < limit) { out[k] = e; terms++; }
  }
  return out;
}

// The terms in a settings object, A to Z. Deleted (null) and broken ones are left out.
export function entriesFrom(settings) {
  const out = [];
  for (const k of Object.keys(settings || {})) {
    if (!isGlossKey(k)) continue;
    const e = cleanEntry(settings[k]);
    if (e) out.push({ id: k.slice(GLOSS_PREFIX.length), ...e });
  }
  return out.sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
}

// ---------- matching ----------
// Whole words for scripts written with spaces; a plain substring for Chinese, Japanese and Thai (which have none).
// Spellings are bucketed so a card is scanned quickly even with thousands of terms: a spelling that starts with a letter or digit
// goes in the bucket of its first word ("atp synthase" → "atp"), one that starts with a symbol or a CJK character goes in the
// bucket of its first character. Only a word that really starts at a position is looked up, and a small expression (built the
// first time its bucket is needed) is tried there.
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const WORD = '[\\p{L}\\p{N}\\p{M}]';
const WORD_CH = /^[\p{L}\p{N}\p{M}]/u;
const WORD_RUN = /[\p{L}\p{N}\p{M}]+/uy;
// (A "-" needs no escape, and is not allowed to have one when the u flag is on.)
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
const shortTerm = s => [...s].length <= 2;       // 1 or 2 characters: "Na" must not match "na"
const firstChar = s => String.fromCodePoint(s.codePointAt(0));

// ---------- plurals and hyphens ----------
// A term also matches its simple English plural or singular (s, es, ies <-> y) and the hyphen-or-space spelling of a compound: the
// term "ACE inhibitor" is also found in "ACE inhibitors" and "ACE-inhibitor". Only the last word changes number. An exact spelling
// always wins over these variants. Terms of 1 or 2 characters ("Na") and Chinese, Japanese and Thai text get none.
// To stay fast with thousands of terms the search itself is not widened: spellings and the text are both read with a hyphen (or any
// run of spaces) between two words as one plain space, and a spelling that ends in a letter also looks for the other number of its
// last word (see pattern). `spellings` knows those other forms, to say which term a found text belongs to.
// Words whose "s" form is a different word, or not a plural at all: "new" is not "news", "aid" is not "AIDS", and "bias", "lens", "series" and
// "species" are already single words.
const NO_NUMBER = new Set(['new', 'news', 'aid', 'aids', 'bias', 'lens', 'series', 'species', 'alias', 'atlas', 'canvas']);
function numberForms(w) {
  const n = [...w].length;
  if (n < 3 || NO_NUMBER.has(w.toLowerCase())) return [];
  if (/ies$/i.test(w) && n > 4) return [w.slice(0, -3) + 'y'];
  if (/(?:ss|sh|ch|x|z)es$/i.test(w) && n > 4) return [w.slice(0, -2)];
  if (/[^s\W]s$/i.test(w) && n > 3 && !/(?:us|is)$/i.test(w)) return [w.slice(0, -1)];
  if (/s$/i.test(w)) return [];                                         // bus, virus, diagnosis, stress: leave alone
  if (/[^aeiou\W]y$/i.test(w)) return [w.slice(0, -1) + 'ies'];
  if (/(?:x|z|ch|sh)$/i.test(w)) return [w + 'es'];
  return [w + 's'];
}
// Between two letters or digits: a hyphen, a run of spaces, or a tab or line break (but not one plain space, which is already right).
const ODD_SEP = /([\p{L}\p{N}\p{M}])(?:[\s-]*-[\s-]*|\s{2,}|[^\S ])(?=[\p{L}\p{N}\p{M}])/gu;
const ODD_SEP_ANY = new RegExp(ODD_SEP.source, 'u');          // (the same without g: a global one remembers where it stopped)
const canon = text => text.normalize('NFC').toLowerCase().replace(ODD_SEP, '$1 ');
// The text with those separators as one space, and where each of its characters was: { c, map } (map is null when nothing changed).
function canonText(text) {
  if (!ODD_SEP_ANY.test(text)) return { c: text, map: null };
  let c = '', last = 0;
  const map = [];
  const copy = (from, to) => { for (let j = from; j < to; j++) { c += text[j]; map.push(j); } };
  for (const m of text.matchAll(ODD_SEP)) {
    const at = m.index + m[1].length;
    copy(last, at);
    c += ' '; map.push(at);
    last = m.index + m[0].length;
  }
  copy(last, text.length);
  return { c, map };
}
// A spelling (canonical, lower case) as its last word and the other forms of it; null when it gets no variants.
const appended = (w, f) => f === w + 's' || f === w + 'es';
function split(low) {
  if ([...low].length <= 2 || NO_SPACES.test(low)) return null;
  const m = low.match(/^(.*?)([\p{L}]+)$/u);
  return m ? { head: m[1], last: m[2], forms: numberForms(m[2]) } : null;
}

let cache = { key: '', matcher: null };
// → null (no terms) or { words, chars, cjk, spellings, key }. The longest spelling wins ("ATP synthase" before "ATP"). When two
// terms share a spelling, the one defined first (older `at`, then id) wins. Built once per glossary version.
export function buildMatcher(entries) {
  if (!entries?.length) return null;
  const key = entries.map(e => `${e.id}\u0001${e.at}\u0001${e.term}\u0001${(e.aliases || []).join('\u0002')}`).join('\u0003');
  if (cache.key === key) return cache.matcher;
  const spellings = new Map();                    // canonical text → [{ text, entry, variant }]
  const search = new Set();                       // what is searched for: the canonical spellings, and the other number of their last word
  const exact = new Set();                        // (the canonical spellings alone)
  const ordered = [...entries].sort((a, b) => (a.at - b.at) || a.id.localeCompare(b.id));
  const add = (k, spelling) => { const list = spellings.get(k); if (list) list.push(spelling); else spellings.set(k, [spelling]); };
  for (const entry of ordered) {
    for (const text of [entry.term, ...(entry.aliases || [])]) {
      const k = canon(text);
      search.add(k); exact.add(k);
      if (!spellings.get(k)?.some(s => s.text === text)) add(k, { text, entry, variant: false });
    }
  }
  // The other number of the last word, after every exact spelling is in (so a variant never hides a real term).
  for (const entry of ordered) {
    for (const text of [entry.term, ...(entry.aliases || [])]) {
      const parts = split(canon(text));
      if (!parts) continue;
      for (const f of parts.forms) {
        const variant = parts.head + f, list = spellings.get(variant);
        if (list && (list.some(s => !s.variant) || list.some(s => s.entry === entry))) continue;
        add(variant, { text: variant, entry, variant: true });
        if (!appended(parts.last, f)) search.add(variant);          // (s and es on the end are found by the search itself, see bucketRe)
      }
    }
  }
  const words = new Map(), chars = new Map(), cjk = new Map();
  const put = (map, k, spelling) => { const b = map.get(k); if (b) b.list.push(spelling); else map.set(k, { list: [spelling], re: undefined }); };
  for (const k of search) {
    if (NO_SPACES.test(k)) put(cjk, firstChar(k), k);
    else if (WORD_CH.test(k)) {
      put(words, k.match(/^[\p{L}\p{N}\p{M}]+/u)[0], k);
      // A one-word spelling is also found by the other number of that word ("cell" by "cells"): look in that word's bucket too.
      const parts = split(k);
      if (parts && parts.head === '' && exact.has(k)) for (const f of parts.forms) if (appended(parts.last, f)) put(words, f, k);
    }
    else put(chars, firstChar(k), k);
  }
  const matcher = { words, chars, cjk, spellings, key };
  cache = { key, matcher };
  return matcher;
}

// The expression of one bucket, made the first time it is needed. A spelling that cannot be made into an expression is left out
// (so one odd term can never stop the others from being underlined).
function bucketRe(bucket, boundary) {
  if (bucket.re !== undefined) return bucket.re;
  const alts = bucket.list.sort((a, b) => b.length - a.length).map(escapeRe);
  // A word may end in s or es (cell -> cells, box -> boxes): whether that is a form of the term is for entryFor to say.
  const make = list => new RegExp(`(?:${list.join('|')})${boundary ? `(?:(?:es|s)(?!${WORD})|(?!${WORD}))` : ''}`, 'iuy');
  try { bucket.re = make(alts); } catch {
    const good = [];
    for (const a of alts) { try { make([a]); good.push(a); } catch { /* skip this spelling */ } }
    try { bucket.re = good.length ? make(good) : null; } catch { bucket.re = null; }
  }
  return bucket.re;
}

// Which entry does this matched text belong to? (A 1–2 character term only counts when written exactly as defined.)
function entryFor(matched, matcher) {
  const list = matcher.spellings.get(matched.normalize('NFC').toLowerCase());
  if (!list) return null;
  if (shortTerm(matched)) return list.find(s => s.text === matched && !s.variant)?.entry || null;
  return (list.find(s => !s.variant) || list[0]).entry;
}

// Where the terms are in `text`: [{ start, end, entry }] in reading order.
//   seen   Set of entry ids already marked on this face (updated here), so each term is marked only the first time
//   skip   Set of entry ids never to mark (on a front: the terms that are in the answer)
export function findTerms(original, matcher, { seen = new Set(), skip = null } = {}) {
  const out = [];
  if (!matcher || !original) return out;
  const { c: text, map } = canonText(original);
  const n = text.length;
  let i = 0, prevWord = false;
  while (i < n) {
    const cp = text.codePointAt(i), ch = String.fromCodePoint(cp), isWord = WORD_CH.test(ch);
    let m = null;
    const tryBucket = (bucket, boundary) => {
      const re = bucket && bucketRe(bucket, boundary);
      if (!re) return null;
      re.lastIndex = i;
      return re.exec(text);
    };
    m = tryBucket(matcher.cjk.get(ch.toLowerCase()) || matcher.cjk.get(ch), false);
    if (!m && !prevWord) {
      if (isWord) { WORD_RUN.lastIndex = i; m = tryBucket(matcher.words.get(WORD_RUN.exec(text)[0].normalize('NFC').toLowerCase()), true); }
      else m = tryBucket(matcher.chars.get(ch.toLowerCase()), true);
    }
    if (m && m[0]) {
      const entry = entryFor(m[0], matcher);
      if (entry && !seen.has(entry.id) && !skip?.has(entry.id)) {
        seen.add(entry.id);
        out.push(map ? { start: map[i], end: map[i + m[0].length - 1] + 1, entry } : { start: i, end: i + m[0].length, entry });
      }
      i += m[0].length;
      prevWord = WORD_CH.test([...m[0]].pop());
    } else { prevWord = isWord; i += ch.length; }
  }
  return out;
}

// The ids of the terms that appear in some text (for the front-answer rule: a term that is in the card's back is not marked on the front).
export const termIdsIn = (text, matcher) => new Set(findTerms(text, matcher).map(t => t.entry.id));
