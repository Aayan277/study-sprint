// "Compare" sheet for two cards that keep getting mixed up (B2, see confusion.js). Loaded when first opened
// (lazily, from the finish screens and the card panel; it is in the service worker's CORE list).
//   two columns side by side (stacked under 600px)
//   Drill these            6 questions in Play on the pair and 4 look-alike neighbours; the partner is always an option
//   Make a comparison card the add-card form, prefilled "A vs B: what's the difference?" in the first card's deck (nothing is saved
//                          until Add, so Cancel leaves nothing behind)
//   Not confused           hides the pair until it has been mixed up twice more (this device only)

import * as db from './db.js';
import { mixPairs, pairKey, dismissPair, loadDismissed, saveDismissed, MIX_WINDOW_DAYS, cardLabel, neighbours, comparisonText } from './confusion.js';
import { daysAgoStart } from './stats-calc.js';
import { mathHTML } from './format.js';
import { imgHTML } from './media.js';
import { openSheet, closeSheet, esc, plural, toast, $ } from './ui.js';

export { cardLabel };     // (finish-extras and the card panel use it)

// The pairs the person mixes up now (last 90 days, minus the ones they said they're not confused about), with the
// cards by id. One read of the log; callers keep what they need.
export async function loadPairs({ now = Date.now() } = {}) {
  const [logs, cards] = await Promise.all([db.getLogsSince(daysAgoStart(MIX_WINDOW_DAYS, now)), db.getAll('cards')]);
  const cardsById = new Map(cards.map(c => [c.id, c]));
  return { cardsById, pairs: mixPairs(logs, { cardsById, since: daysAgoStart(MIX_WINDOW_DAYS, now), dismissed: loadDismissed() }) };
}

const side = card => `
  <section class="cmp-col" aria-label="${esc(cardLabel(card))}">
    <p class="cmp-lbl">Front</p>
    <div class="cmp-text">${imgHTML(card.frontImage, 'card-img cmp-img')}${mathHTML(card.front)}</div>
    <p class="cmp-lbl">Back</p>
    <div class="cmp-text cmp-back">${imgHTML(card.backImage, 'card-img cmp-img')}${mathHTML(card.back)}</div>
  </section>`;

// a, b: the two cards (from the database). onDismiss(pair) runs after "Not confused"; onDone() after a comparison card was added.
export async function openCompare(a, b, { onDismiss = () => {}, onDone = () => {} } = {}) {
  if (!a || !b) return;
  const { pairs } = await loadPairs();
  const pair = pairs.find(p => p.key === pairKey(a.id, b.id));
  openSheet(`
    <h2 id="sheetTitle">Compare</h2>
    <p class="note cmp-note">${pair ? `You’ve mixed these two up ${plural(pair.count, 'time')} in the last ${MIX_WINDOW_DAYS} days.` : 'Side by side, so the difference is easy to see.'}</p>
    <div class="cmp">${side(a)}${side(b)}</div>
    <div class="sheet-actions stack">
      <button class="btn primary" type="button" id="cmpDrill">Drill these</button>
      <button class="btn ghost" type="button" id="cmpMake">Make a comparison card</button>
      ${pair ? '<button class="btn ghost" type="button" id="cmpNot">Not confused</button>' : ''}
    </div>`);
  $('cmpDrill').addEventListener('click', async () => {
    const cards = await db.getAll('cards');
    const ids = [a, b, ...neighbours(a, b, cards)].map(c => c.id);
    closeSheet();
    (await import('./play.js')).drillCards(ids, { mix: [[a.id, b.id], [b.id, a.id]], total: 6 });
  });
  $('cmpMake').addEventListener('click', async () => {
    const btn = $('cmpMake');
    if (btn.disabled) return;
    btn.disabled = true;                                           // a double tap must not open the form twice
    try {
      const { front, back } = comparisonText(a, b);
      const decks = await db.getDecks();
      (await import('./browse.js')).openAddCard({ decks, deckId: a.deckId, refresh: () => {}, prefill: { front, back, onAdded: onDone } });
    } catch (err) { console.error(err); btn.disabled = false; toast("Couldn't open the card form. Try again."); }
  });
  $('cmpNot')?.addEventListener('click', () => {
    saveDismissed(dismissPair(loadDismissed(), pair));
    closeSheet();
    toast('Okay, hidden until you mix them up again');
    onDismiss(pair);
  });
}
