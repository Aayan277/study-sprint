// Edit mode for the Stats page, like the iPhone home screen: tap Edit, then on the page itself drag the real cards to reorder
// them, tap x to remove one, flip a card between half and full width, and bring hidden ones back with "Add widget".
// Loaded when Edit is first pressed (it is in the service worker's CORE list). The page (js/stats.js) draws the cards, each one
// wrapped by unitHTML() here; createSession() makes them work. The layout logic is js/stats-layout.js; every change is saved
// at once into the synced setting `statsLayout`.
//
// How a session ends: Done, or the person leaving Stats. Every listener belongs to one AbortController, so ending a session (also
// in the middle of a drag) removes them all, stops the auto-scroll and the long-press timer, and saves nothing that was not dropped.

import * as db from './db.js';
import { openSheet, closeSheet, esc, icon } from './ui.js';
import { cardInfo, normaliseLayout, setHidden, setSize, canResize, reorderVisible, addWidget, hiddenCards, resetLayout, isDefaultLayout, toSaved, editPlan, visibleOrder } from './stats-layout.js';

const LONG_PRESS = 300;       // a touch must stay put this long before the card lifts (a quicker swipe scrolls the page)
const MOUSE_SLOP = 4;         // a mouse press must travel this far before the card lifts (a plain click does nothing)
const SLOP = 10;              // how far a finger may drift during that time, in px
const EDGE = 70;              // auto-scroll starts this close to the top or bottom of the window

// ---------- the markup ----------
export const editBarHTML = () => `
  <div class="ed-bar" id="edBar" role="region" aria-label="Edit Stats">
    <div class="ed-row">
      <div class="ed-title"><b>Editing Stats</b></div>
      <div class="ed-btns">
        <button type="button" class="ed-list" data-act="list" aria-haspopup="dialog">Edit as a list</button>
        <button type="button" class="ed-list" id="edReset" data-act="reset">Reset</button>
        <button type="button" class="btn primary" id="edDone" data-act="done">Done</button>
      </div>
    </div>
    <div class="ed-confirm" id="edConfirm" role="group" aria-labelledby="edConfirmQ" hidden>
      <p id="edConfirmQ"><b>Reset to the default layout?</b> All cards come back, in their usual order and size.</p>
      <div class="ed-confirm-btns"><button type="button" class="btn ghost" data-act="reset-no">Keep my layout</button><button type="button" class="btn danger" data-act="reset-yes">Reset</button></div>
    </div>
    <p class="sr-only" id="edLive" role="status" aria-live="polite"></p>
  </div>`;

// One card in edit mode: its own markup (inert, so a tap on a bar or the calendar does nothing) plus the controls.
export function unitHTML(id, cardHTML, layout) {
  const n = esc(cardInfo(id).name), plan = editPlan(layout, visibleOrder(layout)).get(id) || { w: 'full' };
  const half = layout.size[id] === 'half';
  return `<div class="ed-unit" data-card="${id}" data-w="${plan.w}"${plan.lone ? ' data-lone' : ''} role="group" aria-label="${n}">
    <div class="ed-body" inert>${cardHTML}</div>
    <button type="button" class="ed-x" data-act="remove" aria-label="Remove ${n}"><span aria-hidden="true">${icon('x')}</span></button>
    ${canResize(id) ? `<button type="button" class="ed-size" data-act="size" aria-label="Make ${n} ${half ? 'full' : 'half'} width"><span aria-hidden="true">${half ? 'Half' : 'Full'}</span></button>` : ''}
    <span class="ed-moves">
      <button type="button" class="ed-mv" data-act="earlier" aria-label="Move ${n} earlier"><span aria-hidden="true">${icon('down', 'ed-prev')}</span></button>
      <button type="button" class="ed-mv" data-act="later" aria-label="Move ${n} later"><span aria-hidden="true">${icon('down', 'ed-next')}</span></button>
    </span>
  </div>`;
}
export const slotHTML = () => '<div class="ed-slot" data-w="half" aria-hidden="true"><span>Drop a half-size card here</span></div>';
export function addTileHTML(layout) {
  const n = hiddenCards(layout).length;
  return n
    ? `<button type="button" class="ed-add" id="edAdd" data-act="add" aria-haspopup="dialog">${icon('plus')}<span>Add widget</span><small class="muted">${n} hidden</small></button>`
    : `<button type="button" class="ed-add" id="edAdd" data-act="add" aria-disabled="true">${icon('check')}<span>All widgets are on the page</span></button>`;
}

