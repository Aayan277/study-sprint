// A draggable divider between the card list and the card editor panel (Browse and a deck's page, on a computer where the
// editor sits beside the list, see openSheet's `side` in ui.js).
//   - drag it with a mouse or finger, or focus it and use the arrow keys (24 px a step, Home / End for the limits)
//   - the editor is at least 360 px and at most 70% of the window; the list keeps at least 320 px
//   - the width is kept on this device (localStorage), double-click or double-tap goes back to the default
// The width is the CSS variable --panel-user on <html>; styles.css turns it into --panel for those two screens (with the
// 360 px / 70% limits in CSS too, so a smaller window re-clamps by itself). With no value the screen's own default is used.
// The divider is only shown by CSS while a side panel is open on those screens, so a phone sheet never has it.

export const PANEL_MIN = 360, PANEL_MAX_FRAC = 0.7, LIST_MIN = 320, PANEL_STEP = 24;
export const PANEL_KEY = 'study-sprint-panel-w';

// The widest the editor may be: 70% of the window, and the list keeps LIST_MIN beside it (`listLeft` = the list's left edge).
// The editor's own minimum wins in a very small window.
export function panelMax(viewport, listLeft = 0) {
  return Math.max(PANEL_MIN, Math.floor(Math.min(viewport * PANEL_MAX_FRAC, viewport - listLeft - LIST_MIN)));
}
export const clampPanel = (width, viewport, listLeft = 0) => Math.round(Math.min(panelMax(viewport, listLeft), Math.max(PANEL_MIN, Number(width) || 0)));

// The saved width, or null (nothing saved, junk, or storage not available).
export function savedPanel(storage) {
  try {
    const n = Number(storage.getItem(PANEL_KEY));
    return Number.isFinite(n) && n >= PANEL_MIN && n <= 4000 ? Math.round(n) : null;
  } catch { return null; }
}
export function savePanel(storage, width) {
  try { if (width == null) storage.removeItem(PANEL_KEY); else storage.setItem(PANEL_KEY, String(Math.round(width))); } catch { /* private window: fine */ }
}

// Builds the divider and wires it. Safe to call once.
export function initPanelResize() {
  if (document.getElementById('panelResizer')) return;
  const root = document.documentElement;
  const bar = document.createElement('div');
  bar.id = 'panelResizer';
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-orientation', 'vertical');
  bar.setAttribute('aria-label', 'Resize the card editor');
  bar.setAttribute('aria-valuetext', 'Editor width');
  bar.tabIndex = 0;
  bar.title = 'Drag to resize. Double-click to reset.';
  document.body.append(bar);

  let storage = null;
  try { storage = window.localStorage; } catch { /* blocked */ }
  const sheet = () => document.getElementById('sheet');
  const listLeft = () => parseFloat(getComputedStyle(document.querySelector('main') || document.body).marginLeft) || 0;
  const current = () => Math.round(sheet()?.getBoundingClientRect().width || 0);
  const limits = () => ({ min: PANEL_MIN, max: panelMax(innerWidth, listLeft()) });
  const sync = () => {
    const { min, max } = limits();
    bar.setAttribute('aria-valuemin', String(min));
    bar.setAttribute('aria-valuemax', String(max));
    bar.setAttribute('aria-valuenow', String(Math.min(max, Math.max(min, current() || min))));
  };
  const set = (w, { save = true } = {}) => {
    const v = clampPanel(w, innerWidth, listLeft());
    root.style.setProperty('--panel-user', v + 'px');
    if (save && storage) savePanel(storage, v);
    sync();
    return v;
  };
  const reset = () => { root.style.removeProperty('--panel-user'); if (storage) savePanel(storage, null); sync(); };

  const saved = storage ? savedPanel(storage) : null;
  if (saved) root.style.setProperty('--panel-user', saved + 'px');

  // Drag: the editor is as wide as the distance from the pointer to the right edge of the window.
  let dragging = false;
  bar.addEventListener('pointerdown', e => {
    if (e.button) return;
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    document.body.classList.add('panel-resizing');
    e.preventDefault();
  });
  bar.addEventListener('pointermove', e => { if (dragging) set(innerWidth - e.clientX, { save: false }); });
  const end = e => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('panel-resizing');
    try { bar.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const w = parseFloat(root.style.getPropertyValue('--panel-user'));
    if (w && storage) savePanel(storage, w);
    sync();
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', reset);
  bar.addEventListener('keydown', e => {
    const w = current() || limits().min;
    // The divider sits on the editor's left edge: Left moves it left (a wider editor), Right moves it right (a narrower one).
    const next = { ArrowLeft: w + PANEL_STEP, ArrowRight: w - PANEL_STEP, Home: limits().min, End: limits().max }[e.key];
    if (next == null) return;
    e.preventDefault();
    set(next);
  });
  // Keep aria-valuenow right when the panel opens or the window changes size.
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', sync);
  sync();
}
