// Own model: the page's side. Loaded only by dynamic import, and only when the Own database exists, a model is loaded and the owner's
// switch is on (js/own-gate.js), or by the Settings screen. It starts the worker (or, where there are no workers, runs the same engine
// room on the page), turns answers into messages, and keeps the few facts Review needs (is Own scheduling right now?). No network.
//
// What Review, Practice and Play use:   begin()  afterAnswer()  afterUndo()  plan()  settled()  isPlanning()  markStale()  PLAN_MS
// What the Settings screen uses:        ownStatus()  ownSetOn(on)  ownCheckNow()  ownRebuild(onProgress)  ownDismissNotice()
//                                       ownModelChanged()  ownRemoveAll()      (loading a file is loadModelFile in own-load.js)
import { OwnCore } from './own-core.js';
import { modelRows, studyDay } from './own-rows.js';
import { removeModel } from './own-load.js';
import { resetOwnGate } from './own-gate.js';
import { PLAN_MS } from './own-plan.js';

export { PLAN_MS };
const TIMEOUT = { open: 20000, rebuild: 0, answer: 5000, undo: 5000, plan: 2000, check: 30000, status: 10000, setOn: 10000, flush: 10000, small: 5000 };
const MAX_TIMEOUTS = 3;              // this many calls in a row that the worker never answered: the worker is given up on (FSRS carries on)
const REBUILD_DELAY_MS = 3000;       // a memory that went out of date is rebuilt this long after, while the app is idle

// How many model rows there are and their ids added up: what the saved memory is compared with.
export const fingerprintOf = rows => { let idSum = 0; for (const r of rows) idSum += r.logId; return { rows: rows.length, idSum }; };

// The middle of the card's last five review times (milliseconds), 8 seconds when there are none to go by.
export function recentMs(logs) {
  const v = (logs || []).filter(l => l.source === 'review' && Number.isFinite(l.ms) && l.ms > 0).sort((a, b) => a.timestamp - b.timestamp).slice(-5).map(l => l.ms).sort((a, b) => a - b);
  if (!v.length) return 8000;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

const slimDecks = decks => (decks || []).map(d => ({ id: d.id, options: !!d.options }));
const slimCard = c => ({ id: c.id, deckId: c.deckId, noteId: c.noteId });
const slimLog = (l, id) => ({ id, cardId: l.cardId, timestamp: l.timestamp, source: l.source, applied: l.applied, rating: l.rating, ms: l.ms, state: l.state });

// ---------- two ways to reach the engine room ----------
class WorkerTransport {
  constructor(onFail) {
    this.pending = new Map(); this.nextId = 1; this.timeouts = 0; this.onFail = onFail;
    this.w = new Worker(new URL('./own-worker.js', import.meta.url), { type: 'module' });
    this.w.onmessage = e => {
      const m = e.data || {}, p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { p.onProgress && p.onProgress(m); return; }
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.type === 'done') { this.timeouts = 0; p.resolve(m.result); } else p.reject(new Error(m.message));
    };
    this.w.onerror = e => { if (e && e.preventDefault) e.preventDefault(); this.onFail(new Error((e && e.message) || 'The Own worker stopped.')); };
  }
  call(type, payload, timeoutMs, onProgress) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id); reject(new Error('The Own worker did not answer in time.'));
        if (++this.timeouts >= MAX_TIMEOUTS) this.onFail(new Error('The Own worker stopped answering.'));
      }, timeoutMs) : 0;
      this.pending.set(id, { resolve, reject, timer, onProgress });
      try { this.w.postMessage({ id, type, ...payload }); } catch (err) { this.pending.delete(id); clearTimeout(timer); reject(err); }
    });
  }
  stop() {
    try { this.w.terminate(); } catch { /* already gone */ }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The Own worker was stopped.')); }
    this.pending.clear();
  }
}
class LocalTransport {
  constructor(core) { this.core = core; }
  call(type, payload, timeoutMs, onProgress) {
    const run = this.core.handle(type, payload, onProgress);
    if (!timeoutMs) return run;
    let timer;
    return Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('The Own engine did not answer in time.')), timeoutMs); })]).finally(() => clearTimeout(timer));
  }
  stop() { return this.core.close().catch(() => {}); }
}

