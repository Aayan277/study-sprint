// Own model: the learner simulator. Pure and seeded: the same config and seed always give the same learners.
// It writes Study Sprint review-log rows (the shape the app saves) plus a separate `truth` object that is only for checks and
// is never part of a row. Design: docs/design/own-model.md, "Simulator".
//
// Hidden memory (world 'own', deliberately not FSRS). Every card has a fast trace m_f (about 1 day) and a slow trace m_s (about
// 30 days). The chance of remembering after t days is
//     logit p = b - difficulty + log(m_f e^(-t/tau_f) + m_s e^(-t/tau_s) + eps) - (bad day ? kappa : 0)
// A success adds to m_s (more when the recall was hard: the spacing effect) and sets m_f = 1. A failure shrinks m_s and sets m_f = 1.
//
// Six effects FSRS cannot see, each with its own switch (config.effects): siblings, interference, drift, badDays, answerTime, schedNoise.
// World 'fsrs' is the control: memory follows FSRS-6 exactly (with weights jittered per learner), so no model should beat FSRS-6 there.
//
// The simulated learner schedules like Anki with FSRS-6 default weights, steps 1 min and 10 min, relearning 10 min.
// All times are UTC. Sessions start between 06:00 and 17:00 and stop before midnight, so the UTC date is the study day.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mulberry32, initState, nextState, forgettingCurve, clipWeights } from '../../js/fsrs-fit.js';
import { fnv1a } from '../../js/rwkv-features.js';

const ts = await import(pathToFileURL(createRequire(import.meta.url).resolve('ts-fsrs')).href);
export const DEFAULT_W = Array.from(ts.default_w);
const BOUNDS = ts.CLAMP_PARAMETERS(ts.W17_W18_Ceiling, true);

export const SIM_VERSION = 'sim-v1';
export const EFFECTS = ['siblings', 'interference', 'drift', 'badDays', 'answerTime', 'schedNoise'];
export const DEFAULT_CONFIG = {
  world: 'own',                                          // 'own' | 'fsrs'
  effects: Object.fromEntries(EFFECTS.map(e => [e, true])),
  days: [60, 400],                                       // study period in days (a number or [low, high])
  newPerDay: [5, 20],
  decks: [1, 4],
  maxReviewsPerDay: 200,
  count: 1                                               // learners() yields this many, seeds seed .. seed+count-1
};
const DAY = 86400000, MIN = 60000, HOUR = 3600000;
const BASE_MS = Date.UTC(2023, 0, 1);

