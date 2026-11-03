// RWKV lab: the worker. The model never runs on the page: this file reads the saved weights from the lab database, keeps the
// memory states, and answers the page's messages. It owns the lab database while it works.
//   page -> worker  { id, type, ...}   init | rebuild | catchup | review | undo | whatIf | flush
//   worker -> page  { id, type: 'done', result } | { id, type: 'error', message } | { id, type: 'progress', done, total }
// No network.
import * as lab from './rwkv-labdb.js';
import { parseWeights, validateWeights } from './rwkv-weights.js';
import { Engine } from './rwkv-engine.js';
import { FeatureBuilder, modelRows } from './rwkv-features.js';
import { encodeEntity, decodeEntity } from './rwkv-state.js';
import { daysForButtons } from './rwkv-curve.js';
import { FEATURE_VERSION, STATE_FORMAT } from './rwkv-spec.js';
import { rowHash } from './rwkv-fresh.js';
import { initState, nextState, forgettingCurve } from './fsrs-fit.js';
import { deltaDays } from './fsrs-data.js';

const CACHE_CARDS = 2000;           // card and note states kept in memory beyond what is being worked on
const SAVE_DELAY_MS = 1000;
const PROGRESS_MS = 100;
const STREAM_OF = { d: 1, p: 3, u: 4 };

let tensors = null, sha = null, engine = null;
let gen = null;                      // this worker's turn at the lab database (a second tab's worker takes the next number and this one then stops writing)
let state = null;                    // the saved 'state' record (without the builder, which lives in the engine)
let saveTimer = 0;
let walk = null;                     // FSRS-6 memory per card for the comparison; saved with each card (see FsrsWalk)
const cursors = [];                  // for undo: { logId, before, modelled, walkBefore } (the bookmark before each live review)
let pendingPreds = [], pendingDeletes = [];

const post = (msg) => self.postMessage(msg);

// ---------- loading ----------
async function init() {
  lab.forbidCreate();
  const rec = await lab.get('weights', 'current');
  if (!rec) throw new Error('No weights file has been chosen.');
  const parsed = parseWeights(rec.bytes);
  const check = validateWeights(parsed.tensors);
  if (!check.ok) throw new Error(check.errors[0]);
  tensors = parsed.tensors; sha = rec.sha256;
  gen = await lab.takeOver();
  state = (await lab.get('meta', 'state')) || null;
  engine = new Engine(tensors);
  walk = new FsrsWalk(null);
  if (state && state.builder && !state.rebuilding) {
    engine.builder = FeatureBuilder.fromJSON(state.builder);
    for (const [k, v] of await lab.getEntries('shared')) engine.shared.set(k, decodeEntity(STREAM_OF[k[0]], v.buf));
  }
  if (state) delete state.builder;
  return { ok: true, rows: state?.rows ?? 0 };
}

async function loadFor(row) {
  if (!engine.cards.has(row.cardKey)) {
    const rec = await lab.get('cards', row.cardKey);
    if (rec) { engine.cards.set(row.cardKey, rec.buf); if (rec.curve) engine.curves.set(row.cardKey, rec.curve); if (rec.fsrs) walk.cards.set(row.cardKey, rec.fsrs); }
  }
  if (!engine.notes.has(row.noteKey)) {
    const rec = await lab.get('notes', row.noteKey);
    if (rec) engine.notes.set(row.noteKey, rec.buf);
  }
  touch(row);
}

// A real least-recently-used cache: what was just used moves to the end, and trim() drops from the front. Anything not yet saved (dirty) stays.
function touch(row) {
  for (const [map, key] of [[engine.cards, row.cardKey], [engine.notes, row.noteKey]]) {
    if (map.has(key)) { const v = map.get(key); map.delete(key); map.set(key, v); }
  }
}
function trim() {
  for (const [map, dirty, extra] of [[engine.cards, engine.dirty.cards, [engine.curves, walk.cards]], [engine.notes, engine.dirty.notes, []]]) {
    if (map.size <= CACHE_CARDS) continue;
    for (const k of [...map.keys()]) {
      if (map.size <= CACHE_CARDS) break;
      if (dirty.has(k)) continue;
      map.delete(k); for (const m of extra) m.delete(k);
    }
  }
}

