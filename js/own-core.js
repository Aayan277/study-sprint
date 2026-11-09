// Own model: the engine room. It runs in a Web Worker (js/own-worker.js) or, when workers are missing, on the page itself
// (js/own-shadow.js). It owns the memory engine and the Own database. The page talks to it with plain messages: handle(type, payload).
// No DOM, no network. Everything it does is in one queue, so answers, undos, plans and rebuilds never overlap.
//
//   open { fp }            load the model and the saved memory; fresh when the saved memory matches the review log's fingerprint
//   rebuild { rows }       replay every model row into a new memory (progress messages), save it
//   answer { ... }         a real answer happened: update the memory, and (real reviews of Review cards only) store a shadow record
//   undo { logId }         take an answer back
//   plan { ... }           the days Hard, Good and Easy would give, worked out before the card is turned
//   status / check / setOn / notePlan / dismissNotice / flush / stale / close
// Shadow record lifecycle (store 'preds'): the two numbers are fixed from the state before the answer (pOwn comes from the engine's
// prediction, which never sees the rating; pFsrs is handed in by the caller, worked out before FSRS rated the card). The record is written
// with y = null first, and y (1 remembered, 0 forgot) is filled in afterwards. Undo removes it. Reviews that arrive by sync, import or
// restore never get a record: they only change the memory (through a rebuild).
import { Engine } from './own-engine.js';
import { OwnFeatures, modelRows } from './own-features.js';
import { studyDay } from './own-rows.js';
import { getLoadedModel } from './own-load.js';
import { openOwnDb } from './own-db.js';
import { OWN_FEATURE_VERSION, OWN_STATE_FORMAT, DEFAULT_SIZE } from './own-spec.js';
import { liveVerdict, exitCheck, recordCheck, nextScheduler, newState, checkDue, MIN_SCORED } from './own-verdict.js';
import { OWN_MAX_DAYS } from './own-plan.js';

const SAVE_EVERY = 20;            // answers between saves of the memory
const SAVE_IDLE_MS = 2000;        // ... or this long after the last answer
const CHUNK = 5000;               // entries per database transaction when saving a whole memory
const tick = () => new Promise(r => setTimeout(r, 0));
const DEFAULT_SETTINGS = { on: false, autoLocked: false };

export class OwnCore {
  constructor({ idb, now = Date.now } = {}) {
    this.idb = idb; this.now = now;
    this.h = null; this.model = null;            // database handle; { name, sha256, header, params }
    this.engine = null; this.ids = new Set();     // the memory; ids of the log rows it contains
    this.fp = null;                              // { rows, idSum, scored, sha } of what the memory contains
    this.status = 'none';                        // 'none' | 'fresh' | 'stale' | 'rebuilding' | 'error'
    this.seen = new Map();                       // logId -> { scored } (made a model row) | null (did not): for undo
    this.settings = { ...DEFAULT_SETTINGS }; this.state = null;
    this.unsaved = 0; this.saveTimer = 0; this.gone = false;
    this._q = Promise.resolve();
  }

  // ---------- the queue ----------
  handle(type, payload = {}, onProgress = () => {}) {
    if (type === 'plan' && (this.status === 'rebuilding')) return Promise.resolve({ skip: 'rebuilding' }); // never wait behind a rebuild
    const run = () => this._dispatch(type, payload, onProgress || (() => {}));
    const p = this._q.then(run, run);
    this._q = p.catch(() => {});
    return p;
  }
  _dispatch(type, p, onProgress) {
    switch (type) {
      case 'open': return this.open(p);
      case 'rebuild': return this.rebuild(p, onProgress);
      case 'answer': return this.answer(p);
      case 'undo': return this.undo(p);
      case 'plan': return this.plan(p);
      case 'status': return this.getStatus();
      case 'check': return this.check(p);
      case 'setOn': return this.setOn(p);
      case 'notePlan': return this.notePlan(p);
      case 'dismissNotice': return this.dismissNotice();
      case 'stale': return this.markStale();
      case 'flush': return this.flush();
      case 'close': return this.close();
      default: throw new Error('Unknown message: ' + type);
    }
  }

