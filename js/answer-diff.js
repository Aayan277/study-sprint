// Shows which letters of a typed answer were wrong. Pure functions (no DOM), tested by tests/answer-diff.test.js.
//
// It lines the typed answer up with the answer letter by letter (the same costs as editDistance in match.js) and
// marks what differs: a letter that is wrong, a letter that is extra, and a letter that is missing. Capitals,
// accents, punctuation, spaces and a leading the/a/an are never marked, so the picture never disagrees with the
// verdict from checkAnswer. Text is worked on as code points, so emoji and kana are never split.

import { closestChoice } from './match.js';

const MAX_CP = 300;            // longer than this on either side: no diff, just the two texts
const SIG = /[\p{L}\p{N}]/gu;  // what counts as a letter or digit

// A code point folded the way normalizeAnswer folds (lower case, accents off), keeping only letters and digits.
// '' means "ignored" (punctuation, a space).
const fold = ch => (ch.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(SIG) || []).join('');

// The code points of a text, each with its folded key. A leading the/a/an and its space are ignored too.
function prepare(text) {
  const cps = Array.from(String(text ?? ''));
  const items = cps.map(ch => ({ ch, key: fold(ch) }));
  let i = 0;
  while (i < items.length && !items[i].key) i++;
  let j = i;
  while (j < items.length && items[j].key) j++;
  const word = items.slice(i, j).map(x => x.key).join('');
  if (['the', 'a', 'an'].includes(word) && items.slice(j).some(x => x.key) && j < items.length) {
    for (let k = i; k < j; k++) items[k].key = '';
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
  const carets = new Set();          // typed positions where an answer letter is missing
  const counts = { wrong: 0, extra: 0, missing: 0 };
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (A[i - 1].key === B[j - 1].key ? 0 : 1)) {
      if (A[i - 1].key !== B[j - 1].key) { ak[A[i - 1].idx] = 'wrong'; bk[B[j - 1].idx] = 'wrong'; counts.wrong++; }
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ak[A[i - 1].idx] = 'extra'; counts.extra++; i--;
    } else {
      bk[B[j - 1].idx] = 'missing'; counts.missing++;
      carets.add(i > 0 ? A[i - 1].idx + 1 : 0);        // just after the last typed letter before it
      j--;
    }
  }

  const tooDifferent = counts.wrong + counts.extra + counts.missing > Math.max(3, 0.6 * m);
  if (tooDifferent) return plain({ counts });

  // The typed row gets a zero-length 'missing' segment (the caret) where answer letters are missing.
  const typedSegs = [];
  const pushCaret = pos => { if (carets.has(pos)) typedSegs.push({ kind: 'missing', text: '' }); };
  pushCaret(0);
  a.forEach((it, p) => {
    const kind = ak[p], last = typedSegs[typedSegs.length - 1];
    if (last && last.kind === kind && last.text !== '') last.text += it.ch; else typedSegs.push({ kind, text: it.ch });
    pushCaret(p + 1);
  });
  return { expected: target, typed: typedSegs, answer: segments(b, bk), counts, tooDifferent: false };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const letters = (n, what) => `${n} ${n === 1 ? 'letter' : 'letters'} ${what}`;

function rowHTML(segs, row) {
  return segs.map(s => {
    const t = esc(s.text);
    if (row === 'typed') {
      if (s.kind === 'wrong') return `<mark class="d-wrong">${t}</mark>`;
      if (s.kind === 'extra') return `<del class="d-extra">${t}</del>`;
      if (s.kind === 'missing') return '<i class="d-caret">‸</i>';
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
const joined = (segs, kind) => segs.filter(s => s.kind === kind).map(s => s.text).join('').split('').join(' ');

// opts.small: the compact version for lists (the Play results).
export function diffHTML(diff, { small = false } = {}) {
  if (!diff) return '';
  const typed = diff.typed.map(s => s.text).join('');
  let sr = `You typed ${typed}. The answer is ${diff.expected}.`;
  let sum = '';
  if (!diff.tooDifferent) {
    const parts = summary(diff);
    sum = `<p class="adiff-sum" aria-hidden="true">${esc(parts.join(' · '))}</p>`;
    const detail = [
      diff.counts.wrong && `${letters(diff.counts.wrong, 'wrong')} (${joined(diff.typed, 'wrong')})`,
      diff.counts.extra && `${diff.counts.extra} extra (${joined(diff.typed, 'extra')})`,
      diff.counts.missing && `${diff.counts.missing} missing (${joined(diff.answer, 'missing')})`
    ].filter(Boolean);
    sr += ` ${detail.join(', ')}.`;
  }
  return `<div class="adiff${small ? ' small' : ''}${diff.tooDifferent ? ' plain' : ''}">
    <div class="adiff-row" aria-hidden="true"><span class="adiff-lbl">You typed</span><span class="adiff-txt">${rowHTML(diff.typed, 'typed')}</span></div>
    <div class="adiff-row" aria-hidden="true"><span class="adiff-lbl">Answer</span><span class="adiff-txt">${rowHTML(diff.answer, 'answer')}</span></div>
    ${sum}<span class="sr-only">${esc(sr)}</span></div>`;
}

// Convenience for the screens: compare with whichever allowed answer the typed text is nearest to.
export function diffAgainstBack(typed, back) {
  const c = closestChoice(typed, back);
  return diffAnswer(typed, c ? c.display : back);
}

export const hasMarks = diff => !!diff && !diff.tooDifferent && (diff.counts.wrong + diff.counts.extra + diff.counts.missing) > 0;