// ---------- saving ----------
function stateRecord(extra = {}) {
  return { ...state, ...extra, builder: engine.builder.toJSON() };
}
function entityPuts(snap) {
  const cardT = k => engine.builder.cards.get(k)?.prevT ?? null;
  return {
    cards: snap.cards.map(([k, buf, curve]) => [k, { buf, curve, t: cardT(k), fsrs: walk.cards.get(k) || null }]),
    notes: snap.notes.map(([k, buf]) => [k, { buf }]),
    shared: snap.shared.map(([k, st]) => [k, { buf: encodeEntity(STREAM_OF[k[0]], st) }])
  };
}
async function flush() {
  clearTimeout(saveTimer); saveTimer = 0;
  if (!engine || !state || state.rebuilding) return { saved: false };
  const snap = engine.snapshotDirty();
  const puts = entityPuts(snap);
  puts.preds = pendingPreds; puts.meta = [['state', stateRecord()]];
  const deletes = { cards: snap.removed.cards, notes: snap.removed.notes, shared: snap.removed.shared, preds: pendingDeletes };
  pendingPreds = []; pendingDeletes = [];
  await lab.commit(puts, deletes, gen);
  trim();
  return { saved: true };
}
// (the timer's flush goes through the message queue, so it never runs in the middle of a review, an undo or a rebuild)
function scheduleFlush() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = 0; enqueue(() => flush()).catch(err => post({ type: 'error', id: 0, message: String(err?.message || err) })); }, SAVE_DELAY_MS);
}

// ---------- FSRS-6 predictions for past reviews ----------
// Walks each card's rows the way the optimizer does (a card must start at "new"; a reset starts again) and gives, for every real
// review a day or more after the card's last answer, the chance FSRS-6 would have given it with `w` (yours) and with the defaults.
class FsrsWalk {
  constructor(fsrs) { this.setParams(fsrs); this.cards = new Map(); }
  setParams(fsrs) { this.fsrs = fsrs && fsrs.wDefault ? fsrs : null; }
  step(row, logState) {
    if (!this.fsrs) return { mine: null, def: null };
    const wM = this.fsrs.w || this.fsrs.wDefault, wD = this.fsrs.wDefault;
    let c = this.cards.get(row.cardKey);
    const fresh = !c || logState === 0;
    if (fresh) {
      const startsNew = logState === 0 || logState === undefined;
      c = { ok: startsNew, last: row.t, mine: startsNew ? initState(wM, row.rating) : null, def: startsNew ? initState(wD, row.rating) : null };
      this.cards.set(row.cardKey, c);
      return { mine: null, def: null };
    }
    if (!c.ok) return { mine: null, def: null };
    const t = deltaDays(c.last, row.t);
    let mine = null, def = null;
    if (t >= 1 && row.kind === 'train') {
      mine = forgettingCurve(wM, t, c.mine.s); def = forgettingCurve(wD, t, c.def.s);
    }
    c.mine = nextState(wM, c.mine.s, c.mine.d, t, row.rating);
    c.def = nextState(wD, c.def.s, c.def.d, t, row.rating);
    c.last = row.t;
    return { mine, def };
  }
}

