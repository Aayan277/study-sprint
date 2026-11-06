// Data source: real review logs of many Anki users, read from a folder OUTSIDE the repo (env FSRS_DATA, default ~/fsrs-data).
// Node only. One of the two files that may name the dataset (the other is data/convert.py).
//
// Where the data comes from, per user <u>:
//   own/users/<u>.json   written by data/convert.py: the six basic columns plus duration_ms, note_id, deck_id and preset_id (null where unknown)
//   users/<u>.json       the older conversion: the six basic columns only (no answer time, no note, no deck)
// own/users is preferred when both exist, because it is a superset of the other (same rows, more columns). A user is used if either file exists,
// so every user already fetched counts. The split does not depend on which folder a user came from.
//
// The data has days but no wall-clock time, so rows get a made-up clock: day_offset at 04:00, plus a running offset inside the day that adds each
// answer's duration (10 s when unknown). That clock is only used for the gaps between different cards, notes and decks; the card's own gap comes
// from elapsed_seconds through row.gapSec, and the study day from day_offset through row.day (js/own-features.js).
//
// Everything in a data file is untrusted: sizes, types, ranges and lengths are checked, and a file that fails is refused whole (counted, never used).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mulberry32 } from '../../../js/fsrs-fit.js';
import { fnv1a } from '../../../js/rwkv-features.js';
import { insideRepo } from '../../../tests/realdata/lib.mjs';
import { splitOf } from './split.mjs';

export const LICENCE = 'anki-revlogs-10k: research use by students/individuals, no redistribution';
export const LIMITS = {
  maxFileBytes: 400 * 1024 * 1024,   // size of one user file
  maxRows: 5_000_000,                // rows in one user file
  maxUsers: 20_000,
  maxDay: 40_000,                    // day_offset: about 110 years
  maxElapsedSec: 1e10,
  maxDurationMs: 36e6               // ten hours; a real answer is capped at 50 minutes by Anki
};
const DAY_MS = 86400000, DAY_START_MS = 4 * 3600000, MAX_OFFSET_MS = 19.5 * 3600000, DEFAULT_ANSWER_MS = 10000;

export class DataError extends Error {}
const bad = (why) => { throw new DataError(why); };

export function dataRoot(opts = {}) { return opts.root ?? process.env.FSRS_DATA ?? join(homedir(), 'fsrs-data'); }

// ---------- checking one user file ----------
const REQUIRED = ['card_id', 'day_offset', 'rating', 'state'];
const OPTIONAL = ['elapsed_seconds', 'duration_ms', 'note_id', 'deck_id', 'preset_id'];

function column(obj, name, n, check, required) {
  const a = obj[name];
  if (a === undefined || a === null) { if (required) bad(`column ${name} is missing`); return null; }
  if (!Array.isArray(a)) bad(`column ${name} is not a list`);
  if (a.length !== n) bad(`column ${name} has ${a.length} values, expected ${n}`);
  for (let i = 0; i < n; i++) { const v = a[i]; if (!(v === null && !required) && !check(v)) bad(`column ${name} has a bad value at row ${i}`); }
  return a;
}
const isInt = (lo, hi) => v => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isId = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// obj: the parsed JSON. Returns it as plain columns (optional ones null when absent). Throws DataError when anything is off.
export function validateUser(obj, limits = LIMITS) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) bad('not an object');
  const n = Array.isArray(obj.card_id) ? obj.card_id.length : bad('column card_id is missing or not a list');
  if (n > limits.maxRows) bad(`too many rows (${n})`);
  const out = { user: obj.user };
  out.card_id = column(obj, 'card_id', n, isId, true);
  out.day_offset = column(obj, 'day_offset', n, isInt(0, limits.maxDay), true);
  out.rating = column(obj, 'rating', n, isInt(0, 4), true);        // 0 = not a real answer: dropped later
  out.state = column(obj, 'state', n, isInt(0, 4), true);
  out.elapsed_seconds = column(obj, 'elapsed_seconds', n, isInt(-1, limits.maxElapsedSec), false);
  out.duration_ms = column(obj, 'duration_ms', n, v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= limits.maxDurationMs, false);
  out.note_id = column(obj, 'note_id', n, isId, false);
  out.deck_id = column(obj, 'deck_id', n, isId, false);
  out.preset_id = column(obj, 'preset_id', n, isId, false);
  for (const k of Object.keys(obj)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k) && k !== 'user' && k !== 'schema' && k !== 'elapsed_days') bad(`unknown column ${String(k).slice(0, 40)}`);
  return out;
}

