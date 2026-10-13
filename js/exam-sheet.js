// Setting a deck's exam date, shared by every place that does it:
//   - Edit deck (decks.js) saves through commitDeck()
//   - the short "exam" sheet (openExamSheet), opened from Today's "Add exam date" chips and from a deck's page,
//     saves through the same commitDeck(), so the same things happen: cards scheduled after the exam are brought
//     forward (pullIn in exam.js), and the same date check runs (examDateError).

import * as db from './db.js';
import { drawSidebar } from './sidebar.js';
import { dayStart } from './days.js';
import { $, esc, toast, closeSheet, openSheet, plural } from './ui.js';
import { effectiveDeck, subtreeIds } from './deck-tree.js';
import { examInfo, examStart, countdown, pullIn } from './exam.js';

// What is wrong with an exam date typed in a box ('' when it is fine). Blank is fine: it clears the date.
export function examDateError(value, now = Date.now()) {
  if (!value) return '';
  const start = examStart(value);
  if (start === null) return 'Pick a valid exam date.';
  if (start < dayStart(now)) return 'That date has passed. Pick today or a later day, or clear it.';
  return '';
}

// Save a deck (new, or with changes). If it now has an exam date that it (or the deck it is inside) didn't have, the
// cards scheduled after that date are brought forward to before it, in this deck and in the subdecks that use the date.
// `decks` is every deck as it was before this save. Returns { moved }: how many cards were brought forward.
export async function commitDeck(saved, decks, { isNew = false } = {}) {
  await db.saveDeck(saved);
  let moved = 0;
  const after = decks.map(d => (d.id === saved.id ? saved : d)).concat(isNew ? [saved] : []);
  const exam = effectiveDeck(after, saved.id).examDate;
  if (!isNew && exam && exam !== effectiveDeck(decks, saved.id).examDate) {
    const dIds = [...subtreeIds(after, saved.id)].filter(id => effectiveDeck(after, id).examDate === exam);
    const ids = new Set((await db.getAll('cards')).filter(c => dIds.includes(c.deckId)).map(c => c.id));
    const changed = pullIn((await db.getAll('cardStates')).filter(st => ids.has(st.cardId)), { examDate: exam }, Date.now(), (await db.getSettings()).easyDays);
    if (changed.length) await db.putStates(changed);
    moved = changed.length;
  }
  drawSidebar();          // the sidebar's deck list and exam markers
  return { moved };
}
// YYYY-MM-DD for the study day (days.js: it starts at 4am) plus n days, in local time (what a date box wants).
// YYYY-MM-DD for today plus n days, in local time (what a date box wants).
const isoIn = (n, from = new Date(dayStart())) => {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const PRESETS = [['In 1 week', 7], ['In 2 weeks', 14], ['In 4 weeks', 28]];

// The short sheet: a date box with presets, and one button. onDone(saved) runs after saving.
export async function openExamSheet(deckId, onDone = () => {}) {
  const decks = await db.getDecks();
  const deck = decks.find(d => d.id === deckId);
  if (!deck) return;
  openSheet(`
    <h2 id="sheetTitle">${esc(deck.name)} exam</h2>
    <form id="xdForm" class="sheet-in" style="padding:0" novalidate>
      <label class="field"><span>Exam date</span>
        <input id="xdDate" class="exam-date" type="date" min="${isoIn(0)}" value="${esc(deck.examDate && !examDateError(deck.examDate) ? deck.examDate : isoIn(14))}" required></label>
      <div class="exam-quick" role="group" aria-label="Quick dates">
        ${PRESETS.map(([label, n]) => `<button type="button" class="tchip" data-days="${n}" aria-pressed="false">${label}</button>`).join('')}
      </div>
      <p class="note" style="margin:0">Every card in ${esc(deck.name)} comes back before then, reviews get a bit stricter in the last two weeks, and Exam prep goes over what you haven't seen lately.</p>
      <p class="err" id="xdErr" hidden></p>
      <div class="sheet-actions"><button class="btn primary" type="submit">Save exam date</button></div>
    </form>`);
  const sync = () => document.querySelectorAll('#sheet [data-days]').forEach(b => b.setAttribute('aria-pressed', String($('xdDate').value === isoIn(+b.dataset.days))));
  sync();
  $('xdDate').addEventListener('input', sync);
  document.querySelectorAll('#sheet [data-days]').forEach(b => b.addEventListener('click', () => { $('xdDate').value = isoIn(+b.dataset.days); sync(); $('xdErr').hidden = true; }));
  $('xdForm').addEventListener('submit', async e => {
    e.preventDefault();
    const value = $('xdDate').value;
    const problem = value ? examDateError(value) : 'Pick an exam date.';
    if (problem) { $('xdErr').textContent = problem; $('xdErr').hidden = false; return; }
    const saved = { ...deck, examDate: value };
    const { moved } = await commitDeck(saved, decks);
    closeSheet();
    toast(`${deck.name}: ${countdown(examInfo(saved)).toLowerCase()}${moved ? `. ${plural(moved, 'card')} brought forward to before it` : ''}`);
    onDone(saved);
  });
}
