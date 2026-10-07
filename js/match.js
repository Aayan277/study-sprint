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

// "The Mitochondria!" → "mitochondria"
export function normalizeAnswer(s) {
  return String(s ?? '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // café → cafe
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')                   // punctuation → space
    .replace(/\s+/g, ' ').trim()
    .replace(/^(?:the|a|an) /, '');
}

// Every answer the back allows. "red / scarlet (dark red)" accepts the whole thing, "red",
// "scarlet (dark red)" and also "scarlet", since words in brackets are optional.
export function acceptedAnswers(back) {
  const raw = String(back ?? '');
  const pieces = [raw, ...raw.split(/[;/]/)];
  const out = new Set();
  for (const p of pieces) {
    for (const v of [p, p.replace(/\([^)]*\)/g, ' ')]) {
      const n = normalizeAnswer(v);
      if (n) out.add(n);
    }
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
  const t = normalizeAnswer(typed);
  if (!t) return { correct: false, exact: false };
  const answers = acceptedAnswers(back);
  if (answers.includes(t)) return { correct: true, exact: true };
  if (!forgiving) return { correct: false, exact: false };
  const close = answers.some(a => editDistance(t, a) <= allowedTypos(a.length));
  return { correct: close, exact: false };
}
