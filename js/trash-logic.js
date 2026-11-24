// "Recently deleted": the rules, with no database and no screen (so tests/trash.test.js can check them one by one).
// js/trash-db.js keeps the entries, js/db.js restoreDeleted puts rows back, js/trash.js joins them, js/trash-sheet.js shows them.
// The design and the reasons are in docs/design/recently-deleted-plan.md.

export const DAY = 86400000;
export const KEEP_DAYS = 30;
export const PART_ROWS = 2000;          // rows per saved piece, so a deck with 10,000 cards is never one huge write

const STORES = ['decks', 'cards', 'cardStates', 'reviewLog'];

// The pictures and sounds a list of cards uses (same fields as db.usedMediaIds).
export function mediaOf(cards) {
  const used = new Set();
  for (const c of cards) {
    if (c.frontImage) used.add(c.frontImage);
    if (c.backImage) used.add(c.backImage);
    for (const id of [...(Array.isArray(c.frontSounds) ? c.frontSounds : []), ...(Array.isArray(c.backSounds) ? c.backSounds : [])]) used.add(id);
  }
  return used;
}

// "Biology › Unit 1" for a deck, from the list of decks.
export function deckPath(decks, id) {
  const byId = new Map(decks.map(d => [d.id, d]));
  const names = [];
  for (let d = byId.get(id), n = 0; d && n < 20; d = byId.get(d.parentId), n++) names.unshift(d.name);
  return names.join(' › ');
}

// The title shown in the list. `plain` turns a card's front into plain text (format.js plainText); `pathOf(deckId)` gives "Biology › Unit 1".
export function cardsTitle(cards, { plain = s => String(s || ''), pathOf = () => '' } = {}) {
  if (cards.length === 1) return plain(cards[0].front).trim().slice(0, 80) || '1 card';
  const decks = new Set(cards.map(c => c.deckId));
  const where = decks.size === 1 ? pathOf([...decks][0]) : '';
  return `${cards.length} cards${where ? ` from ${where}` : ''}`;
}

// Everything one delete action leaves in Recently deleted.
//   snap    { decks, cards, cardStates, reviewLog }: the rows the delete really removed
//   before  { decks, cards }: rows the delete only CHANGED (a partner card that turned into an ordinary card, subdecks moved up),
//           as they were before. A late restore treats them differently (rule 4).
//   meta    { id, kind: 'cards' | 'deck', title, deckId (where to go after a restore), deckPath, now, userId, deckNames }
// Returns { entry, parts }. The list reads only `entry`; `parts` hold the rows, cut into pieces of at most PART_ROWS rows. The
// pieces follow the order the rows must come back in: decks, then cards, then schedules, then reviews. Rows that were only
// changed ("before") all go in the first piece, so they are put back before anything else.
export function buildEntry(snap, { id, kind, title, deckId = '', deckPath: path = '', now = Date.now(), userId = null, before = {}, deckNames = {} }) {
  const gone = { decks: snap.decks || [], cards: snap.cards || [], cardStates: snap.cardStates || [], reviewLog: snap.reviewLog || [] };
  const was = { decks: before.decks || [], cards: before.cards || [] };
  const blank = () => ({ gone: { decks: [], cards: [], cardStates: [], reviewLog: [] }, before: { decks: [], cards: [] } });
  const parts = [];
  let part = blank(), size = 0;
  const flush = () => { if (size) { parts.push(part); part = blank(); size = 0; } };
  for (const s of ['decks', 'cards']) for (const r of was[s]) { part.before[s].push(r); size++; }
  for (const s of STORES) {
    for (const r of gone[s]) {
      if (size >= PART_ROWS) flush();
      part.gone[s].push(r); size++;
    }
  }
  flush();
  if (!parts.length) parts.push(blank());
  const entry = {
    id, kind, title, deckId, deckPath: path, deletedAt: now, settledAt: now, userId,
    counts: { cards: gone.cards.length, reviews: gone.reviewLog.length },
    deckIds: gone.decks.map(d => d.id),            // the decks this entry holds, so another entry can find "its deck was deleted too"
    deckNames,                                      // { deckId: name } for the decks the cards were in
    mediaIds: [...mediaOf(gone.cards)],
    parts: parts.length
  };
  return { entry, parts };
}

