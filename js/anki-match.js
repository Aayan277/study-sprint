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
export const rowSlot = (c, reverse = false) => (c.cloze ? `c${c.cloze.n}` : c.occlusion ? `o${c.occlusion.n}` : ordinary(c.siblings ? { templateOrd: c.siblings.ord } : c, reverse));

import { isPair } from './reverse.js';

const keyOf = (guid, slot) => `${guid}\u0001${slot}`;

// Every saved card that has a guid, by identity. When one note is saved more than once (a deck imported twice by an older version of
// the app), one copy is chosen for the whole note, so its cards are never joined across decks: the copy in one of the `prefer` decks (the
// deck being imported into, and its subdecks) if there is one, else the copy that holds the oldest card (the one most likely to hold your
// progress). Within the copy, the oldest card of each place wins.
export function indexByGuid(cards, prefer = null) {
  const copies = new Map();         // guid → Map deckId → [cards]
  for (const c of cards) {
    if (!c.ankiGuid) continue;
    const byDeck = copies.get(c.ankiGuid) || copies.set(c.ankiGuid, new Map()).get(c.ankiGuid);
    (byDeck.get(c.deckId) || byDeck.set(c.deckId, []).get(c.deckId)).push(c);
  }
  const older = (a, b) => (a.created || 0) - (b.created || 0) || (a.id < b.id ? -1 : 1);
  const index = new Map();
  for (const [guid, byDeck] of copies) {
    const decks = [...byDeck.entries()].map(([id, list]) => ({ id, list: list.sort(older) }));
    const oldest = d => d.list[0];
    decks.sort((x, y) => (prefer && prefer.has(y.id)) - (prefer && prefer.has(x.id)) || older(oldest(x), oldest(y)));
    for (const c of decks[0].list) {
      const k = keyOf(guid, slotOf(c));
      if (!index.has(k)) index.set(k, c);
    }
  }
  return index;
}

// Before 4.54 a note with several card templates came in as its first card only, saved with no templateOrd. That card is the note's
// template 0, so when the incoming ft0 has no exact match it takes the saved plain card (f) of the same note: the update gives it
// templateOrd 0 and the note's shared noteId, so it becomes a sibling of the cards added beside it instead of being duplicated.
// (There is no such case for a reverse card: a reversed note is never a several-template note, so rt0 has no fallback.)
const FALLBACK = { ft0: 'f' };

// For each item { guid, slot }, the saved card it matches, or null. A saved card is matched at most once (the first item to ask for it).
export function matchRows(items, index) {
  const claimed = new Set();
  return items.map(it => {
    if (!it || !it.guid || !index) return null;
    let card = index.get(keyOf(it.guid, it.slot));
    if ((!card || claimed.has(card.id)) && FALLBACK[it.slot]) {
      card = index.get(keyOf(it.guid, FALLBACK[it.slot]));
      if (card && isPair(card)) card = undefined;          // the plain card of a reversed pair is not a template-0 card: leave its pair alone
    }
    if (!card || claimed.has(card.id)) return null;
    claimed.add(card.id);
    return card;
  });
}

// What an update replaces. Everything else (id, deck, created, flag, suspended, buried, acceptAnswers)
// stays, and so do the schedule and review history, which are kept in other stores keyed by the card's id.
export const CONTENT = ['front', 'back', 'frontImage', 'backImage', 'frontSounds', 'backSounds', 'noteFields', 'noteExtra', 'typeIn', 'cloze', 'noteText', 'occlusion', 'templateOrd'];
// What counts as the card's text when asking "was it edited here?": the same, without how the cards are linked.
const SIG_FIELDS = CONTENT.filter(k => k !== 'templateOrd');
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

// ---------- was the card edited here? ----------
// Every card an import saves or updates gets `ankiSig`, a short fingerprint of its content at that moment. A later re-import compares the
// card's content with it: equal means nobody has edited the card since, so the file's version can safely replace it; different means you
// edited it here (or an older version of the app saved it, with no fingerprint to compare), so it is only overwritten if you say so.
function hashOf(text) {          // a small fast hash (cyrb53), as hex: this is a change check, not security
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0'));
}
export const contentSig = card => hashOf(JSON.stringify(SIG_FIELDS.map(k => card[k] ?? null)));
const untouched = card => card.ankiSig !== undefined && card.ankiSig === contentSig(card);

