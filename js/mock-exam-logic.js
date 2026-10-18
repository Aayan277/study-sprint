// The Practice test: a calm mock exam. This file holds the rules (pure functions, no page, no database), tested by tests/mock-exam-logic.test.js.
//   building a test   which cards, how many, which question types, in what order
//   grading           answers are only checked at the end, as in a real exam
//   results           score, score by tag and by subdeck, the list of questions, the cards to drill
//   saved state       the test in progress (so a reload can resume it), the last choices per deck and the results history
// Play is fun timed rounds; the test has no feedback until you submit. It reuses Play's question builder and wrong options (game.js).

import { questionFor, isCloze, isFrontOnly, canMultipleChoice, pickDistractors, playableCards, shuffle, defaultQuestionType } from './game.js';
import { checkTyped } from './match.js';
import { answerTargets } from './format.js';
import { withAccepted, acceptedOf } from './accept.js';
import { spreadSiblings } from './queue.js';
import { tagTree, cardsUnder, tagWords, normTag, pieces } from './tag-tree.js';

// ---------- the choices ----------
export const COUNTS = [10, 20, 30, 50, 'all'];
export const LIMITS = [0, 10, 20, 30, 45, 60];                     // minutes; 0 = no time limit
export const KINDS = { mc: 'Multiple choice', typing: 'Typed answer', cloze: 'Fill in the blank', tf: 'True or false' };
export const ORDERS = { random: 'Random', weak: 'Weakest first' };
export const DEFAULT_CFG = { count: 20, kinds: Object.keys(KINDS), limit: 0, order: 'random', counts: false, tags: [] };

// Choices from a saved setting or a backup, made safe. (A damaged value falls back to the default for that choice.)
export function cleanCfg(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const kinds = Array.isArray(c.kinds) ? Object.keys(KINDS).filter(k => c.kinds.includes(k)) : [];
  const limit = Number(c.limit);
  return {
    count: c.count === 'all' || (Number.isInteger(c.count) && c.count >= 1 && c.count <= 500) ? c.count : DEFAULT_CFG.count,
    kinds: kinds.length ? kinds : [...DEFAULT_CFG.kinds],
    limit: Number.isFinite(limit) && limit > 0 && limit <= 600 ? limit : 0,
    order: c.order === 'weak' ? 'weak' : 'random',
    counts: c.counts === true,                       // "Count answers as reviews": off unless exactly true
    tags: Array.isArray(c.tags) ? c.tags.filter(t => typeof t === 'string' && normTag(t)).map(normTag).slice(0, 50) : []
  };
}

// The tags to offer as a narrowing: the top-level tags (or folders of "::" tags) of the cards, biggest first.
export function tagChoices(cards, max = 24) {
  return tagTree(cards).map(n => ({ tag: n.path, label: n.name, n: n.count })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).slice(0, max);
}

// The cards that have one of the tags (or a tag below it). No tags chosen: all of them.
export function narrowByTags(cards, tags) {
  if (!tags?.length) return cards;
  const keep = new Set();
  for (const t of tags) for (const c of cardsUnder(cards, t)) keep.add(c.id);
  return cards.filter(c => keep.has(c.id));
}

// ---------- weakest first ----------
// How weak a card is: its chance of being remembered now (lower is weaker; recallOf(card) gives it, or null for a card that was never
// studied), then more lapses, then at random. A card never studied has no memory to test, so it goes after the ones you have studied.
export function weakOrder(cards, recallOf, lapsesOf = () => 0, rnd = Math.random) {
  const key = cards.map(c => { const r = recallOf(c); return { c, r: Number.isFinite(r) ? r : null, lapses: lapsesOf(c) || 0, tie: rnd() }; });
  key.sort((a, b) => (a.r === null) - (b.r === null) || (a.r ?? 0) - (b.r ?? 0) || b.lapses - a.lapses || a.tie - b.tie);
  return key.map(k => k.c);
}

// Of cards in order, one per note first (a cloze note's other blanks, or a reverse card, give the answer away), then the rest.
const onePerNote = cards => {
  const seen = new Set(), first = [], rest = [];
  for (const c of cards) { if (c.noteId && seen.has(c.noteId)) rest.push(c); else { if (c.noteId) seen.add(c.noteId); first.push(c); } }
  return [...first, ...rest];
};

