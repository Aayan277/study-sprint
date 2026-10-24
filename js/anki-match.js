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
// The place of a row in the import preview (its cloze / occlusion are still { noteKey, n, … } objects there, and its template number is
// siblings.ord): the same answer slotOf gives for the card it will make. `reverse`: its reverse card.
export const rowSlot = (c, reverse = false) => slotOf({
  cloze: c.cloze ? c.cloze.n : undefined, occlusion: c.occlusion, templateOrd: c.siblings ? c.siblings.ord : undefined, reverse });

import { isPair } from './reverse.js';

const keyOf = (guid, slot) => `${guid}\u0001${slot}`;

// Every saved card that has a guid, by identity. When one note is saved more than once (a deck imported twice by an older version of
// the app), the saved cards fall into copies: the cards that share a noteId are one copy (a reversed pair, a cloze note's blanks, a
// several-template note), and a card with no noteId is a copy of its own. Copies are ranked: one with a card in one of the `prefer`
// decks (the deck being imported into, and its subdecks) first, then the one holding the oldest card (most likely to hold your progress).
// Places are taken from the single best noteId copy: two different notes are never mixed, so no note ever ends up with two cards in one
// place. A place that copy lacks is then filled by a card with no note of its own, if there is one; otherwise it becomes a new card in
// that note (see noteIdMap). The oldest card of a place wins within a copy.
export function indexByGuid(cards, prefer = null) {
  const byGuid = new Map();         // guid → Map copy key → [cards]
  for (const c of cards) {
    if (!c.ankiGuid) continue;
    const copies = byGuid.get(c.ankiGuid) || byGuid.set(c.ankiGuid, new Map()).get(c.ankiGuid);
    const key = typeof c.noteId === 'string' && c.noteId ? `n:${c.noteId}` : `c:${c.id}`;
    (copies.get(key) || copies.set(key, []).get(key)).push(c);
  }
  const older = (a, b) => (a.created || 0) - (b.created || 0) || (a.id < b.id ? -1 : 1);
  const index = new Map();
  for (const [guid, copies] of byGuid) {
    const list = [...copies.entries()].map(([key, cs]) => ({ note: key.startsWith('n:'), cs: cs.sort(older) }));
    const chosen = e => !!prefer && e.cs.some(c => prefer.has(c.deckId));
    list.sort((x, y) => chosen(y) - chosen(x) || older(x.cs[0], y.cs[0]));
    const best = list.find(e => e.note);
    for (const e of [best, ...list.filter(e => !e.note)]) {
      if (!e) continue;
      for (const c of e.cs) {
        const k = keyOf(guid, slotOf(c));
        if (!index.has(k)) index.set(k, c);
      }
    }
  }
  return index;
}

// Before 4.54 a note with several card templates came in as its first card only, saved with no templateOrd. That card is the note's
// template 0, so when the incoming ft0 has no exact match it takes the saved plain card (f) of the same note: the update gives it
// templateOrd 0 and the note's shared noteId, so it becomes a sibling of the cards added beside it instead of being duplicated.
// (There is no such case for a reverse card: a reversed note is never a several-template note, so rt0 has no fallback.)
// A good occlusion row (o1, o2…) likewise takes the plain picture card (f) a note saved earlier when its picture or boxes could not be used.
const fallbackOf = slot => (slot === 'ft0' || /^o\d+$/.test(slot) ? 'f' : null);

// For each item { guid, slot }, the saved card it matches, or null. A saved card is matched at most once (the first item to ask for it).
export function matchRows(items, index) {
  const claimed = new Set();
  return items.map(it => {
    if (!it || !it.guid || !index) return null;
    let card = index.get(keyOf(it.guid, it.slot));
    if ((!card || claimed.has(card.id)) && fallbackOf(it.slot)) {
      card = index.get(keyOf(it.guid, fallbackOf(it.slot)));
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
  // (a saved card that is in a note decides first: the cards of a re-imported note go into the note the saved cards are in)
  for (const [old, fresh] of [...pairs.filter(([o]) => o.noteId), ...pairs.filter(([o]) => !o.noteId)]) {
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
// (Object keys are sorted first: the sync server stores cards as JSON that comes back with its keys in another order.)
const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
export const contentSig = card => hashOf(JSON.stringify(SIG_FIELDS.map(k => canon(card[k] ?? null))));
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
  const { fresh } = plan, noteId = cur.noteId || plan.noteId;          // (a saved card is never moved to another note)
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
