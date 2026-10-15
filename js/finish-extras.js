// Extra panels on the finish screens (Review and Play): leeches caught this session and pairs that got mixed up.
// Loaded lazily by the finish screen. Both panels are stubs until their batches land (2D leech coach, 2C pairs).

const leechPanel = (/* { leechIds } */) => '';

import { pairsFor } from './confusion.js';
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// "You mix these up" (B2): up to 3 pairs, involving the cards of this round (or session), from the last 90 days of the
// log. `cardsById` is a Map; a pair whose card is gone is left out. Pure: the pairs come from mixPairs.
export const MAX_PAIRS = 3;
export function pairsHTML(pairs, cardsById, label = c => String(c?.front ?? '')) {
  const rows = pairs.filter(p => cardsById.has(p.a) && cardsById.has(p.b)).slice(0, MAX_PAIRS);
  if (!rows.length) return '';
  return `<section class="mixups"><h2>You mix these up</h2><ul class="mix-list">${rows.map(p => `
    <li class="mix-row"><span class="mix-pair"><span class="mix-card">${esc(label(cardsById.get(p.a)))}</span><span class="mix-vs" aria-hidden="true">vs</span><span class="sr-only"> and </span><span class="mix-card">${esc(label(cardsById.get(p.b)))}</span></span>
      <span class="mix-n mono">${p.count}×</span><button class="btn ghost small" type="button" data-mix-a="${esc(p.a)}" data-mix-b="${esc(p.b)}">Compare</button></li>`).join('')}</ul></section>`;
}
async function pairsPanel({ cardIds }) {
  if (!cardIds?.length) return '';
  const { loadPairs, cardLabel } = await import('./compare-sheet.js');
  const { cardsById, pairs } = await loadPairs();
  return pairsHTML(pairsFor(cardIds, pairs), cardsById, cardLabel);
}

// Compare buttons in the slot open the sheet; "Not confused" in the sheet takes the row away.
function wireCompare(slot) {
  if (slot.dataset.mixWired) return;
  slot.dataset.mixWired = '1';
  slot.addEventListener('click', async e => {
    const btn = e.target.closest('[data-mix-a]');
    if (!btn) return;
    const db = await import('./db.js');
    const [a, b] = await Promise.all([db.get('cards', btn.dataset.mixA), db.get('cards', btn.dataset.mixB)]);
    if (!a || !b) { btn.closest('li')?.remove(); return; }
    (await import('./compare-sheet.js')).openCompare(a, b, {
      onDismiss: () => { btn.closest('li')?.remove(); if (!slot.querySelector('.mix-row')) { slot.querySelector('.mixups')?.remove(); slot.hidden = !slot.innerHTML.trim(); } }
    });
  });
}

// Fills `slot` with the panels, or hides it when there is nothing to show. The pairs panel reads the log, so it comes
// in a moment later; the returned promise settles when it has.
// source: 'review' | 'play'. cardIds: cards answered. leechIds: leeches hit. entries: Play's answer log.
export const drawFinishExtras = (slot, { source, cardIds = [], leechIds = [], entries = [] } = {}) => {
  if (!slot) return;
  // Cards can be deleted (or synced away) mid-session: panels must skip ids that no longer have a card, and a panel
  // that fails leaves the finish screen as it was.
  const safe = fn => { try { return fn() || ''; } catch (err) { console.warn('finish extras:', err); return ''; } };
  const html = safe(() => leechPanel({ source, leechIds }));
  slot.innerHTML = html;
  slot.hidden = !html;
  return Promise.resolve().then(() => pairsPanel({ source, cardIds, entries })).then(more => {
    if (!more || !slot.isConnected) return;
    slot.insertAdjacentHTML('beforeend', more);
    slot.hidden = false;
    wireCompare(slot);
  }).catch(err => console.warn('finish extras:', err));
};
