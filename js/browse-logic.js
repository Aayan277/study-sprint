// The card list (browser): each card's status, plus search, filters and sorting.
// Pure functions (no page, no database), tested by tests/browse.test.js.
//
// Extra fields a card can have (all optional, so older cards just don't have them):
//   suspended    true = left out of Review and Play until you unsuspend it
//   buriedUntil  a time; until then the card is left out of Review and Play ("bury until tomorrow")
//   flag         0 = none, 1 red, 2 orange, 3 green, 4 blue

import { dayEnd } from './days.js';
import { formatInterval } from './queue.js';
import { dupKey } from './import.js';
import { normTag, tagWords, SEP } from './tag-tree.js';
import { isPair, loneIds, unpaired } from './reverse.js';

export const FLAGS = [
  { id: 1, name: 'Red', color: '#E5484D' },
  { id: 2, name: 'Orange', color: '#F76B15' },
  { id: 3, name: 'Green', color: '#46A758' },
  { id: 4, name: 'Blue', color: '#3E63DD' }
];
const NEW = 0, LEARNING = 1, RELEARNING = 3;

// Comparing text with localeCompare() builds a new collator on every call, which is very slow in a sort of
// thousands of cards. These two are made once: plain A-Z order, and A-Z ignoring case/accents with numbers in order.
const COLLATE = new Intl.Collator();
const NATURAL = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export const isSuspended = card => !!card.suspended;
export const isBuried = (card, now = Date.now()) => !!card.buriedUntil && card.buriedUntil > now;
// Cards Review and Play should skip right now.
export const isHidden = (card, now = Date.now()) => isSuspended(card) || isBuried(card, now);

// "Bury until tomorrow" means until the next study day starts (4am).
export const buryUntil = (now = Date.now()) => dayEnd(now);

// A card's status for the list, as { key, label }. Suspended and buried win over the schedule.
export function cardStatus(card, state, now = Date.now()) {
  if (isSuspended(card)) return { key: 'suspended', label: 'Suspended' };
  if (isBuried(card, now)) return { key: 'buried', label: 'Buried' };
  if (!state || state.state === NEW) return { key: 'new', label: 'New' };
  if (state.state === LEARNING || state.state === RELEARNING) return { key: 'learning', label: state.due <= now ? 'Learning · due' : 'Learning' };
  if (state.due <= dayEnd(now)) return { key: 'due', label: 'Due' };
  return { key: 'review', label: `Due in ${formatInterval(state.due - now)}` };
}

export const FILTERS = [
  ['all', 'All cards'],
  ['new', 'New'],
  ['learning', 'Learning'],
  ['due', 'Due today'],
  ['review', 'Not due yet'],
  ['suspended', 'Suspended'],
  ['buried', 'Buried'],
  ['flagged', 'Any flag'],
  ...FLAGS.map(f => [`flag${f.id}`, `${f.name} flag`]),
  ['leech', 'Leeches'],
  ['dupes', 'Duplicates (same front)']
];

// The same filters, grouped for the dropdown (<optgroup>s). 'All cards' stands on its own at the top.
export const FILTER_GROUPS = [
  [null, ['all']],
  ['Status', ['new', 'learning', 'due', 'review', 'suspended', 'buried']],
  ['Flags', ['flagged', ...FLAGS.map(f => `flag${f.id}`)]],
  ['Problems', ['leech', 'dupes']]
];

export const SORTS = [
  ['added-new', 'Newest first'],
  ['added-old', 'Oldest first'],
  ['due', 'Due soonest'],
  ['lapses', 'Most forgotten'],
  ['difficulty', 'Hardest (FSRS)'],
  ['az', 'A → Z']
];