// Small static pictures for the Add widget list (shapes only, in the accent colour).
const THUMBS = {
  streak: '<path d="M20 6c2 6 9 9 9 17a9 9 0 0 1-18 0c0-3.5 2-5.5 3.5-7 .5 2 1.8 3.5 3.5 4C17 15 18 10.5 20 6z" fill="currentColor" opacity=".85"/>',
  retention: '<circle cx="20" cy="20" r="11" fill="none" stroke="currentColor" opacity=".25" stroke-width="5"/><path d="M20 9a11 11 0 1 1-10.4 14.7" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>',
  rs: '<path d="M6 12h28M6 20h28M6 28h28" stroke="currentColor" opacity=".25" stroke-width="2"/><circle cx="16" cy="12" r="3" fill="currentColor"/><circle cx="24" cy="20" r="3" fill="currentColor"/><circle cx="20" cy="28" r="3" fill="currentColor"/><path d="M27 8v24" stroke="currentColor" stroke-width="1.5"/>',
  cal: Array.from({ length: 28 }, (_, i) => `<rect x="${6 + (i % 7) * 4.6}" y="${6 + Math.floor(i / 7) * 7.2}" width="3.6" height="5.6" rx="1" fill="currentColor" opacity="${[.2, .45, .75, 1][(i * 5 + (i >> 2)) % 4]}"/>`).join(''),
  perDay: [5, 8, 6, 12, 9, 14, 11, 16, 10].map((h, i) => `<rect x="${5 + i * 3.7}" y="${30 - h}" width="2.6" height="${h}" rx="1" fill="currentColor"/>`).join(''),
  forecast: [14, 9, 11, 6, 8, 5, 7].map((h, i) => `<rect x="${6 + i * 4.8}" y="${30 - h}" width="3.4" height="${h}" rx="1" fill="currentColor" opacity="${i ? .7 : 1}"/>`).join(''),
  hardest: '<path d="M7 9h26M7 13.5h18M7 21h26M7 25.5h14M7 33h26" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".8"/>',
  buttons: '<rect x="5" y="15" width="30" height="9" rx="3" fill="currentColor" opacity=".25"/><rect x="5" y="15" width="9" height="9" rx="3" fill="currentColor"/><rect x="14" y="15" width="8" height="9" fill="currentColor" opacity=".7"/><rect x="22" y="15" width="6" height="9" fill="currentColor" opacity=".5"/>',
  hours: [3, 5, 9, 14, 16, 12, 8, 5, 3].map((h, i) => `<rect x="${5 + i * 3.7}" y="${31 - h}" width="2.6" height="${h}" rx="1" fill="currentColor" opacity=".85"/>`).join(''),
  difficulty: [4, 9, 15, 11, 6, 3].map((h, i) => `<rect x="${7 + i * 5}" y="${31 - h}" width="3.6" height="${h}" rx="1" fill="currentColor"/>`).join('') + '<path d="M6 32h28" stroke="currentColor" opacity=".3"/>',
  mastery: Array.from({ length: 20 }, (_, i) => `<rect x="${6 + (i % 5) * 6}" y="${8 + Math.floor(i / 5) * 6.6}" width="5" height="5" rx="1.2" fill="currentColor" opacity="${i < 9 ? 1 : i < 14 ? .5 : .2}"/>`).join('')
};
export const thumbHTML = id => `<svg class="aw-svg" viewBox="0 0 40 40" aria-hidden="true">${THUMBS[id] || ''}</svg>`;

