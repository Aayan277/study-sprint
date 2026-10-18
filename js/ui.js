// Small helpers shared by every screen.

import { streakText } from './stats-calc.js';
import { openOverlay, closeOverlay } from './nav.js';
import { toggleToken } from './a11y.js';

export const $ = id => document.getElementById(id);

// Make user text safe to put inside HTML (so a deck called "<b>" shows as text, not as bold).
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Screen readers hear a toast through a live region that is always in the page (#toastLive, visually hidden). A region that
// appears and fills in one step is often skipped, so it is cleared first and filled on the next tick. The visible toast is not
// a live region itself (it comes and goes, and its Undo link must stay a normal link: it is the last stop in the tab order).
let liveTimer = 0;
// A modal dialog (showModal) makes everything outside it inert, and that includes the live region, so while one is open the
// region moves inside it; it goes back to <body> when the dialog closes (or at the next toast, if the dialog was removed).
let liveEl = null;
// Puts the region in the topmost modal dialog if there is one, else in <body>. Called when a toast is announced, again just before
// its text goes in (a sheet may have opened or closed in between), and whenever any dialog closes. A region whose dialog was
// removed from the page is still held here, so it is simply attached again.
function placeLive() {
  liveEl = liveEl || document.getElementById('toastLive');
  const live = liveEl;
  if (!live) return null;
  const modals = document.querySelectorAll('dialog:modal');
  const host = modals[modals.length - 1] || document.body;
  if (live.parentNode !== host || !live.isConnected) host.append(live);
  return live;
}
if (typeof document !== 'undefined') document.addEventListener('close', placeLive, true);      // 'close' does not bubble; the capture phase still sees every dialog's
function announceToast(msg) {
  clearTimeout(liveTimer);
  const live = placeLive();
  if (!live) return;
  live.textContent = '';
  if (!msg) return;
  liveTimer = setTimeout(() => { placeLive().textContent = msg; }, 60);
}

// A short message that pops up above the tab bar for a few seconds.
let toastTimer = 0, toastLeave = null;      // toastLeave: the hashchange listener of a held toast
// `link` ({ href, label, onClick }) adds a link after the message and keeps the toast up longer, so it can be tapped.
// With onClick the link does that instead of going to href, and the toast closes.
// `hold` keeps the toast up until you leave the screen (or 10 minutes, or the next toast): for an Undo.
// Hiding the toast also empties the live region, so it never keeps (or re-reads) a message that is no longer on screen.
function hideToast() {
  $('toast').hidden = true;
  announceToast('');
}
export function toast(msg, { link = null, hold = false, ms = 0 } = {}) {
  const t = $('toast');
  if (toastLeave) { window.removeEventListener('hashchange', toastLeave); toastLeave = null; }      // an older held toast must not hide this one
  t.textContent = msg;
  announceToast(link ? `${msg} ${link.label}` : msg);
  if (link) {
    const a = document.createElement('a');
    a.href = link.href; a.textContent = link.label; a.className = 'toast-link';
    if (link.onClick) a.addEventListener('click', e => { e.preventDefault(); clearTimeout(toastTimer); hideToast(); link.onClick(); });
    t.append(' ', a);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, hold ? 600000 : ms || (link ? 7000 : 2600));
  if (hold) { toastLeave = () => { hideToast(); toastLeave = null; }; window.addEventListener('hashchange', toastLeave, { once: true }); }
}

// Focus mode: while a Review or Play round is running, the header and tab bar get out of the way on phones
// (styles.css hides them when <body> has the class "focus"). Each screen turns it on when a round starts
// and off when the round ends; going to any other screen also turns it off (see route() in app.js).
export function setFocusMode(on) {
  document.body.classList.toggle('focus', !!on);
}

// The speaker button's picture (it replaces the 🔊 emoji, which looks different on every phone).
export const SPEAKER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';

// Small line icons (same style as the tab icons: 24px grid, 1.8 stroke) for buttons and labels.
// icon('check') returns an <svg> that takes its color and size from the text around it (see .ico in styles.css).
const ICON_PATHS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M7 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 .3 1.2 1 2 2 2.2C10.5 8.5 11 5.5 12 3z"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4.5h6v2.5H9z"/><path d="M9 12h6M9 16h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  circle: '<circle cx="12" cy="12" r="6"/>',
  sub: '<path d="M6 4v9a3 3 0 0 0 3 3h9M14 12l4 4-4 4"/>',
  enter: '<path d="M20 6v6a3 3 0 0 1-3 3H5M9 11l-4 4 4 4"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  snow: '<path d="M12.0 3.0L12.0 21.0M4.2 7.5L19.8 16.5M4.2 16.5L19.8 7.5"/><path d="M12.0 5.6L10.5 7.4M12.0 5.6L13.5 7.4M6.5 8.8L7.3 11.1M6.5 8.8L8.8 8.4M6.5 15.2L8.8 15.6M6.5 15.2L7.3 12.9M12.0 18.4L13.5 16.6M12.0 18.4L10.5 16.6M17.5 15.2L16.7 12.9M17.5 15.2L15.2 15.6M17.5 8.8L15.2 8.4M17.5 8.8L16.7 11.1"/>',
  flag: '<path d="M6 21V4.5M6 5h11.5l-2.2 3.8 2.2 3.7H6"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'
};
export const icon = (name, cls = '') =>
  `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

// The streak line shared by Today and the end of a Review session: flame, the count, what to do about it, and
// (when there is one) a freeze note. `button` makes it a button that opens the "Your streak" sheet (Today).
// Keep both the same text: tests compare Today's streak with the one at the end of a session.
export function streakHTML(streak, { button = false } = {}) {
  const { line, sub } = streakText(streak);
  const pill = sub ? `<span class="frz-pill${streak.freeze.usedOn ? ' used' : ''}">${icon('snow')}${esc(sub)}</span>` : '';
  const inner = `${icon('flame')}<b class="mono">${streak.days}</b> day streak <span>${esc(line)}</span>${pill}${button ? '<span class="sr-only">, details</span>' : ''}`;
  const cls = `streak${streak.studiedToday ? ' kept' : ''}`;
  return button
    ? `<button type="button" class="${cls} streak-btn" id="streakBtn" aria-haspopup="dialog" title="Your streak, streak freeze and days off">${inner}${icon('chevron', 'sb-go')}</button>`
    : `<p class="${cls}">${inner}</p>`;
}

// The last 7 days as little squares (Stats and the "Your streak" sheet): a check = studied, a snowflake = a streak
// freeze covered the day, a moon = a planned day off. Each has a shape as well as a colour. `week` is streak.week.
const DOT_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const DOT_NAME = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
// "Tue 13 Oct", in the reader's language but always weekday, day, month.
const dotSaid = time => { const p = Object.fromEntries(DOT_DAY.formatToParts(time).map(x => [x.type, x.value])); return `${p.weekday} ${p.day} ${p.month}`; };
export function weekDotsHTML(week, label = 'Last 7 days') {
  // A list for screen readers: each day says what happened ("Tue 13 Oct: streak freeze used"); the squares are only pictures.
  return `<div class="week" role="list" aria-label="${esc(label)}">${week.map(d => {
    const kind = d.on ? 'on' : d.frozen ? 'frz' : d.rest ? 'rest' : '';
    const note = d.on ? ', studied' : d.frozen ? ', streak freeze used' : d.rest ? (d.idle ? ', nothing due' : ', day off') : '';
    const said = `${dotSaid(d.time)}: ${(d.on ? 'studied' : d.frozen ? 'streak freeze used' : d.rest ? (d.idle ? 'nothing due' : 'day off') : d.today ? 'not studied yet' : 'not studied')}${d.today && d.on ? ' (today)' : ''}`;
    return `<div class="wd${kind ? ' ' + kind : ''}${d.today ? ' today' : ''}" role="listitem" title="${esc(DOT_DAY.format(d.time) + note)}"><span class="sr-only">${esc(said)}</span>
      <i aria-hidden="true">${d.frozen && !d.on ? icon('snow') : d.rest && !d.on ? icon('moon') : ''}</i><span aria-hidden="true">${esc(DOT_NAME.format(d.time).slice(0, 2))}</span></div>`;
  }).join('')}</div>`;
}

// A progress ring (SVG). frac is 0 to 1; `inner` is drawn in the middle. Colors come from .ring-bg / .ring-fg in styles.css.
export function ring(frac, size, stroke, inner = '', cls = '') {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, frac || 0));
  return `<span class="ring${cls ? ' ' + cls : ''}" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="ring-bg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
    ${f > 0 ? `<circle class="ring-fg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ''}</svg>
    <span class="ring-in">${inner}</span></span>`;
}

