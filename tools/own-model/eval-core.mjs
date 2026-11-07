// Evaluating one learner (or user) with every model, on exactly the same held-out reviews. Importable; the tests call it on tiny made-up learners.
//
// The split is by time, like splitHistories in js/fsrs-fit.js: the cutoff day is the day by which 80% of the later-day scored reviews have happened.
// Everything before the cutoff is the train part, the reviews after it are the held-out part. All models are scored on the held-out reviews that are
// scored (not a card's first answer, no earlier life of a reset card) and happen on a later day than the card's previous answer ("long");
// reviews on the same day as the previous answer ("same") are reported separately.
//   FSRS-6 default          standard weights
//   FSRS-6 fitted           our fit() on the train part only
//   FSRS-6 fsrs-rs          reference weights, only when they were made for this very split
//   Own, zero-shot          the model replays the whole history for its memories, nothing is learned from the user
//   Own + per-user fine-tune  the model first learns from the train part (a leash towards the starting weights, early stop on the last 10% of the train days)
//   RWKV reference          outside predictions, only when they line up with these reviews row by row
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fit, splitHistories, clipWeights } from '../../js/fsrs-fit.js';
import { createOwnModel, StateStore, eventsFromRows } from '../../js/own-model.js';
import { Tape, Adam } from '../../js/own-grad.js';
import { parseOwnFile } from '../../js/own-file.js';
import { eval6, Metrics } from '../../tests/realdata/lib.mjs';
import { isLong, isSame, predictAll, applyFrozen, zeroFrozen, frozenFor } from './common.mjs';
import { readNpz } from './npz.mjs';

const ts = await import(pathToFileURL(createRequire(import.meta.url).resolve('ts-fsrs')).href);
export const DEFAULT_W = Array.from(ts.default_w);
export const BOUNDS = ts.CLAMP_PARAMETERS(ts.W17_W18_Ceiling, true);
const RELEARN_STEPS = 1;
const drive = gen => { for (;;) { const r = gen.next(); if (r.done) return r.value; } };

export const FT_DEFAULTS = { epochs: 4, lr: 1e-3, l2: 1e-3, chunk: 128, perStep: 2, patience: 2, minVal: 30, minFit: 50, share: 0.9 };

export function loadModelFile(path) {
  const { header, params } = parseOwnFile(readFileSync(path));
  const ablate = typeof header.info?.ablate === 'string' && header.info.ablate !== 'none' ? header.info.ablate.split(',') : [];
  return { header, params: Float64Array.from(params), size: header.size, ablate };
}

// ---------- FSRS histories from rows ----------
// Same cards and numbers as toHistories (tests/realdata/lib.mjs) makes from the raw columns: only scored lives of a card; deltas are whole days
// between rows; tFrac is the card gap in days (from gapSec when the data has it, else from the row times).
export function fsrsCardsFromRows(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.scored === false) continue;
    let l = by.get(r.cardKey);
    if (!l) by.set(r.cardKey, l = []);
    l.push(r);
  }
  const cards = [];
  for (const [cardId, list] of by) {
    const m = list.length, deltas = new Int32Array(m), ratings = new Uint8Array(m), scored = new Uint8Array(m).fill(1), tFrac = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      ratings[i] = list[i].rating;
      if (i === 0) continue;
      deltas[i] = Math.max(0, list[i].day - list[i - 1].day);
      tFrac[i] = Number.isFinite(list[i].gapSec) ? list[i].gapSec / 86400 : Math.max(0, (list[i].t - list[i - 1].t) / 86400000);
    }
    cards.push({ cardId, day0: list[0].day, deltas, ratings, scored, tFrac });
  }
  return cards;
}

const result = m => { const r = m.result(); return { logLoss: r.logLoss, rmse: r.rmse, auc: r.auc, n: r.n }; };
const clip6 = w => clipWeights(w, RELEARN_STEPS, BOUNDS);
const seconds = t0 => Math.round(performance.now() - t0) / 1000;