// Where the page reads the review log from (the main database). Only here, only reads.
const mainSource = {
  async read() {
    const d = await import('./db.js');
    const [logs, cards, decks] = await Promise.all([d.getAllInPieces('reviewLog'), d.getAll('cards'), d.getAll('decks')]);
    return { logs, cards, decks };
  },
  async cardLogs(id) { return (await import('./db.js')).getCardLogs(id); }
};

export class OwnClient {
  // opts: { makeTransport(onFail) -> transport (tests), source ({ read, cardLogs }), idb, now }
  constructor({ makeTransport, source = mainSource, idb, now = Date.now } = {}) {
    this.makeTransport = makeTransport; this.source = source; this.idb = idb; this.now = now;
    this.t = null; this.local = null;
    this.failed = false; this.ready = false; this.starting = false;
    this.scheduler = 'fsrs'; this.noticePending = null;
    this.rebuilding = false; this.rebuildPending = false; this.rebuildAgain = false;
    this.beginP = null; this.beginDay = null;
    this._chain = Promise.resolve();
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && this.t && !this.failed) this.t.call('flush', {}, TIMEOUT.flush).catch(() => {}); });
    }
  }

  // ---- the transport ----
  _transport() {
    if (this.t) return this.t;
    const onFail = err => this._fail(err);
    if (this.makeTransport) this.t = this.makeTransport(onFail);
    else {
      try { this.t = typeof Worker !== 'undefined' ? new WorkerTransport(onFail) : new LocalTransport(new OwnCore({ idb: this.idb, now: this.now })); }
      catch { this.t = new LocalTransport(new OwnCore({ idb: this.idb, now: this.now })); }      // workers are blocked: the same engine room on the page
    }
    return this.t;
  }
  // The worker crashed or stopped answering: FSRS carries on, and each plan asked for from now on counts as a failed plan.
  _fail(err) {
    console.warn('Own model stopped:', (err && err.message) || err);
    this.failed = true; this.ready = false; this.beginP = null;
    if (this.t) { try { this.t.stop(); } catch { /* gone */ } this.t = null; }
  }
  call(type, payload = {}, timeoutMs = 0, onProgress = null) {
    return this._transport().call(type, payload, timeoutMs, onProgress);
  }
  // Counting needs no engine: when the worker is gone, the plain database work is done on the page.
  _counter() {
    if (!this.failed) return this._transport();
    return (this.local ||= new LocalTransport(new OwnCore({ idb: this.idb, now: this.now })));
  }

  // ---- starting a session ----
  isPlanning() { return this.scheduler === 'own'; }

  // Called when a review or practice session starts (and before any answer is handed over). Resolves true when Own is switched on and
  // ready to follow answers. Safe to call again: the memory is only loaded once, and the daily check runs once per study day.
  begin() {
    const today = studyDay(this.now());
    if (this.failed) { this.failed = false; this.ready = false; this.beginP = null; }        // a new session tries the worker again
    if (this.beginP) {
      if (this.beginDay !== today && this.ready) {       // the app stayed open past the start of a new study day: its daily check is due
        this.beginDay = today;
        this.beginP = this.beginP.then(async ok => { if (ok) await this._check().catch(() => {}); return ok; });
      }
      return this.beginP;
    }
    this.beginDay = today;
    this.starting = true;
    return (this.beginP = this._begin().finally(() => { this.starting = false; }));
  }
  async _begin() {
    try {
      const o = await this.call('open', {}, TIMEOUT.open);
      if (!o.loaded || !o.on) { this.beginP = null; return false; }
      let rows = await this._rows();
      const r = await this.call('open', { fp: fingerprintOf(rows) }, TIMEOUT.open);
      if (!r.fresh) await this._rebuildWith(rows);
      rows = null;
      this.ready = true;
      await this._check().catch(err => console.warn('Own model:', (err && err.message) || err));
      return true;
    } catch (err) {
      console.warn('Own model:', (err && err.message) || err);
      this.beginP = null; this.ready = false;
      return false;
    }
  }
  async _rows() { const { logs, cards, decks } = await this.source.read(); return modelRows(logs, cards, decks); }
  async _check(force = false) {
    const c = await this.call('check', { force }, TIMEOUT.check);
    this._learn(c);
    return c;
  }
  _learn(c) {
    if (!c) return;
    if (c.scheduler) this.scheduler = c.scheduler;
    if ('noticePending' in c) this.noticePending = c.noticePending;
  }

  // ---- rebuilding ----
  async _rebuildWith(rows, onProgress) {
    const was = this.rebuilding;
    this.rebuilding = true; this.rebuildPending = false;
    try { return await this.call('rebuild', { rows }, TIMEOUT.rebuild, onProgress); }
    finally { this.rebuilding = was; }
  }
  // Replays the whole review log into a new memory. onProgress({ done, total }). A review that arrives by sync meanwhile starts it again.
  async rebuild(onProgress) {
    if (this.rebuilding) { this.rebuildAgain = true; return null; }
    this.rebuilding = true;
    try {
      const o = await this.call('open', {}, TIMEOUT.open);
      if (!o.loaded) return null;
      let result = null;
      do {
        this.rebuildAgain = false;
        const rows = await this._rows();
        result = await this._rebuildWith(rows, onProgress);
      } while (this.rebuildAgain);
      this.ready = true;
      return result;
    } finally { this.rebuilding = false; }
  }
  // A review came in by sync (or the memory is otherwise out of date): no plans and no records until it is rebuilt, in the background.
  async markStale() {
    this.rebuildPending = true; this.ready = false;
    if (this.rebuilding) { this.rebuildAgain = true; return; }
    try { await this.call('stale', {}, TIMEOUT.small); } catch { /* the next start rebuilds */ }
    setTimeout(() => { this.rebuild().catch(err => console.warn('Own model:', (err && err.message) || err)); }, REBUILD_DELAY_MS);
  }

  // ---- hooks (fire and forget: they never throw and FSRS never waits for them) ----
  // a: { logId, log, card, decks, pFsrs, fsrsKind, memoryOnly }. pFsrs must be worked out before FSRS rated the card.
  afterAnswer(a) { return (this._chain = this._chain.then(() => this._answer(a))); }
  afterUndo(logId) { return (this._chain = this._chain.then(() => this._undo(logId))); }
  async _answer({ logId, log, card, decks = [], pFsrs = null, fsrsKind = 6, memoryOnly = false }) {
    try {
      if (this.beginP) await this.beginP; else if (!(await this.begin())) return;
      if (this.rebuilding || this.rebuildPending) this.rebuildAgain = true;        // the rebuild may have read the log before this answer
      if (this.failed || !this.ready) return;
      await this.call('answer', { log: slimLog(log, logId), card: card ? slimCard(card) : null, decks: slimDecks(decks), pFsrs, fsrsKind, memoryOnly }, TIMEOUT.answer);
    } catch (err) { console.warn('Own model:', (err && err.message) || err); }
  }
  async _undo(logId) {
    try {
      if (this.beginP) await this.beginP;
      if (this.failed || !this.ready) return;
      const r = await this.call('undo', { logId }, TIMEOUT.undo);
      if (r && r.stale) this.markStale();
    } catch (err) { console.warn('Own model:', (err && err.message) || err); }
  }

  // ---- plans ----
  // The days until the card should come back after Hard, Good and Easy, worked out before the card is turned over (review.js freezes it).
  // -> { cardId, lastReview, at, days: { 2, 3, 4 }, modelSha }, or { skip: true } (the memory is starting up or being rebuilt: not counted
  // as a failed plan), or null (a failed plan: FSRS schedules the card). Never throws. Give the result to settled().
  async plan({ card, state, now = Date.now(), opts, decks = [] }) {
    try {
      if (this.failed) return null;
      if (this.starting || this.rebuilding || this.rebuildPending) return { skip: true };
      if (!this.ready || !state || state.state !== 2 || !(opts && opts.maxInterval > 0) || !(opts.retention > 0)) return null;
      await this._chain;                                         // the last answer and undo must have reached the engine first
      const ms = recentMs(await this.source.cardLogs(card.id));
      const r = await this.call('plan', { card: slimCard(card), decks: slimDecks(decks), now, ms, target: opts.retention, maxDays: opts.maxInterval }, TIMEOUT.plan);
      if (r && r.days) return { cardId: card.id, lastReview: state.lastReview ?? null, at: now, days: r.days, modelSha: r.modelSha };
      if (r && r.skip) return { skip: true };
      return null;
    } catch (err) { console.warn('Own model:', (err && err.message) || err); return null; }
  }
  // What came of a plan the page asked for. Counts it (a failed plan counts against the 5% rule) and returns the plan to use, or null for FSRS.
  settled(plan) {
    if (plan && plan.skip) return null;
    const ok = !!plan;
    this._counter().call('notePlan', { ok }, TIMEOUT.small).then(r => this._learn(r)).catch(() => {});
    return ok ? plan : null;
  }

  // ---- for the Settings screen ----
  async status() {
    const s = await this._counter().call('status', {}, TIMEOUT.status);
    this._learn(s);
    return { ...s, building: this.rebuilding, rebuildPending: this.rebuildPending, workerFailed: this.failed };
  }
  async setOn(on) {
    const r = await this._counter().call('setOn', { on: !!on }, TIMEOUT.setOn);
    this._learn(r);
    if (r && r.ok) {
      this.scheduler = 'fsrs'; this.ready = false; this.beginP = null;
      resetOwnGate();
      if (on) this.begin();                                      // builds the memory in the background
    }
    return r;
  }
  async checkNow() {
    await this.begin();
    return this._check(true);
  }
  dismissNotice() { this.noticePending = null; return this._counter().call('dismissNotice', {}, TIMEOUT.small); }
  // A model file was loaded or replaced: forget everything held in memory (the memory is rebuilt for the new model).
  modelChanged() {
    if (this.t) { try { this.t.stop(); } catch { /* gone */ } this.t = null; }
    this.failed = false; this.ready = false; this.beginP = null; this.scheduler = 'fsrs'; this.noticePending = null;
    resetOwnGate();
  }
  // Deletes the model and everything Own saved. Cards, reviews and due dates are not touched.
  async removeAll() {
    if (this.t) { try { this.t.stop(); } catch { /* gone */ } this.t = null; }
    this.local = null; this.failed = false; this.ready = false; this.beginP = null; this.scheduler = 'fsrs'; this.noticePending = null;
    resetOwnGate();
    return removeModel({ idb: this.idb });
  }
}

let single = null;
export const getOwn = () => (single ||= new OwnClient());
export const begin = () => getOwn().begin();
export const afterAnswer = a => getOwn().afterAnswer(a);
export const afterUndo = logId => getOwn().afterUndo(logId);
export const plan = a => getOwn().plan(a);
export const settled = p => getOwn().settled(p);
export const isPlanning = () => getOwn().isPlanning();
export const markStale = () => getOwn().markStale();
export const ownStatus = () => getOwn().status();
export const ownSetOn = on => getOwn().setOn(on);
export const ownCheckNow = () => getOwn().checkNow();
export const ownRebuild = onProgress => getOwn().rebuild(onProgress);
export const ownDismissNotice = () => getOwn().dismissNotice();
export const ownModelChanged = () => getOwn().modelChanged();
export const ownRemoveAll = () => getOwn().removeAll();
