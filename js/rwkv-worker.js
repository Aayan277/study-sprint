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
import { initState, nextState, forgettingCurve } from './fsrs-fit.js';
import { deltaDays } from './fsrs-data.js';

const CACHE_CARDS = 2000;           // card and note states kept in memory beyond what is being worked on
const SAVE_DELAY_MS = 1000;
const PROGRESS_MS = 100;
const STREAM_OF = { d: 1, p: 3, u: 4 };

let tensors = null, sha = null, engine = null;
let state = null;                    // the saved 'state' record (without the builder, which lives in the engine)
let saveTimer = 0;
const cursors = [];                  // for undo: { logId, before } (the bookmark before each live review)
let pendingPreds = [], pendingDeletes = [];

const post = (msg) => self.postMessage(msg);

// ---------- loading ----------
async function init() {
  const rec = await lab.get('weights', 'current');
  if (!rec) throw new Error('No weights file has been chosen.');
  const parsed = parseWeights(rec.bytes);
  const check = validateWeights(parsed.tensors);
  if (!check.ok) throw new Error(check.errors[0]);
  tensors = parsed.tensors; sha = rec.sha256;
  state = (await lab.get('meta', 'state')) || null;
  engine = new Engine(tensors);
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
    if (rec) { engine.cards.set(row.cardKey, rec.buf); if (rec.curve) engine.curves.set(row.cardKey, rec.curve); }
  }
  if (!engine.notes.has(row.noteKey)) {
    const rec = await lab.get('notes', row.noteKey);
    if (rec) engine.notes.set(row.noteKey, rec.buf);
  }
}

function trim() {
  for (const [map, curves] of [[engine.cards, engine.curves], [engine.notes, null]]) {
    while (map.size > CACHE_CARDS) {
      const k = map.keys().next().value;
      map.delete(k); curves?.delete(k);
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
    cards: snap.cards.map(([k, buf, curve]) => [k, { buf, curve, t: cardT(k) }]),
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
  await lab.commit(puts, deletes);
  trim();
  return { saved: true };
}
function scheduleFlush() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = 0; flush().catch(err => post({ type: 'error', id: 0, message: String(err?.message || err) })); }, SAVE_DELAY_MS); }

// ---------- FSRS-6 predictions for past reviews ----------
// Walks each card's rows the way the optimizer does (a card must start at "new"; a reset starts again) and gives, for every real
// review a day or more after the card's last answer, the chance FSRS-6 would have given it with `w` (yours) and with the defaults.
class FsrsWalk {
  constructor(fsrs) { this.fsrs = fsrs && fsrs.wDefault ? fsrs : null; this.cards = new Map(); }
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
  const walk = new FsrsWalk(fsrs);
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
  await lab.putMany('cards', puts.cards); await lab.putMany('notes', puts.notes); await lab.putMany('shared', puts.shared);
  await lab.putMany('preds', preds);
  let ts = -Infinity, lid = -Infinity;
  for (const l of logs) if (l.timestamp > ts || (l.timestamp === ts && l.id > lid)) { ts = l.timestamp; lid = l.id; }
  state = { modelSha: sha, stateFormat: STATE_FORMAT, featureVersion: FEATURE_VERSION, rows: rows.length, lastTs: logs.length ? ts : 0,
    lastLogId: logs.length ? lid : 0, totalLogRows: logs.length, rebuiltAt: Date.now(), rebuilding: false, fallbacks: before.fallbacks || 0 };
  await lab.put('meta', { ...state, builder: engine.builder.toJSON() }, 'state');
  trim();
  return { rows: rows.length, cards: puts.cards.length, preds: preds.length };
}

// New answers the lab missed (made while shadow mode was off, or before the worker saved): feed them in, without scoring.
async function catchup({ logs, cards, decks, count, newest }) {
  for (const row of modelRows(logs, cards, decks)) {
    await loadFor(row);
    engine.review(row, { score: false, keepToken: false });
    state.rows++;
  }
  state.totalLogRows = count; state.lastTs = newest.timestamp; state.lastLogId = newest.id;
  await flush();
  return { rows: state.rows };
}

async function review({ log, card, decks, fsrsMine, fsrsDefault, count }) {
  if (!state || state.rebuilding) throw new Error('The lab memory is not ready.');
  const [row] = modelRows([log], [card], decks);
  if (!row) return { skipped: true };
  await loadFor(row);
  const scored = row.kind === 'train';
  const r = engine.review(row, { score: scored, keepToken: true });
  cursors.push({ logId: row.logId, before: { totalLogRows: state.totalLogRows, lastTs: state.lastTs, lastLogId: state.lastLogId, rows: state.rows } });
  if (cursors.length > 50) cursors.shift();
  state.rows++; state.totalLogRows = count; state.lastTs = Math.max(state.lastTs, row.t); state.lastLogId = row.logId;
  if (scored && Number.isFinite(r.pCurve) && Number.isFinite(r.pImm)) {
    pendingPreds.push({ logId: row.logId, cardId: row.cardKey.slice(2), t: row.t, y: row.rating > 1 ? 1 : 0, elapsedDays: r.elapsedDays,
      rwkvCurve: r.pCurve, rwkvImm: r.pImm, fsrsMine: fsrsMine ?? null, fsrsDefault: fsrsDefault ?? null, src: 'live' });
  }
  scheduleFlush();
  return { pCurve: r.pCurve, pImm: r.pImm };
}

async function undo({ logId }) {
  const i = cursors.findIndex(c => c.logId === logId);
  if (i < 0 || i !== cursors.length - 1 || !engine.undo(logId)) return false;
  Object.assign(state, cursors.pop().before);
  pendingPreds = pendingPreds.filter(p => p.logId !== logId);
  pendingDeletes.push(logId);
  scheduleFlush();
  return true;
}

// What would each answer do to the card's forgetting curve, and how many days until the chance falls to `target`?
async function whatIf({ log, card, decks, ms, target, maxDays }) {
  const [row] = modelRows([{ ...log, rating: 3 }], [card], decks);
  if (!row) return null;
  await loadFor(row);
  const heads = engine.whatIf(row, ms);
  if (!heads) { state.fallbacks = (state.fallbacks || 0) + 1; scheduleFlush(); return null; }       // not real numbers: FSRS schedules this card
  const days = daysForButtons(heads, target, maxDays);
  return { days, curves: Object.fromEntries(Object.entries(heads).map(([g, h]) => [g, { w: [...h.w], s: [...h.s], d: [...h.d] }])) };
}

const handlers = { init, rebuild, catchup, review, undo, whatIf, flush };
let queue = Promise.resolve();
self.onmessage = e => {
  const { id, type, ...rest } = e.data || {};
  queue = queue.then(async () => {
    try {
      const fn = handlers[type];
      if (!fn) throw new Error('Unknown message.');
      post({ id, type: 'done', result: await fn(rest, id) });
    } catch (err) {
      post({ id, type: 'error', message: String(err?.message || err) });
    }
  });
};