// Big screens (computers) get the desktop layout: a sidebar, wider pages, and side panels. See styles.css.
const WIDE = matchMedia('(min-width: 1200px)');      // wide enough for a side panel next to the page

// The pop-up sheet used for forms and confirmations (instead of the browser's own confirm() boxes).
//   side: on a wide screen, show it as a panel down the right-hand side instead, next to the page
//         (e.g. a card's panel beside the card list, so you can click from card to card).
//         On phones it's the usual pop-up from the bottom.
//
// Every sheet has the same frame, whatever is inside it:
//   a sticky header   the title (the <h2 id="sheetTitle"> in `html`) and a × at the top right
//   a scrolling body  everything else in `html`
//   a sticky footer   the LAST `.sheet-actions` row in `html` (Cancel on the left, the main button on the right).
//                     A submit button in it still submits its form (it gets a form="..." link, because it is
//                     no longer inside the <form>). A sheet with no such row has no footer.
// On a phone the header's little grab bar really works: drag the sheet down to close it (see initSheet).
let sheetOverlay = 0;    // the sheet's entry in the history (js/nav.js), while it is open
let opener = null;       // what had the focus when a side panel opened (the button that opened it)
let sheetGuard = null;   // () => true while the open sheet holds changes that were not saved (see guardSheet)