// ---------- messages ----------
async function rebuild({ logs, cards, decks, fsrs }, id) {
  const rows = modelRows(logs, cards, decks);
  const stateOf = new Map(logs.map(l => [l.id, l.state]));
  const before = (await lab.get('meta', 'state')) || {};
  const marker = { ...before, rows: before.rows ?? 0, rebuilding: true };
  delete marker.builder;
  await lab.put('meta', marker, 'state');       // if this is interrupted, the flag stays and the state counts as stale
  await lab.clearStates();
  engine = new Engine(tensors);
  state = marker;
  cursors.length = 0; pendingPreds = []; pendingDeletes = [];
  walk = new FsrsWalk(fsrs);
  const preds = [];
  let lastProgress = performance.now();
  for (let n = 0; n < rows.length; n++) {
    const row = rows[n];
    const f = walk.step(row, stateOf.get(row.logId));
    const scored = row.kind === 'train';
    const r = engine.review(row, { score: scored, keepToken: false });
    if (scored && Number.isFinite(r.pCurve) && Number.isFinite(r.pImm)) {
      preds.push({ logId: row.logId, cardId: row.cardKey.slice(2), t: row.t, y: row.rating > 1 ? 1 : 0, elapsedDays: r.elapsedDays,
        rwkvCurve: r.pCurve, rwkvImm: r.pImm, fsrsMine: f.mine, fsrsDefault: f.def, src: 'replay' });
    }
    const now = performance.now();
    if (now - lastProgress >= PROGRESS_MS) { lastProgress = now; post({ id, type: 'progress', done: n + 1, total: rows.length }); }
  }
  post({ id, type: 'progress', done: rows.length, total: rows.length });
  // Everything is written in batches, then the state record last: only then is the rebuild real.
  const snap = engine.snapshotDirty();
  const puts = entityPuts(snap);
  await lab.putMany('cards', puts.cards, gen); await lab.putMany('notes', puts.notes, gen); await lab.putMany('shared', puts.shared, gen);
  await lab.putMany('preds', preds, gen);
  let ts = -Infinity, lid = -Infinity, hash = 0;
  for (const l of logs) { hash = (hash + rowHash(l.id, l.timestamp)) >>> 0; if (l.timestamp > ts || (l.timestamp === ts && l.id > lid)) { ts = l.timestamp; lid = l.id; } }
  state = { modelSha: sha, stateFormat: STATE_FORMAT, featureVersion: FEATURE_VERSION, rows: rows.length, lastTs: logs.length ? ts : 0,
    lastLogId: logs.length ? lid : 0, totalLogRows: logs.length, hash, rebuiltAt: Date.now(), rebuilding: false, fallbacks: before.fallbacks || 0 };
  await lab.commit({ meta: [['state', { ...state, builder: engine.builder.toJSON() }]] }, {}, gen);
  trim();
  return { rows: rows.length, cards: puts.cards.length, preds: preds.length };
}

// Is this log row newer than the bookmark? Rows at or before it were already handled (a rebuild or an earlier message read them).
const isLater = l => l.timestamp > state.lastTs || (l.timestamp === state.lastTs && l.id > state.lastLogId);
const bookmark = () => ({ totalLogRows: state.totalLogRows, hash: state.hash, lastTs: state.lastTs, lastLogId: state.lastLogId, rows: state.rows });
// The lab counts up by the rows it is given, so a row it was never told about (or one deleted behind its back) shows up as a mismatch.
function counted(l) { state.totalLogRows++; state.hash = (state.hash + rowHash(l.id, l.timestamp)) >>> 0; state.lastTs = l.timestamp; state.lastLogId = l.id; }

// New answers the lab missed (made while shadow mode was off, or before the worker saved): feed them in, without scoring.
async function catchup({ logs, cards, decks, fsrs }) {
  if (!state || state.rebuilding) throw new Error('The lab memory is not ready.');
  walk.setParams(fsrs);
  const later = logs.filter(isLater).sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
  const rows = new Map(modelRows(later, cards, decks).map(r => [r.logId, r]));
  for (const l of later) {
    const row = rows.get(l.id);
    if (row) { await loadFor(row); walk.step(row, l.state); engine.review(row, { score: false, keepToken: false }); state.rows++; engine.dirty.cards.add(row.cardKey); }
    counted(l);
  }
  await flush();
  return { rows: state.rows };
}

