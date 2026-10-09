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

export const FLAGS = [
  { id: 1, name: 'Red', color: '#E5484D' },
  { id: 2, name: 'Orange', color: '#F76B15' },
  { id: 3, name: 'Green', color: '#46A758' },
  { id: 4, name: 'Blue', color: '#3E63DD' }
];
const NEW = 0, LEARNING = 1, RELEARNING = 3;

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
  ['leech', 'Leeches']
];

export const SORTS = [
  ['added-new', 'Newest first'],
  ['added-old', 'Oldest first'],
  ['due', 'Due soonest'],
  ['lapses', 'Most forgotten'],
  ['difficulty', 'Hardest (FSRS)'],
  ['az', 'A → Z']
];

// Search, filter and sort a list of cards.
//   cards      all cards to consider
//   statesById Map of cardId → schedule
//   opts       { query, filter, sort, now }
// Search matches the front, back and tags, ignoring capitals and accents.
export function browseCards(cards, statesById, { query = '', filter = 'all', sort = 'added-new', now = Date.now() } = {}) {
  const q = dupKey(query);
  let list = cards.map(card => ({ card, state: statesById.get(card.id), status: null }));
  for (const x of list) x.status = cardStatus(x.card, x.state, now).key;
  if (q) list = list.filter(({ card }) => dupKey(`${card.front} ${card.back} ${(card.tags || []).join(' ')}`).includes(q));
  if (filter === 'flagged') list = list.filter(x => x.card.flag);
  else if (/^flag\d$/.test(filter)) list = list.filter(x => x.card.flag === +filter.slice(4));
  else if (filter === 'leech') list = list.filter(x => (x.card.tags || []).includes('leech'));
  else if (filter !== 'all') list = list.filter(x => x.status === filter);

  const due = x => (x.state && x.state.state !== NEW ? x.state.due : Infinity);
  const by = {
    'added-new': (a, b) => b.card.created - a.card.created,
    'added-old': (a, b) => a.card.created - b.card.created,
    due: (a, b) => due(a) - due(b),
    lapses: (a, b) => (b.state?.lapses || 0) - (a.state?.lapses || 0),
    difficulty: (a, b) => (b.state?.difficulty || 0) - (a.state?.difficulty || 0),
    az: (a, b) => a.card.front.localeCompare(b.card.front, undefined, { sensitivity: 'base', numeric: true })
  }[sort] || ((a, b) => b.card.created - a.card.created);
  return list.sort(by);
}

// "a, b , c" → ['a', 'b', 'c'] (no blanks, no repeats)
export function parseTags(text) {
  return [...new Set(String(text ?? '').split(/[,\n]/).map(t => t.trim().toLowerCase()).filter(Boolean))];
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
// What happens to a card that just became a leech: tagged "leech", and suspended unless the action is tag-only.
export function markLeech(card, action = LEECH_DEFAULTS.leechAction) {
  const tags = [...new Set([...(card.tags || []), 'leech'])];
  return { ...card, tags, ...(action === 'suspend' ? { suspended: true } : {}) };
}
