// Own model: the small shared helpers that turn Study Sprint's review log into rows for the memory engine.
// Pure functions; no DOM, no storage, no network. Depends only on fsrs-data.js (rowKind) and days.js (ROLLOVER_HOUR).
import { rowKind } from './fsrs-data.js';
import { ROLLOVER_HOUR } from './days.js';

const DAY_MS = 86400000;

// a fixed 32-bit hash of a text (used to give each entity its own stable code)
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// which study day a time belongs to (a new day starts at 4am local time)
export function studyDay(t) {
  const d = new Date(t);
  const back = d.getHours() < ROLLOVER_HOUR ? 1 : 0;       // before 4am still belongs to yesterday
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() - back) / DAY_MS);
}

// logs: review-log rows; cards: [{ id, deckId, noteId }]; decks: [{ id, options? }]
// -> [{ logId, cardKey, noteKey, deckKey, presetKey, t, day, rating, ms, kind }] in time order
export function modelRows(logs, cards, decks) {
  const cardOf = new Map(cards.map(c => [c.id, c]));
  const ownPreset = new Set(decks.filter(d => d && d.options).map(d => d.id));
  const rows = [];
  for (const log of logs) {
    const kind = rowKind(log);
    if (kind !== 'train' && kind !== 'replay') continue;
    const card = cardOf.get(log.cardId);
    const cardKey = 'c:' + log.cardId;
    const row = {
      logId: log.id, cardKey, t: log.timestamp, day: studyDay(log.timestamp), rating: log.rating,
      ms: Math.min(600000, Math.max(0, Number.isFinite(log.ms) ? log.ms : 0)), kind
    };
    if (card) {
      row.noteKey = typeof card.noteId === 'string' && card.noteId !== '' ? 'n:' + card.noteId : cardKey;
      row.deckKey = 'd:' + card.deckId;
      row.presetKey = ownPreset.has(card.deckId) ? 'p:' + card.deckId : 'p:default';
    } else {
      row.noteKey = cardKey; row.deckKey = 'd:?'; row.presetKey = 'p:default';
    }
    rows.push(row);
  }
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  rows.sort((a, b) => a.t - b.t || cmp(a.logId, b.logId));
  return rows;
}