async function review({ log, card, decks, fsrs }) {
  if (!state || state.rebuilding) throw new Error('The lab memory is not ready.');
  if (!isLater(log)) return { skipped: 'handled' };         // already read (by a rebuild, or the catch-up that started this worker)
  walk.setParams(fsrs);
  const [row] = modelRows([log], [card], decks);
  const cursor = { logId: log.id, ts: log.timestamp, before: bookmark(), modelled: !!row, cardKey: row?.cardKey, walkBefore: null };
  if (!row) { cursors.push(cursor); counted(log); scheduleFlush(); return { skipped: 'not a memory event' }; }
  await loadFor(row);
  cursor.walkBefore = walk.cards.has(row.cardKey) ? structuredClone(walk.cards.get(row.cardKey)) : null;
  const scored = row.kind === 'train';
  const f = walk.step(row, log.state);
  const r = engine.review(row, { score: scored, keepToken: true });
  engine.dirty.cards.add(row.cardKey);
  cursors.push(cursor);
  if (cursors.length > 50) cursors.shift();
  counted(log); state.rows++;
  if (scored && Number.isFinite(r.pCurve) && Number.isFinite(r.pImm)) {
    pendingPreds.push({ logId: row.logId, cardId: row.cardKey.slice(2), t: row.t, y: row.rating > 1 ? 1 : 0, elapsedDays: r.elapsedDays,
      rwkvCurve: r.pCurve, rwkvImm: r.pImm, fsrsMine: f.mine, fsrsDefault: f.def, src: 'live' });
  }
  scheduleFlush();
  return { pCurve: r.pCurve, pImm: r.pImm };
}

// Take the newest answer back (a real undo, or a row deleted again: Play's "I was right"). Only the newest one can be rolled back exactly;
// false means the memory can't follow, and the page marks it out of date.
async function undo({ logId }) {
  const i = cursors.findIndex(c => c.logId === logId);
  if (i < 0 || i !== cursors.length - 1) return false;
  const c = cursors[i];
  if (c.modelled && !engine.undo(logId)) return false;
  cursors.pop();
  if (c.modelled) { if (c.walkBefore) walk.cards.set(c.cardKey, c.walkBefore); else walk.cards.delete(c.cardKey); }
  Object.assign(state, c.before);
  pendingPreds = pendingPreds.filter(p => p.logId !== logId);
  pendingDeletes.push(logId);
  scheduleFlush();
  return { ts: c.ts };                                       // (the page needs the row's time to keep its own count in step)
}

// What would each answer do to the card's forgetting curve, and how many days until the chance falls to `target`?
async function whatIf({ log, card, decks, ms, target, maxDays }) {
  if (!state || state.rebuilding || !engine.builder) return null;
  const [row] = modelRows([{ ...log, rating: 3 }], [card], decks);
  if (!row) return null;
  await loadFor(row);
  if (!engine.hasCard(row.cardKey) || !engine.cards.has(row.cardKey)) return null;     // the model has no memory of this card yet: FSRS schedules it
  const heads = engine.whatIf(row, ms);
  if (!heads) return null;                                  // not real numbers: FSRS schedules this card (the page counts it)
  const days = daysForButtons(heads, target, maxDays);
  if (![2, 3, 4].every(r => Number.isFinite(days[r]) && days[r] > 0)) return null;
  return { days, curves: Object.fromEntries(Object.entries(heads).map(([g, h]) => [g, { w: [...h.w], s: [...h.s], d: [...h.d] }])) };
}

const handlers = { init, rebuild, catchup, review, undo, whatIf, flush };
let queue = Promise.resolve();
// Everything the worker does (messages and the timed save) runs one after the other through here.
function enqueue(fn) { const p = queue.then(fn); queue = p.catch(() => {}); return p; }
self.onmessage = e => {
  const { id, type, ...rest } = e.data || {};
  enqueue(async () => {
    try {
      const fn = handlers[type];
      if (!fn) throw new Error('Unknown message.');
      post({ id, type: 'done', result: await fn(rest, id) });
    } catch (err) {
      post({ id, type: 'error', message: String(err?.message || err) });
    }
  });
};
