// The "Postpone reviews" sheet (opened from Today > Options > Custom study; loaded when first needed, it is in the
// service worker's CORE list). The arithmetic is in postpone.js; this draws the choices and saves the new due times.
//   openPostponeSheet({ data, cards, onChange })   data from loadAll, cards = the cards of the decks chosen in Options

import * as db from './db.js';
import { dayEnd } from './days.js';
import { recallAt, examInfo, FINAL_DAYS } from './exam.js';
import { effectiveDeck } from './deck-tree.js';
import { postponeCandidates, postponeStates, defaultCount, averages, pct } from './postpone.js';
import { openSheet, closeSheet, plural, toast, $ } from './ui.js';

const CHOICES = [[1, '1 day'], [2, '2 days'], [3, '3 days'], [7, '1 week']];

// "tomorrow", "Sunday", or "Sun 25 Oct" for a week or more.
export function dayName(days, now = Date.now()) {
  if (days === 1) return 'tomorrow';
  const d = new Date(dayEnd(now, days - 1));
  return days >= 7 ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : d.toLocaleDateString(undefined, { weekday: 'long' });
}

export function openPostponeSheet({ data, cards, onChange = () => {} }) {
  let days = 2, count = 0;
  let list = [];
  const examNear = new Map();           // deck id → days left of the exam it has (or inherits)
  for (const d of data.decks) examNear.set(d.id, examInfo(effectiveDeck(data.decks, d.id))?.daysLeft);

  const compute = () => {
    list = postponeCandidates(cards, data.statesById, {
      days, recallAt,
      // A deck with an exam within `days` + the final pass's 3 days is left alone, and so is a card the final pass brought forward.
      skip: card => data.exam.caps.has(card.id) || examNear.get(card.deckId) <= days + FINAL_DAYS
    });
    count = defaultCount(list);
  };

  openSheet(`
    <h2 id="sheetTitle">Postpone reviews</h2>
    <p>Busy few days? Push back the reviews you'll still remember best.</p>
    <div class="chips" role="group" aria-label="Push back by">
      ${CHOICES.map(([d, l]) => `<button type="button" class="tchip" data-pdays="${d}" aria-pressed="${d === days}">${l}</button>`).join('')}
    </div>
    <div class="cs-row" style="margin-top:var(--s-3)">
      <span id="ppHowLbl">How many</span>
      <div class="stepper">
        <button type="button" class="icon-btn" id="ppMinus" aria-label="Fewer">−</button>
        <input id="ppCount" type="number" inputmode="numeric" min="0" aria-labelledby="ppHowLbl">
        <button type="button" class="icon-btn" id="ppPlus" aria-label="More">+</button>
      </div>
    </div>
    <p class="pp-line" id="ppLine" role="status" aria-live="polite"></p>
    <p class="note" id="ppNote"></p>
    <div class="sheet-actions">
      <button class="btn ghost" type="button" id="ppCancel">Cancel</button>
      <button class="btn primary" type="button" id="ppGo">Postpone</button>
    </div>`);

  const draw = () => {
    count = Math.max(0, Math.min(list.length, Math.round(Number(count) || 0)));
    $('ppCount').value = count; $('ppCount').max = list.length;
    $('ppNote').textContent = `Decks with an exam in the next ${days + FINAL_DAYS} days are left out.`;
    const avg = averages(list, count);
    $('ppLine').innerHTML = !list.length ? 'Nothing to postpone: no reviews are due.'
      : `Moves <b>${count}</b> of ${list.length} due reviews to ${dayName(days)}.${avg ? ` Expected recall on them: ${pct(avg.before)} now, ${pct(avg.after)} then.` : ''}`;
    $('ppGo').textContent = count ? `Postpone ${plural(count, 'review')}` : 'Postpone';
    $('ppGo').disabled = !count;
    $('ppMinus').disabled = count <= 0; $('ppPlus').disabled = count >= list.length; $('ppCount').disabled = !list.length;
  };
  compute(); draw();

  document.querySelectorAll('#sheet [data-pdays]').forEach(b => b.addEventListener('click', () => {
    days = +b.dataset.pdays;
    document.querySelectorAll('#sheet [data-pdays]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    compute(); draw();
  }));
  $('ppCount').addEventListener('change', e => { count = e.target.value; draw(); });
  $('ppMinus').addEventListener('click', () => { count = Math.max(0, count - (count > 20 ? 10 : 1)); draw(); });
  $('ppPlus').addEventListener('click', () => { count = Math.min(list.length, count + (count >= 20 ? 10 : 1)); draw(); });
  $('ppCancel').addEventListener('click', closeSheet);
  $('ppGo').addEventListener('click', async () => {
    const chosen = list.slice(0, count);
    if (!chosen.length) return;
    $('ppGo').disabled = true;
    const now = Date.now();
    const next = postponeStates(chosen, days, now);
    const olds = chosen.map(x => x.state);
    await db.putStates(next);
    const where = dayName(days, now);
    closeSheet();
    toast(`Postponed ${plural(chosen.length, 'review')} to ${where}`, {
      hold: true,
      link: { href: '#', label: 'Undo', onClick: async () => {
        // Only the cards still as postponed: one reviewed or changed since is left alone.
        const cur = new Map((await db.getAll('cardStates')).map(s => [s.cardId, s]));
        const back = olds.filter((o, i) => { const c = cur.get(o.cardId); return c && c.due === next[i].due && c.lastReview === o.lastReview; });
        if (back.length) await db.putStates(back);
        toast(back.length ? `Put ${plural(back.length, 'review')} back` : 'Nothing to put back');
        onChange();
      } }
    });
    onChange();
  });
}