// What an update does to the card as it is saved RIGHT NOW (`cur`: read inside the save, so an edit or sync that landed a moment ago
// is never overwritten with an older copy). plan: { fresh (the new card), noteId (the note it should be in) }.
// Returns { kind, row }:
//   same     the content is already what the file has: nothing to replace (row: only new tags, the note link or the fingerprint, if any)
//   updated  the content is replaced (row is the whole card)
//   held     the content differs and was edited here (or has no fingerprint): left as it is, unless overwriteEdited
// row is null when nothing needs writing. A card saved by an older version of the app as a note's first card (no templateOrd) becomes
// template 0 of its note in every case: that only changes how the cards are linked, not their content.
export function applyUpdate(cur, plan, { now = Date.now(), overwriteEdited = false } = {}) {
  const { fresh } = plan, noteId = plan.noteId || cur.noteId;
  const merged = mergeCard(cur, fresh, noteId, now);
  const relink = fresh.templateOrd === 0 && cur.templateOrd === undefined && !isPair(cur);
  const keepText = adopt => {
    const next = { ...cur };
    const tags = [...(cur.tags || [])];
    for (const t of fresh.tags || []) if (!tags.includes(t)) tags.push(t);
    if (tags.length !== (cur.tags || []).length) next.tags = tags;
    if (relink) { next.templateOrd = 0; if (noteId) next.noteId = noteId; }
    if (adopt && cur.ankiSig === undefined) next.ankiSig = contentSig(cur);          // now known to match the file: later edits can be told apart
    return JSON.stringify(next) === JSON.stringify(cur) ? null : next;
  };
  if (contentSig(cur) === contentSig(merged)) return { kind: 'same', row: keepText(true) };
  if (untouched(cur) || overwriteEdited) return { kind: 'updated', row: { ...merged, ankiSig: contentSig(merged) } };
  return { kind: 'held', row: keepText(false) };
}

// The preview cannot know the picture and sound ids a save will make, so it compares what it can see: the text, the note's fields,
// and whether each side has a picture or sounds. Same answers as applyUpdate for everything but a picture that changed to another picture.
//   c  a preview row (front, back, noteFields, noteExtra, typeIn, cloze, pictures, sounds, reversed); reverse: asks about its reverse card
export function approxOf(c, reverse = false) {
  const [f, b] = reverse ? ['back', 'front'] : ['front', 'back'];
  const pics = c.pictures || {}, snd = c.sounds || {};
  return {
    front: String(c[f] ?? '').trim(), back: String(c[b] ?? '').trim(),
    frontPic: !!pics[f], backPic: !!pics[b], frontSounds: (snd[f] || []).length, backSounds: (snd[b] || []).length,
    noteFields: c.occlusion ? null : c.noteFields || [], noteExtra: c.noteExtra || '', noteText: c.cloze ? c.cloze.text : undefined,
    typeIn: reverse ? !!c.reversed?.typeIn : !!c.typeIn
  };
}
// Would the saved card `old` change if the preview row were imported over it? 'same', 'safe' (changes, and nobody edited it here) or 'edited'.
export function classifyRow(old, c, reverse = false) {
  const a = approxOf(c, reverse);
  const differs = old.front !== a.front || old.back !== a.back
    || !!old.frontImage !== a.frontPic || !!old.backImage !== a.backPic
    || (old.frontSounds || []).length !== a.frontSounds || (old.backSounds || []).length !== a.backSounds
    || (a.noteFields && JSON.stringify(old.noteFields || []) !== JSON.stringify(a.noteFields))
    || (old.noteExtra || '') !== a.noteExtra || (a.noteText !== undefined && old.noteText !== a.noteText) || !!old.typeIn !== a.typeIn;
  return !differs ? 'same' : untouched(old) ? 'safe' : 'edited';
}
