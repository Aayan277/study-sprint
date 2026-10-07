// Game rules for the Play tab, ported from Kanji Sprint and adapted for any deck.
// Pure functions (no page, no database), tested by tests/game.test.js.

import { canType, normalizeAnswer } from './match.js';
import { dupKey } from './import.js';

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

// What a question asks: the prompt shown and the answer expected.
export function questionFor(card, qtype) {
  if (qtype === 'front') return { prompt: card.front, answer: card.back };
  if (qtype === 'back') return { prompt: card.back, answer: card.front };
  if (canType(card.back)) return { prompt: card.front, answer: card.back };
  if (canType(card.front)) return { prompt: card.back, answer: card.front };
  return null;   // both sides too long to type
}

// Which cards can be used for a question type.
export function playableCards(cards, qtype) {
  return cards.filter(c => questionFor(c, qtype));
}

// Multiple choice needs at least 4 different possible answers.
export function canMultipleChoice(cards, qtype) {
  return new Set(cards.map(c => dupKey(questionFor(c, qtype).answer))).size >= MIN_CARDS;
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

// Pick wrong options for a card from the other cards' answers.
//   Normal: prefer the same deck, a similar length (within ±50%), and shared tags or words, plus some randomness.
//   Hard:   rank by how alike the text looks, so the traps are plausible.
export function pickDistractors(card, pool, qtype, { hard = false, count = hard ? 5 : 3, rnd = Math.random } = {}) {
  const answer = questionFor(card, qtype).answer;
  const seen = new Set([dupKey(answer)]);
  const words = contentWords(answer);
  const tags = new Set(card.tags || []);
  const scored = [];
  for (const other of shuffle(pool.slice(), rnd)) {
    if (other.id === card.id) continue;
    const label = questionFor(other, qtype).answer;
    const key = dupKey(label);
    if (!key || seen.has(key)) continue;      // no duplicate options, and never the right answer twice
    seen.add(key);
    let score = 0;
    if (other.deckId === card.deckId) score += 2;
    const ratio = label.length / Math.max(1, answer.length);
    if (ratio >= 0.5 && ratio <= 1.5) score += 2;
    score += Math.min(2, (other.tags || []).filter(t => tags.has(t)).length);
    score += Math.min(2, [...contentWords(label)].filter(w => words.has(w)).length);
    score = hard ? similarity(label, answer) * 10 + score * 0.5 + rnd() * 0.5 : score + rnd() * 2.5;
    scored.push({ label, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, count).map(s => s.label);
}

// ---------- the round ----------

// Pick `len` cards, weighted so cards you struggle with come up more often,
// without the same card twice in a row. Every card is used once before any repeats.
export function weightedQueue(items, len, weightOf = () => 1, rnd = Math.random) {
  const out = [];
  let bag = [];
  while (out.length < len && items.length) {
    if (!bag.length) bag = items.slice();
    const w = bag.map(weightOf);
    let r = rnd() * w.reduce((a, b) => a + b, 0), idx = 0;
    for (; idx < bag.length; idx++) { r -= w[idx]; if (r <= 0) break; }
    idx = Math.min(idx, bag.length - 1);
    const prev = out[out.length - 1];
    if (prev && bag.length > 1 && bag[idx].id === prev.id) idx = (idx + 1) % bag.length;
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

export function gradeFor(accuracy, avgSpeed) {
  const rating = accuracy * 0.75 + avgSpeed * 0.25;
  const [, letter, label] = GRADES.find(g => rating >= g[0]);
  return { letter, label };
}

// Best scores are kept per deck, format, question type, difficulty, flash and (for Classic) length.
export function bestKey({ deckId, fmt, qtype, hard, flash, len }) {
  return [deckId || 'all', fmt, qtype, hard ? 'hard' : 'normal', flash || 0, fmt === 'classic' ? len : '-'].join('|');
}
