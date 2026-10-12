// Small helpers shared by every screen.

export const $ = id => document.getElementById(id);

// Make user text safe to put inside HTML (so a deck called "<b>" shows as text, not as bold).
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A short message that pops up above the tab bar for a few seconds.
let toastTimer = 0;
export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
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
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 .3 1.2 1 2 2 2.2C10.5 8.5 11 5.5 12 3z"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  circle: '<circle cx="12" cy="12" r="6"/>',
  sub: '<path d="M6 4v9a3 3 0 0 0 3 3h9M14 12l4 4-4 4"/>',
  enter: '<path d="M20 6v6a3 3 0 0 1-3 3H5M9 11l-4 4 4 4"/>'
};
export const icon = (name, cls = '') =>
  `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

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
export function openSheet(html, { side = false } = {}) {
  const d = $('sheet');
  const asSide = side && WIDE.matches;
  if (d.open && d.classList.contains('side') !== asSide) d.close();     // switching between the two kinds
  d.classList.toggle('side', asSide);
  d.innerHTML = `<div class="sheet-in">${html}</div>`;
  if (!d.open) { if (asSide) d.show(); else d.showModal(); }
  document.body.classList.toggle('has-side', asSide);
  return d;
}
export function closeSheet() {
  const d = $('sheet');
  if (d.open) d.close();
  afterClose();          // straight away (the dialog's own 'close' event comes a moment later)
}
// The page gets its full width back, and the card list stops highlighting the card that was open.
function afterClose() {
  document.body.classList.remove('has-side');
  document.querySelectorAll('.crow.sel').forEach(r => r.classList.remove('sel'));
}

// Tapping the dim area outside the sheet closes it. Escape closes a side panel too
// (the browser only does that for pop-ups).
export function initSheet() {
  const d = $('sheet');
  d.addEventListener('click', e => { if (e.target === d) closeSheet(); });
  d.addEventListener('close', afterClose);          // closed another way (e.g. Escape on a pop-up)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && d.open && d.classList.contains('side')) closeSheet();
  });
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
  const control = e.target.closest?.('button, a, input, select, textarea, [role=button]');
  return !!control && control.id !== except;
};
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