// What search compares: lower case, Latin accents off (other marks stay, so か ≠ が), and punctuation as a space, but
// symbols that mean something (+ # & % @ * and anything in \p{S}, emoji included) kept, so "c++" doesn't match "c".
// A query with nothing else in it ("?!", "+", "🧠") is looked for as it is typed (lower case, spaces collapsed).
const searchFold = s => String(s ?? '').toLowerCase().replace(/ς/g, 'σ').normalize('NFKD')
  .replace(/[\u0300-\u036f\ufe00-\ufe0f]/g, '').replace(/[^\p{L}\p{N}\p{M}\p{S}#%&@*]+/gu, ' ').replace(/\s+/g, ' ').trim().normalize('NFC');
const rawFold = s => String(s ?? '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
export function searchMatcher(query) {
  const q = searchFold(query);
  if (/[\p{L}\p{N}\p{S}#%&@*]/u.test(q)) return text => searchFold(text).includes(q);
  const raw = rawFold(query);
  return raw ? text => rawFold(text).includes(raw) : null;
}

// The text search looks in for one card (front, back and tags), folded once and remembered per card object, so typing
// another letter only does a substring check per card instead of re-folding every card's text. A card that was edited
// in place (new front, back or tags) is folded again. Cards are normally replaced by copies when they change.
const foldCache = { fold: new WeakMap(), raw: new WeakMap() };
function foldedCard(card, kind, fold) {
  const tags = (card.tags || []).join(' ');
  let e = foldCache[kind].get(card);
  if (!e || e.front !== card.front || e.back !== card.back || e.tags !== tags) {
    e = { front: card.front, back: card.back, tags, text: fold(`${card.front} ${card.back} ${tags}`) };
    foldCache[kind].set(card, e);
  }
  return e.text;
}
// Like searchMatcher, but takes a card and uses the remembered folded text. Same answers as
// searchMatcher(query)(`${front} ${back} ${tags.join(' ')}`).
export function cardMatcher(query) {
  const q = searchFold(query);
  if (/[\p{L}\p{N}\p{S}#%&@*]/u.test(q)) return card => foldedCard(card, 'fold', searchFold).includes(q);
  const raw = rawFold(query);
  return raw ? card => foldedCard(card, 'raw', rawFold).includes(raw) : null;
}

const CARD_ONLY_SORTS = {
  'added-new': (a, b) => b.created - a.created,
  'added-old': (a, b) => a.created - b.created,
  az: (a, b) => NATURAL.compare(a.front, b.front)
};
const sortCache = new WeakMap();    // cards array → { sort, length, list }
function sortedCards(cards, sort) {
  const c = sortCache.get(cards);
  if (c && c.sort === sort && c.length === cards.length) return c.list;
  const list = [...cards].sort(CARD_ONLY_SORTS[sort]);
  sortCache.set(cards, { sort, length: cards.length, list });
  return list;
}

// Search, filter and sort a list of cards.
//   cards      all cards to consider
//   statesById Map of cardId → schedule
//   opts       { query, filter, sort, now }
// Search matches the front, back and tags, ignoring capitals and accents.
// `tag:<path>` (for example tag:#uworld::step) keeps the cards with that tag or any tag below it; it combines with other words.
// The cards array and the cards in it are treated as unchanging while a list is on screen (callers pass a fresh array after a change):
// the sorted order is remembered per array.
export function browseCards(cards, statesById, { query = '', filter = 'all', sort = 'added-new', now = Date.now() } = {}) {
  const { text, tags: tagTerms } = parseTagSearch(query);
  const match = cardMatcher(text);
  // Narrow by tag and search first (cheap, and usually leaves fewer cards), then work out each remaining card's status.
  // Sorts that look only at the card itself (not its schedule) are remembered for the whole list, so typing in the search box
  // filters an already-sorted list instead of sorting again. (A stable sort of the whole list, then filtered, gives the same order
  // as filtering and then sorting.)
  const presorted = filter !== 'dupes' && CARD_ONLY_SORTS[sort] ? sortedCards(cards, sort) : null;
  let found = presorted || cards;
  for (const path of tagTerms) found = found.filter(card => hasTagUnder(card, path));
  if (match) found = found.filter(match);
  let list = found.map(card => ({ card, state: statesById.get(card.id), status: null }));
  if (filter !== 'all' && filter !== 'dupes') for (const x of list) x.status = cardStatus(x.card, x.state, now).key;
  if (filter === 'flagged') list = list.filter(x => x.card.flag);
  else if (/^flag\d$/.test(filter)) list = list.filter(x => x.card.flag === +filter.slice(4));
  else if (filter === 'leech') list = list.filter(x => (x.card.tags || []).includes('leech'));
  else if (filter === 'dupes') {
    // Cards whose front matches another card's (ignoring capitals, accents, punctuation and formatting),
    // listed next to each other.
    // (Image-occlusion cards are left out: their fronts differ only by number. So are reverse cards, whose front is another card's back.)
    const key = x => (x.card.occlusion || x.card.reverse ? '' : dupKey(x.card.front));
    const counts = new Map();
    for (const x of list) counts.set(key(x), (counts.get(key(x)) || 0) + 1);
    return list.filter(x => key(x) && counts.get(key(x)) > 1).sort((a, b) => COLLATE.compare(key(a), key(b)) || a.card.created - b.card.created);
  }
  else if (filter !== 'all') list = list.filter(x => x.status === filter);

  if (presorted) return list;
  const due = x => (x.state && x.state.state !== NEW ? x.state.due : Infinity);
  const by = {
    'added-new': (a, b) => b.card.created - a.card.created,
    'added-old': (a, b) => a.card.created - b.card.created,
    due: (a, b) => due(a) - due(b),
    lapses: (a, b) => (b.state?.lapses || 0) - (a.state?.lapses || 0),
    difficulty: (a, b) => (b.state?.difficulty || 0) - (a.state?.difficulty || 0),
    az: (a, b) => NATURAL.compare(a.card.front, b.card.front)
  }[sort] || ((a, b) => b.card.created - a.card.created);
  return list.sort(by);
}

// "tag:#uworld::step lung" → { text: 'lung', tags: ['#uworld::step'] }. A path with spaces goes in quotes: tag:"my tag".
export function parseTagSearch(query) {
  const tags = [];
  const text = String(query ?? '').replace(/(^|\s)tag:(?:"([^"]*)"|(\S*))/gi, (all, lead, quoted, bare) => {
    const path = normTag(quoted ?? bare ?? '');
    if (path) tags.push(path);
    return lead;
  });
  return { text, tags };
}
// Does the card have the tag `path`, or a tag below it? (Ignores capitals; `path` as normTag gives it.)
const hasTagUnder = (card, path) => tagWords(card.tags).some(t => { const n = normTag(t); return n === path || n.startsWith(path + SEP); });

// "a b, c" → ['a', 'b', 'c'] (lower case, no blanks, no repeats). Tags are separated by spaces, commas or line breaks (like Anki, whose tags
// can't contain spaces): the same rule tagWords (tag-tree.js) uses to read what is saved. A piece with nothing in it but colons ("a :: b") is dropped.
export function parseTags(text) {
  return [...new Set(String(text ?? '').toLowerCase().split(/[\s,]+/).filter(t => normTag(t)))];
}

// ---------- leeches ----------
// A leech is a card you keep forgetting. Like Anki: it's flagged when its forgotten count ("lapses")
// reaches the threshold (8 by default), and again every half-threshold after that (12, 16, ...),
// so a suspended leech you bring back gets another chance before it's caught again.
export const LEECH_DEFAULTS = { leechThreshold: 8, leechAction: 'suspend' };   // action: 'suspend' or 'tag'
export function isNewLeech(prevLapses, nextLapses, threshold = LEECH_DEFAULTS.leechThreshold) {
  if (!(threshold > 0) || nextLapses <= prevLapses || nextLapses < threshold) return false;
  return (nextLapses - threshold) % Math.max(1, Math.ceil(threshold / 2)) === 0;
}
// Play can bring a card back with Again when you miss it before it is due. FSRS counts that as a lapse (so the
// card's schedule and "forgotten N times" stay right), but it doesn't count toward the leech limit: only Review
// answers, answers on due cards in Play and imported history do. This counts the misses to leave out, from the card's log.
export function notDueMisses(logs) {
  return logs.filter(l => l.source === 'play' && l.applied && l.reason === 'again' && l.state === 2 && l.rating === 1).length;
}
// isNewLeech for a card that was just answered, leaving out the Play misses on cards that weren't due.
//   logs  the card's review log (db.getCardLogs); the answer just given must not be a not-due Play miss
export function isNewLeechCounted(prevLapses, nextLapses, logs, threshold) {
  const skip = notDueMisses(logs);
  return isNewLeech(Math.max(0, prevLapses - skip), Math.max(0, nextLapses - skip), threshold);
}
// What happens to a card that just became a leech: tagged "leech", and suspended unless the action is tag-only.
export function markLeech(card, action = LEECH_DEFAULTS.leechAction) {
  const tags = [...new Set([...(card.tags || []), 'leech'])];
  return { ...card, tags, ...(action === 'suspend' ? { suspended: true } : {}) };
}

// ---------- card list tools ----------
// Find and replace in cards' text. field: 'front', 'back' or 'both'. Returns only the cards that changed.
export function replaceInCards(cards, { find, replace = '', field = 'both', matchCase = false }) {
  if (!find) return [];
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');
  const fields = field === 'both' ? ['front', 'back'] : [field];
  const out = [];
  for (const c of cards) {
    if (c.occlusion) continue;           // an image-occlusion card's front and back are made from its boxes
    const changes = {};
    for (const f of fields) {
      const now = String(c[f] ?? '').replace(re, () => replace);
      if (now !== c[f]) changes[f] = now;
    }
    if (Object.keys(changes).length) out.push({ ...c, ...changes });
  }
  return out;
}

// Every tag used by these cards, with how many cards have it, most used first. (A card with one tag twice counts once.)
export function tagCounts(cards) {
  const counts = new Map();
  for (const c of cards) for (const t of new Set(tagWords(c.tags))) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || COLLATE.compare(a.tag, b.tag));
}
// The tags a rename gives: what was typed, split like the tags of a card (spaces, commas, line breaks). "a b" makes two tags.
const renamedTo = text => parseTags(text);
// Rename a tag on every card that has it (to = '' removes it). Returns only the cards that changed.
export function renameTag(cards, from, to) {
  const clean = renamedTo(to);
  return cards.filter(c => tagWords(c.tags).includes(from))
    .map(c => ({ ...c, tags: [...new Set(tagWords(c.tags).flatMap(t => (t === from ? clean : [t])))] }));
}

// Rename (or, with to = '', remove) exactly one tag, matching it the way folders do: ignoring capitals and empty pieces
// ("a::::b" is "a::b"). Tags below it are left alone. Returns only the cards that changed.
export function renameTagExact(cards, from, to) {
  const f = normTag(from), clean = renamedTo(to);
  if (!f) return [];
  return cards.filter(c => tagWords(c.tags).some(t => normTag(t) === f))
    .map(c => ({ ...c, tags: [...new Set(tagWords(c.tags).flatMap(t => (normTag(t) === f ? clean : [t])))] }));
}

// Rename a folder of "::" tags: the tag `from` and every tag below it move to `to` (to = '' removes them; "x y" moves them to both). A tag that
// already exists at the new place is merged with. Returns only the cards that changed.
export function renameTagPrefix(cards, from, to) {
  const f = normTag(from);
  const targets = renamedTo(to).map(normTag).filter(Boolean);
  if (!f) return [];
  const out = [];
  for (const c of cards) {
    let hit = false;
    const moved = tagWords(c.tags).flatMap(t => {
      const n = normTag(t);
      if (n === f) { hit = true; return targets; }
      if (n.startsWith(f + SEP)) { hit = true; return targets.map(x => x + n.slice(f.length)); }
      return [t];
    });
    if (hit) out.push({ ...c, tags: [...new Set(moved)] });
  }
  return out;
}

// ---------- duplicating ----------
// Copies of cards as new cards: the same deck, text, tags, pictures, memory hook and accepted answers, but a new id, a
// fresh schedule (copies have no schedule row, so they are new) and none of the card's own state (flag, suspended, buried).
// A card that belongs to a note (a cloze or image-occlusion card) is copied with the whole note: every card of it, under one
// new noteId. Cards of the same note in `cards` are copied once.
//   cards    the cards to copy        all   every card (to find the rest of a note)
//   newId    makes an id              now   when the copies are created (each one a millisecond later, to keep their order)
// Returns { copies, firstCopy, of }: the new cards, the copy of cards[0], and a Map from an original's id to its copy's id.
// A reverse pair (two cards of one noteId, the second with reverse: true, see reverse.js) is copied as a clean new pair; a card
// that has a pair's noteId but no partner (loneIds) is copied as an ordinary card.
export function duplicateCards(cards, all, newId, now = Date.now()) {
  const copies = [], of = new Map(), noteIds = new Map();
  const seen = new Set(), lone = loneIds(all);
  let i = 0;
  for (const card of cards) {
    const group = card.noteId && !lone.has(card.id) ? all.filter(c => c.noteId === card.noteId).sort((a, b) => (a.created || 0) - (b.created || 0) || (a.id < b.id ? -1 : 1)) : [card];
    if (!group.some(c => c.id === card.id)) group.push(card);
    for (const c of group) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.noteId && !lone.has(c.id) && !noteIds.has(c.noteId)) noteIds.set(c.noteId, newId());
      let copy = { ...c, id: newId(), created: now + i++ };
      // Own state and sync/export identity are not copied (a copied ankiGuid would make two notes with one guid in an export).
      for (const k of ['flag', 'suspended', 'buriedUntil', 'updatedAt', 'syncedAt', 'uid', 'ankiGuid', 'ankiId']) delete copy[k];
      if (isPair(c) && lone.has(c.id)) copy = unpaired(copy);          // its partner is missing: an ordinary card
      else if (c.noteId) copy.noteId = noteIds.get(c.noteId);
      if (Array.isArray(c.noteFields)) copy.noteFields = c.noteFields.map(x => (x && typeof x === 'object' ? { ...x } : x));
      if (c.tags) copy.tags = c.tags.filter(t => t !== 'leech');
      if (c.acceptAnswers) copy.acceptAnswers = [...c.acceptAnswers];
      for (const k of ['frontSounds', 'backSounds']) if (Array.isArray(c[k])) copy[k] = [...c[k]];      // sounds (media ids) are shared, the lists are not
      if (c.occlusion) copy.occlusion = { ...c.occlusion, masks: c.occlusion.masks.map(m => ({ ...m })) };
      of.set(c.id, copy.id);
      copies.push(copy);
    }
  }
  const first = cards.length ? of.get(cards[0].id) : null;
  return { copies, firstCopy: copies.find(c => c.id === first) || null, of };
}

// Range select: the ids from anchorId to targetId (both included) in the order of visibleIds, whichever comes first.
// Only ids in visibleIds count. No anchor (or one that is not shown): just the target. A target that is not shown: nothing.
export function rangeIds(visibleIds, anchorId, targetId) {
  const t = visibleIds.indexOf(targetId);
  if (t < 0) return [];
  const a = anchorId == null ? -1 : visibleIds.indexOf(anchorId);
  if (a < 0) return [targetId];
  return visibleIds.slice(Math.min(a, t), Math.max(a, t) + 1);
}
