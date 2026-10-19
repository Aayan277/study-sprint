// The Import screen's part of "Suggest cards": what a row of suggestions looks like, the summary line, the filter, and how ticks and edits
// are carried over when the text changes and the suggestions are found again. Loaded by import-screen.js, which keeps all the state;
// nothing here touches the database or the page (it only makes text and HTML, so it runs in node --test: tests/reading-suggest.test.js).
// The finding itself is js/reading-cards.js (run in a worker by js/keywords-job.js).
import { clozeCard, clozeNumbers } from './cloze.js';
import { KIND_LABEL, KIND_ORDER, MAX_CHARS, MAX_SUGGESTIONS } from './reading-cards.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const SUGGESTED_TAG = 'suggested';
export const MAX_CARRIED = 300;                       // changes kept for the draft (a long text could have hundreds)

const PLURAL = { definition: 'definitions', vocab: 'word pairs', acronym: 'abbreviations', list: 'lists', term: 'key terms', fact: 'numbers or dates', sentence: 'key sentences' };
const SINGULAR = { definition: 'definition', vocab: 'word pair', acronym: 'abbreviation', list: 'list', term: 'key term', fact: 'number or date', sentence: 'key sentence' };
export const kindWord = (kind, n) => (n === 1 ? SINGULAR[kind] : PLURAL[kind]) || kind;
export const kindLabel = kind => KIND_LABEL[kind] || kind;

// The suggestions as an import result (what import.js's buildCards understands), with the suggestions themselves beside it.
export function toResult(suggestions) {
  return {
    columns: ['Front', 'Back'], format: { id: 'suggest', label: 'suggested from your text' }, headerSkipped: false,
    rows: suggestions.map(s => (s.type === 'cloze' ? [clozeCard(s.cloze, 1).front, clozeCard(s.cloze, 1).back] : [s.front, s.back])),
    clozes: suggestions.map((s, i) => (s.type === 'cloze' ? { noteKey: 'sug' + i, n: 1, text: s.cloze } : null)),
    both: suggestions.map(s => !!s.both),
    tags: suggestions.map(() => [SUGGESTED_TAG]),
    suggest: suggestions
  };
}

// A card made from a suggestion: whether it is ticked to begin with, and what it was before any edit (to tell what was changed).
export function decorate(card, sug, onDeck) {
  card.sug = sug;
  card.pick = !!sug.strong && !onDeck;
  card.orig = { pick: card.pick, front: card.front, back: card.back, cloze: card.cloze?.text ?? '' };
  return card;
}

// A card's edit made the cloze have no {{c1::…}} blank: it cannot be a card (front is emptied so it counts as incomplete).
export function editCloze(card, value) {
  card.cloze.text = value;
  if (clozeNumbers(value).includes(1)) {
    const c = clozeCard(value, 1);
    card.front = c.front; card.back = c.back;
    return true;
  }
  card.front = ''; card.back = '';
  return false;
}

// What was changed on the cards, by suggestion key: { key: { pick, front, back, cloze } } for the unticked or edited ones only.
export function changesOf(cards) {
  const out = {};
  let n = 0;
  for (const c of cards) {
    if (!c.sug || n >= MAX_CARRIED) continue;
    const o = c.orig, ch = {};
    if (c.pick !== o.pick) ch.pick = c.pick;
    if (c.cloze) { if (c.cloze.text !== o.cloze) ch.cloze = c.cloze.text; }
    else {
      if (c.front !== o.front) ch.front = c.front;
      if (c.back !== o.back) ch.back = c.back;
    }
    if (Object.keys(ch).length) { out[c.sug.key] = ch; n++; }
  }
  return out;
}
// Put changes back on (new) cards with the same suggestion keys.
export function applyChanges(cards, changes) {
  if (!changes) return;
  for (const c of cards) {
    const ch = c.sug && changes[c.sug.key];
    if (!ch) continue;
    if (typeof ch.pick === 'boolean') c.pick = ch.pick;
    if (c.cloze) { if (typeof ch.cloze === 'string') editCloze(c, ch.cloze); }
    else {
      if (typeof ch.front === 'string') c.front = ch.front;
      if (typeof ch.back === 'string') c.back = ch.back;
    }
  }
}