// ---------- building a test ----------
// What a question carries is plain data, so a test in progress can be saved and a result can be shown later without the cards:
//   { cardId, deckId, tags, kind: 'mc'|'typing'|'cloze'|'tf', qtype ('front'|'back' for multiple choice and true/false, 'typing'),
//     prompt, answer, image?, sounds?, occ?, options? and optIds? (mc: the card each option is the answer of), shown? and truth? (tf),
//     accept? (typed: extra accepted answers) }
const carry = q => ({ prompt: q.prompt, answer: q.answer, ...(q.image ? { image: q.image } : {}), ...(q.sounds ? { sounds: q.sounds } : {}), ...(q.occ ? { occ: true } : {}) });
const tagsOf = card => [...new Set(tagWords(card.tags).map(normTag))].filter(t => t && t !== 'leech');
const hasText = q => !!q && !!String(q.answer ?? '').trim();

// Can this card be asked as this kind? (No wrong options are looked for yet: that happens when the question is made.)
function canAsk(card, kind, ctx) {
  if (kind === 'cloze') return isCloze(card) && hasText(questionFor(card, 'typing'));
  if (kind === 'typing') return !isCloze(card) && hasText(questionFor(card, 'typing'));
  const dir = ctx.dirs.find(d => hasText(questionFor(card, d)));
  if (!dir) return false;
  return kind === 'mc' || (!isFrontOnly(card) && !questionFor(card, dir).occ);        // true or false: plain cards only
}

// One question for the card, or null when it can't be made (not enough different wrong options).
function makeQuestion(card, kind, ctx, rnd) {
  const base = { cardId: card.id, deckId: card.deckId, tags: tagsOf(card), kind };
  if (kind === 'cloze' || kind === 'typing') {
    const q = questionFor(card, 'typing');
    if (!hasText(q)) return null;
    const accept = q.answer === card.back ? acceptedOf(card) : [];
    return { ...base, qtype: 'typing', ...carry(q), ...(accept.length ? { accept } : {}) };
  }
  const dir = ctx.dirs.find(d => hasText(questionFor(card, d)));
  if (!dir) return null;
  const q = questionFor(card, dir);
  const wrong = pickDistractors(card, ctx.pools[dir], dir, { rnd, count: kind === 'tf' ? 1 : 3, withIds: true });
  if (kind === 'tf') {
    if (!wrong.length) return null;
    const truth = rnd() < 0.5;
    return { ...base, qtype: dir, ...carry(q), shown: truth ? q.answer : wrong[0].label, truth };
  }
  if (wrong.length < 2) return null;                        // a multiple choice question needs at least three options
  // Each option remembers which card it is the answer of, so a wrong pick can be recorded as a mix-up (log.mixedWith).
  const items = shuffle([{ label: q.answer, id: card.id }, ...wrong], rnd);
  return { ...base, qtype: dir, ...carry(q), options: items.map(o => o.label), optIds: items.map(o => o.id) };
}

// Which cards the choices could ask, and how (before the count and the order): the setup sheet shows how many.
//   Multiple choice and true or false need at least four different answers in the deck (Play's rule); typed and blank questions don't.
export function askable(cards, cfg) {
  cfg = cleanCfg(cfg);
  const dir = defaultQuestionType(cards);
  const dirs = [dir, dir === 'front' ? 'back' : 'front'].filter(d => canMultipleChoice(cards, d));
  const ctx = { dirs, pools: Object.fromEntries(dirs.map(d => [d, playableCards(cards, d)])) };
  const kinds = cfg.kinds.filter(k => (k !== 'mc' && k !== 'tf') || dirs.length);
  const kindsOf = c => kinds.filter(k => canAsk(c, k, ctx));
  return { cfg, ctx, kinds, kindsOf, able: narrowByTags(cards, cfg.tags).filter(c => kindsOf(c).length) };
}

