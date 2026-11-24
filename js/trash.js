// Recently deleted, the glue: what the delete screens call (keepDeleted, forgetDeleted), what the sheet calls (list, restoreEntry,
// deleteNow, emptyList) and what the app calls (purgeDaily, protectedMedia, emptyAll). The rules are in js/trash-logic.js, the
// storage in js/trash-db.js, the putting back in db.restoreDeleted. Nothing here is synced: the list lives on this device only,
// and only a restore goes back out through normal sync (the restored rows are new changes).
//
// A delete screen does its delete exactly as before (and keeps its Undo toast), then calls keepDeleted(snap, ...). That never
// throws: if the entry can't be saved the delete simply stays as it was before this feature (Undo still works).

import * as db from './db.js';
import * as store from './trash-db.js';
import { account } from './sync-state.js';
import { plainText } from './format.js';
import { isPair } from './reverse.js';
import { ownSynced } from './own-gate.js';
import { buildEntry, cardsTitle, deckPath, deckFate, fixParent, KEEP_DAYS, DAY } from './trash-logic.js';

// Saves what a delete removed. `snap` is the same snapshot the Undo uses (it may also hold rows that were only changed: pass those
// in `before` as { cards, decks } and they are kept apart). meta: { kind: 'cards' | 'deck', title, deckId }.
// Returns a handle { id, parts } (give it to forgetDeleted), or null when nothing was kept.
export async function keepDeleted(snap, { kind = 'cards', title = '', deckId = '', before = {} } = {}) {
  try {
    const was = { cards: before.cards || [], decks: before.decks || [] };
    const changedIds = { cards: new Set(was.cards.map(c => c.id)), decks: new Set(was.decks.map(d => d.id)) };
    const gone = { ...snap, cards: snap.cards.filter(c => !changedIds.cards.has(c.id)), decks: snap.decks.filter(d => !changedIds.decks.has(d.id)) };
    if (!gone.cards.length && !gone.decks.length) return null;
    const [acct, live] = await Promise.all([account(), db.getDecks()]);
    const known = new Map([...live, ...gone.decks].map(d => [d.id, d]));
    const decks = [...known.values()];
    const pathOf = id => deckPath(decks, id);
    const deckNames = {};
    for (const c of gone.cards) if (c.deckId && known.has(c.deckId)) deckNames[c.deckId] = known.get(c.deckId).name;
    const now = Date.now();
    const meta = {
      id: `${now}-${db.newId().slice(0, 8)}`, kind, now, userId: acct ? acct.id : null, before: was, deckNames,
      title: title || cardsTitle(gone.cards, { plain: plainText, pathOf }),
      deckId: deckId || gone.cards[0]?.deckId || '',
      deckPath: kind === 'deck' ? '' : pathOf(gone.cards[0]?.deckId)
    };
    const { entry, parts } = buildEntry(gone, meta);
    try { await store.addEntry(entry, parts); } catch (err) {
      if (err.code !== 'quota') throw err;
      // The device is nearly full: make room by dropping the oldest half of the list, then try once more.
      const all = await store.listEntries();
      await store.removeEntries(all.slice(Math.floor(all.length / 2)));
      await store.addEntry(entry, parts);
    }
    return { id: entry.id, parts: entry.parts };
  } catch (err) {
    console.error('Recently deleted:', err);
    return null;
  }
}

// The Undo toast brought it back already: take the entry out so it does not show twice.
export async function forgetDeleted(handle) {
  if (!handle) return;
  try { await store.removeEntry(handle); } catch (err) { console.error('Recently deleted:', err); }
}

// ---------- the list ----------
// Entries made while signed out belong to this device and show whoever is signed in; entries made in an account show only in that account
// (so one account's cards are never pushed into another).
const visible = (entries, acct) => entries.filter(e => !e.userId || (acct && e.userId === acct.id));
export async function list({ now = Date.now() } = {}) {
  try { await store.purgeExpired(now); } catch (err) { console.error('Recently deleted:', err); }
  return visible(await store.listEntries(), await account());
}

export async function deleteNow(entry) { await store.removeEntry(entry); }
export async function emptyList() { await store.removeEntries(await list()); }
// This device was wiped (Reset, sign-out with Remove, Delete everywhere, Restore backup): the whole list goes, whoever's it was.
export async function emptyAll() { try { await store.clearTrash(); } catch (err) { console.error('Recently deleted:', err); } }