export function parseUserText(text, limits = LIMITS) {
  if (typeof text !== 'string' || text.length > limits.maxFileBytes) bad('file too large');
  let obj;
  try { obj = JSON.parse(text); } catch { bad('not valid JSON'); }
  return validateUser(obj, limits);
}

// ---------- columns -> one learner ----------
// Rules (the same as tests/realdata/lib.mjs toHistories, so scores can be compared with the FSRS numbers):
//   ratings 1 to 4 only (other rows are dropped; their elapsed time still counts towards the next gap of that card);
//   a state-0 row after earlier rows of the card is a reset: it starts a new life of the card (key c<id>~2, ~3 ...), the note, deck and you carry on;
//   only the last life of a card is scored, and only if it starts at state 0; everything else still updates the memory (log.scored = false).
// cap: at most this many rows, thinned by whole cards picked by a shuffle seeded with `seed` (like capCards in tests/realdata/run.mjs).
export function userToLearner(u, { cap = 40000, seed = 0, id = String(u.user) } = {}) {
  const n = u.card_id.length;
  const byCard = new Map();
  for (let r = 0; r < n; r++) { let l = byCard.get(u.card_id[r]); if (!l) byCard.set(u.card_id[r], l = []); l.push(r); }
  const stats = { rawRows: n, droppedRating: 0, resets: 0, unscoredCards: 0, capped: false, cardsKept: 0 };
  const cards = [];     // { cardId, key, rows: [{ r, sec }], scored }
  for (const [cardId, rows] of byCard) {
    const lives = [];
    let cur = null, acc = 0;
    rows.forEach((r, k) => {
      const es = u.elapsed_seconds ? u.elapsed_seconds[r] : null;
      if (u.rating[r] < 1) { stats.droppedRating++; if (es !== null && es >= 0) acc += es; else if (k > 0) acc = NaN; return; }
      if (!cur || u.state[r] === 0 && cur.rows.length) { if (cur) stats.resets++; lives.push(cur = { rows: [] }); }
      cur.rows.push({ r, sec: es !== null && es >= 0 ? acc + es : NaN });
      acc = 0;
    });
    lives.forEach((life, k) => cards.push({ cardId, key: k === 0 ? `c${cardId}` : `c${cardId}~${k + 1}`, rows: life.rows, scored: k === lives.length - 1 && u.state[life.rows[0].r] === 0 }));
  }
  stats.unscoredCards = cards.filter(c => !c.scored && c.key.indexOf('~') < 0).length;
  // cap by whole cards (all lives of a card go or stay together)
  let keep = cards;
  const total = cards.reduce((a, c) => a + c.rows.length, 0);
  if (total > cap) {
    const ids = [...byCard.keys()], rng = mulberry32(fnv1a(`own-cap|${seed}|${id}`));
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const size = new Map();
    for (const c of cards) size.set(c.cardId, (size.get(c.cardId) || 0) + c.rows.length);
    const take = new Set();
    let used = 0;
    for (const cid of ids) { const s = size.get(cid); if (used + s <= cap) { take.add(cid); used += s; } }
    keep = cards.filter(c => take.has(c.cardId));
    stats.capped = true;
  }
  stats.cardsKept = keep.length;
  // all kept rows in time order: by day, then file order inside a day
  const flat = [];
  for (const c of keep) c.rows.forEach((x, i) => flat.push({ c, i, r: x.r, sec: x.sec }));
  flat.sort((a, b) => u.day_offset[a.r] - u.day_offset[b.r] || a.r - b.r);
  const hasNote = !!u.note_id, hasDeck = !!u.deck_id, hasDuration = !!u.duration_ms;
  const logs = [], cardOut = new Map(), prevDay = new Map();
  let curDay = -1, offset = 0, countNoDuration = 0;
  for (const x of flat) {
    const { c, r } = x, day = u.day_offset[r];
    if (day !== curDay) { curDay = day; offset = 0; }
    const dur = hasDuration && u.duration_ms[r] !== null ? u.duration_ms[r] : null;
    const t = day * DAY_MS + DAY_START_MS + offset;
    offset = Math.min(MAX_OFFSET_MS, offset + (dur ?? DEFAULT_ANSWER_MS));
    const log = { id: logs.length, cardId: c.key, timestamp: t, source: 'review', mode: 'flip', rating: u.rating[r], ms: dur ?? 0, state: u.state[r], day };
    if (dur === null) { log.msUnknown = true; countNoDuration++; }
    if (!c.scored) log.scored = false;
    if (x.i > 0) {
      const gapDays = Math.max(0, day - prevDay.get(c.key));
      log.gapSec = Number.isFinite(x.sec) ? x.sec : gapDays * 86400;
    }
    prevDay.set(c.key, day);
    logs.push(log);
    if (!cardOut.has(c.key)) {
      const note = hasNote ? u.note_id[r] : null, deck = hasDeck ? u.deck_id[r] : null, preset = u.preset_id ? u.preset_id[r] : null;
      const o = { id: c.key, deckId: deck === null ? '?' : String(deck), noteId: note === null ? `c${c.cardId}` : String(note) };
      if (preset !== null) o.presetId = String(preset);
      cardOut.set(c.key, o);
    }
  }
  const deckIds = [...new Set([...cardOut.values()].map(c => c.deckId))];
  stats.rows = logs.length; stats.hasNote = hasNote; stats.hasDeck = hasDeck; stats.hasDuration = hasDuration; stats.noDuration = countNoDuration;
  return { id, source: 'anki10k', split: splitOf(id), logs, cards: [...cardOut.values()], decks: deckIds.map(d => ({ id: d })), meta: stats };
}

