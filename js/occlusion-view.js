// The part of image occlusion that touches the page: a pan-and-zoom controller (pinch, wheel, double-tap, keys) and
// the full-screen picture viewer that opens from the Zoom button on a card. The drawing editor uses the same
// controller (panZoom), so there is one place that knows how to pinch.
// Loaded the first time a picture card is shown (review.js), not at start-up. The maths is in occlusion.js.

import { fitView, zoomAt, clampView, MIN_SCALE, MAX_SCALE } from './occlusion.js';

const TAP_MS = 300;        // two taps this close together are a double-tap
const TAP_PX = 30;         // ... and this close to each other
const MOVED_PX = 8;        // a touch that moved less than this was a tap, not a drag
const DOUBLE_ZOOM = 2.5;   // where a double-tap zooms to

// Make `canvas` (the picture and its boxes) pan and zoom inside `stage` (the frame that clips it).
//   oneFinger  'pan': one finger or the mouse drags the picture. 'none': it doesn't (the editor draws with one finger);
//              two fingers pinch and pan either way.
//   aspect     the picture's width / height (else read from the canvas's --ar)
//   onChange(view)  after every move: { s, x, y }
//   onPinch()  when a second finger arrives, so an editor can drop the box it was drawing
// The canvas is sized to fit the frame (zoom 1) and moved with a CSS transform; its --s variable is the zoom, so the
// handles of the editor can stay one size.
// Returns { view, set, fit, zoomBy, setAspect, size, destroy }.
export function panZoom(stage, canvas, { oneFinger = 'pan', aspect = 0, onChange = () => {}, onPinch = () => {} } = {}) {
  let ratio = aspect || parseFloat(getComputedStyle(canvas).getPropertyValue('--ar')) || 1.5;
  let vw = 0, vh = 0, cw = 0, ch = 0;
  let view = { s: 1, x: 0, y: 0 };
  const pointers = new Map();         // pointer id → { x, y } in frame pixels
  let pinch = null;                   // where the two fingers started
  let drag = null;                    // the one finger or mouse that is panning
  let lastTap = null;
  const ac = new AbortController();
  const opt = { signal: ac.signal };

  canvas.style.transformOrigin = '0 0';
  canvas.style.position = 'absolute';
  canvas.style.left = canvas.style.top = '0';

  function apply() {
    canvas.style.transform = `translate(${view.x.toFixed(2)}px, ${view.y.toFixed(2)}px) scale(${view.s.toFixed(4)})`;
    canvas.style.setProperty('--s', view.s.toFixed(4));
    onChange({ ...view });
  }
  // Measure the frame and fit the picture into it (keeping the zoom if it is zoomed in).
  function layout(reset) {
    vw = stage.clientWidth; vh = stage.clientHeight;
    if (!vw || !vh) return;
    const f = fitView(vw, vh, ratio * 1000, 1000);
    cw = f.cw; ch = f.ch;
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    view = reset || view.s <= 1.001 ? { s: 1, x: f.x, y: f.y } : clampView(view, vw, vh, cw, ch);
    apply();
  }
  const put = next => {
    // Back at zoom 1 the picture goes back to the middle.
    view = next.s <= 1.001 ? { s: 1, x: (vw - cw) / 2, y: (vh - ch) / 2 } : clampView(next, vw, vh, cw, ch);
    apply();
  };
  const local = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const zoomTo = (s, cx, cy) => put(zoomAt(view, s, cx, cy));

  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, view: { ...view } };
  }
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    if (e.target.closest?.('button, input, textarea, select, [data-nopan]')) return;
    pointers.set(e.pointerId, local(e));
    try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic pointers can't be captured */ }
    if (pointers.size === 2) { drag = null; startPinch(); onPinch(); }
    else if (pointers.size === 1) drag = { id: e.pointerId, start: local(e), from: { ...view }, at: e.timeStamp, moved: false };
  }, opt);
  stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinch.view.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist));
      // The point of the picture that was under the fingers' middle stays under it.
      const px = (pinch.mid.x - pinch.view.x) / pinch.view.s, py = (pinch.mid.y - pinch.view.y) / pinch.view.s;
      put({ s, x: mid.x - px * s, y: mid.y - py * s });
    } else if (drag && drag.id === e.pointerId) {
      const p = local(e);
      if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > MOVED_PX) drag.moved = true;
      if (oneFinger === 'pan' && drag.moved) put({ ...view, x: drag.from.x + p.x - drag.start.x, y: drag.from.y + p.y - drag.start.y });
    }
  }, opt);
  const release = e => {
    if (!pointers.has(e.pointerId)) return;
    const tapped = drag && drag.id === e.pointerId && !drag.moved && e.type === 'pointerup' && e.pointerType !== 'mouse' && pointers.size === 1;
    pointers.delete(e.pointerId);
    try { stage.releasePointerCapture(e.pointerId); } catch { /* fine */ }
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {           // one finger is left: carry on panning from where it is
      const [[id, p]] = [...pointers];
      drag = { id, start: p, from: { ...view }, at: e.timeStamp, moved: true };
    } else drag = null;
    // A double-tap with a finger zooms in or back out (the mouse has dblclick).
    if (tapped) {
      const p = local(e);
      if (lastTap && e.timeStamp - lastTap.at < TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < TAP_PX) { lastTap = null; zoomTo(view.s > 1.01 ? 1 : DOUBLE_ZOOM, p.x, p.y); }
      else lastTap = { at: e.timeStamp, x: p.x, y: p.y };
    }
  };
  stage.addEventListener('pointerup', release, opt);
  stage.addEventListener('pointercancel', release, opt);
  stage.addEventListener('lostpointercapture', release, opt);
  stage.addEventListener('dblclick', e => {
    if (e.target.closest?.('button, input, textarea, select, [data-nopan]')) return;
    const p = local(e);
    zoomTo(view.s > 1.01 ? 1 : DOUBLE_ZOOM, p.x, p.y);
  }, opt);
  // The wheel (and a trackpad pinch, which arrives as a wheel with ctrlKey) zooms around the cursor.
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const p = local(e);
    zoomTo(view.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
  }, { ...opt, passive: false });
  // Keys: + and - zoom, 0 fits the picture, the arrows move a zoomed picture.
  stage.ownerDocument.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.matches?.('input, textarea, select')) return;
    if (!stage.isConnected || stage.closest('[inert]')) return;
    const mid = { x: vw / 2, y: vh / 2 };
    if (e.key === '+' || e.key === '=') zoomTo(view.s * 1.5, mid.x, mid.y);
    else if (e.key === '-' || e.key === '_') zoomTo(view.s / 1.5, mid.x, mid.y);
    else if (e.key === '0') layout(true);
    else if (view.s > 1 && e.key.startsWith('Arrow') && !e.target.closest?.('button')) {
      put({ ...view, x: view.x + ({ ArrowLeft: 60, ArrowRight: -60 }[e.key] || 0), y: view.y + ({ ArrowUp: 60, ArrowDown: -60 }[e.key] || 0) });
    } else return;
    e.preventDefault();
  }, opt);
  // Gestures on iPhones would otherwise zoom the whole page.
  stage.addEventListener('gesturestart', e => e.preventDefault(), opt);
  const resize = new ResizeObserver(() => layout(false));
  resize.observe(stage);
  layout(true);

  return {
    get view() { return { ...view }; },
    size: () => ({ vw, vh, cw, ch }),
    set: next => put({ ...view, ...next }),
    fit: () => layout(true),
    zoomBy: (factor, cx = vw / 2, cy = vh / 2) => zoomTo(view.s * factor, cx, cy),
    setAspect: a => { if (a > 0 && a !== ratio) { ratio = a; layout(true); } },
    destroy: () => { ac.abort(); resize.disconnect(); }
  };
}

