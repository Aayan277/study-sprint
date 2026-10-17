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
// and only the first LIMITS.terms terms are kept. Everything that is not a "gloss:" key passes through untouched.
export function cleanGlossary(settings) {
  const out = {};
  let terms = 0;
  for (const [k, v] of Object.entries(settings || {})) {
    if (!isGlossKey(k)) { out[k] = v; continue; }
    if (v === null) { out[k] = null; continue; }
    const e = cleanEntry(v);
    if (e && k.length > GLOSS_PREFIX.length && terms < LIMITS.terms) { out[k] = e; terms++; }
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
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const WORD = '[\\p{L}\\p{N}\\p{M}]';
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
const shortTerm = s => [...s].length <= 2;       // 1 or 2 characters: "Na" must not match "na"

let cache = { key: '', matcher: null };
// → null (no terms) or { re, spellings, key }. The longest spelling wins ("ATP synthase" before "ATP"). When two terms share a
// spelling, the one defined first (older `at`, then id) wins. The expression is built once per glossary version.
export function buildMatcher(entries) {
  if (!entries?.length) return null;
  const key = entries.map(e => `${e.id}\u0001${e.at}\u0001${e.term}\u0001${(e.aliases || []).join('\u0002')}`).join('\u0003');
  if (cache.key === key) return cache.matcher;
  const spellings = new Map();                    // lowercase text → [{ text, entry }]
  for (const entry of [...entries].sort((a, b) => (a.at - b.at) || a.id.localeCompare(b.id))) {
    for (const text of [entry.term, ...(entry.aliases || [])]) {
      const k = text.toLowerCase();
      const list = spellings.get(k) || [];
      if (!list.some(s => s.text === text)) list.push({ text, entry });
      spellings.set(k, list);
    }
  }
  const words = [], blocks = [];
  for (const k of [...spellings.keys()].sort((a, b) => b.length - a.length)) (NO_SPACES.test(k) ? blocks : words).push(escapeRe(k));
  const parts = [];
  if (words.length) parts.push(`(?<!${WORD})(?:${words.join('|')})(?!${WORD})`);
  if (blocks.length) parts.push(`(?:${blocks.join('|')})`);
  const matcher = { re: new RegExp(parts.join('|'), 'giu'), spellings, key };
  cache = { key, matcher };
  return matcher;
}

// Which entry does this matched text belong to? (A 1–2 character term only counts when written exactly as defined.)
function entryFor(matched, matcher) {
  const list = matcher.spellings.get(matched.toLowerCase());
  if (!list) return null;
  if (shortTerm(matched)) return list.find(s => s.text === matched)?.entry || null;
  return list[0].entry;
}

// Where the terms are in `text`: [{ start, end, entry }] in reading order.
//   seen   Set of entry ids already marked on this face (updated here), so each term is marked only the first time
//   skip   Set of entry ids never to mark (on a front: the terms that are in the answer)
export function findTerms(text, matcher, { seen = new Set(), skip = null } = {}) {
  const out = [];
  if (!matcher || !text) return out;
  const re = matcher.re;
  re.lastIndex = 0;
  for (let m; (m = re.exec(text));) {
    if (!m[0]) { re.lastIndex++; continue; }
    const entry = entryFor(m[0], matcher);
    if (!entry || seen.has(entry.id) || skip?.has(entry.id)) continue;
    seen.add(entry.id);
    out.push({ start: m.index, end: m.index + m[0].length, entry });
  }
  return out;
}

// The ids of the terms that appear in some text (for the front-answer rule: a term that is in the card's back is not marked on the front).
export const termIdsIn = (text, matcher) => new Set(findTerms(text, matcher).map(t => t.entry.id));