// ---------- the per-user fine-tune ----------
// params: Float64Array (not changed). Returns { params, epochsRun, bestEpoch, valStart, valBest, skipped? }.
export function finetuneParams({ params, size, events, rows, cutoff, frozen, cfg = {} }) {
  const c = { ...FT_DEFAULTS, ...cfg };
  let nTrain = 0;
  while (nTrain < rows.length && rows[nTrain].day <= cutoff) nTrain++;
  const days = [];
  for (let i = 0; i < nTrain; i++) if (isLong(rows[i])) days.push(rows[i].day);
  const cut = days.length ? days[Math.min(days.length - 1, Math.floor(days.length * c.share))] : 0;
  let nFit = 0;
  while (nFit < nTrain && rows[nFit].day <= cut) nFit++;
  let valN = 0, fitN = 0;
  for (let i = 0; i < nTrain; i++) if (events[i].score) { if (i >= nFit) { if (isLong(rows[i])) valN++; } else fitN++; }
  if (valN < c.minVal || fitN < c.minFit) return { params, epochsRun: 0, bestEpoch: 0, skipped: 'little', valN, fitN };
  const p = Float64Array.from(params), model = createOwnModel(p, size), tape = new Tape();
  const fz = frozen || { idx: new Int32Array(0), val: new Float64Array(0) };
  const n = p.length, grads = new Float64Array(n), adam = new Adam(n, { lr: c.lr, l2: c.l2, anchor: params, clip: 1 });
  const valLoss = () => {
    const ps = predictAll(model, events.slice(0, nTrain), new StateStore());
    let s = 0, k = 0;
    for (let i = nFit; i < nTrain; i++) if (events[i].score && isLong(rows[i])) { const q = Math.min(1 - 1e-6, Math.max(1e-6, ps[i])); s -= events[i].y ? Math.log(q) : Math.log(1 - q); k++; }
    return s / Math.max(1, k);
  };
  const start = valLoss();
  let best = { loss: start, epoch: 0, params: Float64Array.from(p) }, bad = 0, ran = 0;
  for (let e = 1; e <= c.epochs && bad < c.patience; e++) {
    const store = new StateStore();
    let count = 0, inStep = 0;
    grads.fill(0);
    for (let pos = 0; pos < nFit; pos += c.chunk) {
      const r = model.trainChunk(tape, grads, events.slice(pos, Math.min(nFit, pos + c.chunk)), store);
      count += r.count; inStep++;
      if (inStep === c.perStep || pos + c.chunk >= nFit) {
        if (count) { for (let i = 0; i < n; i++) grads[i] /= count; zeroFrozen(grads, fz); adam.step(p, grads); applyFrozen(p, fz); }
        grads.fill(0); count = 0; inStep = 0;
      }
    }
    ran = e;
    const v = valLoss();
    if (Number.isFinite(v) && v < best.loss - 1e-6) { best = { loss: v, epoch: e, params: Float64Array.from(p) }; bad = 0; } else bad++;
  }
  return { params: best.params, epochsRun: ran, bestEpoch: best.epoch, valStart: start, valBest: best.loss, valN, fitN };
}

// ---------- the outside (RWKV) predictions ----------
// pred = { n, p (Float64Array, NaN where there is no prediction) } for one user. Rows line up when the file has one entry per row of the user's data
// file and, over the rows that surely get a prediction (a scored row with an earlier answer of its card), nearly all entries are numbers while
// nearly all first answers have none. Otherwise they are not used (we never guess).
export function alignRwkv(rows, meta, pred) {
  if (!pred || pred.n !== meta.rawRows || pred.p.length !== meta.rawRows) return { ok: false, why: 'not the same number of rows' };
  let want = 0, got = 0, first = 0, firstNaN = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.rawRow) || r.rawRow >= pred.p.length) return { ok: false, why: 'rows have no position' };
    const has = Number.isFinite(pred.p[r.rawRow]);
    if (r.dDays !== undefined && r.scored !== false) { want++; if (has) got++; } else if (r.dDays === undefined && r.scored !== false) { first++; if (!has) firstNaN++; }
  }
  if (want < 20) return { ok: false, why: 'too few rows to check' };
  if (got / want < 0.995 || (first >= 20 && firstNaN / first < 0.95)) return { ok: false, why: `entries do not line up (${got}/${want} present, ${firstNaN}/${first} first answers empty)` };
  return { ok: true };
}

