// "You mix these up" (B2). Pure functions (no DOM), tested by tests/confusion.test.js.
//
// Typed Review, and Play when it counts as reviews (Settings), record `mixedWith: '<cardId>'` on a log row when the wrong
// answer given was the answer of another card. This file turns those rows into pairs of cards that keep being confused.
// A practice-only Play round saves no rows; its results panel adds that round's own entries (finish-extras.js), so
// lasting pairs come only from Review or from counted Play.

import { similarity } from './game.js';
import { dupKey } from './import.js';
import { hasMasks, occLabel } from './occlusion.js';
import { plainText } from './format.js';

export const MIX_WINDOW_DAYS = 90;            // the surfaces read the last 90 days of the log
export const MIX_MIN_COUNT = 2;               // a pair needs at least this many mix-ups
export const MIX_DEBOUNCE_MS = 2 * 60 * 1000; // the same mix-up within 2 minutes counts once

// The same key for A→B and B→A.
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Pairs of cards the person mixes up, most often first.
//   logs       review log rows; a row counts when it has a mixedWith card id
//   cardsById  Map (or plain object) of the cards that exist; a pair with a deleted card is left out
//   since      ignore rows older than this timestamp (default: all)
//   dismissed  { 'a|b': count when "Not confused" was pressed }; hidden until two more mix-ups have happened
// Returns [{ key, a, b, count, last }] (a and b in key order, last = timestamp of the latest mix-up).
export function mixPairs(logs, { cardsById, since = 0, dismissed = {} } = {}) {
  const has = id => (cardsById instanceof Map ? cardsById.has(id) : !!cardsById && Object.hasOwn(cardsById, id));
  const rows = logs.filter(l => typeof l.mixedWith === 'string' && l.mixedWith && l.cardId && l.mixedWith !== l.cardId && l.timestamp >= since)
    .sort((x, y) => x.timestamp - y.timestamp);
  const lastCounted = new Map();              // "from>to" → timestamp of the mix-up last counted in that direction
  const pairs = new Map();
  for (const l of rows) {
    const dir = `${l.cardId}>${l.mixedWith}`;
    const prev = lastCounted.get(dir);
    if (prev !== undefined && l.timestamp - prev < MIX_DEBOUNCE_MS) continue;
    lastCounted.set(dir, l.timestamp);
    const key = pairKey(l.cardId, l.mixedWith);
    const [a, b] = l.cardId < l.mixedWith ? [l.cardId, l.mixedWith] : [l.mixedWith, l.cardId];
    const p = pairs.get(key) || { key, a, b, count: 0, last: 0 };
    p.count++; p.last = Math.max(p.last, l.timestamp);
    pairs.set(key, p);
  }
  return [...pairs.values()]
    .filter(p => p.count >= MIX_MIN_COUNT && has(p.a) && has(p.b) && !((dismissed[p.key] ?? -Infinity) >= p.count - 1))
    .sort((x, y) => y.count - x.count || y.last - x.last || (x.key < y.key ? -1 : 1));
}

// The pairs that involve any of these cards (ids in an array or Set).
export function pairsFor(cardIds, pairs) {
  const ids = cardIds instanceof Set ? cardIds : new Set(cardIds);
  return pairs.filter(p => ids.has(p.a) || ids.has(p.b));
}

// The card on the other side of a pair.
export const partnerOf = (pair, id) => (pair.a === id ? pair.b : pair.a);

// "Not confused": remember how many mix-ups there were, so the pair returns after two more.
export const dismissPair = (dismissed, pair) => ({ ...dismissed, [pair.key]: pair.count });

// Dismissals live on this device (localStorage), not in backups or sync.
export const DISMISS_KEY = 'study-sprint-mix-dismissed';
export function loadDismissed(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage.getItem(DISMISS_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
export function saveDismissed(dismissed, storage = globalThis.localStorage) {
  try { storage.setItem(DISMISS_KEY, JSON.stringify(dismissed)); } catch { /* private window: it just won't be remembered */ }
}

// ---------- what the Compare sheet shows and builds (compare-sheet.js) ----------

// A card's front as one short line of plain text (a picture-hiding card: the hidden part's label).
export function cardLabel(card, max = 60) {
  if (!card) return '';
  const t = hasMasks(card) ? (occLabel(card.occlusion.masks, card.occlusion.n) || card.occlusion.header || 'Picture') : plainText(card.front);
  const s = String(t ?? '').replace(/\s+/g, ' ').trim() || 'Picture';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Four look-alikes to drill with the pair: other cards of the pair's decks, nearest in wording first, never a sibling
// of either card and never an answer the pair already has.
export function neighbours(a, b, cards, n = 4) {
  const taken = new Set([dupKey(a.back), dupKey(b.back)]);
  const sib = c => !!c.noteId && (c.noteId === a.noteId || c.noteId === b.noteId);
  const decks = new Set([a.deckId, b.deckId]);
  const rank = c => similarity(c.back, a.back) + similarity(c.back, b.back) + similarity(c.front, a.front) + similarity(c.front, b.front);
  const out = [];
  for (const c of cards.filter(c => c.id !== a.id && c.id !== b.id && !sib(c) && !c.suspended && decks.has(c.deckId))
    .map(c => ({ c, r: rank(c) })).sort((x, y) => y.r - x.r).map(x => x.c)) {
    const k = dupKey(c.back);
    if (!k || taken.has(k)) continue;
    taken.add(k); out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

// The text of a comparison card: it asks for the difference, and the back lists one line per card to fill in.
export function comparisonText(a, b) {
  const [x, y] = [cardLabel(a, 40), cardLabel(b, 40)];
  return { front: `${x} vs ${y}: what's the difference?`, back: `- ${x}: …\n- ${y}: …` };
}
