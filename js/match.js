// Checking a typed answer against the back of a card. Used by typed review now and by Play later.
// Pure functions, tested by tests/match.test.js.
//
// The rules (from PLAN.md):
//   - ignore capitals, punctuation and a leading "the", "a" or "an"
//   - allow typos scaled by length: 0 for answers under 5 characters, 1 for 5 to 9, 2 for 10 or more
//   - accept any alternate in the back separated by ; or /
//   - typing is only offered when the back is 40 characters or less

export const TYPE_MAX = 40;
export const canType = back => String(back ?? '').trim().length <= TYPE_MAX;

// What a text is compared by (shared with import.js dupKey, so duplicates and typed answers agree):
// lower case (final sigma ς is σ), accents off (only the Latin combining marks U+0300 to U+036F: other marks such as
// the kana dakuten or a Hindi vowel sign change the letter, so they stay), punctuation and symbols → space.
// A text made only of symbols ("+", "🧠", "?!") would be empty, so it keeps its symbols instead.
export function foldText(s) {
  const t = String(s ?? '').toLowerCase().replace(/ς/g, 'σ')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')          // café → cafe
    .replace(/[\ufe00-\ufe0f]/g, '');                                // emoji variation selectors (❤ and ❤️ are the same)
  const letters = t.replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (/[\p{L}\p{N}]/u.test(letters)) return letters.normalize('NFC');
  return t.replace(/\s+/g, '').normalize('NFC');
}

// "The Mitochondria!" → "mitochondria"
export function normalizeAnswer(s) {
  return foldText(s).replace(/^(?:the|a|an) /, '');
}

// Every wording of the back that is allowed, as written. "red / scarlet (dark red)" gives the whole thing, "red",
// "scarlet (dark red)", and each without its (brackets), since words in brackets are optional.
const unbracketed = s => s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
function wordings(back, wholeFirst = false) {
  const raw = String(back ?? '');
  const pieces = raw.split(/[;/]/);
  const whole = [raw, unbracketed(raw)];
  const list = wholeFirst ? [...whole, ...pieces.flatMap(p => [p, unbracketed(p)])] : [...pieces, ...pieces.map(unbracketed), ...whole];
  return list.map(t => t.trim());
}

// Every answer the back allows (normalized).
export function acceptedAnswers(back) {
  const out = new Set();
  for (const w of wordings(back, true)) {
    const n = normalizeAnswer(w);
    if (n) out.add(n);
  }
  return [...out];
}

export const allowedTypos = len => (len < 5 ? 0 : len < 10 ? 1 : 2);

// How many single-letter changes turn a into b (insert, delete or swap a letter).
export function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Is the typed answer right? forgiving: false turns off typo forgiveness (Hard mode in Play).
// Returns { correct, exact } where exact means no typos were needed.
export function checkAnswer(typed, back, { forgiving = true } = {}) {
  // Spaces are ignored, so "self esteem" matches "selfesteem" and ひとつ matches ひと(つ).
  const squash = s => s.replace(/ /g, '');
  const t = squash(normalizeAnswer(typed));
  if (!t) return { correct: false, exact: false };
  const answers = acceptedAnswers(back).map(squash);
  if (answers.includes(t)) return { correct: true, exact: true };
  if (!forgiving) return { correct: false, exact: false };
  const close = answers.some(a => editDistance(t, a) <= allowedTypos(a.length));
  return { correct: close, exact: false };
}

// checkAnswer against each wording a card accepts (format.js answerTargets). An exact match wins, then one that is right with typos; when none
// is, the first one is the verdict. Returns the verdict and the wording it was judged against (what the diff compares with).
export function checkTyped(typed, targets, opts) {
  let first = null, right = null;
  for (const target of targets) {
    const res = { ...checkAnswer(typed, target, opts), target };
    if (res.exact) return res;                 // no typos needed
    if (res.correct) right ??= res;
    first ??= res;
  }
  return right ?? first ?? { ...checkAnswer(typed, '', opts), target: '' };
}

// The answers a typed answer can be compared with, to show which letters were wrong: exactly the set
// acceptedAnswers allows. Order: the pieces split on ; and /, then each piece without its (brackets), then the
// whole back (with and without brackets). De-duplicated by key (the answer folded and without spaces).
export function answerChoices(back) {
  const seen = new Set(), out = [];
  for (const display of wordings(back)) {
    const key = normalizeAnswer(display).replace(/ /g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ display, key });
  }
  return out;
}

// The choice the typed answer is nearest to (the earliest on a tie), or null when there is none.
// A choice that accepts the answer (within its typo budget) beats one that doesn't, however near the other is.
export function closestChoice(typed, back) {
  const t = normalizeAnswer(typed).replace(/ /g, '');
  let best = null, bestD = Infinity, bestOk = false;
  for (const c of answerChoices(back)) {
    const d = editDistance(t, c.key), ok = d <= allowedTypos(c.key.length);
    if ((ok && !bestOk) || (ok === bestOk && d < bestD)) { best = c; bestD = d; bestOk = ok; }
  }
  return best;
}

// ---------- an index of exact answers (Play's "mixed up with" check) ----------
// Built once per round instead of comparing a typed answer with up to 2000 cards on every wrong answer.
// buildAnswerIndex(cards, targetsOf)   Map: normalized answer (spaces ignored) → the cards that accept it, in the order given.
//   targetsOf(card) → the wordings the card accepts (format.js answerTargets of its answer), or [] when it has none.
// indexedMixup(index, typed, card)     the id of another card whose answer was typed exactly, else undefined. Siblings of the
//                                      same note (their answers sit on this card's front) and the card itself don't count.
const squashed = s => normalizeAnswer(s).replace(/ /g, '');
export function buildAnswerIndex(cards, targetsOf, max = 2000) {
  const index = new Map();
  for (const card of cards.slice(0, max)) {
    const keys = new Set();
    for (const target of targetsOf(card) || []) for (const a of acceptedAnswers(target)) { const k = a.replace(/ /g, ''); if (k) keys.add(k); }
    for (const k of keys) { if (!index.has(k)) index.set(k, []); index.get(k).push(card); }
  }
  return index;
}
export function indexedMixup(index, typed, card) {
  const key = squashed(String(typed ?? ''));
  if (!key) return undefined;
  for (const other of index.get(key) || []) {
    if (other.id === card.id || (card.noteId && other.noteId === card.noteId)) continue;
    return other.id;
  }
  return undefined;
}
