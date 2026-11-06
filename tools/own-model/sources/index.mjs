// The data sources, all in one list. A source is
//   { id, licence, node, browser, available(opts) -> { ok, reason? }, describe(opts) -> { learners, reviews }, *learners(opts) -> { id, logs, cards, decks, ... } }
// Splits are by learner ('train' | 'val' | 'test'), never by review. `licence` is copied into the trained model's `trainedOn`.
//   sim       made-up learners from the simulator. Always available.
//   fixture   a tiny committed made-up set, for tests. Always available.
//   anki10k   real review logs from a folder outside the repo. Only when asked for AND the folder exists; otherwise skipped, so a test run never needs it.
// Not built: donated reviews (needs consent screens and a server).
import sim from './sim.mjs';
import fixture from './fixture.mjs';
import anki10k from './anki10k.mjs';

export const SOURCES = { sim, fixture, anki10k };

export function getSource(id) {
  if (!Object.prototype.hasOwnProperty.call(SOURCES, id)) throw new Error(`Unknown data source: ${id}`);
  return SOURCES[id];
}

// ids: e.g. ['sim', 'anki10k'] -> { use: [source...], skipped: [{ id, reason }] }. An unknown id is an error; a source whose data is missing is skipped.
export function resolveSources(ids, opts = {}) {
  const use = [], skipped = [];
  for (const id of ids) {
    const s = getSource(id);
    const a = s.available(opts);
    if (a.ok) use.push(s); else skipped.push({ id, reason: a.reason });
  }
  return { use, skipped };
}

export { rowsOf } from './rows.mjs';
export { splitOf, bucketOf } from './split.mjs';
