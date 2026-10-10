// Subdecks: a deck can sit inside another (deck.parentId; empty = top level), e.g. "Psych 101 › Unit 1".
// A parent includes everything inside it: its card list, Review, Play, Stats and Export cover its subdecks,
// its limits cap the whole group, and subdecks use its study options, exam date and read-aloud language
// unless they set their own. Pure functions, tested by tests/deck-tree.test.js.

const byId = decks => new Map(decks.map(d => [d.id, d]));

// The deck and the decks it sits inside, nearest first: [deck, parent, grandparent, …].
// (A missing or looping parent is treated as top level, so a broken link can't hang the app.)
export function ancestors(decks, id, map = byId(decks)) {
  const out = [], seen = new Set();
  for (let d = map.get(id); d && !seen.has(d.id); d = map.get(d.parentId)) { seen.add(d.id); out.push(d); }
  return out;
}
// Deck id → the ids of it and its ancestors (for limits that apply up the tree).
export function chainMap(decks) {
  const map = byId(decks);
  return new Map(decks.map(d => [d.id, ancestors(decks, d.id, map).map(a => a.id)]));
}

// The ids of a deck and everything inside it.
export function subtreeIds(decks, id) {
  const chains = chainMap(decks);
  return new Set(decks.filter(d => chains.get(d.id).includes(id)).map(d => d.id));
}

// "Psych 101 › Unit 1"
export const deckPath = (decks, id, sep = ' › ') => ancestors(decks, id).reverse().map(d => d.name).join(sep);

// All decks in tree order (each parent followed by what's inside it), with their depth (0 = top level).
// Siblings stay in the order given (e.g. by creation time).
export function treeOrder(decks) {
  const ids = new Set(decks.map(d => d.id));
  const kids = new Map();
  for (const d of decks) {
    const parent = d.parentId && ids.has(d.parentId) && !ancestors(decks, d.parentId).some(a => a.id === d.id) ? d.parentId : '';
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(d);
  }
  const out = [];
  const walk = (parent, depth) => (kids.get(parent) || []).forEach(d => { out.push({ deck: d, depth }); walk(d.id, depth + 1); });
  walk('', 0);
  return out;
}

// Can deck `id` be put inside `parentId`? Not inside itself or anything inside it.
export const canNest = (decks, id, parentId) => !parentId || !subtreeIds(decks, id).has(parentId);

// A deck with the settings it inherits filled in: its own if set, otherwise the nearest ancestor's.
//   options (study options), examDate, ttsLang, ttsAuto
export function effectiveDeck(decks, id) {
  const chain = ancestors(decks, id);
  if (!chain.length) return null;
  const first = (key, has) => chain.find(d => has(d[key]))?.[key];
  return {
    ...chain[0],
    options: first('options', v => !!v) ?? null,
    examDate: first('examDate', v => !!v) ?? null,
    ttsLang: first('ttsLang', v => !!v) ?? '',
    ttsAuto: first('ttsAuto', v => typeof v === 'boolean') ?? false
  };
}

// An Anki-style name for a deck: "Psych 101::Unit 1".
export const ankiPath = (decks, id) => deckPath(decks, id, '::');

// Decks to pick from in a list (Move to deck, Import into, …): tree order, each named by its full path.
//   only  optional Set of deck ids to keep
export const deckChoices = (decks, only) =>
  treeOrder(decks).filter(x => !only || only.has(x.deck.id)).map(x => ({ id: x.deck.id, label: deckPath(decks, x.deck.id), depth: x.depth }));
