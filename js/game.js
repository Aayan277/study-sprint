// Game rules for the Play tab, ported from Kanji Sprint and adapted for any deck.
// Pure functions (no page, no database), tested by tests/game.test.js.

import { canType, normalizeAnswer } from './match.js';
import { dupKey } from './import.js';
import { hasMasks, occLabel } from './occlusion.js';
import { isStepped, finalStep, parseElements } from './steps.js';
import { maskMath } from './math.js';

export const LIGHTNING_MS = 60000;   // Lightning: 60 seconds on the clock
export const PENALTY_MS = 3000;      // Lightning: a wrong answer costs 3 seconds
export const LIVES = 3;              // Survival
export const TYPING_TIME = 1.8;      // typing gets 1.8× the time
export const MIN_CARDS = 4;          // multiple choice needs at least 4 different answers

// Grade stamp, from accuracy (75%) and speed (25%). Same thresholds as Kanji Sprint, with letters.
export const GRADES = [[0.88, 'S', 'Outstanding'], [0.75, 'A', 'Excellent'], [0.62, 'B', 'Good'], [0.5, 'C', 'Pass'], [-1, 'D', 'Keep practicing']];

export function shuffle(a, rnd = Math.random) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- question types ----------
// 'front'  show the front, pick the back
// 'back'   show the back, pick the front
// 'typing' show one side, type the other (the short side, so you never type a long definition)

// What a question asks: the prompt shown and the answer expected, plus the prompt side's picture (if any).
// A cloze card (one blank of a note, see cloze.js) always asks front → back: its front is the sentence with the blank.
export const isCloze = card => !!card.noteId && card.cloze !== undefined;
// An image-occlusion card (see occlusion.js) is front-only too: the picture with its highlighted box is the question, the
// box's label the answer. Cards that can't be asked back → front.
// A step-by-step card (its back is "Step 1: ... Step 2: ..."; see steps.js) asks for its final answer. An elements card
// ("Element 1: ...") asks for the whole list, joined with " · ": multiple choice only, never typed.
const stepped = card => !isCloze(card) && !hasMasks(card) && isStepped(card.back, { mask: maskMath });
const elemental = card => !isCloze(card) && !hasMasks(card) && !!parseElements(card.back, { mask: maskMath });
const structured = card => stepped(card) || elemental(card);
export const isFrontOnly = card => isCloze(card) || hasMasks(card) || structured(card);

export function questionFor(card, qtype) {
  if (hasMasks(card)) {
    // Needs a label to be an answer. The picture is drawn by Play (q.occ), not here.
    const label = occLabel(card.occlusion.masks, card.occlusion.n);
    const ask = { prompt: String(card.occlusion.header ?? '').trim() || 'Name the highlighted part', answer: label, occ: true };
    return label && (qtype === 'front' || (qtype === 'typing' && canType(label))) ? ask : null;
  }
  if (stepped(card)) {
    const answer = finalStep(card.back, { mask: maskMath });
    const ask = card.frontImage ? { prompt: card.front, answer, image: card.frontImage } : { prompt: card.front, answer };
    return qtype === 'front' || (qtype === 'typing' && canType(answer)) ? ask : null;
  }
  if (elemental(card)) {
    const answer = parseElements(card.back, { mask: maskMath }).items.join(' · ');
    return qtype === 'front' ? (card.frontImage ? { prompt: card.front, answer, image: card.frontImage } : { prompt: card.front, answer }) : null;
  }
  const q = (front, image) => {
    const [prompt, answer] = front ? [card.front, card.back] : [card.back, card.front];
    return image ? { prompt, answer, image } : { prompt, answer };
  };
  if (qtype === 'front') return q(true, card.frontImage);
  if (qtype === 'back') return isCloze(card) ? null : q(false, card.backImage);
  if (canType(card.back)) return q(true, card.frontImage);
  if (canType(card.front) && !isCloze(card)) return q(false, card.backImage);
  return null;   // both sides too long to type
}

// Which cards can be used for a question type. The answer has to be text (the options are text),
// so a side that's only a picture can be shown but not asked for.
export function playableCards(cards, qtype) {
  return cards.filter(c => { const q = questionFor(c, qtype); return q && String(q.answer ?? '').trim(); });
}

// The question type Play starts on for a deck you haven't picked one for yet.
// Definition-style decks (most backs longer than 40 characters) start on Back → front: you read the
// definition and pick the term. Picking among similar-looking terms is harder, and closer to an exam,
// than spotting the one definition that's about the right topic. Short-back decks start on Front → back.
export const LONG_BACK = 40;
// (Cloze and image-occlusion cards don't count: they can't be asked back → front.)
export function defaultQuestionType(cards) {
  cards = cards.filter(c => !isFrontOnly(c));
  const long = cards.filter(c => String(c.back ?? '').length > LONG_BACK).length;
  return cards.length && long > cards.length / 2 ? 'back' : 'front';
}

