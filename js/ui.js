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

// The pop-up sheet used for forms and confirmations (instead of the browser's own confirm() boxes).
export function openSheet(html) {
  const d = $('sheet');
  d.innerHTML = `<div class="sheet-in">${html}</div>`;
  if (!d.open) d.showModal();
  return d;
}
export function closeSheet() {
  const d = $('sheet');
  if (d.open) d.close();
}

// Tapping the dim area outside the sheet closes it.
export function initSheet() {
  const d = $('sheet');
  d.addEventListener('click', e => { if (e.target === d) closeSheet(); });
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

// "1 card" / "3 cards"
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
