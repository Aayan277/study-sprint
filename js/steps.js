// Step-by-step problems (B5). Pure functions (no DOM), tested by tests/steps.test.js.
//
// A card's back is "stepped" when it has lines like these:
//     Optional intro text
//     Step 1: first step (can go on
//     over several lines)
//     Step 2. second step
//     step 3) third step
//     Answer: the final answer
// A marker is "Step", a number, then ":" or "." or ")" (any capitals). There must be at least 2 steps, numbered
// 1, 2, 3, ... one after the other. A step runs until the next marker; text before Step 1 is the intro. An optional
// "Answer:" line after the steps holds the final answer (and everything below it).
//
// `mask` (optional) is for maths: mask(text) returns a string of the SAME length in which the characters inside
// maths ($$ ... $$, $ ... $) are blanked out, so a "Step 2:" written inside a formula is not taken as a marker.
// It is only used to find the markers; the pieces are cut from the real text. (js/math.js will provide maskMath.)

const STEP = /^[ \t]*step[ \t]*(\d+)[ \t]*[:.)][ \t]*/i;
const ELEMENT = /^[ \t]*element[ \t]*(\d+)[ \t]*[:.)][ \t]*/i;     // elements cards: "Element 1: Duty" (see parseElements)
const ANSWER =/^[ \t]*answer[ \t]*:[ \t]*/i;

// → null (not a stepped back) or { intro, steps: [string], final: string | null }
export const parseSteps = (back, opts) => parseMarked(back, STEP, /step/i, true, opts);

// The shared parser. `marker` finds "Step N:" or "Element N:" lines; `withAnswer` allows the "Answer:" line (steps only).
function parseMarked(back, marker, hint, withAnswer, { mask } = {}) {
  const text = String(back ?? '').replace(/\r\n?/g, '\n');
  if (!hint.test(text)) return null;
  let seen = text;
  if (mask) {
    const m = mask(text);
    if (typeof m === 'string' && m.length === text.length) seen = m;
  }
  // Cut the text into lines, remembering where each starts, and find the markers in the masked copy.
  const lines = [];
  for (let at = 0; at <= text.length;) {
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    lines.push({ at, end, seen: seen.slice(at, end) });
    at = end + 1;
  }
  const marks = [];                               // { line, n, skip } for each "Step N:" line
  let answer = null;                              // { line, skip } for the "Answer:" line after the steps
  for (let i = 0; i < lines.length; i++) {
    const s = marker.exec(lines[i].seen);
    if (s) { if (answer) return null; marks.push({ line: i, n: +s[1], skip: s[0].length }); continue; }
    const a = withAnswer && marks.length && !answer ? ANSWER.exec(lines[i].seen) : null;
    if (a) answer = { line: i, skip: a[0].length };
  }
  if (marks.length < 2 || marks.some((m, i) => m.n !== i + 1)) return null;
  const piece = (from, to) => text.slice(from, to).trim();
  const stepEnd = (k) => (k + 1 < marks.length ? lines[marks[k + 1].line].at : answer ? lines[answer.line].at : text.length);
  const steps = marks.map((m, k) => piece(lines[m.line].at + m.skip, stepEnd(k)));
  if (steps.some(s => !s)) return null;           // "Step 2:" with nothing after it is not a step
  const intro = piece(0, lines[marks[0].line].at);
  const final = answer ? piece(lines[answer.line].at + answer.skip, text.length) : null;
  return { intro, steps, final: final || null };
}

export const isStepped = (back, opts) => parseSteps(back, opts) !== null;

// The answer to ask for in Play and typing: the final answer, otherwise the last step. null if not stepped.
export function finalStep(back, opts) {
  const p = parseSteps(back, opts);
  return p ? p.final ?? p.steps[p.steps.length - 1] : null;
}

// Write the parts back as a card back (what the editor saves). parseSteps(joinSteps(p)) gives p back.
export function joinSteps({ intro = '', steps = [], final = null } = {}) {
  const out = [];
  if (intro && intro.trim()) out.push(intro.trim());
  steps.forEach((s, i) => out.push(`Step ${i + 1}: ${String(s).trim()}`));
  if (final && String(final).trim()) out.push(`Answer: ${String(final).trim()}`);
  return out.join('\n');
}

// Will these parts read back as the same steps once saved? False when a line inside a step starts with "Step N:" or
// "Answer:" (or the intro does), because the saved back then parses differently. Used by the editor before it saves.
export function stepsRoundTrip(parts, opts) {
  const steps = (parts.steps || []).map(s => String(s).trim()).filter(Boolean);
  const intro = String(parts.intro ?? '').trim(), final = String(parts.final ?? '').trim();
  const again = parseSteps(joinSteps({ intro, steps, final }), opts);
  // Same number of steps is not enough ("Answer: x" at the end of the last step would turn into the final answer).
  return !!again && again.steps.length === steps.length && again.steps.every((t, i) => t === steps[i])
    && again.intro === intro && (again.final ?? '') === final;
}

// ---------- elements cards ----------
// A list to recall, written as text the same way: an optional intro, then two or more "Element 1: ...", "Element 2: ..." lines
// (numbered one after the other). Nothing about it is stored except the text, so Anki, CSV and older versions show a readable list.
// There is no "Answer:" line. If the back also reads as steps, it is a steps card (steps win).
// → null or { intro, items: [string] }
export function parseElements(back, opts) {
  if (parseSteps(back, opts)) return null;
  const p = parseMarked(back, ELEMENT, /element/i, false, opts);
  return p ? { intro: p.intro, items: p.steps } : null;
}

// A card's structured back for Review, steps or elements, in one shape { kind, intro, steps, final } (elements have no final).
export function parseStructured(back, opts) {
  const s = parseSteps(back, opts);
  if (s) return { kind: 'steps', ...s };
  const e = parseElements(back, opts);
  return e ? { kind: 'elements', intro: e.intro, steps: e.items, final: null } : null;
}

export const isElements = (back, opts) => parseElements(back, opts) !== null;

export function joinElements({ intro = '', items = [] } = {}) {
  const out = [];
  if (intro && intro.trim()) out.push(intro.trim());
  items.forEach((s, i) => out.push(`Element ${i + 1}: ${String(s).trim()}`));
  return out.join('\n');
}

// Will these parts read back as the same elements once saved? False when a line inside an element starts "Element N:"
// (or the saved text would count as steps).
export function elementsRoundTrip(parts, opts) {
  const items = (parts.items || []).map(s => String(s).trim()).filter(Boolean);
  const intro = String(parts.intro ?? '').trim();
  const again = parseElements(joinElements({ intro, items }), opts);
  return !!again && again.items.length === items.length && again.items.every((t, i) => t === items[i]) && again.intro === intro;
}

// The rating Review suggests after recalling n elements with `missed` of them wrong. The numbers are ts-fsrs's Rating
// (Again 1, Hard 2, Good 3, Easy 4). None missed → Good; a quarter or fewer → Hard; more → Again. Easy is never suggested.
export function suggestRating(n, missed) {
  if (!(missed > 0)) return 3;
  return missed / Math.max(1, n) <= 0.25 ? 2 : 1;
}