// Build a test.
//   cards     the cards of the deck and its subdecks that can be asked (plain-text copies, as Play uses; no suspended or buried ones)
//   cfg       the choices (cleanCfg): count, kinds, order, tags
//   recallOf, lapsesOf  for "Weakest first" (see weakOrder)
// Returns { questions, available }: `available` = how many cards the choices could ask (before the count), for the setup sheet.
export function buildTest(cards, cfgIn, { recallOf = () => null, lapsesOf = () => 0, rnd = Math.random } = {}) {
  const { cfg, ctx, kinds, kindsOf, able } = askable(cards, cfgIn);
  const all = cfg.count === 'all';
  const want = all ? able.length : Math.min(cfg.count, able.length);
  // Which cards, and in what order.
  let ordered;
  if (cfg.order === 'weak') ordered = weakOrder(able, recallOf, lapsesOf, rnd);
  else ordered = shuffle(able.slice(), rnd);
  if (!all) ordered = onePerNote(ordered);
  if (cfg.order === 'random') ordered = spreadSiblings(ordered, c => c.noteId);
  // Make the questions, spreading the kinds evenly. A card that can't make a question is skipped and the next one takes its place.
  const used = Object.fromEntries(kinds.map(k => [k, 0]));
  const questions = [];
  const chosen = ordered.slice(0, want), reserve = ordered.slice(want);
  const queue = [...chosen];
  for (let i = 0; queue.length && questions.length < want; i++) {
    const card = queue.shift();
    const options = kindsOf(card);
    // A cloze card is asked as a blank when that is wanted; otherwise the kind used least so far (a tie at random).
    options.sort((a, b) => (b === 'cloze') - (a === 'cloze') || used[a] - used[b] || rnd() - 0.5);
    let q = null;
    for (const k of options) { q = makeQuestion(card, k, ctx, rnd); if (q) { used[k]++; break; } }
    if (q) questions.push(q);
    else if (reserve.length) queue.push(reserve.shift());
  }
  return { questions, available: able.length };
}

// ---------- grading ----------
// answers[i]: a multiple choice question: the number of the option picked; true or false: true / false; typed: the text. null = not answered.
export function isAnswered(q, a) {
  if (q.kind === 'mc') return Number.isInteger(a) && a >= 0 && a < (q.options?.length || 0);
  if (q.kind === 'tf') return a === true || a === false;
  return typeof a === 'string' && a.trim() !== '';
}
// Is the answer right? A question left blank is wrong. Typed answers allow the same typos as Play (and the card's accepted answers).
export function gradeAnswer(q, a) {
  if (!isAnswered(q, a)) return false;
  if (q.kind === 'mc') return q.options[a] === q.answer;
  if (q.kind === 'tf') return a === q.truth;
  return checkTyped(a, withAccepted(answerTargets(q.answer), { acceptAnswers: q.accept }), { forgiving: true }).correct;
}
// What the person answered, as text for the results list ('' when left blank).
export function givenText(q, a) {
  if (!isAnswered(q, a)) return '';
  if (q.kind === 'mc') return q.options[a];
  if (q.kind === 'tf') return a ? 'True' : 'False';
  return a.trim();
}
// The correct answer, as text. A true or false question says what was shown too.
export const correctText = q => (q.kind === 'tf' ? (q.truth ? 'True' : 'False') : q.answer);

// The score. per[i] = { ok, answered, given }.
export function scoreRun(questions, answers) {
  const per = questions.map((q, i) => ({ ok: gradeAnswer(q, answers[i]), answered: isAnswered(q, answers[i]), given: givenText(q, answers[i]) }));
  const total = questions.length, correct = per.filter(p => p.ok).length, answered = per.filter(p => p.answered).length;
  return { total, correct, wrong: total - correct, answered, unanswered: total - answered, pct: total ? Math.round(100 * correct / total) : 0, per };
}

// Score by group: keysOf(q) gives the groups a question counts in. Weakest first (lowest percentage, then the most questions).
function groupScores(questions, per, keysOf) {
  const map = new Map();
  questions.forEach((q, i) => {
    for (const key of new Set(keysOf(q))) {
      const g = map.get(key) || map.set(key, { key, total: 0, correct: 0 }).get(key);
      g.total++; if (per[i].ok) g.correct++;
    }
  });
  return [...map.values()].map(g => ({ ...g, pct: Math.round(100 * g.correct / g.total) }))
    .sort((a, b) => a.pct - b.pct || b.total - a.total || a.key.localeCompare(b.key));
}
export const UNTAGGED = '(no tag)';
export const byTag = (questions, per) => groupScores(questions, per, q => (q.tags.length ? q.tags : [UNTAGGED]));
// By deck (subdeck): only worth showing when the questions come from more than one.
export const byDeck = (questions, per) => groupScores(questions, per, q => [q.deckId]);
// A tag for people: the last two parts of a folder tag ("step1::biochem::enzymes" is "biochem › enzymes").
export const tagLabel = tag => (tag === UNTAGGED ? tag : pieces(tag).slice(-2).join(' › '));

// The cards that were missed (wrong or left blank), in test order, for "Drill missed".
export const missedIds = (questions, per) => [...new Set(questions.filter((q, i) => !per[i].ok).map(q => q.cardId))];

// How a question shows in the navigator: 'answered' | 'unanswered', and whether it is flagged.
export const navState = (q, a, flagged) => ({ answered: isAnswered(q, a), flagged: !!flagged });

