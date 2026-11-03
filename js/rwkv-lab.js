// RWKV lab: the page's side. Loaded only by dynamic import (the Lab screen, and Review/Practice when the lab is on). It starts the
// worker when it is needed, keeps the lab's settings, and turns answers into messages. Nothing here changes how FSRS schedules.
// No network.
import * as lab from './rwkv-labdb.js';
import { parseWeights, validateWeights } from './rwkv-weights.js';
import { KNOWN_MODELS, STATE_FORMAT, FEATURE_VERSION } from './rwkv-spec.js';
import { freshness } from './rwkv-fresh.js';
import { compare } from './rwkv-metrics.js';
import { forgettingCurve } from './fsrs-fit.js';
import { deltaDays } from './fsrs-data.js';
import { schedulerOptions } from './sched-settings.js';
import { LAB_BUILD } from './rwkv-flag.js';
import * as db from './db.js';

const PLAN_MS = 300;                 // how long the card's buttons wait for a plan (review.js); after that FSRS schedules the card
const TIMEOUT = { review: 5000, whatIf: 2000, init: 30000, catchup: 120000, flush: 10000, undo: 5000 };
const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const slimDecks = decks => (decks || []).map(d => ({ id: d.id, options: !!d.options }));
const slimCard = c => ({ id: c.id, deckId: c.deckId, noteId: c.noteId });
const slimLog = l => ({ id: l.id, cardId: l.cardId, timestamp: l.timestamp, source: l.source, applied: l.applied, rating: l.rating, ms: l.ms, state: l.state });