// A sheet with a form in it can say when it holds unsaved work: guardSheet(() => changed). Then the × , a tap outside, a swipe down,
// Esc, Back (and a sheet's own Close button, if it uses askClose) ask "Discard changes?" instead of throwing the work away.
// Nothing changed: no question. It lasts until the sheet closes or is replaced by another one.
export const guardSheet = fn => { sheetGuard = fn; };
// What a form holds right now, as one string, to compare with the string taken when it opened. With `textOnly`, choices (radios, ticks,
// drop-downs) are left out, so only typed text and attached pictures and sounds count (Add card: the note type you switched to is not work).
export function formSnapshot(root, { textOnly = false } = {}) {
  const part = [];
  for (const el of root.querySelectorAll('input, textarea, select, [contenteditable="true"], [data-media-id], [data-sound-ids], [data-occ-sig]')) {
    if (el.isContentEditable && el.getAttribute('contenteditable') === 'true') part.push(el.id + '=' + el.textContent.replace(/\s+/g, ' ').trim() + '|' + el.innerHTML);
    else if (el.matches('[data-occ-sig]')) part.push((el.id || '') + '~' + el.dataset.occSig);
    else if (el.matches('[data-media-id], [data-sound-ids]')) part.push((el.id || '') + '#' + (el.dataset.mediaId || '') + '#' + (el.dataset.soundIds || ''));
    else if (el.type === 'file' || el.type === 'button' || el.type === 'submit' || el.type === 'hidden') continue;
    else if (el.type === 'checkbox' || el.type === 'radio') { if (!textOnly) part.push((el.id || el.name) + ':' + el.value + '=' + el.checked); }
    else if (el.tagName === 'SELECT') { if (!textOnly) part.push((el.id || el.name) + '=' + el.value); }
    else part.push((el.id || el.name) + '=' + (textOnly ? el.value.trim() : el.value));
  }
  return part.join('\u0001');
}
// Close the open sheet, unless it holds unsaved work: then ask first. Returns true when it closed.
export function askClose() {
  if (!sheetGuard || !sheetGuard()) { closeSheet(); return true; }
  askDiscard();
  return false;
}
// Is there unsaved work in the open sheet right now?
export const sheetDirty = () => !!sheetGuard?.();
// Run `go` (something that replaces what the sheet shows, or changes the card in it) unless the sheet holds unsaved work:
// then ask "Discard changes?" first, and run it only after Discard. Returns true when it ran at once.
export function guardedGo(go) {
  if (!sheetDirty()) { go(); return true; }
  askDiscard(go);
  return false;
}
// A screen that keeps drafts (the card panel) says how to stash one; the router calls stashDraft() before it closes the sheet.
let stasher = null;
export const setDraftStasher = fn => { stasher = fn; };
export const stashDraft = () => stasher?.('stash');
export const clearStashedDraft = () => stasher?.('clear');
let discardThen = null;      // what to do after Discard (instead of just closing the sheet)
function askDiscard(then = null) {
  const d = $('sheet'), body = d.querySelector('.sheet-in');
  if (!d.open || !body) { if (then) then(); else closeSheet(); return; }
  const had = $('discardAsk');
  if (had) { if (then) discardThen = then; $('discardKeep').focus({ preventScroll: true }); return; }      // (already asking: a plain request does not replace the pending action)
  discardThen = then;
  const back = document.activeElement;
  const box = document.createElement('div');
  box.className = 'confirm'; box.id = 'discardAsk'; box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-labelledby', 'discardT');
  box.innerHTML = `<p id="discardT">Discard changes?</p><div class="sheet-actions"><button class="btn ghost" type="button" id="discardKeep">Keep editing</button><button class="btn danger solid" type="button" id="discardYes">Discard</button></div>`;
  body.prepend(box);
  box.scrollIntoView({ block: 'nearest' });
  $('discardKeep').addEventListener('click', () => { discardThen = null; box.remove(); if (back?.isConnected) back.focus({ preventScroll: true }); });
  $('discardYes').addEventListener('click', () => { const then = discardThen; discardThen = null; sheetGuard = null; if (then) then(); else closeSheet(); });
  $('discardKeep').focus({ preventScroll: true });
}
// Back (or an edge swipe) closed the sheet's history entry: with unsaved work, the entry is put back and the question is asked.
function backDismiss() {
  sheetOverlay = 0;
  if (sheetGuard && sheetGuard()) { sheetOverlay = openOverlay(backDismiss); askDiscard(); return; }
  closeSheet();
}
export function openSheet(html, { side = false } = {}) {
  const d = $('sheet');
  sheetGuard = null; discardThen = null;       // a new sheet (or a replaced one) starts with nothing to protect
  const asSide = side && WIDE.matches;
  if (asSide && !d.open) opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  if (d.open && d.classList.contains('side') !== asSide) d.close();     // switching between the two kinds
  d.classList.toggle('side', asSide);
  d.style.transform = d.style.transition = '';                          // undo a half-finished swipe
  const t = document.createElement('template');
  t.innerHTML = html;
  const title = t.content.querySelector('#sheetTitle');
  const rows = t.content.querySelectorAll('.sheet-actions');
  const actions = rows[rows.length - 1] || null;
  const foot = document.createElement('div');
  foot.className = 'sheet-foot' + (actions?.classList.contains('stack') ? ' stack' : '');
  if (actions) {
    const form = actions.closest('form');
    if (form && !form.id) form.id = 'sheetFormAuto';
    for (const b of [...actions.children]) {
      if (form && b.matches('button[type=submit]')) b.setAttribute('form', form.id);
      foot.appendChild(b);
    }
    actions.remove();
  }
  const head = document.createElement('div');
  head.className = 'sheet-head';
  if (title) head.appendChild(title);
  head.insertAdjacentHTML('beforeend', `<button type="button" class="sheet-x" aria-label="Close">${icon('x')}</button>`);
  const body = document.createElement('div');
  body.className = 'sheet-in';
  body.appendChild(t.content);
  const live = d.querySelector('#toastLive');      // the toast's live region may be in here: re-drawing the sheet must not throw it away
  d.replaceChildren(head, body, ...(foot.children.length ? [foot] : []), ...(live ? [live] : []));
  d.setAttribute('aria-labelledby', 'sheetTitle');
  d.querySelector('.sheet-x').addEventListener('click', askClose);
  if (!d.open) { if (asSide) d.show(); else d.showModal(); }
  if (!sheetOverlay) sheetOverlay = openOverlay(backDismiss);      // Back (or an edge swipe) closes the sheet (or asks, with unsaved work)
  // The browser focuses the first thing it finds, which would be the ×. Start on the sheet itself instead: a screen
  // reader reads its title, Tab goes to the first control, and no keyboard pops up on a phone before you ask.
  if (document.activeElement?.classList.contains('sheet-x')) d.focus();
  document.body.classList.toggle('has-side', asSide);
  return d;
}
export function closeSheet() {
  const d = $('sheet');
  // A pop-up gives the focus back to where it came from by itself; a side panel does not, so the focus goes to the card
  // that was open (or the button that opened the panel) instead of being lost on the page.
  const back = d.open && d.classList.contains('side') ? (opener?.isConnected && !opener.closest('.crow') ? opener : document.querySelector('.crow.sel .crow-btn') || (opener?.isConnected ? opener : null)) : null;
  if (d.open) { document.dispatchEvent(new Event('sheet-closing')); d.close(); }      // (the event: so work tied to the sheet stops now, not a task later)
  sheetGuard = null; discardThen = null;
  releaseSheet();
  afterClose();          // straight away (the dialog's own 'close' event comes a moment later)
  back?.focus({ preventScroll: true });
}
// The page gets its full width back, and the card list stops highlighting the card that was open.
function releaseSheet() {
  if (sheetOverlay) { const id = sheetOverlay; sheetOverlay = 0; closeOverlay(id); }
}
function afterClose() {
  document.body.classList.remove('has-side');
  document.querySelectorAll('.crow.sel').forEach(r => r.classList.remove('sel'));
}