// ---------- one learner ----------
// loaded: { id, rows, meta }. ctx: {
//   own: [{ key, params, size, ablate, finetune }]   models to run (zero-shot always; finetune: true adds '<key>_ft'... the main one is key 'own_zero' with finetune)
//   (own: hidden: true runs the model but does not score it; ensembles: [{ key, members: [own keys] }] score the plain mean of the members' probabilities, zero-shot)
//   ft: fine-tune settings, rs(id) -> weights file content or null, rwkv(id) -> { n, p } or null, fitFsrs: true }
export function evalLearner(loaded, ctx) {
  const t0 = performance.now(), { rows, meta } = loaded;
  const res = { user: loaded.id, ok: true, reviews: meta.rawRows ?? rows.length, hasMeta: !!(meta.hasNote || meta.hasDeck), models: {} };
  const cards = fsrsCardsFromRows(rows), split = splitHistories(cards, 0.8), cutoff = split.cutoff;
  res.cutoff = cutoff;
  const headRows = split.head.reduce((a, c) => a + c.ratings.length, 0);
  const add = (key, r) => { res.models[key] = r; };
  add('fsrs6_default', eval6(split.test, clip6(DEFAULT_W)));
  res.n = res.models.fsrs6_default.long.n;
  res.nSame = res.models.fsrs6_default.same.n;
  if (ctx.fitFsrs !== false) {
    const tf = performance.now();
    const r = drive(fit({ cards: split.head, current: DEFAULT_W, defaults: DEFAULT_W, bounds: BOUNDS, config: { skipCheck: true } }));
    res.fitStatus = r.status;
    add('fsrs6_fitted', eval6(split.test, clip6(r.status === 'trained' ? r.fitted : DEFAULT_W)));
    res.fitSeconds = seconds(tf);
  }
  const rs = ctx.rs ? ctx.rs(loaded.id) : null;
  if (rs) {
    if (rs.cutoff === cutoff && rs.headRows === headRows && Array.isArray(rs.fsrs6) && rs.fsrs6.length === 21) { add('fsrs6_rs', eval6(split.test, clip6(rs.fsrs6))); res.rs = 'used'; } else res.rs = 'other split';
  }

  // Own: one pass over all rows for each model
  const events = eventsFromRows(rows);
  const longIdx = [], sameIdx = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].day <= cutoff || !events[i].score) continue;
    if (isLong(rows[i])) longIdx.push(i); else if (isSame(rows[i])) sameIdx.push(i);
  }
  res.ownLong = longIdx.length;
  const score = (key, ps) => {
    const L = new Metrics(), S = new Metrics();
    for (const i of longIdx) L.add(ps[i], events[i].y);
    for (const i of sameIdx) S.add(ps[i], events[i].y);
    add(key, { long: result(L), same: result(S) });
    return ps;
  };
  const predictions = {};
  for (const m of ctx.own || []) {
    const model = createOwnModel(m.params, m.size);
    const ps = predictAll(model, events, new StateStore());
    predictions[m.key] = m.hidden ? ps : score(m.key, ps);
    if (m.finetune) {
      const tf = performance.now();
      const ft = finetuneParams({ params: m.params, size: m.size, events, rows, cutoff, frozen: frozenFor(m.size, m.ablate || []), cfg: ctx.ft });
      res.ft = { epochsRun: ft.epochsRun, bestEpoch: ft.bestEpoch, skipped: ft.skipped || null, valStart: ft.valStart ?? null, valBest: ft.valBest ?? null, seconds: seconds(tf) };
      predictions[m.finetune] = score(m.finetune, predictAll(createOwnModel(ft.params, m.size), events, new StateStore()));
    }
  }
  // an ensemble row is scored like any other: the same reviews, the mean probability of its members
  for (const e of ctx.ensembles || []) {
    const parts = e.members.map(k => predictions[k]);
    if (parts.some(p => !p)) throw new Error(`ensemble ${e.key}: unknown member`);
    const ps = new Float64Array(rows.length);
    for (let i = 0; i < ps.length; i++) { let s = 0; for (const p of parts) s += p[i]; ps[i] = s / parts.length; }
    predictions[e.key] = score(e.key, ps);
  }
  if (res.models.fsrs6_default.long.n !== longIdx.length) res.countMismatch = [res.models.fsrs6_default.long.n, longIdx.length];

  // the outside predictions: only on the very same reviews
  const pr = ctx.rwkv ? ctx.rwkv(loaded.id) : null;
  if (pr) {
    const al = alignRwkv(rows, meta, pr);
    if (!al.ok) res.rwkv = 'not used: ' + al.why;
    else if (res.countMismatch) res.rwkv = 'not used: the review sets differ';
    else {
      const L = new Metrics(), S = new Metrics();
      for (const i of longIdx) L.add(pr.p[rows[i].rawRow], events[i].y);
      for (const i of sameIdx) if (Number.isFinite(pr.p[rows[i].rawRow])) S.add(pr.p[rows[i].rawRow], events[i].y);
      add('rwkv', { long: result(L), same: result(S) });
      res.rwkv = 'used';
      res.rwkvRows = Object.fromEntries(Object.entries(res.models).filter(([k]) => k !== 'rwkv').map(([k, v]) => [k, v.long]));
      res.rwkvRows.rwkv = res.models.rwkv.long;
    }
  }
  for (const m of Object.values(res.models)) for (const part of [m.long, m.same]) if (part && part.n && !Number.isFinite(part.logLoss)) { res.ok = false; res.error = 'a model gave a value that is not a number'; }
  res.seconds = seconds(t0);
  return res;
}

// ---------- reading the optional reference files (paths come from the caller) ----------
export function makeRsReader(dir) {
  return id => {
    const f = join(dir, `${id}.full.json`);
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
  };
}
export function makeRwkvReader(dir) {
  return id => {
    const f = join(dir, `${id}.npz`);
    if (!existsSync(f)) return null;
    try {
      const z = readNpz(readFileSync(f));
      if (!z.p_curve || !z.n) return null;
      return { n: z.n.data[0], p: z.p_curve.data };
    } catch { return null; }
  };
}

// The shipped (synthetic) parameters, from js/own-params.js, or null when that file does not exist yet.
export async function loadShippedParams() {
  let mod;
  try { mod = await import('../../js/own-params.js'); } catch { return null; }
  const P = mod.OWN_PARAMS, bytes = Buffer.from(P.b64, 'base64');
  return { size: P.size || 's', params: Float64Array.from(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))) };
}