// Multiple choice needs at least 4 different possible answers.
export function canMultipleChoice(cards, qtype) {
  return new Set(playableCards(cards, qtype).map(c => dupKey(questionFor(c, qtype).answer))).size >= MIN_CARDS;
}

// ---------- distractors (wrong options) ----------

// Words worth comparing: 4+ letters, so "the" and "of" don't count as shared words.
const contentWords = s => new Set(normalizeAnswer(s).split(' ').filter(w => w.length >= 4));

// How alike two texts look, from 0 to 1 (shared pairs of letters, the "Dice coefficient").
export function similarity(a, b) {
  const pairs = s => { s = normalizeAnswer(s).replace(/ /g, ''); const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; };
  const pa = pairs(a), pb = pairs(b);
  if (!pa.length || !pb.length) return normalizeAnswer(a) === normalizeAnswer(b) ? 1 : 0;
  const counts = new Map();
  pa.forEach(p => counts.set(p, (counts.get(p) || 0) + 1));
  let shared = 0;
  pb.forEach(p => { const n = counts.get(p); if (n) { shared++; counts.set(p, n - 1); } });
  return (2 * shared) / (pa.length + pb.length);
}

// Scoring every card in a big library for every question is slow, so a big pool is sampled:
// half from the card's own deck (the likeliest look-alikes), the rest from anywhere.
const MAX_CANDIDATES = 300;
function takeRandom(list, n, rnd) {
  const copy = list.slice();
  for (let i = 0; i < Math.min(n, copy.length); i++) {      // a partial shuffle: only the first n places
    const j = i + Math.floor(rnd() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
function candidatesFor(card, pool, rnd) {
  if (pool.length <= MAX_CANDIDATES) return shuffle(pool.slice(), rnd);
  const sameDeck = takeRandom(pool.filter(o => o.deckId === card.deckId), MAX_CANDIDATES / 2, rnd);
  return [...sameDeck, ...takeRandom(pool, MAX_CANDIDATES - sameDeck.length, rnd)];   // repeats are skipped below
}

// Pick wrong options for a card from the other cards' answers.
//   Normal: prefer the same deck, a similar length (within ±50%), and shared tags or words, plus some randomness.
//   Hard:   rank by how alike the text looks, so the traps are plausible.
// Returns the labels, or with { withIds: true } [{ label, id }] (id = the card the option is the answer of).
// include: [label]: these options are always among the wrong ones (if a card in the pool has that answer), e.g. the
// card a "You mix these up" pair is confused with.
export function pickDistractors(card, pool, qtype, { hard = false, count = hard ? 5 : 3, rnd = Math.random, withIds = false, include = [] } = {}) {
  const answer = questionFor(card, qtype).answer;
  const seen = new Set([dupKey(answer)]);
  const words = contentWords(answer);
  const tags = new Set(card.tags || []);
  const scored = [];
  const want = new Set(include.map(dupKey).filter(Boolean));
  const consider = other => {
    // Never a sibling: its answer is on this card's front. (For an image-occlusion card the other boxes' labels are the
    // best wrong options: the picture doesn't show them.)
    if (other.id === card.id || (card.noteId && other.noteId === card.noteId && !hasMasks(card))) return;
    const label = questionFor(other, qtype).answer;
    const key = dupKey(label);
    if (!key || seen.has(key)) return;      // no duplicate options, and never the right answer twice
    seen.add(key);
    let score = 0;
    if (other.deckId === card.deckId) score += 2;
    if (isCloze(card) && isCloze(other)) score += 3;                   // a cloze answer looks best among other cloze answers
    if (hasMasks(card) && hasMasks(other)) score += 3;                 // and a label among other labels
    if (hasMasks(card) && card.noteId && other.noteId === card.noteId) score += 4;     // best of all: the same picture
    const ratio = label.length / Math.max(1, answer.length);
    if (ratio >= 0.5 && ratio <= 1.5) score += 2;
    score += Math.min(2, (other.tags || []).filter(t => tags.has(t)).length);
    score += Math.min(2, [...contentWords(label)].filter(w => words.has(w)).length);
    score = hard ? similarity(label, answer) * 10 + score * 0.5 + rnd() * 0.5 : score + rnd() * 2.5;
    if (want.has(key)) score += 1e6;        // forced in
    scored.push({ label, id: other.id, score });
  };
  const sample = candidatesFor(card, pool, rnd);
  sample.forEach(consider);
  // A sample of a big pool can hold too few different answers (e.g. mostly Yes/No): look through the rest.
  if (scored.length < count && pool.length > sample.length) shuffle(pool.slice(), rnd).forEach(consider);
  if (want.size && [...want].some(k => !seen.has(k))) pool.forEach(o => { if (want.has(dupKey(questionFor(o, qtype)?.answer))) consider(o); });
  const top = scored.sort((a, b) => b.score - a.score).slice(0, count);
  return withIds ? top.map(({ label, id }) => ({ label, id })) : top.map(s => s.label);
}

// ---------- the round ----------

// Pick `len` cards, weighted so cards you struggle with come up more often,
// without the same card twice in a row, and without two cards of one cloze note in a row (the first one gives the
// second one away). Every card is used once before any repeats.
//   before  the card shown just before this list, if it continues an earlier one
export function weightedQueue(items, len, weightOf = () => 1, rnd = Math.random, before = null) {
  const out = [];
  let bag = [];
  while (out.length < len && items.length) {
    if (!bag.length) bag = items.slice();
    const w = bag.map(weightOf);
    let r = rnd() * w.reduce((a, b) => a + b, 0), idx = 0;
    for (; idx < bag.length; idx++) { r -= w[idx]; if (r <= 0) break; }
    idx = Math.min(idx, bag.length - 1);
    const prev = out[out.length - 1] || before;
    const clash = c => c.id === prev.id || (!!c.noteId && c.noteId === prev.noteId);
    if (prev && clash(bag[idx])) {
      // Take the next card that doesn't clash. If only siblings are left in the bag, bring in another card early
      // (a repeat, which is better than two siblings in a row). If there is nothing else, at least not the same card.
      const fits = [...bag.keys()].map(k => (idx + k) % bag.length);
      let fit = fits.find(k => !clash(bag[k]));
      if (fit === undefined) {
        const others = items.filter(c => !clash(c));
        if (others.length) { bag.push(others[Math.floor(rnd() * others.length)]); fit = bag.length - 1; }
      }
      idx = fit ?? fits.find(k => bag[k].id !== prev.id) ?? idx;
    }
    out.push(bag.splice(idx, 1)[0]);
  }
  return out;
}

// Time allowed for question number i (counting from 0), in ms.
// Survival shrinks 3% each question, down to a 2s floor. Lightning has no per-question timer.
export function timeLimit({ fmt, pace, typing, i = 0 }) {
  const mul = typing ? TYPING_TIME : 1;
  if (fmt === 'lightning') return Infinity;
  if (fmt === 'survival') return Math.max(2000 * mul, pace * mul * 1000 * Math.pow(0.97, i));
  return pace * mul * 1000;
}

// Points for one answer. 100 for being right, plus up to 100 for speed, times the streak bonus
// (+10% per answer in a row, up to ×1.5), ×1.25 on Hard and ×1.2 with Flash.
// A wrong answer on Hard loses 50 points (never below 0).
export function scoreAnswer({ ok, seconds, limitMs, fmt, streak, hard, flash, score }) {
  if (!ok) return { pts: hard ? -Math.min(50, score) : 0, speed: 0, mult: 1 };
  const speed = fmt === 'lightning' ? Math.max(0, 1 - seconds / 3) : Math.max(0, 1 - seconds / (limitMs / 1000));
  const mult = 1 + 0.1 * Math.min(streak, 5);
  const pts = Math.round((100 + Math.round(100 * speed)) * mult * (hard ? 1.25 : 1) * (flash ? 1.2 : 1));
  return { pts, speed, mult };
}

// ---------- "I was right" ----------
// A typed answer the check marked wrong can be corrected by the person. Only typed answers can: not multiple choice, not
// "out of time" and not a skip.
export const canOverride = (round, entry) => round.qtype === 'typing' && !entry.ok && !entry.overridden && typeof entry.given === 'string' && !!entry.given.trim();

// The log entry as a right answer. The entry's accuracy, speed and place in the Missed list follow; the round's score, streak,
// lives and Lightning clock are NOT touched (the points were scored as they were, so the game can't be won by overriding).
// Returns a new entry; the caller puts it in round.log in place of the old one.
export function overrideEntry(round, entry) {
  if (!canOverride(round, entry)) return entry;
  const speed = round.fmt === 'lightning' ? Math.max(0, 1 - entry.seconds / 3) : Math.max(0, 1 - entry.seconds / (entry.limitMs / 1000));
  const { mixedWith, typed, target, ...rest } = entry;        // right now: no mix-up, no letters to point out
  return { ...rest, ok: true, overridden: true, speed: Number.isFinite(speed) ? speed : 0 };
}

// What the results screen reports from a round's log: answers, right ones, accuracy (0 to 1), the average speed of the right
// ones (0 to 1) and the average answer time in seconds.
export function roundStats(log) {
  const total = log.length, right = log.filter(l => l.ok);
  return {
    total, correct: right.length, accuracy: total ? right.length / total : 0,
    avgSpeed: right.length ? right.reduce((a, l) => a + l.speed, 0) / right.length : 0,
    avgTime: total ? log.reduce((a, l) => a + l.seconds, 0) / total : 0
  };
}

export function gradeFor(accuracy, avgSpeed) {
  const rating = accuracy * 0.75 + avgSpeed * 0.25;
  const [, letter, label] = GRADES.find(g => rating >= g[0]);
  return { letter, label };
}

// Best scores are kept per deck, format, question type, difficulty, flash and (for Classic) length.
export function bestKey({ deckId, fmt, qtype, hard, flash, len }) {
  return [deckId || 'all', fmt, qtype, hard ? 'hard' : 'normal', flash || 0, fmt === 'classic' ? len : '-'].join('|');
}
