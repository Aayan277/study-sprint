// Shows which letters of a typed answer were wrong. Pure functions (no DOM), tested by tests/answer-diff.test.js.
//
// It lines the typed answer up with the answer letter by letter (the same costs as editDistance in match.js) and
// marks what differs: a letter that is wrong, a letter that is extra, and a letter that is missing. Capitals,
// accents, punctuation, spaces and a leading the/a/an are never marked, so the picture never disagrees with the
// verdict from checkAnswer. Text is worked on as grapheme clusters, so emoji, kana with their marks and decomposed accents are never split.

import { closestChoice, foldText } from './match.js';

const MAX_CP = 300;            // longer than this on either side: no diff, just the two texts
const LETTER = /[\p{L}\p{N}]/u;   // what counts as a letter or digit

// A text split into grapheme clusters, so a letter and its accents (decomposed é, kana + dakuten, Hindi vowel
// signs) stay in one piece, and emoji are never split. Falls back to code points where Intl.Segmenter is missing.
const SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export const graphemes = text => {
  const s = String(text ?? '');
  return SEGMENTER ? Array.from(SEGMENTER.segment(s), x => x.segment) : Array.from(s);
};

// A cluster folded the way normalizeAnswer folds it (match.js foldText: lower case, ς = σ, Latin accents off, other
// marks kept), keeping only letters, digits and marks. '' means "ignored" (punctuation, a space).
const fold = ch => { const f = foldText(ch); return LETTER.test(f) ? f.replace(/\s+/g, '') : ''; };

// The clusters of a text, each with its folded key. A leading the/a/an and its space are ignored too.
// A text with no letters or digits at all ("+", "🧠") is compared by its symbols.
function prepare(text) {
  const items = graphemes(text).map(ch => ({ ch, key: fold(ch) }));
  if (!items.some(x => x.key)) for (const it of items) it.key = foldText(it.ch);
  let i = 0;
  while (i < items.length && !items[i].key) i++;
  let j = i;
  while (j < items.length && items[j].key) j++;
  const word = items.slice(i, j).map(x => x.key).join('');
  if (['the', 'a', 'an'].includes(word) && items.slice(j).some(x => x.key) && j < items.length) {
    for (let k = i; k < j; k++) { items[k].key = ''; items[k].article = word; }      // (remembered: an extra article is shown when the answer is wrong anyway)
  }
  return items;
}

// Neighbouring characters of the same kind become one segment.
function segments(items, kinds) {
  const out = [];
  items.forEach((it, n) => {
    const kind = kinds[n];
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += it.ch; else out.push({ kind, text: it.ch });
  });
  return out;
}

export function diffAnswer(typed, target) {
  typed = String(typed ?? ''); target = String(target ?? '');
  if (!typed.trim()) return null;
  const a = prepare(typed), b = prepare(target);
  const plain = (extra = {}) => ({ expected: target, typed: [{ kind: 'ok', text: typed }], answer: [{ kind: 'ok', text: target }],
    counts: { wrong: 0, extra: 0, missing: 0 }, tooDifferent: true, ...extra });
  if (a.length > MAX_CP || b.length > MAX_CP) return plain();

  const A = a.map((x, idx) => ({ ...x, idx })).filter(x => x.key);
  const B = b.map((x, idx) => ({ ...x, idx })).filter(x => x.key);
  const n = A.length, m = B.length;
  // Levenshtein table over the significant characters only.
  const d = Array.from({ length: n + 1 }, (_, i) => { const r = new Array(m + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (A[i - 1].key === B[j - 1].key ? 0 : 1));
  }
  // Walk back from the end. A tie goes to a substitution (a wrong letter) before an extra or a missing one.
  const ak = a.map(x => (x.key ? 'ok' : 'ignored')), bk = b.map(x => (x.key ? 'ok' : 'ignored'));
  const carets = new Map();          // typed positions where answer letters are missing -> those letters (in order)
  const counts = { wrong: 0, extra: 0, missing: 0 };
  let shared = 0, i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (A[i - 1].key === B[j - 1].key ? 0 : 1)) {
      if (A[i - 1].key !== B[j - 1].key) { ak[A[i - 1].idx] = 'wrong'; bk[B[j - 1].idx] = 'wrong'; counts.wrong++; } else shared++;
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ak[A[i - 1].idx] = 'extra'; counts.extra++; i--;
    } else {
      bk[B[j - 1].idx] = 'missing'; counts.missing++;
      const pos = i > 0 ? A[i - 1].idx + 1 : 0;        // just after the last typed letter before it
      if (!carets.has(pos)) carets.set(pos, []);
      carets.get(pos).unshift(B[j - 1].ch);
      j--;
    }
  }

  // Nothing in common ("cat" and "dog"): marking every letter says nothing, so show the two texts.
  const tooDifferent = counts.wrong + counts.extra + counts.missing > Math.max(3, 0.6 * m) || (n > 0 && m > 0 && shared === 0);
  if (tooDifferent) return plain({ counts });

  // A leading the/a/an is never held against you, so it is not marked on its own. But when the answer is wrong anyway and the
  // typed text starts with one the answer does not, it is an extra word like any other: strike it through.
  if (counts.wrong + counts.extra + counts.missing > 0) {
    const mine = a.filter(x => x.article), theirs = b.find(x => x.article);
    if (mine.length && mine[0].article !== theirs?.article) { mine.forEach(x => { ak[a.indexOf(x)] = 'extra'; }); counts.extra += mine.length; }
  }

  // The typed row gets a zero-length 'missing' segment (the caret) where answer letters are missing; the one-line
  // version (`line`) has those letters themselves, inserted where they belong.
  const typedSegs = [], line = [];
  const push = (list, kind, text) => { const last = list[list.length - 1]; if (last && last.kind === kind && last.text !== '' && text !== '') last.text += text; else list.push({ kind, text }); };
  const caretAt = pos => { if (carets.has(pos)) { typedSegs.push({ kind: 'missing', text: '' }); push(line, 'missing', carets.get(pos).join('')); } };
  caretAt(0);
  a.forEach((it, p) => { push(typedSegs, ak[p], it.ch); push(line, ak[p], it.ch); caretAt(p + 1); });
  return { expected: target, typed: typedSegs, line, answer: segments(b, bk), counts, tooDifferent: false };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const letters = (n, what) => `${n} ${n === 1 ? 'letter' : 'letters'} ${what}`;