// Tapping the dim area outside the sheet closes it. Escape closes a side panel too
// (the browser only does that for pop-ups). On a touchscreen a phone sheet can be dragged down by its
// header (the grab bar) and lets go of the screen once it has moved far or fast enough.
export function initSheet() {
  const d = $('sheet');
  // A click on the dim area closes the sheet. It must really be outside the sheet's box: a tap on the header or a drag
  // that ends there is aimed at the dialog itself too, and must not close it.
  d.addEventListener('click', e => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) askClose();
  });
  d.addEventListener('close', () => { if (!d.open) { sheetGuard = null; releaseSheet(); } afterClose(); });          // closed another way (e.g. Escape on a pop-up)
  d.addEventListener('cancel', e => { if (sheetGuard?.()) { e.preventDefault(); askClose(); } });      // Esc on a pop-up with unsaved work asks first
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && d.open && d.classList.contains('side')) askClose();
  });
  let drag = null;
  d.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || d.classList.contains('side') || !e.target.closest('.sheet-head') || e.target.closest('.sheet-x')) return;
    drag = { id: e.pointerId, y: e.clientY, t: e.timeStamp, dy: 0 };
    e.target.closest('.sheet-head').setPointerCapture(e.pointerId);        // on the header, not the dialog: the click that follows a tap must not land on the dialog itself
    d.style.transition = 'none';
  });
  d.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dy = Math.max(0, e.clientY - drag.y);
    d.style.transform = `translateY(${drag.dy}px)`;
  });
  const release = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const { dy, t } = drag; drag = null;
    const fast = dy > 30 && dy / Math.max(1, e.timeStamp - t) > 0.5;      // a quick flick
    d.style.transition = 'transform 160ms ease';
    if (e.type !== 'pointercancel' && (dy > Math.min(120, d.offsetHeight / 3) || fast)) {
      d.style.transform = 'translateY(100%)';
      setTimeout(() => {
        d.style.transform = d.style.transition = '';
        askClose();
      }, 160);
    } else d.style.transform = '';
  };
  d.addEventListener('pointerup', release);
  d.addEventListener('pointercancel', release);
}