// Rules 1-4 for one row. Says what to do with it:
//   'put'          put it back
//   'live'         rule 1: it exists here now (came back another way): leave it
//   'newer'        rule 2 / 4: changed or deleted again on another device since: leave it
//   'no-card'      rule 3: a schedule or review whose card is not here: leave it
//   'no-deck'      the card's deck is not here (and was not chosen)
// Arguments:
//   kind    'gone' (a row the delete removed) or 'before' (a row the delete only changed)
//   live    the row as it is stored now, or undefined
//   tomb    its delete marker { deletedAt }, or undefined
//   entry   the entry (settledAt: when the delete finished)
//   needsCard  for schedules and reviews: is their card here now, or being restored in this run? (omit for others)
//   needsDeck  for cards: is their deck here now, or being restored in this run? (omit for others)
export function restoreRow({ kind = 'gone', live, tomb, entry, needsCard, needsDeck }) {
  if (kind === 'before') {
    // Rule 4: only if the row is exactly as the delete left it. Otherwise the newer row stays.
    if (!live) return 'no-card';
    return (live.updatedAt || 0) <= entry.settledAt ? 'put' : 'newer';
  }
  if (live) return 'live';                                                  // rule 1
  if (tomb && (tomb.deletedAt || 0) > entry.settledAt) return 'newer';      // rule 2 (no marker, or this device's own delete: restore)
  if (needsCard === false) return 'no-card';                                // rule 3
  if (needsDeck === false) return 'no-deck';
  return 'put';
}

// Rule 5: the time to save a restored row with. Never plain "now": if the clock went back after the delete, a row older than its
// delete marker would be ignored by the server and the delete would win again. `tomb` is the row's delete marker, if any.
export const restoreStamp = (now, tomb) => Math.max(now, (tomb && tomb.deletedAt || 0) + 1);

// Which entries are over 30 days old (or dated more than a day in the future: clock trouble). Returns their ids.
export function expired(entries, now = Date.now()) {
  return entries.filter(e => !Number.isFinite(e.deletedAt) || now - e.deletedAt >= KEEP_DAYS * DAY || e.deletedAt > now + DAY).map(e => e.id);
}
export const daysLeft = (entry, now = Date.now()) => Math.max(0, Math.ceil((entry.deletedAt + KEEP_DAYS * DAY - now) / DAY));

// 5b and 5c: where is a deck an entry needs?
//   'live'   it exists now
//   'trash'  it is in another Recently deleted entry (entryId says which)
//   'gone'   nowhere
export function deckFate(deckId, liveDeckIds, trashDecks) {
  if (liveDeckIds.has(deckId)) return { state: 'live' };
  if (trashDecks.has(deckId)) return { state: 'trash', entryId: trashDecks.get(deckId) };
  return { state: 'gone' };
}

// 5c: a restored subdeck's parent. Kept when the parent is here, comes back in this entry or sits in Recently deleted (restoring
// that later puts the tree back together). Cleared when the parent is gone for good.
export function fixParent(deck, { liveDeckIds, entryDeckIds, trashDecks }) {
  if (!deck.parentId) return deck;
  if (liveDeckIds.has(deck.parentId) || entryDeckIds.has(deck.parentId) || trashDecks.has(deck.parentId)) return deck;
  return { ...deck, parentId: '' };
}

// All the "paired" cards (a card and its reverse card share a noteId) that will exist: `partners` maps noteId -> set of card ids.
// A restored paired card with no other card on its note comes back as an ordinary card (the caller removes the pair fields).
export const hasPartner = (card, partners) => {
  const ids = partners.get(card.noteId);
  if (!ids) return false;
  for (const id of ids) if (id !== card.id) return true;
  return false;
};