class Lab {
  constructor() {
    this.worker = null; this.pending = new Map(); this.nextId = 1;
    this.failed = false; this.rebuilding = false; this.planning = false;
    this.stateName = null;          // 'fresh' once the memory is in step with the log
    this._ready = null; this._inited = null;
    this._chain = Promise.resolve();         // answers and undos are handed over in the order they happened
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.worker?.postMessage({ id: 0, type: 'flush' }); });
    }
  }

  // ---- the worker ----
  _spawn() {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./rwkv-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = e => {
      const m = e.data || {}, p = this.pending.get(m.id);
      if (!p) { if (m.type === 'error' && m.id === 0) console.warn('RWKV lab:', m.message); return; }
      if (m.type === 'progress') { p.onProgress?.(m); return; }
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.type === 'done') p.resolve(m.result); else p.reject(new Error(m.message));
    };
    w.onerror = e => { e.preventDefault?.(); this._fail(new Error(e.message || 'The lab worker stopped.')); };
    this.worker = w;
    return w;
  }
  call(type, payload = {}, timeoutMs = 0, onProgress = null) {
    const w = this._spawn();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new Error('The lab did not answer in time.')); }, timeoutMs) : 0;
      this.pending.set(id, { resolve, reject, timer, onProgress });
      w.postMessage({ id, type, ...payload });
    });
  }
  _stop() {
    this.worker?.terminate(); this.worker = null; this._inited = null; this._ready = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The lab was stopped.')); }
    this.pending.clear();
  }
  _fail(err) { console.warn('RWKV lab stopped:', err?.message || err); this.failed = true; this.stateName = null; this._stop(); }
  async _start() {
    if (!this._inited) this._inited = this.call('init', {}, TIMEOUT.init).catch(err => { this._inited = null; throw err; });
    return this._inited;
  }

  // ---- settings and weights ----
  settings() { return lab.getSettings(); }
  async setShadow(on) {
    const s = await lab.getSettings();
    const next = await lab.setSettings({ shadow: !!on, shadowSince: on ? (s.shadowSince ?? Date.now()) : s.shadowSince, ...(on ? {} : { scheduler: 'fsrs' }) });
    if (!on) this.planning = false;
    this._ready = null;
    if (on) { navigator.storage?.persist?.().catch(() => {}); this.ensureReady().catch(() => {}); }
    return next;
  }

  async setScheduler(name) {
    if (name !== 'rwkv') return lab.setSettings({ scheduler: 'fsrs' });
    const why = this.schedulerBlock(await this.status());
    if (why) throw new Error(why);
    this.planning = true;
    this.ensureReady().catch(() => {});
    return lab.setSettings({ scheduler: 'rwkv' });
  }
  // Why RWKV can't schedule right now (null when it can). Takes what status() gave.
  schedulerBlock(s) {
    if (!s.weights) return 'Choose a weights file first';
    if (!s.settings.shadow) return 'Turn on shadow mode first';
    if (s.failed) return 'The lab stopped. Rebuild to start it again';
    if (s.state === 'rebuilding') return 'Rebuild in progress';
    if (s.state !== 'fresh' && s.state !== 'catching-up') return 'Rebuild needed';
    return null;
  }
  // The review session asks this once at the start (and again after the lab screen changes the choice).
  async wantsPlans() {
    this.planning = (await lab.getSettings()).scheduler === 'rwkv';
    if (this.planning) this.ensureReady().catch(() => {});     // start the worker while the first card is being read
    return this.planning;
  }

  // -> { ok: true, info } | { ok: false, error }
  async loadWeightsFile(file) {
    let bytes;
    try { bytes = await file.arrayBuffer(); } catch { return { ok: false, error: 'This file could not be read.' }; }
    let parsed;
    try { parsed = parseWeights(bytes); } catch (err) { return { ok: false, error: err.message }; }
    const check = validateWeights(parsed.tensors);
    if (!check.ok) return { ok: false, error: check.errors[0] };
    const sha = await sha256(bytes);
    const old = await lab.get('weights', 'current');
    const rec = { id: 'current', bytes, sha256: sha, name: file.name, size: bytes.byteLength, format: parsed.format, addedAt: Date.now() };
    await lab.put('weights', rec, 'current');
    if (old && old.sha256 !== sha) { const s = await lab.getSettings(); if (s.scheduler !== 'fsrs') await lab.setSettings({ scheduler: 'fsrs' }); }   // other weights: back to FSRS until rebuilt
    this.planning = false;
    this._stop(); this.failed = false; this.stateName = null;
    navigator.storage?.persist?.().catch(() => {});
    return { ok: true, info: this._weightsInfo(rec) };
  }
  _weightsInfo(rec) { return rec ? { name: rec.name, size: rec.size, sha: rec.sha256, format: rec.format, known: KNOWN_MODELS[rec.sha256] || null } : null; }

  // ---- is the saved memory in step with the review log? ----
  async checkFresh() {
    const [st, w] = await Promise.all([lab.get('meta', 'state'), lab.get('weights', 'current')]);
    if (!w || !st) return { status: 'none' };
    const count = await db.count('reviewLog');
    const newRows = st.rebuilding ? [] : await db.getLogsSince(st.lastTs);
    return freshness(st, { sha: w.sha256, stateFormat: STATE_FORMAT, featureVersion: FEATURE_VERSION, count, newRows });
  }

  async status() {
    if (!(await lab.labExists())) {        // nothing saved (yet, or removed): reading must not create the database
      return { weights: null, state: 'none', reason: null, news: 0, rows: 0, cards: 0, rebuiltAt: null, fallbacks: 0, settings: { ...lab.DEFAULT_SETTINGS }, failed: this.failed, persisted: true };
    }
    const [w, st, fallbacks] = await Promise.all([lab.get('weights', 'current'), lab.get('meta', 'state'), lab.get('meta', 'fallbacks')]);
    let settings = await lab.getSettings();
    // No weights, or shadow mode off: RWKV can't be in charge, so the choice goes back to FSRS.
    if (settings.scheduler === 'rwkv' && (!w || !settings.shadow)) { settings = await lab.setSettings({ scheduler: 'fsrs' }); this.planning = false; }
    const f = w ? await this.checkFresh() : { status: 'none' };
    let state = f.status;
    if (this.rebuilding) state = 'rebuilding';
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => true) : true;
    return {
      weights: this._weightsInfo(w), state, reason: f.reason || null, news: f.rows ? f.rows.length : 0,
      rows: st?.rows ?? 0, cards: await lab.count('cards'), rebuiltAt: st?.rebuiltAt ?? null, fallbacks: fallbacks ?? 0,
      settings, failed: this.failed, persisted
    };
  }

  // ---- getting ready to follow live answers ----
  ensureReady() {
    if (this.failed) return Promise.resolve(false);
    if (!this._ready) this._ready = this._boot().catch(err => { this._fail(err); return false; });
    return this._ready;
  }
  async _boot() {
    const [s, w] = await Promise.all([lab.getSettings(), lab.get('weights', 'current')]);
    if (!s.shadow || !w) { this._ready = null; return false; }
    await this._start();
    let f = await this.checkFresh();
    if (f.status === 'catching-up') { await this._catchUp(f.rows); f = { status: 'fresh' }; }
    this.stateName = f.status;
    if (f.status === 'fresh') this.sha = (await lab.get('weights', 'current'))?.sha256 || null;
    return f.status === 'fresh';
  }
  async _catchUp(rows) {
    const decks = slimDecks(await db.getAll('decks'));
    const cards = [];
    for (const id of new Set(rows.map(r => r.cardId))) { const c = await db.get('cards', id); if (c) cards.push(slimCard(c)); }
    await this.call('catchup', { logs: rows.map(slimLog), cards, decks, count: await db.count('reviewLog'), newest: { timestamp: rows[rows.length - 1].timestamp, id: rows[rows.length - 1].id } }, TIMEOUT.catchup);
  }

  // ---- hooks (fire and forget: they never throw and FSRS never waits for them) ----
  afterAnswer(a) { return (this._chain = this._chain.then(() => this._answer(a))); }
  afterUndo(logId) { return (this._chain = this._chain.then(() => this._undo(logId))); }
  async _answer({ logId, log, card, prev = null, opts = null, decks = [] }) {
    try {
      if (!(await this.ensureReady())) return;
      let fsrsMine = null, fsrsDefault = null;
      if (log.source === 'review' && prev && prev.lastReview && Number.isFinite(prev.stability)) {
        const t = deltaDays(prev.lastReview, log.timestamp);
        if (t >= 1) {
          const { default_w } = await import('./srs.js');
          fsrsMine = forgettingCurve(opts?.w ?? default_w, t, prev.stability);
          fsrsDefault = forgettingCurve(default_w, t, prev.stability);
        }
      }
      await this.call('review', { log: { ...log, id: logId }, card: slimCard(card), decks: slimDecks(decks), fsrsMine, fsrsDefault, count: await db.count('reviewLog') }, TIMEOUT.review);
    } catch (err) { console.warn('RWKV lab:', err?.message || err); }
  }
  async _undo(logId) {
    try {
      if (!(await this.ensureReady())) return;
      const ok = await this.call('undo', { logId }, TIMEOUT.undo);
      if (!ok) { this.stateName = 'stale'; this._ready = Promise.resolve(false); }
    } catch (err) { console.warn('RWKV lab:', err?.message || err); }
  }

  // ---- scheduling (only when the owner chose RWKV (lab)) ----
  // The days until the card should come back after Hard, Good and Easy, worked out before the card is flipped (review.js freezes the result).
  // -> { cardId, lastReview, at, days: { 2, 3, 4 }, modelSha } or null (then FSRS schedules the card). Never throws.
  async plan({ card, state, now = Date.now(), opts, decks = [] }) {
    try {
      this.lastPlan = null;                                    // (the last plan made, for the browser tests)
      if (!this.planning || this.failed || !state || state.state !== 2 || !(opts?.maxInterval > 0) || !(opts?.retention > 0)) return null;
      await this._chain;                                       // the last answer (and any undo) must have reached the worker first
      if (!(await this.ensureReady()) || this.stateName !== 'fresh') return null;
      const logs = await db.getCardLogs(card.id);
      const ms = recentMs(logs);
      const r = await this.call('whatIf', { log: { id: -1, cardId: card.id, timestamp: now, source: 'review', mode: 'flip', correct: true, ms, rating: 3, state: state.state },
        card: slimCard(card), decks: slimDecks(decks), ms, target: opts.retention, maxDays: opts.maxInterval }, TIMEOUT.whatIf);
      const days = r && r.days;
      if (!days || ![2, 3, 4].every(g => Number.isFinite(days[g]) && days[g] > 0)) return null;
      return (this.lastPlan = { cardId: card.id, lastReview: state.lastReview ?? null, at: now, days: { 2: days[2], 3: days[3], 4: days[4] }, modelSha: this.sha || (this.sha = (await lab.get('weights', 'current'))?.sha256 || null) });
    } catch (err) { console.warn('RWKV lab:', err?.message || err); return null; }
  }
  // A card that should have been scheduled by RWKV went to FSRS instead; the Lab screen shows the count.
  noteFallback() {
    this._fb = (this._fb || Promise.resolve()).then(async () => {
      try { await lab.put('meta', ((await lab.get('meta', 'fallbacks')) || 0) + 1, 'fallbacks'); } catch { /* the count is only for show */ }
    });
    return this._fb;
  }

  // ---- rebuild ----
  // Replays the whole review log. -> { rows, cards, preds }. onProgress({ done, total }).
  async rebuild(onProgress = () => {}) {
    if (this.rebuilding) throw new Error('A rebuild is already running.');
    if (this.failed) { this.failed = false; this._stop(); }
    this.rebuilding = true;
    try {
      await this._start();
      const [logs, cards, decks, settings, srs] = await Promise.all([
        db.getAllInPieces('reviewLog'), db.getAll('cards'), db.getAll('decks'), db.getSettings(), import('./srs.js').catch(() => null)
      ]);
      const fsrs = srs ? { w: schedulerOptions(settings).w ?? null, wDefault: [...srs.default_w] } : null;
      const result = await this.call('rebuild', { logs: logs.map(slimLog), cards: cards.map(slimCard), decks: slimDecks(decks), fsrs }, 0, onProgress);
      this.stateName = 'fresh'; this._ready = Promise.resolve(true);
      return result;
    } finally {
      this.rebuilding = false;
    }
  }
  cancelRebuild() { if (!this.rebuilding) return; this._stop(); this.rebuilding = false; }

  async preds() {
    if (!(await lab.labExists())) return [];
    if (this.worker && this._inited) { try { await this.call('flush', {}, TIMEOUT.flush); } catch { /* read what is saved */ } }
    return lab.getAll('preds');
  }
  async comparison(sinceShadow) {
    const preds = await this.preds();
    const s = preds.length ? await lab.getSettings() : lab.DEFAULT_SETTINGS;
    return compare(preds, { since: sinceShadow ? (s.shadowSince ?? Infinity) : null });
  }

  async deleteAll() {
    this._stop(); this.failed = false; this.stateName = null; this.rebuilding = false; this.planning = false;
    await lab.deleteLab();
  }
}

// The middle of the card's last five answer times (milliseconds), 8 seconds when there are none to go by.
export function recentMs(logs) {
  const v = (logs || []).filter(l => l.source === 'review' && Number.isFinite(l.ms) && l.ms > 0).sort((a, b) => a.timestamp - b.timestamp).slice(-5).map(l => l.ms).sort((a, b) => a - b);
  if (!v.length) return 8000;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

let single = null;
export const getLab = () => single || (single = new Lab());
// What Review and Practice call (see the hooks there).
export const afterAnswer = args => getLab().afterAnswer(args);
export const afterUndo = logId => getLab().afterUndo(logId);
export const wantsPlans = () => getLab().wantsPlans();
export const plan = args => getLab().plan(args);
export const isPlanning = () => getLab().planning === true;
export const noteFallback = () => getLab().noteFallback();
export { PLAN_MS };

// For the browser tests only (this build only): stop the worker the way a crash would, so the next card has to fall back to FSRS.
if (LAB_BUILD && typeof window !== 'undefined') window.__rwkvBreak = () => getLab()._fail(new Error('Broken on purpose for a test.'));
