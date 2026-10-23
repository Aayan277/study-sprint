// Re-importing an Anki deck: finding the cards you already have, so the import can update them instead of making a second set.
// Pure functions (no page, no database), tested by tests/anki-match.test.js.
//
// A card's identity is its Anki note guid (saved on the card as ankiGuid) plus its place in the note, because one note can make
// several cards that all carry the same guid:
//   f  the ordinary front → back card         r  the reverse card of a "both directions" note
//   c3 the card for cloze blank 3             o2 the card for image-occlusion box group 2
// The same note re-imported from a changed deck keeps its guid and its places, so the match survives edits to the text.

// The place of a saved card (or of a card about to be saved: it has the same fields once its cloze / occlusion / reverse are set).
// A note that makes several ordinary cards (one per Anki card template) has them told apart by templateOrd (0, 1, 2…): t0, t1…
// A card with no templateOrd (saved before that existed) is its own place, f (or r), never the same as t0.
const ordinary = (card, reverse) => `${reverse ? 'r' : 'f'}${Number.isInteger(card.templateOrd) ? `t${card.templateOrd}` : ''}`;
export function slotOf(card) {
  if (card.cloze !== undefined && card.cloze !== null) return `c${card.cloze.n ?? card.cloze}`;
  if (card.occlusion) return `o${card.occlusion.n}`;
  return ordinary(card, card.reverse);
}
// The place of a row in the import preview (its cloze / occlusion are still { noteKey, n, … } objects there). `reverse`: its reverse card.
export const rowSlot = (c, reverse = false) => (c.cloze ? `c${c.cloze.n}` : c.occlusion ? `o${c.occlusion.n}` : ordinary(c, reverse));

const keyOf = (guid, slot) => `${guid}\u0001${slot}`;

// Every saved card that has a guid, by identity. When one identity is on several cards (a deck imported twice by an older version of
// the app), the oldest card wins, so the update goes to the card most likely to hold your progress.
export function indexByGuid(cards) {
  const index = new Map();
  for (const c of cards) {
    if (!c.ankiGuid) continue;
    const k = keyOf(c.ankiGuid, slotOf(c)), had = index.get(k);
    if (!had || (c.created || 0) < (had.created || 0) || ((c.created || 0) === (had.created || 0) && c.id < had.id)) index.set(k, c);
  }
  return index;
}

// For each item { guid, slot }, the saved card it matches, or null. A saved card is matched at most once (the first item to ask for it).
export function matchRows(items, index) {
  const claimed = new Set();
  return items.map(it => {
    if (!it || !it.guid || !index) return null;
    const card = index.get(keyOf(it.guid, it.slot));
    if (!card || claimed.has(card.id)) return null;
    claimed.add(card.id);
    return card;
  });
}

// What an update replaces. Everything else (id, deck, created, flag, suspended, buried, acceptAnswers)
// stays, and so do the schedule and review history, which are kept in other stores keyed by the card's id.
export const CONTENT = ['front', 'back', 'frontImage', 'backImage', 'frontSounds', 'backSounds', 'noteFields', 'noteExtra', 'typeIn', 'cloze', 'noteText', 'occlusion'];
const MEDIA = ['frontImage', 'backImage', 'frontSounds', 'backSounds'];
export { MEDIA };

// The saved card with the new card's content on it. Tags are added to, never taken away (they are yours to change).
// noteId: the note the cards share (cloze blanks, a reverse pair); the caller decides it (see noteIdMap).
export function mergeCard(old, fresh, noteId, now) {
  const out = { ...old };
  for (const k of CONTENT) delete out[k];
  for (const k of CONTENT) if (fresh[k] !== undefined) out[k] = fresh[k];
  out.ankiGuid = fresh.ankiGuid || old.ankiGuid;
  const tags = [...(old.tags || [])];
  for (const t of fresh.tags || []) if (!tags.includes(t)) tags.push(t);
  out.tags = tags;
  if (noteId) { out.noteId = noteId; out.noteEditedAt = now; }
  return out;
}

// Which note id each new note id turns into, so siblings that are not matched (a blank added in the new version, a reverse card made
// now) join the note the matched cards already belong to. A matched card with no note of its own takes the new one.
//   pairs  [[savedCard, newCard], …]
export function noteIdMap(pairs) {
  const map = new Map();
  for (const [old, fresh] of pairs) {
    if (fresh.noteId && !map.has(fresh.noteId)) map.set(fresh.noteId, old.noteId || fresh.noteId);
  }
  return map;
}

// Is the merged card the same as the saved one, as far as what an update touches goes? (An unchanged card is not written again, so
// re-importing the same file changes nothing and syncs nothing.)
export function sameContent(a, b) {
  const sig = c => JSON.stringify([...CONTENT.map(k => c[k] ?? null), [...(c.tags || [])].sort(), c.noteId ?? null]);
  return sig(a) === sig(b);
}

// How many of the preview's cards are already in the collection (a "both directions" row can match two: forward and reverse).
//   cards  the import's cards that will be saved, each with ankiGuid, cloze/occlusion and `reverse: true` when it also makes a reverse card
export function countMatches(cards, index) {
  const items = [];
  for (const c of cards) {
    items.push({ guid: c.ankiGuid, slot: rowSlot(c) });
    if (c.reverse) items.push({ guid: c.ankiGuid, slot: rowSlot(c, true) });
  }
  return matchRows(items, index).filter(Boolean).length;
}
