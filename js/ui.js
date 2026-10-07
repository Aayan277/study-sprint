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

// "1 card" / "3 cards"
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