  // ---------- the database ----------
  async _db() {
    if (this.h) return this.h;
    const h = await openOwnDb({ idb: this.idb, forbidCreate: true });
    if (!h) { this.gone = true; throw new Error('There is no Own database.'); }
    this.h = h; this.gone = false;
    return h;
  }
  async _do(fn) {
    try { return await fn(await this._db()); } catch (err) {
      if (this.gone) throw err;
      if (this.h) { this.h.close(); this.h = null; }          // the connection may have been closed by another tab: try once more
      return fn(await this._db());
    }
  }
  async close() {
    clearTimeout(this.saveTimer);
    if (this.h) { this.h.close(); this.h = null; }
    this.engine = null; this.status = 'none';
    return { ok: true };
  }

  // ---------- settings and state ----------
  async _loadMeta() {
    const [s, st] = await this._do(h => Promise.all([h.get('meta', 'settings'), h.get('meta', 'state')]));
    this.settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
    this.state = st ? { verdicts: [], verdict: null, noticePending: null, fallbacks: 0, errors: 0, plans: { day: null, total: 0, failed: 0 }, ...st } : null;
  }
  async _saveState() { if (this.state) await this._do(h => h.put('meta', 'state', this.state)); }
  async _saveSettings() { await this._do(h => h.put('meta', 'settings', this.settings)); }
  _today() { return studyDay(this.now()); }
  _freshState(today) {
    return { ...newState(today), watchT: this.now(), watchDay: today, sinceT: this.now(), verdicts: [], verdict: null, noticePending: null,
      fallbacks: 0, errors: 0, plans: { day: today, total: 0, failed: 0 } };
  }

  // ---------- opening ----------
  // payload: { fp: { rows, idSum } } the fingerprint of the model rows in the review log right now (null: do not load the memory)
  // -> { ok, loaded, on, fresh, status }
  async open({ fp = null } = {}) {
    let m;
    try { m = await getLoadedModel({ idb: this.idb }); } catch { m = { ok: false }; }
    if (!m.ok || !m.loaded) { this.status = 'none'; this.model = null; return { ok: m.ok, loaded: false, on: false, fresh: false, status: 'none', message: m.message || null }; }
    this.model = { name: m.name, sha256: m.sha256, header: m.header, params: m.params };
    await this._loadMeta();
    if (!this.state) { this.state = this._freshState(this._today()); await this._saveState(); }
    if (!fp) return { ok: true, loaded: true, on: this.settings.on, fresh: false, status: this.status };
    if (this.status === 'fresh' && this.engine && this.fp && this.fp.rows === fp.rows && this.fp.idSum === fp.idSum && this.fp.sha === m.sha256) {
      return { ok: true, loaded: true, on: this.settings.on, fresh: true, status: 'fresh' };      // already loaded in this worker
    }
    try {
      const saved = await this._do(h => h.get('meta', 'fingerprint'));
      const builder = saved && await this._do(h => h.get('meta', 'builder'));
      if (!saved || !builder || saved.sha !== m.sha256 || saved.rows !== fp.rows || saved.idSum !== fp.idSum
        || saved.format !== OWN_STATE_FORMAT || saved.featureVersion !== OWN_FEATURE_VERSION) { this.engine = null; this.status = 'stale'; return { ok: true, loaded: true, on: this.settings.on, fresh: false, status: 'stale' }; }
      const e = new Engine(m.params, { size: m.header.size || DEFAULT_SIZE });
      e.builder = OwnFeatures.fromJSON(builder);
      const [cards, notes, shared] = await this._do(h => Promise.all([h.getEntries('cards'), h.getEntries('notes'), h.getEntries('shared')]));
      for (const [k, v] of cards) { e.cards.set(k, v.state); if (v.curve) e.curves.set(k, v.curve); }
      for (const [k, v] of notes) e.notes.set(k, v);
      for (const [k, v] of shared) e.shared.set(k, v);
      this.engine = e; this.fp = { rows: saved.rows, idSum: saved.idSum, scored: saved.scored, sha: saved.sha };
      this.ids = new Set();      // (ids of the rows are not kept on disk: a repeated answer is told apart by the fingerprint instead)
      this.idsKnown = false;
      this.status = 'fresh';
      return { ok: true, loaded: true, on: this.settings.on, fresh: true, status: 'fresh' };
    } catch (err) {
      this.engine = null; this.status = 'stale'; await this._bump('errors');
      return { ok: true, loaded: true, on: this.settings.on, fresh: false, status: 'stale', message: String(err && err.message || err) };
    }
  }