function rowHTML(segs, row) {
  return segs.map(s => {
    const t = esc(s.text);
    if (row === 'typed' || row === 'line') {
      if (s.kind === 'wrong') return `<mark class="d-wrong">${t}</mark>`;
      if (s.kind === 'extra') return `<del class="d-extra">${t}</del>`;
      if (s.kind === 'missing') return row === 'line' ? `<ins class="d-miss">${t}</ins>` : '<i class="d-caret">‸</i>';
    } else {
      if (s.kind === 'wrong') return `<mark class="d-wrong">${t}</mark>`;
      if (s.kind === 'missing') return `<ins class="d-miss">${t}</ins>`;
    }
    return t;
  }).join('');
}

// The text that sits under the letters for a screen reader, and as the visible summary.
function summary(diff) {
  const { wrong, extra, missing } = diff.counts;
  return [wrong && letters(wrong, 'wrong'), extra && `${extra} extra`, missing && `${missing} missing`].filter(Boolean);
}
const spaced = (segs, kind) => graphemes(segs.filter(s => s.kind === kind).map(s => s.text).join('')).join(' ');
const joined = spaced;

// opts.small: the compact version for lists (the Play results).
// opts.answerRow: false = one corrected line (what was typed, wrong letters marked, extra ones struck through, missing
//   ones inserted) and no "Answer" row; the screen-reader text then leaves out "The answer is …" (the card shows it).
// opts.closest: with answerRow false, add a plain "Closest answer" row (for when the card has several answers and
//   the text was compared with one of them).
export function diffHTML(diff, { small = false, answerRow = true, closest = false } = {}) {
  if (!diff) return '';
  const typed = diff.typed.map(s => s.text).join('');
  let sr = `You typed ${typed}.`;
  if (answerRow) sr += ` The answer is ${diff.expected}.`;
  else if (closest) sr += ` Closest answer: ${diff.expected}.`;
  let sum = '';
  if (!diff.tooDifferent) {
    const parts = summary(diff);
    if (parts.length) sum = `<p class="adiff-sum" aria-hidden="true">${esc(parts.join(' · '))}</p>`;
    const detail = [
      diff.counts.wrong && `${letters(diff.counts.wrong, 'wrong')} (you typed ${joined(diff.typed, 'wrong')}, the answer has ${joined(diff.answer, 'wrong')})`,
      diff.counts.extra && `${diff.counts.extra} extra (${joined(diff.typed, 'extra')})`,
      diff.counts.missing && `${diff.counts.missing} missing (${joined(diff.answer, 'missing')})`
    ].filter(Boolean);
    if (detail.length) sr += ` ${detail.join(', ')}.`;
  }
  const row = (label, html) => `<div class="adiff-row" aria-hidden="true"><span class="adiff-lbl">${label}</span><span class="adiff-txt">${html}</span></div>`;
  const rows = answerRow || diff.tooDifferent
    ? row('You typed', rowHTML(diff.typed, 'typed')) + row('Answer', rowHTML(diff.answer, 'answer'))
    : row('You typed', rowHTML(diff.line, 'line')) + (closest ? row('Closest answer', esc(diff.expected)) : '');
  return `<div class="adiff${small ? ' small' : ''}${diff.tooDifferent ? ' plain' : ''}${answerRow ? '' : ' one'}">
    ${rows}
    ${sum}<span class="sr-only">${esc(sr)}</span></div>`;
}

// Convenience for the screens: compare with whichever allowed answer the typed text is nearest to.
// `alternate` is true when that is not the whole back (the back has several answers), so a screen that
// shows the back anyway can add the "Closest answer" row only then.
export function diffAgainstBack(typed, back) {
  const c = closestChoice(typed, back);
  const diff = diffAnswer(typed, c ? c.display : back);
  if (diff) diff.alternate = !!c && c.display !== String(back ?? '').trim();
  return diff;
}

export const hasMarks = diff => !!diff && !diff.tooDifferent && (diff.counts.wrong + diff.counts.extra + diff.counts.missing) > 0;