// Removes what is over 30 days old, at most once a day (the app calls this when the browser is idle after start).
const PURGED_KEY = 'study-sprint-trash-purged';
export async function purgeDaily({ now = Date.now(), force = false } = {}) {
  try {
    let last = 0;
    try { last = Number(localStorage.getItem(PURGED_KEY)) || 0; } catch { /* no storage: purge every start */ }
    if (!force && last && now >= last && now - last < DAY) return 0;
    const n = await store.purgeExpired(now);
    try { localStorage.setItem(PURGED_KEY, String(now)); } catch { /* fine */ }
    return n;
  } catch (err) { console.error('Recently deleted:', err); return 0; }
}

// The pictures and sounds the clean-up and the account sweep must leave alone, or null if the list can't be read (then do not clean).
export async function protectedMedia() {
  try { return await store.mediaIds(); } catch (err) { console.error('Recently deleted:', err); return null; }
}

// ---------- restoring ----------
// Puts an entry back, piece by piece. Options:
//   onProgress({ done, total })   after each piece
//   pickDeck({ name, inTrash, title })   asked when a card's deck is gone. Answer { deckId } (put the cards in that deck),
//                                 { restoreToo: true } (only when the deck is in Recently deleted: restore it first) or null (cancel).
// Returns { ok, title, deckId, cards, reviews, decks, newer } or { cancelled: true } / { missing: true }.
// Safe to run again after an interruption (rows that are back already are left alone).
export async function restoreEntry(id, { onProgress = () => {}, pickDeck = null, seen = new Set() } = {}) {
  const acct = await account();
  const entries = visible(await store.listEntries(), acct);
  const entry = entries.find(e => e.id === id);
  if (!entry) return { missing: true };
  seen.add(id);
  const live = new Set((await db.getDecks()).map(d => d.id));
  const own = new Set(entry.deckIds || []);
  const trashDecks = new Map();
  for (const e of entries) if (e.id !== id) for (const d of e.deckIds || []) trashDecks.set(d, e.id);

  // First look through the pieces: which decks do the cards need, and which cards are a pair.
  const need = new Set(), goneNotes = new Map();
  for (let n = 0; n < entry.parts; n++) {
    const part = await store.getPart(id, n);
    for (const c of part?.gone.cards || []) {
      if (c.deckId && !own.has(c.deckId)) need.add(c.deckId);
      if (isPair(c)) (goneNotes.get(c.noteId) || goneNotes.set(c.noteId, new Set()).get(c.noteId)).add(c.id);
    }
  }
  // 5b: a card's deck is gone. Never skip silently.
  const deckMap = new Map();
  for (const deckId of need) {
    if (live.has(deckId)) continue;
    const fate = deckFate(deckId, live, trashDecks);
    const name = entry.deckNames?.[deckId] || 'its deck';
    const answer = pickDeck ? await pickDeck({ name, inTrash: fate.state === 'trash', title: fate.state === 'trash' ? entries.find(e => e.id === fate.entryId)?.title : '' }) : null;
    if (!answer) return { cancelled: true };
    if (answer.restoreToo && fate.state === 'trash' && !seen.has(fate.entryId)) {
      const sub = await restoreEntry(fate.entryId, { onProgress: () => {}, pickDeck, seen });
      if (sub.cancelled) return sub;
      live.add(deckId);
      continue;
    }
    if (answer.deckId) deckMap.set(deckId, answer.deckId);
    else return { cancelled: true };
  }
  for (const d of await db.getDecks()) live.add(d.id);

  // Pairs: a card whose partner is here (or comes back with it) stays a pair.
  const partners = new Map(goneNotes);
  if (goneNotes.size) {
    for (const c of await db.getAll('cards')) if (isPair(c)) (partners.get(c.noteId) || partners.set(c.noteId, new Set()).get(c.noteId)).add(c.id);
  }

  const total = { cards: 0, reviews: 0, decks: 0, states: 0, newer: 0, noDeck: 0 };
  for (let n = 0; n < entry.parts; n++) {
    const part = await store.getPart(id, n);
    if (!part) continue;
    const fix = { liveDeckIds: live, entryDeckIds: own, trashDecks };
    const ready = {
      gone: { ...part.gone, decks: part.gone.decks.map(d => fixParent(d, fix)), cards: part.gone.cards.map(c => (deckMap.has(c.deckId) ? { ...c, deckId: deckMap.get(c.deckId) } : c)) },
      before: part.before
    };
    const got = await db.restoreDeleted(ready, entry, { partners });
    for (const k of Object.keys(total)) total[k] += got[k] || 0;
    onProgress({ done: n + 1, total: entry.parts });
    await new Promise(r => setTimeout(r));          // let the screen draw between pieces
  }
  if (total.reviews) await ownSynced();            // Own's memory no longer matches the log: it is rebuilt now, not at the next session
  await store.removeEntry(entry);
  return { ok: true, title: entry.title, deckId: [...deckMap.values()][0] || entry.deckId, ...total };
}

export { KEEP_DAYS };
