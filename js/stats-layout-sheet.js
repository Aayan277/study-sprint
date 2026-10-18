// The "Customise Stats" sheet (opened from the Stats page): every Stats card with a show/hide switch, move up and down buttons
// and a Half / Full width choice, and "Reset to default". Loaded when first opened (it is in the service worker's CORE list).
// Every change is saved at once (the synced setting `statsLayout`, see stats-layout.js) and onChange redraws the page behind the sheet.
//
// The list is updated in place, never redrawn, so the focus stays on the button you pressed. A live region says where a card went.

import * as db from './db.js';
import { openSheet, closeSheet, esc, icon, $ } from './ui.js';
import { cardInfo, normaliseLayout, moveCard, setHidden, setSize, toSaved, isDefaultLayout, resetLayout } from './stats-layout.js';

export async function openStatsLayoutSheet({ onChange = () => {} } = {}) {
  let layout = normaliseLayout((await db.getSettings()).statsLayout);
  let chain = Promise.resolve();
  // Saves run one after the other, so quick taps cannot save in the wrong order.
  const save = () => {
    const value = toSaved(layout);
    chain = chain.then(() => db.setSetting('statsLayout', value)).then(() => onChange()).catch(err => console.error(err));
    return chain;
  };

  const row = id => {
    const c = cardInfo(id), name = esc(c.name);
    return `<li class="sl-row" data-id="${id}">
      <div class="sl-top">
        <span class="sl-grip" aria-hidden="true" title="Drag to move">⠿</span>
        <label class="sl-show"><input type="checkbox" class="switch" data-act="show" aria-label="Show ${name}"><span class="sl-name">${name}</span></label>
        <span class="sl-moves">
          <button type="button" class="sl-btn" data-act="up" aria-label="Move ${name} up">${icon('down', 'sl-up')}</button>
          <button type="button" class="sl-btn" data-act="down" aria-label="Move ${name} down">${icon('down')}</button>
        </span>
      </div>
      <div class="sl-size chips" role="radiogroup" aria-label="${name} size on wide screens">
        ${[['half', 'Half'], ['full', 'Full']].map(([v, l]) => `<label class="chip"><input type="radio" name="sz-${id}" value="${v}" data-act="size"><span>${l}</span></label>`).join('')}
      </div>
    </li>`;
  };

  openSheet(`
    <h2 id="sheetTitle">Customise Stats</h2>
    <p class="muted small sl-note">Show or hide a card, move it up or down, and pick its size. Size applies on wider screens: on a phone every card is full width. Two half cards side by side share a row; a half card with no half card next to it shows full width.</p>
    <ol class="sl-list" id="slList">${layout.order.map(row).join('')}</ol>
    <div class="sl-confirm" id="slConfirm" role="group" aria-labelledby="slConfirmQ" hidden>
      <p id="slConfirmQ"><b>Reset to the default layout?</b> All cards come back, in their usual order and size.</p>
      <div class="sl-confirm-btns"><button type="button" class="btn ghost" id="slNo">Keep my layout</button><button type="button" class="btn danger" id="slYes">Reset</button></div>
    </div>
    <p class="sr-only" id="slLive" role="status" aria-live="polite"></p>
    <div class="sheet-actions"><button type="button" class="btn ghost" id="slReset">Reset to default</button><button type="button" class="btn primary" id="slDone">Done</button></div>`);

  const list = $('slList'), live = $('slLive'), resetBtn = $('slReset');
  const rowOf = id => list.querySelector(`.sl-row[data-id="${id}"]`);
  // Bring the rows in line with `layout` (order, switches, sizes, which arrows can be used).
  const paint = () => {
    const n = layout.order.length;
    layout.order.forEach((id, i) => {
      const r = rowOf(id);
      if (list.children[i] !== r) list.insertBefore(r, list.children[i] || null);
      r.classList.toggle('off', layout.hidden.includes(id));
      r.querySelector('[data-act=show]').checked = !layout.hidden.includes(id);
      r.querySelectorAll('[data-act=size]').forEach(x => { x.checked = x.value === layout.size[id]; });
      // (aria-disabled, not disabled: the focus must not be lost when a card reaches the top or bottom)
      r.querySelector('[data-act=up]').setAttribute('aria-disabled', String(i === 0));
      r.querySelector('[data-act=down]').setAttribute('aria-disabled', String(i === n - 1));
    });
    resetBtn.setAttribute('aria-disabled', String(isDefaultLayout(layout)));
  };
  const say = text => { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); };
  paint();

  list.addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('.sl-row').dataset.id, dir = b.dataset.act === 'up' ? -1 : 1, name = cardInfo(id).name;
    const from = layout.order.indexOf(id);
    if (b.getAttribute('aria-disabled') === 'true') { say(`${name} is already ${dir < 0 ? 'first' : 'last'}.`); return; }
    layout = moveCard(layout, id, dir);
    paint();
    b.focus();
    say(`${name} moved to position ${layout.order.indexOf(id) + 1} of ${layout.order.length}.`);
    if (from !== layout.order.indexOf(id)) save();
  });
  list.addEventListener('change', e => {
    const t = e.target, id = t.closest('.sl-row')?.dataset.id;
    if (!id) return;
    const name = cardInfo(id).name;
    if (t.dataset.act === 'show') {
      layout = setHidden(layout, id, !t.checked);
      say(`${name} ${t.checked ? 'shown' : 'hidden'}.`);
    } else if (t.dataset.act === 'size') {
      layout = setSize(layout, id, t.value);
      say(`${name} is now ${t.value} width.`);
    } else return;
    paint();
    save();
  });

  // Drag to reorder (Pointer Events, so it works with a mouse, a pen and touch). The grip is for pointers only; the arrow buttons
  // stay the way to do it from the keyboard or a screen reader. The row follows the pointer and the list opens a gap where it will
  // land; the order is saved on drop. Escape or a cancelled pointer puts the row back.
  let drag = null;
  const scroller = list.closest('.sheet-in') || list.parentElement;
  const endDrag = commit => {
    if (!drag) return;
    const d = drag; drag = null;
    cancelAnimationFrame(d.raf);
    document.removeEventListener('keydown', d.onKey, true);
    for (const [t, f] of [['pointermove', d.move], ['pointerup', d.up], ['pointercancel', d.cancel]]) document.removeEventListener(t, f);
    d.row.classList.remove('lifted'); d.row.style.transform = '';
    list.classList.remove('dragging');
    const ids = [...list.children].map(r => r.dataset.id);
    if (commit && ids.join() !== d.before.join()) {
      layout = { ...layout, order: ids };
      paint();
      say(`Moved ${cardInfo(d.id).name} to position ${ids.indexOf(d.id) + 1} of ${ids.length}.`);
      save();
    } else { d.before.forEach(id => list.appendChild(rowOf(id))); paint(); }
  };
  list.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.sl-grip');
    if (!grip || drag || (e.pointerType === 'mouse' && e.button !== 0) || e.isPrimary === false) return;
    e.preventDefault();
    const row = grip.closest('.sl-row');
    const d = drag = { grip, row, id: row.dataset.id, pid: e.pointerId, y: e.clientY, before: [...list.children].map(r => r.dataset.id), grab: e.clientY - row.getBoundingClientRect().top };
    row.classList.add('lifted'); list.classList.add('dragging');
    const follow = () => {
      // Swap with a neighbour once the row's middle passes the neighbour's middle.
      row.style.transform = '';
      for (;;) {
        const r = row.getBoundingClientRect(), mid = d.y - d.grab + r.height / 2;
        const prev = row.previousElementSibling, next = row.nextElementSibling;
        const pr = prev?.getBoundingClientRect(), nr = next?.getBoundingClientRect();
        if (prev && mid < pr.top + pr.height / 2) list.insertBefore(row, prev);
        else if (next && mid > nr.top + nr.height / 2) list.insertBefore(next, row);
        else break;
      }
      row.style.transform = `translateY(${d.y - d.grab - row.getBoundingClientRect().top}px)`;
    };
    // Near the top or bottom edge of the sheet's list the sheet scrolls by itself.
    const auto = () => {
      const sr = scroller.getBoundingClientRect();
      const dy = d.y < sr.top + 48 ? -10 : d.y > sr.bottom - 48 ? 10 : 0;
      if (dy) { const was = scroller.scrollTop; scroller.scrollTop += dy; if (scroller.scrollTop !== was) follow(); }
      d.raf = requestAnimationFrame(auto);
    };
    // (Listened for on the document: moving the row in the list drops a pointer capture, so the grip cannot be relied on.)
    const mine = ev => ev.pointerId === d.pid;
    d.move = ev => { if (mine(ev)) { d.y = ev.clientY; follow(); } };
    d.up = ev => { if (mine(ev)) endDrag(true); };
    d.cancel = ev => { if (mine(ev)) endDrag(false); };
    d.onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); endDrag(false); say('Move cancelled.'); } };
    for (const [t, f] of [['pointermove', d.move], ['pointerup', d.up], ['pointercancel', d.cancel]]) document.addEventListener(t, f);
    document.addEventListener('keydown', d.onKey, true);
    d.raf = requestAnimationFrame(auto);
    follow();
  });

  // Reset asks first.
  const confirm = $('slConfirm');
  resetBtn.addEventListener('click', () => {
    if (resetBtn.getAttribute('aria-disabled') === 'true') { say('Already the default layout.'); return; }
    confirm.hidden = false;
    confirm.scrollIntoView({ block: 'nearest' });
    $('slNo').focus();
  });
  $('slNo').addEventListener('click', () => { confirm.hidden = true; resetBtn.focus(); });
  $('slYes').addEventListener('click', () => {
    layout = resetLayout();
    confirm.hidden = true;
    paint();
    resetBtn.focus();
    say('Stats are back to the default layout.');
    save();
  });
  $('slDone').addEventListener('click', closeSheet);
}