  // ---------- rebuilding ----------
  // payload: { rows } model rows in time order (from modelRows). Progress: onProgress({ done, total }).
  async rebuild({ rows }, onProgress = () => {}) {
    if (!this.model) { const o = await this.open({}); if (!o.loaded) throw new Error('No model is loaded.'); }
    this.status = 'rebuilding';
    clearTimeout(this.saveTimer);
    try {
      const e = new Engine(this.model.params, { size: this.model.header.size || DEFAULT_SIZE });
      const ids = new Set(); let idSum = 0, scored = 0;
      for (let n = 0; n < rows.length; n++) {
        const row = rows[n], c = e.builder.cards.get(row.cardKey);
        const train = row.kind === 'train', gap = c ? row.day - c.prevDay : null;
        const r = e.review(row, { score: train, keepToken: false });
        if (train && gap !== null && gap >= 1 && r.pCurve !== null) scored++;
        ids.add(row.logId); idSum += row.logId;
        if ((n + 1) % 500 === 0) { onProgress({ done: n + 1, total: rows.length }); await tick(); }
      }
      onProgress({ done: rows.length, total: rows.length });
      this.engine = e; this.ids = ids; this.idsKnown = true;
      this.fp = { rows: rows.length, idSum, scored, sha: this.model.sha256 };
      await this._saveAll();
      this.status = 'fresh'; this.unsaved = 0;
      return { ok: true, rows: rows.length, scored };
    } catch (err) {
      this.engine = null; this.status = 'error'; await this._bump('errors').catch(() => {});
      throw err;
    }
  }