// ---------- the source ----------
function userFiles(root) {
  const found = new Map();      // id -> path (own/users preferred)
  for (const dir of ['users', join('own', 'users')]) {
    const d = join(root, dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) { const m = /^(\d{1,12})\.json$/.exec(f); if (m) found.set(m[1], join(d, f)); }
  }
  return found;
}

export default {
  id: 'anki10k',
  licence: LICENCE,
  node: true,
  browser: false,
  available(opts = {}) {
    const root = dataRoot(opts);
    if (insideRepo(root)) return { ok: false, reason: 'the data folder is inside the repo' };
    if (!existsSync(root)) return { ok: false, reason: 'no data folder' };
    return userFiles(root).size ? { ok: true } : { ok: false, reason: 'no user files in the data folder' };
  },
  describe(opts = {}) {
    const ids = [...userFiles(dataRoot(opts)).keys()];
    const split = { train: 0, val: 0, test: 0 };
    for (const id of ids) split[splitOf(id)]++;
    return { learners: ids.length, reviews: null, split };
  },
  // opts: { split, seed, cap (rows per user, default 40000), root, users (only these ids), limit, onSkip(id, why) }
  *learners(opts = {}) {
    const root = dataRoot(opts);
    if (insideRepo(root)) throw new Error('Refusing: the data folder is inside the repo. Real review data must stay outside it.');
    const files = userFiles(root);
    let ids = [...files.keys()].sort((a, b) => a - b);
    if (ids.length > LIMITS.maxUsers) ids = ids.slice(0, LIMITS.maxUsers);
    if (opts.users) { const want = new Set(opts.users.map(String)); ids = ids.filter(i => want.has(i)); }
    if (opts.split) ids = ids.filter(i => splitOf(i) === opts.split);
    if (opts.limit) ids = ids.slice(0, opts.limit);
    for (const id of ids) {
      let learner;
      try {
        const path = files.get(id);
        if (statSync(path).size > LIMITS.maxFileBytes) bad('file too large');
        const u = parseUserText(readFileSync(path, 'utf8'));
        u.user = Number(id);
        learner = userToLearner(u, { cap: opts.cap ?? 40000, seed: opts.seed ?? 0, id });
      } catch (e) {
        if (!(e instanceof DataError)) throw e;
        opts.onSkip?.(id, e.message);
        continue;
      }
      yield learner;
    }
  }
};