export function resolveConfig(config = {}) {
  const c = { ...DEFAULT_CONFIG, ...config, effects: { ...DEFAULT_CONFIG.effects, ...(config.effects || {}) } };
  if (c.world !== 'own' && c.world !== 'fsrs') throw new Error(`Unknown world: ${c.world}`);
  for (const k of Object.keys(c.effects)) if (!EFFECTS.includes(k)) throw new Error(`Unknown effect: ${k}`);
  return c;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const stream = (tag, seed) => mulberry32(fnv1a(`${SIM_VERSION}|${tag}|${seed}`));
const uni = (r, lo, hi) => lo + (hi - lo) * r();
const range = (r, v) => (Array.isArray(v) ? v[0] + Math.floor(r() * (v[1] - v[0] + 1)) : v);
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

const EPS = 0.02, FIRST_MULT = [0, 0.5, 0.8, 1, 1.3], RATING_MULT = [0, 0, 0.8, 1, 1.3];
const STEPS_MIN = [1, 10], RELEARN_MIN = 10;

// ---------- one learner ----------
export function makeLearner(config = {}, seed = 1) {
  const cfg = resolveConfig(config), fx = cfg.effects;
  const rP = stream('params', seed), rD = stream('days', seed), rA = stream('answers', seed), rS = stream('sched', seed), rC = stream('cards', seed);

  // learner traits
  const P = {
    days: range(rP, cfg.days), newPerDay: range(rP, cfg.newPerDay), nDecks: range(rP, cfg.decks),
    retention: uni(rP, 0.80, 0.95), skipP: uni(rP, 0.10, 0.30), lateSigma: uni(rP, 0.1, 0.3), offP: 0.10,
    startHour: 6 + Math.floor(rP() * 12),
    bL: 2.5 + 0.3 * gauss(rP), tauF: Math.exp(0.3 * gauss(rP)), tauS: 30 * Math.exp(0.3 * gauss(rP)),
    gain: Math.exp(0.25 * gauss(rP)) * 2.5, rho: uni(rP, 0.4, 0.7), lamFail: uni(rP, 0.3, 0.6),
    sdCard: uni(rP, 0.5, 1.0), noteShare: 0.5, qInt: uni(rP, 0.2, 0.5),
    walkSigma: uni(rP, 0.02, 0.05), pBad: uni(rP, 0.05, 0.25), stick: 0.6, kappa: uni(rP, 0.5, 1.5),
    speed: Math.exp(Math.log(7000) + 0.4 * gauss(rP)), msSigma: 0.35,
    hardBase: uni(rP, 0.03, 0.10), easyBase: uni(rP, 0.10, 0.40),
    firstDist: null
  };
  const fa = uni(rP, 0.10, 0.25), fh = uni(rP, 0.05, 0.15), fe = uni(rP, 0.05, 0.15);
  P.firstDist = [fa, fh, fe];                                          // chance of Again, Hard, Easy on a first look (the rest is Good)
  P.deckOff = Array.from({ length: P.nDecks }, () => 0.4 * gauss(rP));
  P.deckWeight = Array.from({ length: P.nDecks }, () => uni(rP, 0.5, 1.5));
  let wTrue = null;
  if (cfg.world === 'fsrs') {
    wTrue = clipWeights(DEFAULT_W.map((v, i) => (i < 4 ? v * Math.exp(0.15 * gauss(rP)) : v * Math.exp(0.12 * gauss(rP)))), 1, BOUNDS);
  }

  // day processes: bad days (two-state chain) and the learning-gain walk (with exam-term steps)
  const D = P.days, bad = new Uint8Array(D), logG = new Float32Array(D);
  { let b = rD() < P.pBad ? 1 : 0, lg = 0; const aIn = 0.4 * P.pBad / (1 - P.pBad);
    for (let d = 0; d < D; d++) {
      b = b ? (rD() < P.stick ? 1 : 0) : (rD() < aIn ? 1 : 0);
      lg += P.walkSigma * gauss(rD) - 0.02 * lg;
      if (rD() < 1 / 120) lg += (rD() < 0.5 ? 1 : -1) * uni(rD, 0.2, 0.5);
      if (fx.badDays) bad[d] = b;
      if (fx.drift) logG[d] = lg;
    } }

  // ---------- state ----------
  const W = DEFAULT_W;                                             // the learner's scheduler
  const decay = -W[20], factor = Math.pow(0.9, 1 / decay) - 1;
  const interval = s => Math.max(1, Math.round(s * (Math.pow(P.retention, 1 / decay) - 1) / factor));
  const logs = [], cards = [], pLog = [], deckIds = Array.from({ length: P.nDecks }, (_, i) => `d${i + 1}`);
  const cardList = [], notes = [], groups = Array.from({ length: P.nDecks }, () => []), newQueue = [];
  const truthCard = {};
  const buckets = new Map();
  let overdue = [], noteN = 0, logN = 0;

  function makeNote() {
    let x = rC() * P.deckWeight.reduce((a, b) => a + b, 0), deck = 0;
    while (deck < P.nDecks - 1 && x >= P.deckWeight[deck]) { x -= P.deckWeight[deck]; deck++; }
    const u = rC(), n = u < 0.5 ? 1 : u < 0.85 ? 2 : 3, noteId = `n${++noteN}`, zNote = gauss(rC), members = [];
    for (let k = 0; k < n; k++) {
      const zc = gauss(rC);
      const share = fx.siblings ? P.noteShare : 0;
      const delta = P.sdCard * (Math.sqrt(share) * zNote + Math.sqrt(1 - share) * zc) + P.deckOff[deck];
      let g = groups[deck].find(q => q.members.length < q.size && rC() < 0.7);
      if (!g) { g = { id: `g${deck + 1}.${groups[deck].length + 1}`, size: 4 + Math.floor(rC() * 5), members: [] }; groups[deck].push(g); }
      const card = { id: `c${cardList.length + 1}`, deck, noteId, note: members, group: g, delta, introduced: false,
        phase: 'new', step: 0, reps: 0, lapses: 0, lastT: 0, lastDay: 0, mf: 0, ms: 0, tf: 0, ts: 0, sched: null, tru: null, dueT: 0, dueDay: 0 };
      cardList.push(card); members.push(card); g.members.push(card); newQueue.push(card);
    }
  }

  const recallOwn = (c, t, d) => {
    const mf = c.mf * Math.exp(-(t - c.tf) / (P.tauF * DAY)), ms = c.ms * Math.exp(-(t - c.ts) / (P.tauS * DAY));
    const z = P.bL - c.delta + Math.log(mf + ms + EPS) - (bad[d] ? P.kappa : 0);
    return { p: 1 / (1 + Math.exp(-z)), mf, ms };
  };

  function schedule(c, d, interDays) {                              // next due day of a review card, with scheduling noise
    let gap = interDays;
    if (fx.schedNoise) {
      if (rS() < P.offP) gap = Math.max(1, Math.round(interDays * Math.exp(uni(rS, Math.log(0.3), Math.log(3)))));
      else gap = Math.max(interDays, Math.round(interDays * Math.exp(Math.abs(P.lateSigma * gauss(rS)))));
    }
    c.dueDay = d + gap;
    let b = buckets.get(c.dueDay); if (!b) buckets.set(c.dueDay, b = []);
    b.push(c);
  }

  // One answer. Returns the ms spent. `learning` collects cards that come back later in the same session.
  function answer(c, t, d, learning, dayEndT) {
    const first = c.reps === 0;
    const day = d;
    let p = NaN, mfN = 0, msN = 0, tWhole = 0;
    if (!first) {
      tWhole = day - c.lastDay;
      if (cfg.world === 'own') { const r = recallOwn(c, t, d); p = r.p; mfN = r.mf; msN = r.ms; }
      else p = tWhole > 0 ? forgettingCurve(wTrue, tWhole, c.tru.s, true) : forgettingCurve(wTrue, (t - c.lastT) / DAY, c.tru.s, false);
    }
    let rating;
    if (first) {
      const u = rA();
      rating = u < P.firstDist[0] ? 1 : u < P.firstDist[0] + P.firstDist[1] ? 2 : u < P.firstDist[0] + P.firstDist[1] + P.firstDist[2] ? 4 : 3;
    } else if (rA() >= p) rating = 1;
    else {
      const pHard = clamp(P.hardBase + 0.6 * (1 - p), 0, 0.6), pEasy = (1 - pHard) * P.easyBase * p ** 4, u = rA();
      rating = u < pHard ? 2 : u < pHard + pEasy ? 4 : 3;
    }
    const pm = first ? 0.5 : p;
    const ms = Math.round(clamp(P.speed * (fx.answerTime ? 0.5 + 1.5 * (1 - pm) : 1) * Math.exp(P.msSigma * gauss(rA)), 800, 120000));
    const state = c.phase === 'new' ? 0 : c.phase === 'learn' ? 1 : c.phase === 'review' ? 2 : 3;
    logs.push({ id: `L${++logN}`, cardId: c.id, timestamp: t, source: 'review', mode: 'flip', rating, ms, state });
    pLog.push(p);

    // hidden memory
    const g = P.gain * Math.exp(logG[d]);
    if (cfg.world === 'own') {
      if (first) { c.mf = 1; c.ms = g * FIRST_MULT[rating]; c.tf = c.ts = t; c.introduced = true; }
      else if (rating > 1) {
        c.ms = msN + g * Math.pow(1 - p, P.rho) * (1 + msN) * RATING_MULT[rating]; c.mf = 1; c.tf = c.ts = t;
        if (fx.siblings) for (const o of c.note) if (o !== c && o.introduced) { o.mf = o.mf * Math.exp(-(t - o.tf) / (P.tauF * DAY)) + 0.3; o.tf = t; }
      } else { c.ms = msN * P.lamFail; c.mf = 1; c.tf = c.ts = t; }
      if (fx.interference && !first && rA() < P.qInt) {
        for (const o of c.group.members) if (o !== c && o.introduced) o.ms *= uni(rA, 0.85, 0.95);
      }
    } else c.tru = first ? initState(wTrue, rating, true) : nextState(wTrue, c.tru.s, c.tru.d, tWhole, rating, true, p);
    c.introduced = true;

    // the learner's own FSRS-6 view, used to schedule
    if (first) c.sched = initState(W, rating, true);
    else c.sched = nextState(W, c.sched.s, c.sched.d, tWhole, rating, true, tWhole > 0 ? forgettingCurve(W, tWhole, c.sched.s, true) : 1);
    c.reps++; c.lastT = t; c.lastDay = day;

    // what happens next
    const stepAgain = () => { c.step = 0; c.dueT = t + STEPS_MIN[0] * MIN; };
    if (c.phase === 'new' || c.phase === 'learn') {
      const wasNew = c.phase === 'new';
      c.phase = 'learn';
      if (wasNew) c.step = 0;
      if (rating === 1) stepAgain();
      else if (rating === 4 || (rating === 3 && c.step >= STEPS_MIN.length - 1)) { c.phase = 'review'; schedule(c, d, interval(c.sched.s)); return ms; }
      else if (rating === 3) { c.step++; c.dueT = t + STEPS_MIN[c.step] * MIN; }
      else c.dueT = t + (c.step === 0 ? 5 : 15) * MIN;
      if (c.dueT < dayEndT) learning.push(c); else { c.dueDay = d + 1; (buckets.get(d + 1) || buckets.set(d + 1, []).get(d + 1)).push(c); }
    } else if (c.phase === 'review') {
      if (rating === 1) { c.lapses++; c.phase = 'relearn'; c.dueT = t + RELEARN_MIN * MIN; if (c.dueT < dayEndT) learning.push(c); else (buckets.get(d + 1) || buckets.set(d + 1, []).get(d + 1)).push(c); }
      else schedule(c, d, interval(c.sched.s));
    } else {                                                       // relearn
      if (rating >= 3) { c.phase = 'review'; schedule(c, d, interval(c.sched.s)); }
      else { c.dueT = t + RELEARN_MIN * MIN; if (c.dueT < dayEndT) learning.push(c); else (buckets.get(d + 1) || buckets.set(d + 1, []).get(d + 1)).push(c); }
    }
    return ms;
  }

  // ---------- the days ----------
  const dayStartOf = d => BASE_MS + d * DAY;
  for (let d = 0; d < D; d++) {
    const due = buckets.get(d); if (due) { overdue.push(...due); buckets.delete(d); }
    if (fx.schedNoise && rS() < P.skipP) continue;                  // a day off: everything waits
    const dayEnd = dayStartOf(d) + 23.5 * HOUR;
    let clock = dayStartOf(d) + P.startHour * HOUR + Math.floor(rS() * HOUR);
    const todays = [];
    const learning = [];
    // the cards of "yesterday's unfinished steps" are in overdue with phase learn/relearn: treat them as due right away
    overdue.sort((a, b) => (a.phase === 'review' ? a.dueDay : -1) - (b.phase === 'review' ? b.dueDay : -1) || (a.id < b.id ? -1 : 1));
    const take = overdue.slice(0, cfg.maxReviewsPerDay);
    overdue = overdue.slice(cfg.maxReviewsPerDay);
    for (const c of take) { if (c.phase === 'review') todays.push(c); else { c.dueT = clock; learning.push(c); } }
    let newLeft = overdue.length > 150 ? Math.ceil(P.newPerDay / 2) : P.newPerDay, ri = 0;
    for (let i = todays.length - 1; i > 0; i--) { const j = Math.floor(rS() * (i + 1)); [todays[i], todays[j]] = [todays[j], todays[i]]; }
    for (;;) {
      if (clock >= dayEnd) break;
      let pick = null, bi = -1;
      for (let i = 0; i < learning.length; i++) if (learning[i].dueT <= clock && (bi < 0 || learning[i].dueT < learning[bi].dueT)) bi = i;
      if (bi >= 0) { pick = learning[bi]; learning.splice(bi, 1); }
      else if (ri < todays.length) pick = todays[ri++];
      else if (newLeft > 0) { if (!newQueue.length) makeNote(); pick = newQueue.shift(); newLeft--; }
      else if (learning.length) { clock = Math.min(...learning.map(c => c.dueT)); continue; }
      else break;
      clock += answer(pick, clock, d, learning, dayEnd) + 1000 + Math.floor(rA() * 2000);
    }
    for (const c of learning) { c.dueDay = d + 1; let b = buckets.get(d + 1); if (!b) buckets.set(d + 1, b = []); b.push(c); }
    for (; ri < todays.length; ri++) overdue.push(todays[ri]);
  }

  // ---------- output ----------
  const used = cardList.filter(c => c.reps > 0);
  for (const c of used) cards.push({ id: c.id, deckId: deckIds[c.deck], noteId: c.noteId });
  const truth = {
    simVersion: SIM_VERSION, seed, world: cfg.world, effects: { ...fx }, params: { ...P, firstDist: [...P.firstDist] }, baseMs: BASE_MS,
    w: wTrue, p: Float64Array.from(pLog), bad, logG,
    card: Object.fromEntries(used.map(c => [c.id, { delta: c.delta, deltaOwn: c.delta - P.deckOff[c.deck], group: c.group.id, note: c.noteId }]))
  };
  return { id: `sim${seed}`, logs, cards, decks: deckIds.map(id => ({ id })), truth };
}

export function* learners(config = {}, seed = 1) {
  const cfg = resolveConfig(config);
  for (let k = 0; k < cfg.count; k++) yield makeLearner(cfg, seed + k);
}

// ---------- the truth-based numbers ----------
// Rows that are scored the way the FSRS tools score them: not the first answer of a card, and on a later UTC date than the card's last answer.
// Returns [{ i, y, p }] for 'long' rows; 'same' rows (same date) are kept apart.
export function scoredRows(learner) {
  const last = new Map(), long = [], same = [];
  learner.logs.forEach((l, i) => {
    const day = Math.floor(l.timestamp / DAY), prev = last.get(l.cardId);
    last.set(l.cardId, day);
    if (prev === undefined) return;
    (day > prev ? long : same).push({ i, y: l.rating > 1 ? 1 : 0, p: learner.truth.p[i] });
  });
  return { long, same };
}
export function logLossOf(rows, pOf = r => r.p) {
  let s = 0;
  for (const r of rows) { const p = clamp(pOf(r), 1e-6, 1 - 1e-6); s -= r.y ? Math.log(p) : Math.log(1 - p); }
  return rows.length ? s / rows.length : 0;
}