  // The whole memory (after a rebuild): clear the three stores, write everything.
  async _saveAll() {
    const e = this.engine;
    await this._do(h => Promise.all(['cards', 'notes', 'shared'].map(s => h.clear(s))));
    e.dirty = { cards: new Set(e.cards.keys()), notes: new Set(e.notes.keys()), shared: new Set(e.shared.keys()) };
    await this._writeSnapshot(e.snapshotDirty());
  }
  async _writeSnapshot(snap) {
    const chunks = (list, store, mk) => {
      const out = [];
      for (let i = 0; i < list.length; i += CHUNK) out.push(this._do(h => h.putEntries(store, list.slice(i, i + CHUNK).map(mk))));
      return out;
    };
    await Promise.all([
      ...chunks(snap.cards, 'cards', ([k, v, curve]) => [k, { state: v, curve }]),
      ...chunks(snap.notes, 'notes', x => x), ...chunks(snap.shared, 'shared', x => x)
    ]);
    const gone = [['cards', snap.removed.cards], ['notes', snap.removed.notes], ['shared', snap.removed.shared]].filter(([, ks]) => ks.length);
    for (const [store, ks] of gone) await this._do(h => h.deleteKeys(store, ks));
    await this._do(async h => {
      await h.put('meta', 'builder', snap.builder);
      await h.put('meta', 'fingerprint', { ...this.fp, format: OWN_STATE_FORMAT, featureVersion: OWN_FEATURE_VERSION });
    });
  }
  async flush() {
    clearTimeout(this.saveTimer); this.saveTimer = 0;
    if (!this.engine || this.status !== 'fresh' || !this.unsaved) return { ok: true, saved: 0 };
    const n = this.unsaved; this.unsaved = 0;
    await this._writeSnapshot(this.engine.snapshotDirty());
    return { ok: true, saved: n };
  }
  _afterChange() {
    if (++this.unsaved >= SAVE_EVERY) { this.flush().catch(() => {}); return; }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.flush().catch(() => {}); }, SAVE_IDLE_MS);
    if (this.saveTimer && this.saveTimer.unref) this.saveTimer.unref();
  }

  // The memory no longer matches the review log (a review came in by sync, import or restore, or an undo could not be done).
  async markStale() {
    if (this.status === 'rebuilding') return { ok: true };
    this.status = 'stale'; this.engine = null; clearTimeout(this.saveTimer);
    try { await this._do(h => h.delete('meta', 'fingerprint')); } catch { /* a missing fingerprint only makes the next open rebuild */ }
    return { ok: true };
  }

  // ---------- answers ----------
  // payload: { log: { id, cardId, timestamp, source, applied, rating, ms, state }, card: { id, deckId, noteId }, decks: [{ id, options }],
  //            pFsrs, fsrsKind (6 | 7), memoryOnly }
  // -> { row: bool, record: bool }
  async answer({ log, card, decks = [], pFsrs = null, fsrsKind = 6, memoryOnly = false }) {
    const rows = modelRows([log], card ? [card] : [], decks);
    if (!rows.length) { this._see(log.id, null); return { row: false, record: false }; }        // only logged (Play): no memory change
    const row = rows[0];
    if (this.status !== 'fresh' || !this.engine) { this._see(log.id, { scored: false }); return { row: true, record: false, skipped: this.status }; }
    if (this.idsKnown && this.ids.has(row.logId)) return { row: true, record: false, skipped: 'known' };     // the rebuild already had it
    const e = this.engine, c = e.builder.cards.get(row.cardKey);
    const train = row.kind === 'train', gap = c ? row.day - c.prevDay : null, scoredNow = train && gap !== null && gap >= 1;
    const wantRecord = !memoryOnly && this.settings.on && log.source === 'review' && train && log.state === 2 && scoredNow
      && Number.isFinite(pFsrs) && pFsrs > 0 && pFsrs <= 1;
    const r = e.review(row, { score: scoredNow, keepToken: true });    // r.pCurve: Own's chance of remembering, from the state before this answer
    const counted = scoredNow && r.pCurve !== null;
    this.ids.add(row.logId); this._see(log.id, { scored: counted });
    this.fp = { ...this.fp, rows: this.fp.rows + 1, idSum: this.fp.idSum + row.logId, scored: this.fp.scored + (counted ? 1 : 0) };
    let record = false;
    if (wantRecord && r.pCurve !== null && Number.isFinite(r.pCurve)) {
      const rec = { logId: row.logId, cardId: log.cardId, t: row.t, day: row.day, elapsedDays: r.elapsedDays, pOwn: r.pCurve, pFsrs, y: null,
        sched: this.state && this.state.scheduler === 'own' ? 'own' : 'fsrs', fsrsKind: fsrsKind === 7 ? 7 : 6, modelSha: this.model.sha256, tuneId: null };
      await this._do(h => h.put('preds', null, rec));                          // 1. the two numbers, y not known yet
      await this._do(h => h.put('preds', null, { ...rec, y: row.rating > 1 ? 1 : 0 }));       // 2. y filled in
      record = true;
    }
    this._afterChange();
    return { row: true, record };
  }
  _see(id, made) { this.seen.set(id, made); if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value); }

  async undo({ logId }) {
    const made = this.seen.get(logId);
    if (made === null) return { ok: true, undone: false };           // it never reached the memory
    try { await this._do(h => h.delete('preds', logId)); } catch { /* no record */ }
    if (this.status !== 'fresh' || !this.engine) return { ok: true, undone: false };
    const entry = this.engine.undos.find(t => t.logId === logId);
    if (entry && this.engine.undo(logId)) {
      this.ids.delete(logId);
      this.fp = { ...this.fp, rows: this.fp.rows - 1, idSum: this.fp.idSum - logId, scored: Math.max(0, this.fp.scored - (made && made.scored ? 1 : 0)) };
      this._afterChange();
      return { ok: true, undone: true };
    }
    await this.markStale();                                            // cannot be rolled back exactly: the memory is rebuilt
    return { ok: true, undone: false, stale: true };
  }

  // ---------- plans ----------
  // payload: { card, decks, now, ms, target, maxDays } -> { days: { 2, 3, 4 }, modelSha } | { skip } | { fail }
  async plan({ card, decks = [], now, ms, target, maxDays }) {
    if (!this.engine || this.status !== 'fresh') return this.status === 'stale' ? { fail: 'stale' } : { skip: this.status };
    try {
      const rows = modelRows([{ id: -1, cardId: card.id, timestamp: now, source: 'review', rating: 3, ms }], [card], decks);
      if (!rows.length || !this.engine.hasCard(rows[0].cardKey)) return { fail: 'unknown-card' };
      const days = this.engine.daysForButtons(rows[0], ms, target, Math.min(maxDays, OWN_MAX_DAYS));
      if (!days || ![2, 3, 4].every(g => Number.isFinite(days[g]) && days[g] > 0)) return { fail: 'bad-numbers' };
      return { days: { 2: days[2], 3: days[3], 4: days[4] }, modelSha: this.model.sha256 };
    } catch (err) {
      await this._bump('errors').catch(() => {});
      return { fail: 'error', message: String(err && err.message || err) };
    }
  }

  async _bump(field) { if (this.state) { this.state[field] = (this.state[field] || 0) + 1; await this._saveState(); } }

  // The page reports what happened to a plan it asked for: ok true (used), false (a failed plan: FSRS scheduled the card).
  // The day's counts feed the error rule (more than 5% of at least 20 plans: back to FSRS at once).
  async notePlan({ ok }) {
    if (!this.state) await this._loadMeta();
    if (!this.state) return { ok: false };
    const today = this._today(), p = this.state.plans && this.state.plans.day === today ? this.state.plans : { day: today, total: 0, failed: 0 };
    this.state.plans = { day: today, total: p.total + 1, failed: p.failed + (ok ? 0 : 1) };
    if (!ok) this.state.fallbacks = (this.state.fallbacks || 0) + 1;
    let switched = null;
    if (!ok && this.state.scheduler === 'own') switched = this._applySwitch(nextScheduler(this.state, { on: this.settings.on, plans: this.state.plans }, today));
    await this._saveState();
    return { ok: true, switched, scheduler: this.state.scheduler, plans: this.state.plans };
  }

  _applySwitch(r) {
    if (!r.switched) { this.state = { ...this.state, ...r.state }; return null; }
    this.state = { ...r.state, sinceT: this.now(), noticePending: r.why === 'off' ? null : r.state.switches.length };
    if (this.state.autoLocked !== this.settings.autoLocked) { this.settings = { ...this.settings, autoLocked: this.state.autoLocked }; this._saveSettings().catch(() => {}); }
    return { to: r.scheduler, why: r.why };
  }

  // ---------- the owner's switch, the daily check ----------
  async setOn({ on }) {
    if (!this.model) { const o = await this.open({}); if (!o.loaded) return { ok: false, message: 'Load a model file first.' }; }
    const today = this._today();
    if (!this.state) await this._loadMeta();
    if (on) {
      this.settings = { ...this.settings, on: true, autoLocked: false };
      this.state = this._freshState(today);                           // a fresh start every time it is turned on
    } else {
      const r = nextScheduler(this.state, { on: false }, today);
      this._applySwitch(r);
      this.settings = { ...this.settings, on: false };
      if (!r.switched) this.state = { ...this.state, scheduler: 'fsrs' };
    }
    await this._saveSettings(); await this._saveState();
    return { ok: true, on: this.settings.on, scheduler: this.state.scheduler };
  }

  async _records() {
    const all = await this._do(h => h.getAll('preds'));
    const sha = this.model && this.model.sha256, since = this.state ? this.state.watchT || 0 : 0;
    return all.filter(r => (r.y === 0 || r.y === 1) && r.modelSha === sha && r.t >= since).sort((a, b) => a.t - b.t || a.logId - b.logId);
  }

  // The daily check (once per study day) and the refresh behind the "Check now" button.
  // payload: { force } -> the status (see getStatus) plus { ran: bool, switched }
  async check({ force = false } = {}) {
    if (!this.model) { const o = await this.open({}); if (!o.loaded) return { ...(await this.getStatus()), ran: false, switched: null }; }
    if (!this.state) await this._loadMeta();
    const today = this._today(), s = this.state;
    const due = checkDue(s, today);
    const fresh = this.status === 'fresh';
    if (!force && !due) return { ...(await this.getStatus()), ran: false, switched: null };
    if (!fresh && !force) return { ...(await this.getStatus()), ran: false, switched: null };       // an out-of-date memory makes no verdict
    const recs = await this._records();
    const verdict = liveVerdict(recs, { totalScored: this.fp ? this.fp.scored : 0, daysWatching: today - (s.watchDay ?? today), nLive: recs.length });
    this.state = { ...s, verdict: { ...verdict, day: today } };
    let switched = null, ran = false;
    if (due && fresh) {
      ran = true;
      const verdicts = recordCheck(s.verdicts, today, verdict.status);
      const sinceSwitch = recs.filter(r => r.t >= (s.sinceT || 0)).length;
      const exit = s.scheduler === 'own' ? exitCheck(recs, sinceSwitch) : undefined;
      this.state = { ...this.state, verdicts, lastCheckDay: today };
      switched = this._applySwitch(nextScheduler(this.state, { on: this.settings.on, verdicts, exit, recordsSinceSwitch: sinceSwitch, plans: this.state.plans }, today));
    }
    await this._saveState();
    return { ...(await this.getStatus()), ran, switched };
  }

  async dismissNotice() {
    if (!this.state) await this._loadMeta();
    if (this.state) { this.state = { ...this.state, noticePending: null }; await this._saveState(); }
    return { ok: true };
  }

  // Everything the Settings screen needs.
  async getStatus() {
    let m = this.model;
    if (!m) { const o = await this.open({}); m = this.model; if (!o.loaded) return { loaded: false, on: false, scheduler: 'fsrs', status: 'none' }; }
    if (!this.state) await this._loadMeta();
    const s = this.state || {}, today = this._today();
    let records = 0;
    try { records = (await this._records()).length; } catch { /* the count is only for show */ }
    return {
      loaded: true, name: m.name, sha256: m.sha256, shortSha: m.sha256.slice(0, 6), on: this.settings.on === true, autoLocked: s.autoLocked === true,
      scheduler: s.scheduler === 'own' ? 'own' : 'fsrs', paused: s.errorPauseUntil != null && today < s.errorPauseUntil, pausedUntilDay: s.errorPauseUntil ?? null,
      memory: this.status, verdict: s.verdict || null, verdicts: s.verdicts || [], switches: s.switches || [], noticePending: s.noticePending ?? null,
      fallbacks: s.fallbacks || 0, errors: s.errors || 0, plansToday: s.plans && s.plans.day === today ? s.plans : { day: today, total: 0, failed: 0 },
      records, scored: this.fp ? this.fp.scored : 0, minScored: MIN_SCORED, lastCheckDay: s.lastCheckDay ?? null, watchDay: s.watchDay ?? null
    };
  }
}
