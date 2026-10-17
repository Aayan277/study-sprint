// "Paste a list" for the glossary (item 12). Pure; tested by tests/glossary.test.js. Kept apart from glossary.js so the app's start
// does not load the import code.

import { parseText, dupKey } from './import.js';
import { LIMITS } from './glossary.js';

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// ---------- "term - definition" lists (Paste a list) ----------
// Pasted text goes through the same format detection as importing cards (import.js parseText: "term - definition", "term: definition",
// tabs, tables, Quizlet exports…). Column 1 is the term, column 2 the definition.
// → { items: [{ term, def }] (new terms), already: n (terms the glossary has, or that repeat in the list), skipped: n (no definition or too long),
//     over: n (left out because the glossary is full), format }
export function parseGlossaryList(text, existing = []) {
  const parsed = parseText(text);
  const have = new Set(existing.flatMap(e => [e.term, ...(e.aliases || [])]).map(dupKey));
  const items = [];
  let already = 0, skipped = 0, over = 0;
  for (const row of parsed.rows) {
    const term = str(row[0], 1e6), def = typeof row[1] === 'string' ? row[1].trim() : '';
    if (!term || !def || term.length > LIMITS.term) { skipped++; continue; }
    if (have.has(dupKey(term))) { already++; continue; }
    if (existing.length + items.length >= LIMITS.terms) { over++; continue; }
    have.add(dupKey(term));
    items.push({ term, def: def.slice(0, LIMITS.def) });
  }
  return { items, already, skipped, over, format: parsed.format };
}