// ---------- the session ----------
// el: the Stats screen. layout: the saved layout. redraw(): draws the page again (js/stats.js). onDone(): Done was pressed.
// onEnd(): the session ended some other way (the person left Stats).
export function createSession({ el, layout, redraw, onDone, onEnd, openList }) {
  const ac = new AbortController(), { signal } = ac;
  const doc = document;
  let L = normaliseLayout(layout);
  let ended = false, drag = null, press = null, mo = null, idle = [];
  const flushIdle = () => { if (drag) return; const f = idle; idle = []; f.forEach(fn => fn()); };

  // ----- saving: every change is saved at once; quick changes cost one write at a time, never a queue
  let latest = null, dirty = false, busy = null;
  const save = () => {
    latest = toSaved(L); dirty = true;
    if (busy) return busy;
    return (busy = (async () => {
      try { while (dirty) { dirty = false; await db.setSetting('statsLayout', latest); } }
      catch (err) { console.error(err); } finally { busy = null; }
    })());
  };
  const settled = () => busy || Promise.resolve();

  // ----- the page
  const q = sel => el.querySelector(sel);
  const units = () => [...el.querySelectorAll('.ed-unit')];
  const unitOf = id => el.querySelector(`.ed-unit[data-card="${id}"]`);
  const flowItems = () => [...el.querySelectorAll('.ed-unit:not(.lifted), .ed-ph')];
  const say = text => { const live = q('#edLive'); if (!live) return; live.textContent = ''; setTimeout(() => { if (live.isConnected) live.textContent = text; }, 30); };
  const domOrder = () => units().map(u => u.dataset.card);

  // The true grid: each card's width, and an empty slot beside a half card that has no half partner. (Phones are one column:
  // the CSS hides the slots and the size badges.) A card being dragged counts through its placeholder.
  const reflow = () => {
    el.querySelectorAll('.ed-slot').forEach(s => s.remove());
    const items = flowItems(), ids = items.map(i => i.dataset.card);
    const plan = editPlan({ ...L, order: ids, hidden: [] }, ids);
    for (const it of items) {
      const p = plan.get(it.dataset.card);
      it.dataset.w = p.w;
      it.toggleAttribute('data-lone', p.lone);
      if (p.lone) it.insertAdjacentHTML('afterend', slotHTML());
    }
    for (const u of units()) {
      const id = u.dataset.card, b = u.querySelector('[data-act=size]');
      if (b) {
        const half = L.size[id] === 'half', n = cardInfo(id).name;
        b.setAttribute('aria-label', `Make ${n} ${half ? 'full' : 'half'} width`);
        b.firstElementChild.textContent = half ? 'Half' : 'Full';
      }
    }
    const list = units(), n = list.length;
    list.forEach((u, i) => {
      u.querySelector('[data-act=earlier]').setAttribute('aria-disabled', String(i === 0));
      u.querySelector('[data-act=later]').setAttribute('aria-disabled', String(i === n - 1));
    });
    const reset = q('#edReset');
    if (reset) reset.setAttribute('aria-disabled', String(isDefaultLayout(L)));
  };
  const refreshAdd = () => { const t = q('#edAdd'); if (t) t.outerHTML = addTileHTML(L); };

  // ----- actions
  const position = id => `${units().findIndex(u => u.dataset.card === id) + 1} of ${units().length}`;
  const applyOrder = () => { L = reorderVisible(L, domOrder()); };
  const remove = id => {
    const u = unitOf(id); if (!u) return;
    const all = units(), i = all.indexOf(u), next = all[i + 1] || all[i - 1];
    L = setHidden(L, id, true);
    u.remove();
    reflow(); refreshAdd(); save();
    (next?.querySelector('[data-act=remove]') || q('#edDone'))?.focus({ preventScroll: true });
    say(`${cardInfo(id).name} removed. Use Add widget to bring it back.`);
  };
  const toggleSize = id => {
    const next = L.size[id] === 'half' ? 'full' : 'half';
    L = setSize(L, id, next);
    reflow(); save();
    say(`${cardInfo(id).name} is now ${next} width.`);
  };
  const move = (id, dir) => {
    const u = unitOf(id), all = units(), i = all.indexOf(u), j = i + dir;
    const btn = u.querySelector(`[data-act=${dir < 0 ? 'earlier' : 'later'}]`);
    if (j < 0 || j >= all.length) { say(`${cardInfo(id).name} is already ${dir < 0 ? 'first' : 'last'}.`); return; }
    if (dir < 0) all[j].before(u); else all[j].after(u);
    applyOrder(); reflow(); save();
    u.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    btn.focus({ preventScroll: true });
    say(`Moved ${cardInfo(id).name} to position ${position(id)}.`);
  };
  const add = async id => {
    L = addWidget(L, id);
    const p = save();
    await p;
    await redraw();
    const u = unitOf(id);
    u?.scrollIntoView({ block: 'center', behavior: 'instant' });
    u?.querySelector('[data-act=remove]')?.focus({ preventScroll: true });
    say(`${cardInfo(id).name} added at the end.`);
  };
  const openAdd = () => {
    const hidden = hiddenCards(L);
    if (!hidden.length) { say('All widgets are already on the page.'); return; }
    openSheet(`
      <h2 id="sheetTitle">Add widget</h2>
      <ul class="aw-list">${hidden.map(c => `<li><button type="button" class="aw-item" data-id="${c.id}" aria-label="Add ${esc(c.name)}">
        <span class="aw-thumb">${thumbHTML(c.id)}</span>
        <span class="aw-txt"><b>${esc(c.name)}</b></span>
        <span class="aw-plus" aria-hidden="true">${icon('plus')}</span></button></li>`).join('')}</ul>
      <div class="sheet-actions"><button type="button" class="btn ghost" id="awClose">Close</button></div>`);
    document.getElementById('awClose').addEventListener('click', closeSheet);
    document.querySelector('.aw-list').addEventListener('click', e => {
      const b = e.target.closest('.aw-item'); if (!b) return;
      closeSheet();
      add(b.dataset.id);
    });
  };
  const confirmReset = on => {
    const c = q('#edConfirm'); if (!c) return;
    if (on && isDefaultLayout(L)) { say('Already the default layout.'); return; }
    c.hidden = !on;
    if (on) { c.scrollIntoView({ block: 'nearest' }); c.querySelector('[data-act=reset-no]').focus(); } else q('#edReset')?.focus();
  };
  const doReset = async () => {
    L = resetLayout();
    await save();
    await redraw();
    q('#edReset')?.focus({ preventScroll: true });
    say('Stats are back to the default layout.');
  };

  el.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || !el.contains(b) || b.closest('.ed-body')) return;
    if (!el.isConnected) { end(); return; }
    const act = b.dataset.act, id = b.closest('.ed-unit')?.dataset.card;
    if (b.getAttribute('aria-disabled') === 'true' && act !== 'add' && act !== 'reset') { if (act === 'earlier' || act === 'later') move(id, act === 'earlier' ? -1 : 1); return; }
    if (act === 'remove') remove(id);
    else if (act === 'size') toggleSize(id);
    else if (act === 'earlier') move(id, -1);
    else if (act === 'later') move(id, 1);
    else if (act === 'add') openAdd();
    else if (act === 'reset') confirmReset(true);
    else if (act === 'reset-no') confirmReset(false);
    else if (act === 'reset-yes') doReset();
    else if (act === 'list') openList?.();
    else if (act === 'done') { finish(); onDone?.(); }
  }, { signal });
  // Keep the long-press menu and the browser's own picture drag out of it.
  el.addEventListener('contextmenu', e => { if (e.target.closest('.ed-unit')) e.preventDefault(); }, { signal });
  el.addEventListener('dragstart', e => e.preventDefault(), { signal });

  // ----- dragging (Pointer Events: mouse, pen and touch)
  // Move the placeholder to where the pointer says: over a card's near half, over an empty slot, or past either end of the page.
  const place = (x, y) => {
    const ph = drag.ph, parent = ph.parentNode;
    const spot = () => [ph.previousElementSibling, ph.nextElementSibling];
    const was = spot();
    const inside = b => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
    // (an empty slot only takes a half card: a full card held over it is ignored, so no stray slot or blank cell is made)
    const slot = L.size[ph.dataset.card] === 'half' ? [...el.querySelectorAll('.ed-slot')].find(s => inside(s.getBoundingClientRect())) : null;
    const hit = slot ? null : flowItems().find(u => u !== ph && inside(u.getBoundingClientRect()));
    const all = flowItems().filter(u => u !== ph), tile = el.querySelector('.ed-add');
    if (slot) parent.insertBefore(ph, slot);
    else if (hit) {
      const b = hit.getBoundingClientRect();
      const after = hit.dataset.w === 'half' ? x > b.left + b.width / 2 : y > b.top + b.height / 2;
      let nx = hit.nextElementSibling;
      if (nx?.classList.contains('ed-slot')) nx = nx.nextElementSibling;
      parent.insertBefore(ph, after ? nx : hit);
    } else if (all[0] && y < all[0].getBoundingClientRect().top) parent.insertBefore(ph, all[0]);
    else if (all.length && y > all[all.length - 1].getBoundingClientRect().bottom) parent.insertBefore(ph, tile);
    const now = spot();
    if (now[0] !== was[0] || now[1] !== was[1]) reflow();      // (slots are made again wherever the placeholder moved, even past a slot)
  };
  const follow = () => {
    if (!drag) return;
    drag.unit.style.transform = `translate(${drag.x - drag.gx}px, ${drag.y - drag.gy}px) scale(1.03) rotate(-1deg)`;
  };
  const block = e => { if (drag && e.cancelable) e.preventDefault(); };      // a held finger must not also scroll the page
  const lift = (unit, x, y, pid) => {
    const r = unit.getBoundingClientRect();
    const ph = doc.createElement('div');
    ph.className = 'ed-ph'; ph.dataset.card = unit.dataset.card; ph.dataset.w = unit.dataset.w;
    ph.style.minHeight = `${r.height}px`;
    ph.setAttribute('aria-hidden', 'true');
    unit.before(ph);
    drag = { unit, ph, pid, x, y, gx: x - r.left, gy: y - r.top, before: domOrder(), raf: 0, nx: NaN, ny: NaN };
    Object.assign(unit.style, { left: '0', top: '0', width: `${r.width}px`, height: `${r.height}px` });
    unit.classList.add('lifted');
    el.classList.add('ed-dragging');
    reflow();
    follow();
    loop();
    say(`${cardInfo(unit.dataset.card).name} picked up.`);
  };
  // Every frame: scroll the window when the pointer is near its top or bottom edge, and keep the placeholder under the pointer.
  const loop = () => {
    if (!drag) return;
    if (!el.isConnected) { end(); return; }
    const h = innerHeight, y = drag.y;
    const dy = y < EDGE ? -Math.ceil((EDGE - y) / 4) : y > h - EDGE ? Math.ceil((y - (h - EDGE)) / 4) : 0;
    if (dy) scrollBy(0, Math.max(-24, Math.min(24, dy)));
    if (dy || drag.x !== drag.nx || drag.y !== drag.ny) { drag.nx = drag.x; drag.ny = drag.y; place(drag.x, drag.y); }
    drag.raf = requestAnimationFrame(loop);
  };
  const unlift = () => {
    const d = drag; if (!d) return null;
    drag = null;
    cancelAnimationFrame(d.raf);
    d.unit.classList.remove('lifted');
    d.unit.removeAttribute('style');
    el.classList.remove('ed-dragging');
    return d;
  };
  const drop = () => {
    const d = unlift(); if (!d) return;
    d.ph.replaceWith(d.unit);
    reflow();
    const now = domOrder();
    if (now.join() === d.before.join()) { say(`${cardInfo(d.unit.dataset.card).name} stays where it was.`); return; }
    applyOrder(); save();
    say(`Moved ${cardInfo(d.unit.dataset.card).name} to position ${position(d.unit.dataset.card)}.`);
  };
  const dropAndFlush = () => { drop(); flushIdle(); };
  const cancelDrag = (announce = true) => {
    const d = unlift(); if (!d) return;
    d.ph.remove();
    if (el.isConnected) reflow();
    if (announce) say('Move cancelled.');
    flushIdle();
  };
  const clearPress = () => { if (press) { clearTimeout(press.timer); press = null; } };

  el.addEventListener('pointerdown', e => {
    if (drag || press || !e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const unit = e.target.closest('.ed-unit');
    if (!unit || e.target.closest('button, a, input, select')) return;
    if (!el.isConnected) { end(); return; }
    if (e.pointerType === 'mouse') { e.preventDefault(); press = { unit, pid: e.pointerId, x: e.clientX, y: e.clientY, mouse: true }; return; }
    // Touch and pen: hold still for a moment, so ordinary scrolling still works.
    press = { unit, pid: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
      const p = press; press = null;
      if (p && p.unit.isConnected && el.isConnected) lift(p.unit, p.x, p.y, p.pid); else if (!el.isConnected) end();
    }, LONG_PRESS) };
  }, { signal });
  doc.addEventListener('pointermove', e => {
    if (press && e.pointerId === press.pid && press.mouse) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOUSE_SLOP) {
        const p = press; press = null;
        if (el.isConnected && p.unit.isConnected) { lift(p.unit, p.x, p.y, p.pid); drag.x = e.clientX; drag.y = e.clientY; follow(); } else end();
      }
    } else if (press && e.pointerId === press.pid && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) clearPress();      // it is a scroll
    else if (press && e.pointerId === press.pid) { press.x = e.clientX; press.y = e.clientY; }
    if (drag && e.pointerId === drag.pid) { drag.x = e.clientX; drag.y = e.clientY; follow(); }
  }, { signal });
  doc.addEventListener('pointerup', e => {
    if (press && e.pointerId === press.pid) clearPress();
    if (drag && e.pointerId === drag.pid) { if (el.isConnected) dropAndFlush(); else end(); }
  }, { signal });
  doc.addEventListener('pointercancel', e => {
    if (press && e.pointerId === press.pid) clearPress();
    if (drag && e.pointerId === drag.pid) cancelDrag();
  }, { signal });
  doc.addEventListener('touchmove', block, { signal, passive: false });
  doc.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (drag) { e.preventDefault(); e.stopPropagation(); cancelDrag(); return; }
    if (doc.getElementById('sheet')?.open || !el.isConnected) return;       // (a sheet's own Escape closes the sheet)
    const c = q('#edConfirm');
    if (c && !c.hidden) { e.preventDefault(); confirmReset(false); return; }
    e.preventDefault(); finish(); onDone?.();      // Escape leaves edit mode, same as Done
  }, { signal, capture: true });

  let lastFocus = null;
  el.addEventListener('focusin', e => { const a = e.target; lastFocus = { card: a.closest('.ed-unit')?.dataset.card, act: a.dataset.act, id: a.id }; }, { signal });
  // (forgotten once the focus goes somewhere else, or a click lands elsewhere; a control that was only hidden leaves it standing)
  el.addEventListener('focusout', e => { if (e.relatedTarget) lastFocus = null; }, { signal });
  doc.addEventListener('pointerdown', () => { lastFocus = null; }, { signal, capture: true });

  // ----- ending
  function end() {
    if (ended) return;
    ended = true;
    clearPress();
    cancelDrag(false);      // (puts a held card back; nothing is saved)
    ac.abort();
    mo?.disconnect();
  }
  function finish() { end(); }
  // Leaving Stats (any way) ends the session: the screen's box leaves the page, or the address is no longer Stats.
  if (el.parentNode) {
    mo = new MutationObserver(() => { if (!el.isConnected) { end(); onEnd?.(); } });
    mo.observe(el.parentNode, { childList: true });
  }
  addEventListener('hashchange', () => { if (!/^#\/stats/.test(location.hash)) { end(); onEnd?.(); } }, { signal });
  addEventListener('pagehide', () => { end(); onEnd?.(); }, { signal });

  return {
    // After each draw of the page: the DOM is new, so a drag in progress is dropped, then the grid and the controls are brought up to date.
    beforeRender() {
      const a = doc.activeElement, mine = a && el.contains(a) && a !== doc.body;
      // (a control that stopped being shown, such as a size badge when the window shrinks to a phone, dropped the focus without a word)
      const f = mine ? { card: a.closest('.ed-unit')?.dataset.card, act: a.dataset.act, id: a.id } : lastFocus && (!a || a === doc.body) ? lastFocus : null;
      return { y: scrollY, f };
    },
    whenNotDragging(fn) { if (drag) idle.push(fn); else fn(); },
    mount(fresh, keep) {
      if (ended) return;
      if (fresh) L = normaliseLayout(fresh);
      clearPress(); cancelDrag(false);
      el.classList.add('ed-on');      // (no browser scroll anchoring: the scroll is put back by hand below)
      const bar = q('#edBar');
      if (bar) {      // below the phone header, which is sticky too
        const top = doc.querySelector('.top'), h = top && getComputedStyle(top).position === 'sticky' && top.offsetParent !== null ? top.getBoundingClientRect().height : 0;
        bar.style.top = `${Math.round(h)}px`;
      }
      reflow();
      if (keep) {      // the same control keeps the focus (matched by card and action), and the page stays where it was
        const f = keep.f;
        if (f) {
          const shown = n => n && n.getClientRects().length ? n : null;      // (a size badge is not shown on a phone)
          const t = shown(f.card && f.act && q(`.ed-unit[data-card="${f.card}"] [data-act=${f.act}]`)) || shown(f.id && q('#' + f.id))
            || shown(f.card && q(`.ed-unit[data-card="${f.card}"] [data-act=remove]`)) || q('#edDone');
          t?.focus({ preventScroll: true });
        }
        scrollTo(0, keep.y);
      }
    },
    settled,
    focusDone: () => q('#edDone')?.focus({ preventScroll: true }),
    layout: () => L,
    end,
    get active() { return !ended; }
  };
}