// ---------- the summary above the list ----------

export function summaryHtml({ cards, stats }) {
  const total = cards.length;
  const by = {};
  for (const c of cards) by[c.sug.kind] = (by[c.sug.kind] || 0) + 1;
  const kinds = KIND_ORDER.filter(k => by[k]).map(k => `${by[k]} ${kindWord(k, by[k])}`);
  const picked = cards.filter(c => c.pick).length;
  const strong = cards.filter(c => c.orig.pick).length;
  const parts = [`Suggested <b>${plural(total, 'card')}</b> from your text${kinds.length ? ': ' + kinds.join(', ') : ''}.`];
  parts.push(strong ? `The strongest <b>${strong}</b> ${strong === 1 ? 'is' : 'are'} ticked.` : 'None are ticked, because none looked certain.');
  parts.push('Check each one: suggestions can be wrong.');
  if (picked) parts.push(`They get a <b>${SUGGESTED_TAG}</b> tag so you can find and check them.`);
  if (stats?.cut) parts.push(`Your text is very long, so these come from the first ${MAX_CHARS.toLocaleString('en')} characters.`);
  if (stats && stats.total > stats.shown) parts.push(`Showing the best ${stats.shown} of ${stats.total}.`);
  return parts.join(' ');
}
export const NONE_FOUND = 'No cards found. Suggestions need full sentences like “Osmosis is the movement of water…”, or lines like “term: meaning”. Try Make cards with Claude, or read it as cards.';
export const STOPPED = 'Stopped. Press Suggest cards to try again.';
export const TIMED_OUT = 'This took too long. Try a shorter part of the text.';
export const FAILED = "Couldn't suggest cards from this text. Try Make cards with Claude instead.";

// ---------- the filter ----------

// The options of the "Show" box: All, Ticked, then each kind that is there. value: 'all', 'ticked' or the kind.
export function filterOptions(cards) {
  const by = {};
  for (const c of cards) by[c.sug.kind] = (by[c.sug.kind] || 0) + 1;
  const out = [{ value: 'all', label: `All (${cards.length})` }, { value: 'ticked', label: `Ticked (${cards.filter(c => c.pick).length})` }];
  for (const k of KIND_ORDER) if (by[k]) out.push({ value: k, label: `${cap(kindWord(k, 2))} (${by[k]})` });
  return out;
}
const cap = s => s[0].toUpperCase() + s.slice(1);
export const shownBy = (card, filter) => filter === 'all' || (filter === 'ticked' ? !!card.pick : card.sug.kind === filter);

// ---------- one row ----------

// Escaped, with no inline handlers: import-screen.js listens on the list.
export function rowHtml(c, i) {
  const n = i + 1, kind = kindLabel(c.sug.kind);
  const fields = c.cloze
    ? `<textarea rows="2" data-side="cloze" aria-label="Card ${n}, fill in the blank. The hidden words are inside {{c1:: and }}" aria-describedby="sk${i}">${esc(c.cloze.text)}</textarea>`
    : `<textarea rows="1" data-side="front" aria-label="Front of card ${n}" aria-describedby="sk${i}" placeholder="Front">${esc(c.front)}</textarea>
        <textarea rows="1" data-side="back" aria-label="Back of card ${n}" placeholder="Back">${esc(c.back)}</textarea>`;
  const src = esc(c.sug.source) + (c.sug.where ? `<span class="muted"> · ${esc(c.sug.where)}</span>` : '');
  return `<li class="prow sug${c.pick ? '' : ' off'}" data-i="${i}" data-kind="${esc(c.sug.kind)}">
      <label class="pick-wrap"><input type="checkbox" class="pick" ${c.pick ? 'checked' : ''} aria-label="Use card ${n}: ${esc(kind)}"><span class="pnum mono" aria-hidden="true">${n}</span></label>
      <div class="pcells">
        <span class="sug-kind" id="sk${i}">${esc(kind)}</span>
        ${fields}
        <details class="sug-src"><summary>Where it came from</summary><p>“${src}”</p></details>
        <span class="badge" hidden></span>
      </div>
    </li>`;
}

export { MAX_SUGGESTIONS };
