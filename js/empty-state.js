// The "Nothing to study yet" start block: Today shows it when there are no cards at all (after Skip in the
// first-run start, or after deleting everything). Add cards (into the course, when there is just one), try the
// sample cards, or read how it works again.

import { icon } from './ui.js';
import { addSampleDeck } from './sample.js';
import { go as navGo } from './nav.js';

const ART = '<svg class="empty-art" viewBox="0 0 120 96" aria-hidden="true"><rect x="34" y="10" width="62" height="74" rx="10" fill="none" stroke="var(--line-strong)" stroke-width="2" transform="rotate(8 65 47)"/><rect x="24" y="14" width="62" height="74" rx="10" fill="var(--surface-2)" stroke="var(--line-strong)" stroke-width="2"/><path d="M58 30l-12 18h9l-2 14 12-18h-9z" fill="var(--accent)" style="filter:drop-shadow(0 0 6px var(--glow))"/><circle cx="96" cy="20" r="2.5" fill="var(--accent-text)"/><circle cx="104" cy="34" r="1.8" fill="var(--accent-text)"/><circle cx="14" cy="70" r="2" fill="var(--accent-text)"/></svg>';

// courseId: the one course to paste into, or '' to let the import screen ask.
export const emptyStartHTML = ({ courseId = '' } = {}) => `<div class="empty empty-first">${ART}<b>Nothing to study yet</b>
  <p>Add terms and definitions and Study Sprint turns them into flashcards. Or try 12 sample cards first.</p>
  <div class="empty-btns"><a class="btn primary" href="#/import${courseId ? '/' + encodeURIComponent(courseId) : ''}">${icon('paste')} Add cards</a>
    <button class="btn ghost" type="button" id="trySample">Try sample cards</button></div>
  <a class="fr-how" href="#/help">How it works ›</a></div>`;

export const wireEmptyStart = el => {
  el.querySelector('#trySample')?.addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    await addSampleDeck();
    navGo('#/welcome/review/sample');          // three guided cards, then "Add your own cards"
  });
};
