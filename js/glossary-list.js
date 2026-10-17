// "Paste a list" for the glossary (item 12). Pure; tested by tests/glossary.test.js. Kept apart from glossary.js so the app's start
// does not load the import code.

import { dupKey } from './import.js';
import { LIMITS } from './glossary.js';

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// ---------- "term - definition" lists (Paste a list) ----------
// Each line picks its own separator, the first of these it contains: a tab, " - ", " – ", ": ", "=" (then "|"). So a list that mixes
// "beta-agonist - stimulates receptors", "Anti-HBs: antibody" and a tab-separated line reads all three. Left of the separator is the
// term, the rest is the definition.
// → { items: [{ term, def }] (new terms), already: n (the glossary has them), repeated: n (an earlier line has them), noDef: n (no
//     separator or nothing after it), tooLong: n (term over the limit), skipped: noDef + tooLong, over: n (the glossary is full) }
const SEPARATORS = ['\t', ' - ', ' – ', ': ', '=', '|'];
export function splitLine(line) {
  for (const sep of SEPARATORS) {
    const at = line.indexOf(sep);
    if (at > 0) return [line.slice(0, at), line.slice(at + sep.length)];
  }
  return [line, ''];
}
export function parseGlossaryList(text, existing = []) {
  const have = new Set(existing.flatMap(e => [e.term, ...(e.aliases || [])]).map(dupKey));
  const seen = new Set();
  const items = [];
  let already = 0, repeated = 0, noDef = 0, tooLong = 0, over = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rawTerm, rawDef] = splitLine(line);
    const term = str(rawTerm, 1e6), def = rawDef.trim();
    if (!term || !def) { noDef++; continue; }
    if (term.length > LIMITS.term) { tooLong++; continue; }
    if (have.has(dupKey(term))) { already++; continue; }
    if (seen.has(dupKey(term))) { repeated++; continue; }
    if (existing.length + items.length >= LIMITS.terms) { over++; continue; }
    seen.add(dupKey(term));
    items.push({ term, def: def.slice(0, LIMITS.def) });
  }
  return { items, already, repeated, noDef, tooLong, skipped: noDef + tooLong, over };
}