// Stop iPhone double-tap zoom during Review and Play.
// Answering redraws the screen, so two quick taps (e.g. the card, then a button) land on different
// elements and Safari can treat them as a double-tap and zoom. If a second tap in one of these areas
// comes within 350ms of the first, cancel the browser's handling (which cancels the zoom) and press
// the button ourselves.
const TAP_ZONES = '.flash, .ratebar, .rv-head, .options, .feedback, .hud';
export function initTapGuard() {
  let lastTap = 0;
  document.addEventListener('touchend', e => {
    const zone = e.target.closest?.(TAP_ZONES);
    if (zone && e.timeStamp - lastTap < 350 && e.cancelable) {
      e.preventDefault();
      e.target.closest('button, [role="button"]')?.click();
    }
    lastTap = zone ? e.timeStamp : 0;
  }, { passive: false });
}

// Folds (a <details>, or a button that shows and hides a section) remember whether they were open, on this device only.
// Keyed by a short name like 'stats-more'. localStorage can be missing or blocked, so every use is wrapped.
export function foldOpen(key, fallback = false) {
  try { const v = localStorage.getItem('study-sprint-fold-' + key); return v === null ? fallback : v === '1'; } catch { return fallback; }
}
export function saveFold(key, open) {
  try { localStorage.setItem('study-sprint-fold-' + key, open ? '1' : '0'); } catch { /* fine without */ }
}
// Remember a <details> element's state under `key` (it must already be drawn open or closed with foldOpen()).
export function rememberFold(details, key) {
  details?.addEventListener('toggle', () => saveFold(key, details.open));
}