// "12:03" or "1:02:03".
export function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

// ---------- the test in progress ----------
// Saved in two parts so a reload can resume it: the run (the questions and choices, written once) and the state (answers, flags, the
// place, the time used: small, written at every change). Only time spent on the test counts toward the time limit.
export const RUN_VERSION = 1;
export const RUN_MAX_AGE = 2 * 86400000;             // an unfinished test older than two days is dropped

export function newRun(cfg, questions, deckId, now = Date.now(), id = `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`) {
  return { v: RUN_VERSION, id, deckId, cfg: cleanCfg(cfg), questions, created: now };
}
export const newState = (run, now = Date.now()) => ({
  v: RUN_VERSION, id: run.id, i: 0, answers: run.questions.map(() => null), flags: run.questions.map(() => false), spent: run.questions.map(() => 0), elapsed: 0, saved: now
});

const okQuestion = q => q && typeof q === 'object' && typeof q.cardId === 'string' && ['mc', 'typing', 'cloze', 'tf'].includes(q.kind)
  && typeof q.prompt === 'string' && typeof q.answer === 'string' && Array.isArray(q.tags)
  && (q.kind !== 'mc' || (Array.isArray(q.options) && q.options.length >= 2 && q.options.every(o => typeof o === 'string')))
  && (q.kind !== 'tf' || (typeof q.shown === 'string' && typeof q.truth === 'boolean'));
// A saved run and state back, or null when they are missing, damaged, don't belong together or are too old.
export function parseRun(rawRun, rawState, now = Date.now()) {
  try {
    const run = typeof rawRun === 'string' ? JSON.parse(rawRun) : rawRun, st = typeof rawState === 'string' ? JSON.parse(rawState) : rawState;
    if (!run || !st || run.v !== RUN_VERSION || st.v !== RUN_VERSION || run.id !== st.id) return null;
    if (!Array.isArray(run.questions) || !run.questions.length || !run.questions.every(okQuestion)) return null;
    if (!(now - run.created < RUN_MAX_AGE) || typeof run.deckId !== 'string') return null;
    const n = run.questions.length;
    const arr = (a, ok) => Array.isArray(a) && a.length === n && a.every(ok);
    if (!arr(st.answers, (a, i) => a === null || isAnswered(run.questions[i], a)) || !arr(st.flags, f => typeof f === 'boolean') || !arr(st.spent, s => Number.isFinite(s) && s >= 0)) return null;
    return { run: { ...run, cfg: cleanCfg(run.cfg) }, state: { ...st, i: Number.isInteger(st.i) && st.i >= 0 && st.i < n ? st.i : 0, elapsed: Number.isFinite(st.elapsed) && st.elapsed >= 0 ? st.elapsed : 0 } };
  } catch { return null; }
}
// Time left, in ms (Infinity with no time limit).
export const timeLeft = (run, state) => (run.cfg.limit > 0 ? Math.max(0, run.cfg.limit * 60000 - state.elapsed) : Infinity);
// The same questions again, nothing answered.
export const retakeRun = (run, now = Date.now()) => newRun(run.cfg, run.questions, run.deckId, now);

// ---------- what is remembered ----------
// Last choices per deck: { [deckId]: cfg }.
export function cleanPrefs(raw) {
  const out = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (typeof k === 'string' && v && typeof v === 'object') out[k] = cleanCfg(v);
  return out;
}
export const HISTORY_MAX = 10;
// Results history per deck, newest last: { [deckId]: [{ at, pct, correct, total, secs }] }.
export function cleanHistory(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const rows = list.filter(r => r && Number.isFinite(r.at) && Number.isFinite(r.pct) && Number.isFinite(r.correct) && Number.isFinite(r.total) && r.total > 0)
      .map(r => ({ at: r.at, pct: Math.min(100, Math.max(0, Math.round(r.pct))), correct: r.correct, total: r.total, secs: Number.isFinite(r.secs) ? Math.max(0, Math.round(r.secs)) : 0 }));
    if (rows.length) out[k] = rows.slice(-HISTORY_MAX);
  }
  return out;
}
export function addResult(history, deckId, result) {
  const h = cleanHistory(history);
  h[deckId] = [...(h[deckId] || []), result].slice(-HISTORY_MAX);
  return h;
}
// The last few results of a deck, newest first.
export const recentResults = (history, deckId, n = 5) => (cleanHistory(history)[deckId] || []).slice(-n).reverse();
