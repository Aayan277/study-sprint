// Shared by the Own tests: a loaded model in a stand-in database, a small review history, and a clock you can move.
import { writeOwnFile } from '../js/own-file.js';
import { initParams } from '../js/own-model.js';
import { loadModelFile } from '../js/own-load.js';
import { openOwnDb } from '../js/own-db.js';
import { modelRows } from '../js/own-rows.js';
import { makeFakeIdb } from './own-idb-fake.mjs';

export const DAY = 86400000;
export const T0 = new Date(2026, 5, 1, 12).getTime();           // noon, 1 June 2026 (local time)
export const DECKS = [{ id: 'd' }];
export const CARDS = ['a', 'b', 'c'].map((id, i) => ({ id, deckId: 'd', noteId: 'n' + i }));

export const modelBytes = (seed = 3) => writeOwnFile({ size: 's', params: Float32Array.from(initParams('s', seed)), trainedOn: [{ id: 'sim-v1', licence: 'ours' }], seed, gitStamp: 'abc1234', createdAt: '2026-11-06T00:00:00.000Z' });
export const fileOf = (bytes, name = 'test.own') => ({ name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });

// A stand-in database holding a loaded model (switch off).
export async function loadedIdb(seed = 3) {
  const idb = makeFakeIdb();
  const r = await loadModelFile(fileOf(modelBytes(seed)), { idb });
  if (!r.ok) throw new Error(r.message);
  return idb;
}
export async function setSettings(idb, settings) {
  const h = await openOwnDb({ idb });
  await h.put('meta', 'settings', settings);
  h.close();
}

// Reviews of the cards every 2 days, `n` rounds. Row ids count up from `firstId`.
export function history(n = 6, { firstId = 1, cards = CARDS } = {}) {
  const logs = []; let id = firstId;
  for (let d = 0; d < n; d++) for (const c of cards) logs.push({ id: id++, cardId: c.id, timestamp: T0 + d * 2 * DAY + id, source: 'review', rating: 3, ms: 5000, state: d ? 2 : 0 });
  return logs;
}
export const rowsOf = logs => modelRows(logs, CARDS, DECKS);
export const slim = (l, id = l.id) => ({ id, cardId: l.cardId, timestamp: l.timestamp, source: l.source, applied: l.applied, rating: l.rating, ms: l.ms, state: l.state });
// the next real review of a card, `days` after T0
export const reviewAt = (id, cardId, days, over = {}) => ({ id, cardId, timestamp: T0 + days * DAY, source: 'review', rating: 3, ms: 4000, state: 2, ...over });
// a clock that tests move by hand
export const clock = (start = T0 + 40 * DAY) => { const c = { t: start, now: () => c.t, advance: d => { c.t += d * DAY; } }; return c; };