// "1 card" / "3 cards"
// True when a key press is aimed at a button, link or form field. Those handle Enter and Space themselves,
// so a screen-wide shortcut must leave them alone. `except` is the id of one element that should still count
// as "not a control" (Review's card, which is focusable but has no key handling of its own).
export const onControl = (e, except) => {
  const control = e.target.closest?.('button, a, input, select, textarea, summary, [role=button]');
  return !!control && control.id !== except;
};
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A mouse or finger press on these buttons must not move focus to them, so Space still flips the card afterwards.
// (Keyboard use is untouched: Tab and Enter focus and press a button as usual.) `selector` picks the buttons inside `root`.
export function keepFocusOnPress(root, selector = 'button') {
  const stop = e => { if (e.target.closest?.(selector)) e.preventDefault(); };
  root.addEventListener('pointerdown', stop);
  root.addEventListener('mousedown', stop);
}

// ---------- form errors (WCAG 3.3.1 Error Identification, 4.1.3 Status Messages) ----------
let errSeq = 0;
// Show a problem with a form field. errEl is the error paragraph (role="alert" is set here if the markup forgot, but give it in the markup:
// an alert that exists before its text appears is announced most reliably). The field gets aria-invalid and aria-describedby pointing at the
// message, and the cursor moves to it. The error clears itself when the person edits the field. field may be null (an error about the whole form).
// When the cursor moves to the field, the field's aria-describedby makes the screen reader read the message, so the message is NOT also an alert
// (it would be spoken twice). Without a field, or without moving focus, it is an alert, the only thing that tells the person.
// clearOnInput false keeps the message until the caller clears it (for boxes that check the value again themselves as you type).
export function showFieldError(field, errEl, text, { focus = true, clearOnInput = true } = {}) {
  if (!errEl) return;
  if (!errEl.id) errEl.id = `err${++errSeq}`;
  const moving = field && focus && document.activeElement !== field;      // (focus already there: nothing new is read, so the alert must speak)
  if (moving) errEl.removeAttribute('role'); else errEl.setAttribute('role', 'alert');
  errEl.textContent = text;
  errEl.hidden = false;
  if (!field) return;
  field.setAttribute('aria-invalid', 'true');
  field.setAttribute('aria-describedby', toggleToken(field.getAttribute('aria-describedby'), errEl.id, true));
  if (focus) field.focus();
  if (clearOnInput && !field._errClear) {
    field._errClear = () => { field._errClear = null; clearFieldError(field, errEl); };
    field.addEventListener('input', field._errClear, { once: true });
  }
}
// The problem is fixed: hide the message and remove aria-invalid / the describedby link.
export function clearFieldError(field, errEl) {
  if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
  if (!field) return;
  field.removeAttribute('aria-invalid');
  const d = toggleToken(field.getAttribute('aria-describedby'), errEl?.id || '', false);
  if (d) field.setAttribute('aria-describedby', d); else field.removeAttribute('aria-describedby');
  if (field._errClear) { field.removeEventListener('input', field._errClear); field._errClear = null; }
}
