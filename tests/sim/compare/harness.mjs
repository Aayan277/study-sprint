// Stochastic-learner harness that drives one version's REAL scheduling modules (srs.js, queue.js, study-data.js
// loadAll/countFor, exam.js, balance.js, autograde.js, game.js weightedQueue, browse-logic.js leech rules).
//   node harness.mjs <versionDir> <scenario> <learner> <seedFrom> <seedTo>
// Prints one JSON line per seed. TZ is forced to UTC by the runner.
import { register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
register('./loader.mjs', import.meta.url);

const [,, verDir, scenario, learner, seedFrom, seedTo] = process.argv;
const here = path.dirname(new URL(import.meta.url).pathname);
const J = p => import(pathToFileURL(path.resolve(verDir, 'js', p)).href);

// ---------- clock ----------
let NOW = 0;
Date.now = () => NOW;
const DAY = 86400000, HOUR = 3600000;

// ---------- the app's modules (this version) ----------
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
const DAYS = await J('days.js');
const db = await import(pathToFileURL(path.join(here, 'memdb.mjs')).href);
const IS31 = typeof examM.examSchedule === 'function';      // v3.1 code path (final pass, gain order, new leech rule)

// ---------- truth: the learner's own FSRS ----------
const TF = await import(pathToFileURL(path.join(here, 'deps/node_modules/ts-fsrs/dist/index.mjs')).href);
const W0 = [...TF.default_w];
const LEARNERS = {
  default: w => w,
  // forgets faster: initial stabilities halved, stability gains ~40% smaller, post-lapse S lower, steeper decay
  forgetful: w => w.map((x, i) => (i <= 3 ? x * 0.5 : i === 8 ? x - 0.5 : i === 11 ? x * 0.7 : i === 20 ? 0.4 : x)),
  // remembers better: initial stabilities x1.6, stability gains ~40% larger, flatter decay
  strong: w => w.map((x, i) => (i <= 3 ? x * 1.6 : i === 8 ? x + 0.35 : i === 20 ? 0.12 : x))
};
const TW = LEARNERS[learner](W0);
const TRUE = TF.fsrs(TF.generatorParameters({ w: TW, enable_fuzz: false, enable_short_term: true, learning_steps: ['1m', '10m'], relearning_steps: ['10m'] }));
const TD = TRUE.parameters.w[20], TFAC = 0.9 ** (-1 / TD) - 1;
const trueR = (tc, t) => (tc.state === 0 || !tc.last_review ? 0 : (1 + TFAC * Math.max(0, (t - tc.last_review.getTime()) / DAY) / tc.stability) ** -TD);
// The app's own prediction (default FSRS-6 decay), same formula as v3.1 exam.js recallAt.
const AD = 0.1542, AFAC = 0.9 ** (-1 / AD) - 1;
const appR = (st, t) => (st.stability > 0 ? (1 + AFAC * Math.max(0, (t - (st.lastReview || st.due - (st.scheduledDays || 0) * DAY)) / DAY) / st.stability) ** -AD : 0);

// ---------- randomness (common random numbers across versions) ----------
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------- scenarios ----------
const T0 = Date.UTC(2026, 9, 12, 9);   // Monday 12 Oct 2026, 09:00 (UTC)
const ymd = d => new Date(T0 + d * DAY).toISOString().slice(0, 10);
const SC = {
  A:    { cards: 300, exam: 30, newPerDay: 20 },
  A_easy: { cards: 300, exam: 30, newPerDay: 20, easyDays: ['minimum', 'normal', 'normal', 'normal', 'normal', 'normal', 'reduced'] },
  B10:  { cards: 300, exam: 10, newPerDay: 50 },       // 50/day = the app's own "N new a day to finish by the exam"
  B60:  { cards: 300, exam: 60, newPerDay: 20 },
  C:    { cards: 1000, exam: 45, newPerDay: 25, reviewLimit: 120 },
  D:    { cards: 300, exam: 74, newPerDay: 20, examSetDay: 60 },
  E1:   { cards: 300, exam: 30, newPerDay: 20, importDay: 23, importN: 100, importKind: 'new' },
  E2:   { cards: 300, exam: 30, newPerDay: 20, importDay: 23, importN: 100, importKind: 'history' },
  F1:   { cards: 300, exam: 30, newPerDay: 20, skip: 'random2' },
  F2:   { cards: 300, exam: 30, newPerDay: 20, skip: 'before-window' },
  G:    { cards: 500, days: 120, newPerDay: 20, noExam: true },
  H1:   { cards: 300, exam: 30, newPerDay: 20, subdecks: 3, study: 'all-in-turn' },
  H2:   { cards: 300, exam: 30, newPerDay: 20, subdecks: 3, study: 'one-per-day' }
};
const cfg = SC[scenario];
const PLAY_P = +(process.env.PLAY_P ?? 0.4), PLAY_N = 20, PLAY_LIMIT = 8000;

async function runSeed(seed) {
  db.reset({ newPerDay: cfg.newPerDay, reviewLimit: cfg.reviewLimit ?? null, ...(cfg.easyDays ? { easyDays: cfg.easyDays } : {}) });
  Math.random = mulberry(hash(`app:${seed}`));                 // the app's own randomness (balance tie-breaks)
  const dayRng = mulberry(hash(`day:${seed}`));
  const playRng = mulberry(hash(`play:${seed}`));
  const L = new Map();                                          // card id -> learner info (true memory)
  const examDay = cfg.noExam ? null : cfg.exam;
  const examDate = examDay === null ? null : ymd(examDay);
  const examT = examDay === null ? null : examM.examStart(examDate);
  // decks
  const decks = [];
  if (cfg.subdecks) {
    decks.push({ id: 'P', name: 'P', created: 1, examDate });
    for (let i = 0; i < cfg.subdecks; i++) decks.push({ id: `S${i}`, name: `S${i}`, created: 2 + i, parentId: 'P' });
  } else decks.push({ id: 'd', name: 'd', created: 1, examDate: cfg.examSetDay !== undefined || cfg.noExam ? null : examDate });
  db.S.decks = decks;
  const leafIds = cfg.subdecks ? decks.slice(1).map(d => d.id) : ['d'];
  const addCard = (i, deckId, created) => {
    const id = `c${i}`;
    db.S.cards.set(id, { id, deckId, created, front: id, back: id });
    const r = mulberry(hash(`card:${seed}:${id}`));
    L.set(id, { rng: r, z: gauss(r), m: Math.exp(0.4 * gauss(r)), tc: TF.createEmptyCard(new Date(T0)), exam: mulberry(hash(`exam:${seed}:${id}`))() });
    return id;
  };
  for (let i = 0; i < cfg.cards; i++) addCard(i, leafIds[Math.floor(i * leafIds.length / cfg.cards)], T0 - DAY + i);

  // the learner's true memory after an answer
  const updateTrue = (info, rating, now) => {
    const first = info.tc.state === 0;
    info.tc = TRUE.next(info.tc, new Date(now), rating).card;
    if (first) { info.tc.stability *= info.m; info.tc.difficulty = clamp(info.tc.difficulty + 1.5 * info.z, 1, 10); }
  };
  // Review: recall ~ Bernoulli(true R); fail -> Again; pass -> Hard/Good/Easy by R.
  const reviewAnswer = (id, now) => {
    const info = L.get(id), r = info.rng;
    let rating;
    if (info.tc.state === 0) {
      const pA = clamp(0.25 + 0.1 * info.z, 0.05, 0.6), u = r();
      rating = u < pA ? 1 : u < pA + 0.15 ? 2 : u < pA + 0.25 ? 4 : 3;
    } else {
      const R = trueR(info.tc, now);
      if (r() >= R) rating = 1;
      else { const pH = 0.08 + 0.5 * (1 - R), pE = 0.25 * R ** 6, u = r(); rating = u < pH ? 2 : u < pH + pE ? 4 : 3; }
    }
    updateTrue(info, rating, now);
    return rating;
  };
  const playAnswer = (id, now) => {
    const info = L.get(id), r = info.rng;
    const R = trueR(info.tc, now);
    const recalled = r() < R, ok = recalled || r() < 0.25;           // 4-option multiple choice: guesses
    let ms, timedOut = false;
    if (ok) ms = clamp(0.2 + 0.6 * (1 - R) + 0.3 * (r() - 0.5), 0.05, 0.98) * PLAY_LIMIT;
    else if (r() < 0.3) { timedOut = true; ms = PLAY_LIMIT; } else ms = 0.6 * PLAY_LIMIT;
    updateTrue(info, recalled ? 3 : 1, now);                          // retrieval practice changes true memory either way
    return { ok, ms, timedOut };
  };

  const perDay = [];
  let suspended = 0, playApplied = 0, playAgainNotDue = 0;
  const suspend = id => { const c = db.S.cards.get(id); if (!c.suspended) { db.S.cards.set(id, BL.markLeech(c, 'suspend')); suspended++; } };
  const thr = () => db.S.settings.leechThreshold;
  const optsFor = (settings, decksNow, card, now, balance) => {
    const deck = DT.effectiveDeck(decksNow, card.deckId);
    return { ...examM.examOptions(SCH.deckSchedulerOptions(settings, deck), deck, now), balance };
  };

  // ---- one Review session, mirroring review.js renderReview → countFor → start() → answer() of this version ----
  async function reviewSession(deckIds, day) {
    const data = await SD.loadAll();
    const cards = SD.countFor(data, deckIds).cards;
    const now0 = NOW;
    let qb;
    if (IS31) {
      const ex = examM.examSchedule(data.decks, cards, data.statesById, now0, (card, st, es) =>
        srs.examGain(st, es, now0, SCH.deckSchedulerOptions(data.settings, DT.effectiveDeck(data.decks, card.deckId))), data.exam.caps);
      qb = Q.buildQueue(cards, data.statesById, data.newLeft, now0, data.reviewLeft, ex);
    } else qb = Q.buildQueue(cards, data.statesById, data.newLeft, now0, data.reviewLeft);
    const { queue, waiting } = qb;
    const balance = { load: BAL.loadByDay([...data.statesById.values()]), easyDays: data.settings.easyDays };
    for (;;) {
      const item = Q.takeNext(queue, waiting, NOW);
      if (!item) break;
      const id = item.card.id, prev = data.statesById.get(id) || null;
      const rating = reviewAnswer(id, NOW);
      const next = srs.rate(id, prev, rating, optsFor(data.settings, data.decks, item.card, NOW, balance), NOW);
      await db.saveReview(next, { cardId: id, timestamp: NOW, source: 'review', mode: 'flip', correct: rating !== 1, ms: 8000, rating, state: prev ? prev.state : 0 });
      data.statesById.set(id, next);
      day.answers++;
      if (prev && prev.state === 2) day.reviews++;
      if ((next.state === 1 || next.state === 3) && next.due <= DAYS.dayEnd(NOW)) Q.addWaiting(waiting, { card: item.card, kind: 'learn', due: next.due });
      const leech = IS31
        ? next.lapses > (prev?.lapses || 0) && BL.isNewLeechCounted(prev?.lapses || 0, next.lapses, await db.getCardLogs(id), thr())
        : BL.isNewLeech(prev?.lapses || 0, next.lapses, thr());
      if (leech) {
        suspend(id);
        for (const list of [queue, waiting]) for (let i = list.length - 1; i >= 0; i--) if (list[i].card.id === id) list.splice(i, 1);
      }
      NOW += 10000;
    }
  }

  // ---- one Play round (classic, multiple choice, 8 s), mirroring play.js renderPlay → start() → record() → checkLeech() ----
  async function playRound(deckIds) {
    let data;
    if (IS31) {
      const d = await SD.loadAll();
      data = { settings: d.settings, decks: d.decks, cards: d.cards, statesById: d.statesById, examCaps: d.exam.caps,
        playedToday: new Set(d.logs.filter(l => l.source === 'play' && l.applied).map(l => l.cardId)), newLeft: d.newLeft };
    } else {
      const [settings, decksNow, allCards, states, logs] = await Promise.all([db.getSettings(), db.getDecks(), db.getAll('cards'), db.getAll('cardStates'), db.getLogsSince(DAYS.dayStart())]);
      decksNow.sort((a, b) => a.created - b.created);
      data = { settings, decks: decksNow, cards: allCards.filter(c => !BL.isHidden(c)), statesById: new Map(states.map(s => [s.cardId, s])),
        playedToday: new Set(logs.filter(l => l.source === 'play' && l.applied).map(l => l.cardId)),
        newLeft: Q.newLimits({ perDay: settings.newPerDay, decks: decksNow, logs, deckOf: new Map(allCards.map(c => [c.id, c.deckId])), extra: Q.extraNewToday(settings.extraNew), chains: DT.chainMap(decksNow) }) };
    }
    const ids = new Set(deckIds.flatMap(id => [...DT.subtreeIds(data.decks, id)]));
    const pool = data.cards.filter(c => ids.has(c.deckId));
    const weightOf = c => { const s = data.statesById.get(c.id); return 1 + 2 * Math.min(s?.lapses || 0, 5); };
    const qs = GAME.weightedQueue(pool, PLAY_N, weightOf, playRng);
    let balance = null;
    for (const card of qs) {
      const id = card.id;
      if (db.S.cards.get(id).suspended) continue;                     // dropped from the round
      const { ok, ms, timedOut } = playAnswer(id, NOW);
      const rating = AG.autoRating({ ok, ms, limitMs: PLAY_LIMIT, typing: false });
      const prev = data.statesById.get(id);
      const examDeck = !!examM.examInfo(DT.effectiveDeck(data.decks, card.deckId), NOW);
      const newRoom = Q.newRoomFor(data.newLeft, card.deckId);
      let decision;
      if (IS31) {
        const cap = data.examCaps.get(id);
        const dueState = prev && cap !== undefined ? { ...prev, due: Math.min(prev.due, cap) } : prev;
        decision = AG.scheduleDecision({ state: dueState, rating, alreadyToday: data.playedToday.has(id), now: NOW, examDeck, newRoom, timedOut, limitMs: PLAY_LIMIT, fmt: 'classic' });
      } else decision = AG.scheduleDecision({ state: prev, rating, alreadyToday: data.playedToday.has(id), now: NOW, examDeck, newRoom });
      if (decision === 'first') Q.takeNewFor(data.newLeft, card.deckId);
      const log = { cardId: id, timestamp: NOW, source: 'play', mode: 'front', format: 'classic', correct: ok, ms, rating, state: prev ? prev.state : 0, applied: false, reason: decision };
      if (AG.applies(decision)) {
        balance ||= { load: BAL.loadByDay([...data.statesById.values()]), easyDays: data.settings.easyDays };
        const next = srs.rate(id, prev, rating, optsFor(data.settings, data.decks, card, NOW, balance), NOW);
        log.applied = true;
        await db.saveReview(next, log);
        data.statesById.set(id, next);
        data.playedToday.add(id);
        playApplied++;
        if (decision === 'again') playAgainNotDue++;
        let leech;
        if (IS31) leech = !(log.reason === 'again' || next.lapses <= (prev?.lapses || 0)) && BL.isNewLeechCounted(prev?.lapses || 0, next.lapses, await db.getCardLogs(id), thr());
        else leech = BL.isNewLeech(prev?.lapses || 0, next.lapses, thr());
        if (leech) suspend(id);
      } else await db.addLog(log);
      NOW += 6000;
    }
  }

  // skip pattern
  const totalDays = cfg.noExam ? cfg.days : examDay;
  const skip = new Set();
  if (cfg.skip === 'random2') for (let w = 0; w * 7 < totalDays; w++) { const a = Math.floor(dayRng() * 7); let b = Math.floor(dayRng() * 6); if (b >= a) b++; skip.add(w * 7 + a); skip.add(w * 7 + b); }
  if (cfg.skip === 'before-window') { const first = examDay - Math.min(5, examDay); for (let k = 1; k <= 3; k++) skip.add(first - k); }

  for (let d = 0; d < totalDays; d++) {
    NOW = T0 + d * DAY;
    // events
    if (cfg.examSetDay === d) {
      // decks.js: saving a deck with a new exam date runs pullIn on its cards and saves what changed
      db.S.decks = db.S.decks.map(x => (x.id === 'd' ? { ...x, examDate } : x));
      const states = [...db.S.states.values()];
      const changed = IS31 ? examM.pullIn(states, { examDate }, NOW, db.S.settings.easyDays) : examM.pullIn(states, { examDate }, NOW);
      await db.putStates(changed);
    }
    if (cfg.importDay === d) {
      for (let k = 0; k < cfg.importN; k++) {
        const id = addCard(cfg.cards + k, 'd', NOW + k);
        if (cfg.importKind === 'history') {
          // An Anki deck with history: Review state, app stability 3-90 d, last seen 0-1.2 S days ago.
          const info = L.get(id), r = info.rng;
          const S = Math.exp(Math.log(3) + r() * (Math.log(90) - Math.log(3)));
          const D = 3 + 5 * r();
          const ago = Math.floor(r() * 1.2 * S + 0.5);
          const last = NOW - ago * DAY - 2 * HOUR;
          const ivl = Math.max(1, Math.round(S));
          await db.putStates([{ cardId: id, due: last + ivl * DAY, stability: S, difficulty: D, elapsedDays: 0, scheduledDays: ivl, learningSteps: 0, reps: 5, lapses: Math.floor(r() * 2), state: 2, lastReview: last }]);
          const tc = { ...TF.createEmptyCard(new Date(last)), state: 2, stability: S * info.m * (learner === 'forgetful' ? 0.6 : learner === 'strong' ? 1.4 : 1), difficulty: clamp(D + 1.5 * info.z, 1, 10), reps: 5, last_review: new Date(last), due: new Date(last + ivl * DAY) };
          info.tc = tc;
        }
      }
    }
    const day = { reviews: 0, answers: 0, skipped: skip.has(d) };
    perDay.push(day);
    if (skip.has(d)) continue;
    if (cfg.study === 'all-in-turn') for (const s of leafIds) { await reviewSession([s], day); NOW += 5 * 60000; }
    else if (cfg.study === 'one-per-day') await reviewSession([leafIds[d % leafIds.length]], day);
    else await reviewSession(cfg.subdecks ? ['P'] : ['d'], day);
    if (dayRng() < PLAY_P) { NOW += 30 * 60000; await playRound(cfg.subdecks ? ['P'] : ['d']); }
  }

  // ---- measurements ----
  const ids = [...db.S.cards.keys()];
  const T = cfg.noExam ? T0 + cfg.days * DAY : examT + 5 * HOUR;        // exam morning (9am) / day 120 9am
  const Rs = ids.map(id => trueR(L.get(id).tc, T));
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const out = {
    seed, n: ids.length,
    meanR: mean(Rs), p90: mean(Rs.map(r => +(r >= 0.9))), p80: mean(Rs.map(r => +(r >= 0.8))),
    score: mean(ids.map((id, i) => +(L.get(id).exam < Rs[i]))),
    reviews: perDay.reduce((n, x) => n + x.reviews, 0), answers: perDay.reduce((n, x) => n + x.answers, 0),
    maxDaily: Math.max(...perDay.map(x => x.reviews)),
    suspended, playApplied, playAgainNotDue,
    unstarted: ids.filter(id => L.get(id).tc.state === 0).length
  };
  if (!cfg.noExam) {
    out.last5 = perDay.slice(-5).reduce((n, x) => n + x.reviews, 0);
    out.eve = perDay[perDay.length - 1].reviews;
    out.perDay = perDay.map(x => x.reviews);
    // cards the app itself would say still needed a review (predicted < 95% on exam day) but are scheduled after the exam
    // afterNeed: not reviewed in the final window (last min(5, days) days), so nothing was done about it.
    let afterNeed = 0, afterNeedRaw = 0, afterAny = 0, afterTrueLow = 0;
    const winStart0 = examT - Math.min(5, examDay) * DAY;
    for (const id of ids) {
      const st = db.S.states.get(id);
      if (!st || st.state !== 2 || st.due <= examT) continue;
      afterAny++;
      if (appR(st, examT) < 0.95) { afterNeedRaw++; if (st.lastReview < winStart0) afterNeed++; }
      if (trueR(L.get(id).tc, T) < 0.8) afterTrueLow++;
    }
    Object.assign(out, { afterNeed, afterNeedRaw, afterAny, afterTrueLow });
    // diagnostics: true R of cards the app left alone (predicted >= 95%) vs reviewed in the window
    const winStart = examT - Math.min(5, examDay) * DAY;
    const skipped = [], reviewed = [];
    for (const id of ids) {
      const st = db.S.states.get(id);
      if (!st || st.state === 0) continue;
      (st.lastReview >= winStart ? reviewed : skipped).push(trueR(L.get(id).tc, T));
    }
    out.leftAloneN = skipped.length; out.leftAloneR = skipped.length ? mean(skipped) : null;
    out.leftAloneLow80 = skipped.filter(r => r < 0.8).length;
    out.windowN = reviewed.length; out.windowR = reviewed.length ? mean(reviewed) : null;
  }
  return out;
}

for (let s = +seedFrom; s <= +seedTo; s++) process.stdout.write(JSON.stringify(await runSeed(s)) + '\n');