// ---------- the picture viewer ----------
// Opens the picture full screen: pinch, wheel or the buttons to zoom, drag to move. Escape or Close to leave.
//   figureHTML  the card's picture as occlusion.js drew it (the same boxes and covers)
export function openZoom(figureHTML, title = 'Picture', returnTo = null) {
  if (document.querySelector('dialog.occ-view')) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'occ-view';
  dlg.setAttribute('aria-label', title);
  dlg.innerHTML = `
    <div class="occ-view-bar">
      <button type="button" class="btn ghost small" data-close>Close</button>
      <span class="occ-view-title">${esc(title)}</span>
      <span class="occ-view-tools" role="group" aria-label="Zoom">
        <button type="button" class="icon-btn" data-z="out" aria-label="Zoom out" aria-keyshortcuts="-">−</button>
        <button type="button" class="icon-btn" data-z="in" aria-label="Zoom in" aria-keyshortcuts="+">+</button>
        <button type="button" class="btn ghost small" data-z="fit" aria-keyshortcuts="0">Fit</button>
      </span>
    </div>
    <div class="occ-view-stage"><div class="occ-view-canvas"></div></div>`;
  const stage = dlg.querySelector('.occ-view-stage'), canvas = dlg.querySelector('.occ-view-canvas');
  // The copy has no Zoom button, and its pictures fill themselves in again (the page's copies are marked as loading).
  const tpl = document.createElement('template');
  tpl.innerHTML = figureHTML;
  tpl.content.querySelectorAll('.occ-zoom').forEach(b => b.remove());
  tpl.content.querySelectorAll('img').forEach(img => img.removeAttribute('data-loading'));
  const figure = tpl.content.firstElementChild;
  canvas.append(tpl.content);
  document.body.append(dlg);
  dlg.showModal();
  const pz = panZoom(stage, canvas, { oneFinger: 'pan', aspect: parseFloat(figure?.style.getPropertyValue('--ar')) || 0 });
  // Without a saved size, the box takes the picture's own shape once it has loaded.
  const img = canvas.querySelector('img');
  img?.addEventListener('load', () => { if (!parseFloat(figure?.style.getPropertyValue('--ar'))) pz.setAspect(img.naturalWidth / img.naturalHeight); });
  dlg.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) dlg.close();
    const z = e.target.closest('[data-z]')?.dataset.z;
    if (z === 'in') pz.zoomBy(1.5); else if (z === 'out') pz.zoomBy(1 / 1.5); else if (z === 'fit') pz.fit();
  });
  dlg.addEventListener('close', () => {
    pz.destroy();
    dlg.remove();
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  });
  dlg.querySelector('[data-close]').focus();
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The Zoom button of a card's picture was pressed.
export function zoomFrom(button) {
  const figure = button.closest('.occ');
  if (figure) openZoom(figure.outerHTML, figure.querySelector('img')?.alt || 'Picture', button);
}

// One handler for every Zoom button on the page (Review, onboarding). It runs before the card's own click handler and
// stops it, so zooming doesn't flip the card.
document.addEventListener('click', e => {
  const button = e.target.closest?.('.occ-zoom');
  if (!button || button.closest('dialog.occ-view')) return;
  e.stopPropagation();
  e.preventDefault();
  zoomFrom(button);
}, true);
