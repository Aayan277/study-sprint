// algo2 harness: drives one copy's REAL scheduling modules (v3.4 srs.js, queue.js, study-data.js loadAll/countFor,
// exam.js, balance.js, autograde.js, game.js weightedQueue/timeLimit, browse-logic.js leech rules) with a stochastic
// learner. Extends simcmp/harness.mjs (same truth model, same Review mirror) with:
//   - Play before Review on Play days (so Play meets due cards), MC / MC-Hard / typing / mixed rounds
//   - recognition > recall for multiple choice (partial knowledge + guessing), weaker testing effect for MC
//   - answer times that depend on true R, the person's own speed and the text length (for B6)
//   - an "ideal rater" (from true R) to score auto-ratings
//   - breaks (B9): k days off, daily review limit, recovery metrics
//   node harness2.mjs <copyDir> <scenario> <mem:speed> <seedFrom> <seedTo>
// env: PLAY_MODE=mc|mchard|typing|mix  PLAY_LEN=20  PLAY_P=0.4  MC_LAMBDA=0.5  BREAK=0  SPEED_JSON={...}
//      RESCUE=N   (B1) on the day the break ends, start a catch-up plan over N days when Q.rescueOffer() would offer one
//                 (always for a deck with an exam, to show that exam decks are exempt). 0 / unset = no plan.
//      PAUSE=0|1  pause new cards during the plan (default 1)
//      AWAY=all|<n>  (B1) "I'm away until...": on the last study day before the break, also review ahead every card
//                 that comes due during the break (all), or the n soonest. Unset = off.
//      CARDS=n    override the number of cards (Gb has 1000, all introduced by day 40; 2000 keeps new cards coming).
//      OPT=1      (FSRS optimizer, PR 2) once 400 reviews count, and then every OPT_EVERY (30) days, fit the learner's own weights with the
//                 app's real fsrs-data.js + fsrs-fit.js (history from the simulated review log; fitChecked: fit on the first 80%, judged on the last 20%, refit on all)
//                 and keep them in settings.fsrsParams only if they predict better there. Needs a copy that has js/fsrs-fit.js. OPT_CONFIG='{...}' overrides FIT_DEFAULTS. Extra metrics:
//                 revR (mean true recall at the moment of a Review answer on a graduated card), optRuns / optKept, and oos (log loss of
//                 what the app would use vs the standard weights, both scored on the last 20% after deciding on the first 80%).
//      Extra metrics for break scenarios: Rret (mean true recall on the first day back, before studying), recPeak / recP90 (largest and 90th-percentile answers a day after the break),
//      R30end (mean true recall 30 days after the break, non-exam decks), offered (did the offer fire).
import { register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
register('./loader.mjs', import.meta.url);

const [,, verDir, scenario, learnerArg, seedFrom, seedTo] = process.argv;
const [learner, speedName] = learnerArg.split(':');
const here = path.dirname(new URL(import.meta.url).pathname);
const J = p => import(pathToFileURL(path.resolve(verDir, 'js', p)).href);

let NOW = 0;
Date.now = () => NOW;
const DAY = 86400000, HOUR = 3600000;

const srs = await J('srs.js');
const examM = await J('exam.js');
const Q = await J('queue.js');
const SD = await J('study-data.js');
const BAL = await J('balance.js');
const SCH = await J('sched-settings.js');
const AG = await J('autograde.js');
const GAME = await J('game.js');
const BL = await J('browse-logic.js');
const DT = await J('deck-tree.js');
const OPT = process.env.OPT === '1', OPT_EVERY = +(process.env.OPT_EVERY ?? 30);
const FD = OPT ? await J('fsrs-data.js') : null;
const FIT = OPT ? await J('fsrs-fit.js') : null;
const DAYS = await J('days.js');
const db = await import(pathToFileURL(path.join(here, 'memdb.mjs')).href);
if (process.env.SPEED_JSON && AG.SPEED) Object.assign(AG.SPEED, JSON.parse(process.env.SPEED_JSON));   // B6 tuning grid

// ---------- truth (same as simcmp) ----------
const TF = await import(pathToFileURL(path.join(here, 'deps/node_modules/ts-fsrs/dist/index.mjs')).href);
const W0 = [...TF.default_w];
const LEARNERS = {
  default: w => w,
  forgetful: w => w.map((x, i) => (i <= 3 ? x * 0.5 : i === 8 ? x - 0.5 : i === 11 ? x * 0.7 : i === 20 ? 0.4 : x)),
  strong: w => w.map((x, i) => (i <= 3 ? x * 1.6 : i === 8 ? x + 0.35 : i === 20 ? 0.12 : x))
};
const TW = LEARNERS[learner](W0);
const TRUE = TF.fsrs(TF.generatorParameters({ w: TW, enable_fuzz: false, enable_short_term: true, learning_steps: ['1m', '10m'], relearning_steps: ['10m'] }));
const TD = TRUE.parameters.w[20], TFAC = 0.9 ** (-1 / TD) - 1;
const trueR = (tc, t) => (tc.state === 0 || !tc.last_review ? 0 : (1 + TFAC * Math.max(0, (t - tc.last_review.getTime()) / DAY) / tc.stability) ** -TD);
const AD = 0.1542, AFAC = 0.9 ** (-1 / AD) - 1;
const appR = (st, t) => (st.stability > 0 ? (1 + AFAC * Math.max(0, (t - (st.lastReview || st.due - (st.scheduledDays || 0) * DAY)) / DAY) / st.stability) ** -AD : 0);

// ---------- person speed (B6) ----------
// base seconds per question at 25 chars and R = 1; typing seconds per answer character
const SPEEDS = { fast: { P: 1.4, type: 0.15 }, med: { P: 2.2, type: 0.22 }, slow: { P: 3.6, type: 0.30 } };
const SP = SPEEDS[speedName || 'med'];
const BETA = 1.2, SIG = 0.3;           // time × exp(BETA (1 − R)), lognormal noise σ
const MC_LAMBDA = +(process.env.MC_LAMBDA ?? 0.5);   // MC recall strengthens true memory this fraction of a Good review
const REC_EXP = { mc: 0.4, mchard: 0.7 };            // recognition strength R_rec = R^k (lookalikes in Hard: weaker)
const GUESS = { mc: 1 / 4, mchard: 1 / 6 };
// Ideal rater from true R before the answer (correct answers): Hard below H, Easy (typing) at or above E, else Good.
const IDEAL = { H: +(process.env.IDEAL_H ?? 0.75), E: +(process.env.IDEAL_E ?? 0.95) };

function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------- scenarios ----------
const T0 = Date.UTC(2026, 9, 12, 9);
const ymd = d => new Date(T0 + d * DAY).toISOString().slice(0, 10);
const BREAK = +(process.env.BREAK ?? 0);
const rl = () => (process.env.RL === 'none' ? null : +(process.env.RL ?? 150));         // RL=none: no daily review limit
const RESCUE = +(process.env.RESCUE ?? 0), PAUSE = (process.env.PAUSE ?? '1') !== '0', AWAY = process.env.AWAY || '';
const SC = {
  // B6 / MC: exam deck (300 cards, exam day 30) and non-exam deck (500 cards, 120 days)
  A: { cards: 300, exam: 30, newPerDay: 20 },
  G: { cards: 500, days: 120, newPerDay: 20, noExam: true },
  // B9: non-exam 500 cards, learn 60 days, break, 30 recovery days; exam 300 cards, break from day 24, exam day 45
  Gb: { cards: 1000, newPerDay: 25, noExam: true, reviewLimit: rl(), breakFrom: 60, recover: 30 },
  Ab: { cards: 600, exam: 50, newPerDay: 25, reviewLimit: rl(), breakFrom: 26 }
};
const cfg = SC[scenario];
if (process.env.CARDS) cfg.cards = +process.env.CARDS;      // more cards, so new cards are still being introduced at the break (to test PAUSE)
if (cfg.breakFrom !== undefined && cfg.noExam) cfg.days = cfg.breakFrom + BREAK + cfg.recover;
const PLAY_P = +(process.env.PLAY_P ?? 0.4), PLAY_LEN = +(process.env.PLAY_LEN ?? 20), PACE = 8;
const PLAY_MODE = process.env.PLAY_MODE || 'mix';

async function runSeed(seed) {
  db.reset({ newPerDay: cfg.newPerDay, reviewLimit: cfg.reviewLimit ?? null, timer: PACE });
  Math.random = mulberry(hash(`app:${seed}`));
  const dayRng = mulberry(hash(`day:${seed}`));
  const playRng = mulberry(hash(`play:${seed}`));
  const L = new Map();
  const examDay = cfg.noExam ? null : cfg.exam;
  const examDate = examDay === null ? null : ymd(examDay);
  const examT = examDay === null ? null : examM.examStart(examDate);
  db.S.decks = [{ id: 'd', name: 'd', created: 1, examDate }];
  for (let i = 0; i < cfg.cards; i++) {
    const id = `c${i}`;
    db.S.cards.set(id, { id, deckId: 'd', created: T0 - DAY + i, front: id, back: id });
    const r = mulberry(hash(`card:${seed}:${id}`));
    const z = gauss(r), m = Math.exp(0.4 * gauss(r));
    const chars = Math.round(clamp(25 * Math.exp(0.7 * gauss(r)), 3, 200));      // text read in a question
    const ansChars = Math.round(clamp(10 * Math.exp(0.6 * gauss(r)), 1, 40));     // typed answer length
    L.set(id, { rng: r, z, m, chars, ansChars, tc: TF.createEmptyCard(new Date(T0)), exam: mulberry(hash(`exam:${seed}:${id}`))(), lastSrc: null });
  }
  const updateTrue = (info, rating, now, lambda = 1) => {
    const first = info.tc.state === 0, prevS = info.tc.stability, wasReview = info.tc.state === 2;
    info.tc = TRUE.next(info.tc, new Date(now), rating).card;
    if (first) { info.tc.stability *= info.m; info.tc.difficulty = clamp(info.tc.difficulty + 1.5 * info.z, 1, 10); }
    else if (lambda < 1 && wasReview && info.tc.stability > prevS) info.tc.stability = prevS + lambda * (info.tc.stability - prevS);
  };
  const st = { nextRev: { mc: [0, 0], typing: [0, 0], review: [0, 0] }, revR: [0, 0] };   // recall at the next Review, by what counted last; true recall at Review answers
  const reviewAnswer = (id, now) => {
    const info = L.get(id), r = info.rng;
    let rating;
    if (info.tc.state === 0) {
      const pA = clamp(0.25 + 0.1 * info.z, 0.05, 0.6), u = r();
      rating = u < pA ? 1 : u < pA + 0.15 ? 2 : u < pA + 0.25 ? 4 : 3;
    } else {
      const R = trueR(info.tc, now);
      st.revR[0] += R; st.revR[1]++;
      if (r() >= R) rating = 1;
      else { const pH = 0.08 + 0.5 * (1 - R), pE = 0.25 * R ** 6, u = r(); rating = u < pH ? 2 : u < pH + pE ? 4 : 3; }
    }
    updateTrue(info, rating, now);
    return rating;
  };
  // A Play answer. kind: 'mc' | 'mchard' | 'typing'. limitMs from the app's own timeLimit().
  const playAnswer = (id, now, kind, limitMs) => {
    const info = L.get(id), r = info.rng;
    const R = trueR(info.tc, now);
    const recalled = r() < R;
    const lenF = 0.5 + info.chars / 50;
    const noise = () => Math.exp(SIG * gauss(r));
    const rt = SP.P * lenF * Math.exp(BETA * (1 - R)) * noise() * 1000;
    let ok, ms, how;
    if (kind === 'typing') {
      const typeMs = info.ansChars * SP.type * Math.exp(0.2 * gauss(r)) * 1000;
      ok = recalled; how = recalled ? 'recall' : 'none';
      ms = recalled ? rt + typeMs : rt * 1.5 + 0.5 * typeMs;
    } else {
      const Rrec = R ** REC_EXP[kind];
      const recognized = recalled || r() < (Rrec - R) / Math.max(1e-9, 1 - R);
      if (recalled) { ok = true; how = 'recall'; ms = rt; }
      else if (recognized) { ok = true; how = 'recognize'; ms = rt * 1.5; }
      else { ok = r() < GUESS[kind]; how = 'guess'; ms = SP.P * lenF * 2.5 * noise() * 1000; }
    }
    let timedOut = false;
    if (ms >= limitMs) { timedOut = true; ok = false; ms = limitMs; }
    // true memory: a successful retrieval strengthens it (MC less: recognition), a failed one is a lapse
    if (recalled && !timedOut) updateTrue(info, 3, now, kind === 'typing' ? 1 : MC_LAMBDA);
    else updateTrue(info, 1, now);
    return { ok, ms: Math.round(ms), timedOut, R, how };
  };

  const perDay = [];
  let suspended = 0;
  const pl = { answers: 0, applied: 0, appliedDue: 0, mcDueApplied: 0, mcDueLogged: 0, corr: 0, acc: 0, accApplied: 0, nApplied: 0,
    given: [0, 0, 0, 0, 0], ideal: [0, 0, 0, 0, 0], hardWhenIdealGood: 0, idealGood: 0, guessedApplied: 0, recogApplied: 0, profiled: 0 };
  const suspend = id => { const c = db.S.cards.get(id); if (!c.suspended) { db.S.cards.set(id, BL.markLeech(c, 'suspend')); suspended++; } };
  const thr = () => db.S.settings.leechThreshold;
  const optsFor = (settings, decksNow, card, now, balance) => {
    const deck = DT.effectiveDeck(decksNow, card.deckId);
    return { ...examM.examOptions(SCH.deckSchedulerOptions(settings, deck), deck, now), balance };
  };
  const noteNext = (id, prev, rating) => {         // a Review answer on a graduated card: did the learner recall it?
    const info = L.get(id);
    if (prev && prev.state === 2 && info.lastSrc) { const b = st.nextRev[info.lastSrc]; b[0]++; if (rating !== 1) b[1]++; }
  };


  // ---- the optimizer (js/optimize-sheet.js startRun, without the page): fit, judge on what the scheduler uses, keep only if better ----
  const run = g => { for (;;) { const r = g.next(); if (r.done) return r.value; } };
  const optStat = { runs: 0, kept: 0 };
  let lastOpt = null;
  const optInput = hist => ({ cards: hist.cards, current: SCH.cleanFsrsParams(db.S.settings.fsrsParams)?.w || [...TF.default_w], defaults: [...TF.default_w], bounds: TF.CLAMP_PARAMETERS(TF.W17_W18_Ceiling, true), config: process.env.OPT_CONFIG ? JSON.parse(process.env.OPT_CONFIG) : undefined });
  function maybeOptimize(d) {
    if (!OPT || (lastOpt !== null && d - lastOpt < OPT_EVERY)) return;
    const hist = FD.buildHistories(db.S.logs);
    if (hist.reviews < FD.MIN_REVIEWS) return;
    lastOpt = d;
    const input = { ...optInput(hist), steps: hist.cards.map(() => 1) };       // one deck, one relearning step
    const res = run(FIT.fitChecked(input));                                   // fit on the first 80%, judge on the last 20%, refit only if it wins
    if (res.status === 'not-enough') return;
    optStat.runs++;
    if (res.status !== 'better') return;
    optStat.kept++;
    db.S.settings.fsrsParams = { w: TF.clipParameters(res.w, 0, true), at: NOW, reviews: hist.reviews, cards: hist.cardsUsed,
      logLoss: { before: res.before.logLoss, after: res.after.logLoss }, rmse: { before: res.before.rmse, after: res.after.rmse }, version: SCH.FSRS_VERSION };
  }

  // ---- Review session (review.js start()/answer() of v3.4) ----
  async function reviewSession(day) {
    const data = await SD.loadAll();
    const cards = SD.countFor(data, ['d']).cards;
    const now0 = NOW;
    const ex = examM.examSchedule(data.decks, cards, data.statesById, now0, (card, s, es) =>
      srs.examGain(s, es, now0, SCH.deckSchedulerOptions(data.settings, DT.effectiveDeck(data.decks, card.deckId))), data.exam.caps);
    const { queue, waiting } = Q.buildQueue(cards, data.statesById, data.newLeft, now0, data.reviewLeft, ex, undefined, data.rescue);
    const balance = { load: BAL.loadByDay([...data.statesById.values()]), easyDays: data.settings.easyDays };
    for (;;) {
      const item = Q.takeNext(queue, waiting, NOW);
      if (!item) break;
      const id = item.card.id, prev = data.statesById.get(id) || null;
      const rating = reviewAnswer(id, NOW);
      noteNext(id, prev, rating);
      const next = srs.rate(id, prev, rating, optsFor(data.settings, data.decks, item.card, NOW, balance), NOW);
      await db.saveReview(next, { cardId: id, timestamp: NOW, source: 'review', mode: 'flip', correct: rating !== 1, ms: 8000, rating, state: prev ? prev.state : 0 });
      L.get(id).lastSrc = 'review';
      data.statesById.set(id, next);
      day.answers++;
      if (prev && prev.state === 2) { day.reviews++; if (rating === 1) day.lapses++; }
      if ((next.state === 1 || next.state === 3) && next.due <= DAYS.dayEnd(NOW)) Q.addWaiting(waiting, { card: item.card, kind: 'learn', due: next.due });
      if (next.lapses > (prev?.lapses || 0) && BL.isNewLeechCounted(prev?.lapses || 0, next.lapses, await db.getCardLogs(id), thr())) {
        suspend(id);
        for (const list of [queue, waiting]) for (let i = list.length - 1; i >= 0; i--) if (list[i].card.id === id) list.splice(i, 1);
      }
      NOW += 10000;
    }
  }

  // ---- Play round (play.js renderPlay() → start() → record() → checkLeech() of this copy) ----
  async function playRound(day) {
    const d = await SD.loadAll();
    const data = { settings: d.settings, decks: d.decks, cards: d.cards, statesById: d.statesById, examCaps: d.exam.caps,
      playedToday: new Set(d.logs.filter(l => l.source === 'play' && l.applied).map(l => l.cardId)), newLeft: d.newLeft };
    if (AG.speedProfiles) data.speed = AG.speedProfiles(await db.getLogsSince(NOW - 60 * DAY));
    const kind = PLAY_MODE === 'mix' ? (playRng() < 0.5 ? 'mc' : 'typing') : PLAY_MODE;
    const qtype = kind === 'typing' ? 'typing' : 'front', hard = kind === 'mchard';
    const typing = qtype === 'typing';
    const pool = data.cards.filter(c => c.deckId === 'd');
    const weightOf = c => { const s = data.statesById.get(c.id); return 1 + 2 * Math.min(s?.lapses || 0, 5); };
    const qs = GAME.weightedQueue(pool, PLAY_LEN, weightOf, playRng);
    const limitMs = GAME.timeLimit({ fmt: 'classic', pace: PACE, typing, i: 0 });
    for (const card of qs) {
      const id = card.id;
      if (db.S.cards.get(id).suspended) continue;
      const info = L.get(id);
      const { ok, ms, timedOut, R, how } = playAnswer(id, NOW, kind, limitMs);
      const chars = info.chars;
      const speed = data.speed ? data.speed.get(AG.speedKey(qtype, hard)) : undefined;
      if (speed) pl.profiled++;
      let rating = AG.autoRating({ ok, ms, limitMs, typing, speed, chars });
      const prev = data.statesById.get(id);
      const examDeck = !!examM.examInfo(DT.effectiveDeck(data.decks, card.deckId), NOW);
      const newRoom = Q.newRoomFor(data.newLeft, card.deckId);
      const cap = data.examCaps.get(id);
      const dueState = prev && cap !== undefined ? { ...prev, due: Math.min(prev.due, cap) } : prev;
      let decision = AG.scheduleDecision({ state: dueState, rating, alreadyToday: data.playedToday.has(id), now: NOW, examDeck, newRoom,
        timedOut, limitMs, fmt: 'classic', mc: !typing, hard });
      if (AG.appliedRating) rating = AG.appliedRating({ decision, rating, mc: !typing, hard, examDeck });
      if (decision === 'first') Q.takeNewFor(data.newLeft, card.deckId);
      const log = { cardId: id, timestamp: NOW, source: 'play', mode: qtype, format: 'classic', correct: ok, ms, rating, chars, hard,
        state: prev ? prev.state : 0, applied: false, reason: decision };
      // scoring vs the ideal rater (correct answers on started cards)
      pl.answers++;
      const ideal = ok ? (R < IDEAL.H ? 2 : typing && R >= IDEAL.E ? 4 : 3) : 1;
      const isApplied = AG.applies(decision);
      if (ok && prev && prev.state !== 0) {
        pl.corr++; if (rating === ideal) pl.acc++;
        if (ideal === 3) { pl.idealGood++; if (rating === 2) pl.hardWhenIdealGood++; }
        if (isApplied) { pl.nApplied++; if (rating === ideal) pl.accApplied++; pl.given[rating]++; pl.ideal[ideal]++; if (how === 'guess') pl.guessedApplied++; if (how === 'recognize') pl.recogApplied++; }
      }
      if (decision === 'mc-due') pl.mcDueLogged++;
      if (isApplied) {
        const balance = { load: BAL.loadByDay([...data.statesById.values()]), easyDays: data.settings.easyDays };
        const next = srs.rate(id, prev, rating, optsFor(data.settings, data.decks, card, NOW, balance), NOW);
        log.applied = true;
        await db.saveReview(next, log);
        data.statesById.set(id, next);
        data.playedToday.add(id);
        pl.applied++;
        if (decision === 'due') { pl.appliedDue++; day.playDue++; if (!typing && ok) pl.mcDueApplied++; }
        if (prev && prev.state === 2) info.lastSrc = typing ? 'typing' : 'mc';
        const leech = !(log.reason === 'again' || next.lapses <= (prev?.lapses || 0)) && BL.isNewLeechCounted(prev?.lapses || 0, next.lapses, await db.getCardLogs(id), thr());
        if (leech) suspend(id);
      } else await db.addLog(log);
      NOW += 6000;
    }
  }

  // ---- B1: "I'm away until..." (Options → Custom study → Review ahead, customQueue('ahead') of study-data.js) ----
  async function awaySession(day) {
    const data = await SD.loadAll();
    const cards = SD.countFor(data, ['d']).cards;
    let list = Q.aheadQueue(cards, data.statesById, BREAK, NOW, data.exam.caps).queue;       // soonest first
    if (AWAY !== 'all') list = list.slice(0, +AWAY);
    for (const item of list) {
      const id = item.card.id, prev = data.statesById.get(id);
      const rating = reviewAnswer(id, NOW);
      noteNext(id, prev, rating);
      const next = srs.rate(id, prev, rating, optsFor(data.settings, data.decks, item.card, NOW, { load: BAL.loadByDay([...data.statesById.values()]), easyDays: data.settings.easyDays }), NOW);
      await db.saveReview(next, { cardId: id, timestamp: NOW, source: 'review', mode: 'flip', correct: rating !== 1, ms: 8000, rating, state: prev ? prev.state : 0 });
      L.get(id).lastSrc = 'review';
      data.statesById.set(id, next);
      day.answers++; day.reviews++; if (rating === 1) day.lapses++;
      NOW += 10000;
    }
  }
  // ---- B1: the catch-up plan, started on the day the break ends (Today's banner would offer it) ----
  const plan = { offered: false, backlog: 0 };
  async function startRescue() {
    const data = await SD.loadAll();
    const exempt = new Set(data.decks.filter(d => examM.examInfo(DT.effectiveDeck(data.decks, d.id), NOW)).map(d => d.id));
    const start = DAYS.dayStart(NOW);
    const backlog = Q.rescueBacklog(data.cards, data.statesById, exempt, start);
    const answers = perDay.slice(0, bFrom).map(x => x.answers).filter(n => n > 0).slice(-14).sort((a, b) => a - b);
    const typical = answers.length ? answers[answers.length >> 1] : 20;
    const offer = Q.rescueOffer({ backlog, typicalDaily: typical, now: NOW });
    plan.offered = !!offer; plan.backlog = backlog;
    if (offer || exempt.size) db.S.settings.rescue = { start, days: RESCUE, backlog: exempt.size ? data.cards.filter(c => { const s = data.statesById.get(c.id); return s && s.state === 2 && s.due < start; }).length : backlog, pauseNew: PAUSE, at: NOW };
  }

  const totalDays = cfg.noExam ? cfg.days : examDay;
  const bFrom = cfg.breakFrom, bTo = bFrom === undefined ? -1 : bFrom + BREAK;      // days [bFrom, bTo) skipped
  const ids = [...db.S.cards.keys()];
  const backlog = () => { const end = DAYS.dayEnd(NOW); let n = 0; for (const id of ids) { const s = db.S.states.get(id); if (s && s.state === 2 && s.due <= end && !db.S.cards.get(id).suspended) n++; } return n; };
  const snap = t => { let sum = 0, lost = 0, started = 0; for (const id of ids) { const tc = L.get(id).tc; if (tc.state === 0) continue; started++; const r = trueR(tc, t); sum += r; if (r < 0.5) lost++; } return { meanR: sum / ids.length, lost, started }; };
  const rec = { answers: [], cleared: null, lostDays: 0, rSum: 0, n: 0, backlogStart: null, maxBacklog: 0, reviews: 0, lapses: 0 };
  const daily = [];                                   // true-memory snapshot at 09:00 each day, before studying
  for (let d = 0; d < totalDays; d++) {
    NOW = T0 + d * DAY;
    daily.push(snap(NOW));
    const day = { reviews: 0, answers: 0, lapses: 0, playDue: 0 };
    perDay.push(day);
    if (d >= bFrom && d < bTo) continue;
    const inRec = bFrom !== undefined && d >= bTo;
    if (inRec) { const s = daily[d]; rec.lostDays += s.lost; rec.rSum += s.meanR; rec.n++; if (d === bTo) rec.backlogStart = backlog(); }
    if (RESCUE > 0 && d === bTo) await startRescue();
    maybeOptimize(d);
    const play = dayRng() < PLAY_P;
    if (play) { await playRound(day); NOW += 10 * 60000; }      // Play first (e.g. on the bus), then Review
    await reviewSession(day);
    if (AWAY && d === bFrom - 1 && BREAK > 0) await awaySession(day);
    if (inRec) {
      rec.answers.push(day.answers);
      const b = backlog(); rec.maxBacklog = Math.max(rec.maxBacklog, b); rec.reviews += day.reviews; rec.lapses += day.lapses;
      if (rec.cleared === null && b === 0) rec.cleared = d - bTo + 1;
    }
  }

  const T = cfg.noExam ? T0 + cfg.days * DAY : examT + 5 * HOUR;
  const Rs = ids.map(id => trueR(L.get(id).tc, T));
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  // long-run retention for non-exam decks: mean true R at 09:00, averaged over the last 60 days
  let longR = null;
  if (cfg.noExam && cfg.breakFrom === undefined) longR = mean([...daily.slice(-60).map(x => x.meanR), snap(T).meanR]);
  // how far the app's belief exceeds the truth, over graduated cards at the end
  let over = 0, nOver = 0;
  for (const id of ids) { const s = db.S.states.get(id); if (s && s.state === 2) { over += appR(s, T) - trueR(L.get(id).tc, T); nOver++; } }
  const out = {
    seed, n: ids.length, meanR: mean(Rs), longR, p80: mean(Rs.map(r => +(r >= 0.8))), lostEnd: Rs.filter((r, i) => r < 0.5 && L.get(ids[i]).tc.state !== 0).length,
    score: mean(ids.map((id, i) => +(L.get(id).exam < Rs[i]))),
    reviews: perDay.reduce((n, x) => n + x.reviews, 0), answers: perDay.reduce((n, x) => n + x.answers, 0),
    maxDaily: Math.max(...perDay.map(x => x.reviews)), suspended, over: nOver ? over / nOver : 0,
    play: pl, nextRev: st.nextRev, perDay: perDay.map(x => x.reviews), revR: st.revR[1] ? st.revR[0] / st.revR[1] : null
  };
  if (OPT) {
    Object.assign(out, { optRuns: optStat.runs, optKept: optStat.kept, wFinal: db.S.settings.fsrsParams?.w ?? null });
    // an out-of-sample score of what the app does: use only the first 80% of the days, run the whole decision on it (fitChecked), and score the
    // weights it would use (the fitted ones if it keeps them, else the standard ones) against the standard weights on the last 20%.
    // rawAfter: the same without the decision (always take the fit), for comparison.
    const hist = FD.buildHistories(db.S.logs);
    const { head, test } = FIT.splitHistories(hist.cards);
    const base = { ...optInput(hist), current: [...TF.default_w] };
    const r = run(FIT.fitChecked({ ...base, cards: head, steps: head.map(() => 1) }));
    const raw = run(FIT.fit({ ...base, cards: head, config: { ...base.config, minReviews: 1 } }));
    const use = r.status === 'better' ? r.w : base.current;
    const before = FIT.evaluate(test, base.current);
    out.oos = r.status === 'not-enough' || raw.status === 'not-enough' ? null : { before: before.logLoss, after: FIT.evaluate(test, use).logLoss, rawAfter: FIT.evaluate(test, raw.fitted).logLoss, n: before.n, kept: r.status === 'better' };
    out.reviewsCounted = hist.reviews;
  }
  if (cfg.breakFrom !== undefined) {
    const s = snap(cfg.noExam ? T : NOW);
    Object.assign(out, { recCleared: rec.cleared ?? (cfg.noExam ? cfg.recover + 1 : totalDays - bTo + 1), recClearedCensored: rec.cleared === null,
      recLostDays: rec.lostDays, recMeanR: rec.n ? rec.rSum / rec.n : null, recBacklog0: rec.backlogStart, recMaxBacklog: rec.maxBacklog,
      recReviews: rec.reviews, recLapses: rec.lapses, endLost: s.lost });
    const sorted = [...rec.answers].sort((a, b) => a - b);
    Object.assign(out, { recPeak: sorted.length ? sorted[sorted.length - 1] : null, recP90: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)] : null,
      offered: plan.offered, planBacklog: plan.backlog, Rret: daily[bTo] ? daily[bTo].meanR : null });
    if (cfg.noExam) out.R30end = s.meanR;
    if (cfg.noExam) { out.R7 = daily[bTo + 7].meanR; out.lost7 = daily[bTo + 7].lost; out.R14 = daily[bTo + 14].meanR; out.preBreakR = daily[bFrom].meanR; }
  }
  return out;
}

for (let s = +seedFrom; s <= +seedTo; s++) process.stdout.write(JSON.stringify(await runSeed(s)) + '\n');
