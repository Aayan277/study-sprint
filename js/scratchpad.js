import { keepFocusOnPress } from './ui.js';
// Scratchpad (B4): draw on top of a Review card with a pen, finger or mouse. A DOM module; Review wires it up.
//
//   const pad = mountScratch(cardEl, { onChange: on => ... });
//   pad.on() / pad.off()   drawing on or off (the drawing stays visible when off)
//   pad.clear()            wipe the drawing         pad.destroy()   remove everything
//   pad.isOn()             pad.hasInk()   has anything been drawn?      pad.restore(canvas)   put an earlier drawing back
//
// The bitmap is only sized once the pad is first turned on (or a drawing is put back): a pad that is never used costs nothing,
// and a resize only copies the bitmap when there is something drawn on it.
//
// A <canvas class="scratch"> covers the card. While off it lets every touch and click through to the card
// (pointer-events: none; touch-action: auto). While on it takes them (pointer-events: auto; touch-action: none).
// Tools appear in the top-right corner while on: Pen, Eraser, Clear, Close (.scratch-tools, 40px buttons).
// Drawings are never saved. The colour is the card's --text, the bitmap keeps its pixels when the card resizes.

const BASE_WIDTH = 3, ERASER_WIDTH = 16, PALM_MS = 1000;

export function mountScratch(card, { onChange } = {}) {
  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
  const canvas = document.createElement('canvas');
  canvas.className = 'scratch';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', zIndex: '3', pointerEvents: 'none', touchAction: 'auto' });
  const ctx = canvas.getContext('2d');

  const tools = document.createElement('div');
  tools.className = 'scratch-tools';
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', 'Scratchpad tools');
  Object.assign(tools.style, { position: 'absolute', top: '6px', right: '6px', zIndex: '4', display: 'none', gap: '4px' });
  const mk = (id, label) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'scratch-tool'; b.dataset.tool = id; b.textContent = label;
    Object.assign(b.style, { minWidth: '40px', height: '40px' });
    tools.appendChild(b);
    return b;
  };
  const penBtn = mk('pen', 'Pen'), eraserBtn = mk('eraser', 'Eraser'), clearBtn = mk('clear', 'Clear'), closeBtn = mk('close', 'Close');
  card.append(canvas, tools);

  let enabled = false, tool = 'pen';
  const setTool = t => {
    tool = t;
    penBtn.setAttribute('aria-pressed', String(t === 'pen'));
    eraserBtn.setAttribute('aria-pressed', String(t === 'eraser'));
  };
  setTool('pen');

  // ----- size: keep the bitmap when the card changes size -----
  let dpr = 1, cssW = 0, cssH = 0, inked = false, sized = false;
  function fit() {
    const w = card.clientWidth, h = card.clientHeight;
    const r = window.devicePixelRatio || 1;
    if (!w || !h || (w === cssW && h === cssH && r === dpr)) return;
    let keep = null;
    if (inked && canvas.width && canvas.height) {
      keep = document.createElement('canvas');
      keep.width = canvas.width; keep.height = canvas.height;
      keep.getContext('2d').drawImage(canvas, 0, 0);
    }
    const oldDpr = dpr;
    cssW = w; cssH = h; dpr = r;
    canvas.width = Math.round(w * r); canvas.height = Math.round(h * r);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (keep) ctx.drawImage(keep, 0, 0, keep.width * (r / oldDpr), keep.height * (r / oldDpr));   // same pixels, top-left
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  function ensureSized() {
    if (!sized) { sized = true; ro?.observe(card); }
    fit();
  }

  // ----- drawing -----
  let active = null;                 // pointerId being drawn with (one at a time)
  let last = null, mid = null;       // previous point, and the midpoint the last curve ended at
  let penSeen = false, penDown = false, lastPen = 0;
  let activeType = '', snapshot = null;   // what the active pointer is, and the picture from just before a touch began
  let colour = '#888';                // the stroke colour, read once when a stroke starts

  const point = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pointerType === 'pen' ? e.pressure : 0.5 }; };
  const widthFor = p => (tool === 'eraser' ? ERASER_WIDTH : BASE_WIDTH * (0.4 + p));
  const style = () => {
    if (tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; }
    else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = colour; ctx.fillStyle = colour;
    }
  };
  function dot(pt) {
    inked = true;
    style();
    ctx.beginPath(); ctx.arc(pt.x, pt.y, widthFor(pt.p) / 2, 0, Math.PI * 2); ctx.fill();
  }
  function segment(pt) {
    inked = true;
    // A quadratic curve from the last midpoint to the new midpoint, with the last point as its control: smooth lines.
    const m = { x: (last.x + pt.x) / 2, y: (last.y + pt.y) / 2 };
    style();
    ctx.lineWidth = widthFor((last.p + pt.p) / 2);
    ctx.beginPath(); ctx.moveTo(mid.x, mid.y); ctx.quadraticCurveTo(last.x, last.y, m.x, m.y); ctx.stroke();
    last = pt; mid = m;
  }
  const palmRejected = e => e.pointerType === 'touch' && penSeen && (penDown || e.timeStamp - lastPen < PALM_MS);

  canvas.addEventListener('pointerdown', e => {
    if (!enabled) return;
    if (e.pointerType === 'pen') { penSeen = true; penDown = true; lastPen = e.timeStamp; }
    // A palm that landed first is drawing a blob: let go of it, undo what it drew, and let the pen take over.
    if (e.pointerType === 'pen' && active !== null && activeType === 'touch') {
      try { canvas.releasePointerCapture(active); } catch { /* already released */ }
      if (snapshot) { try { ctx.putImageData(snapshot, 0, 0); } catch { /* no snapshot to restore */ } }
      active = null; last = null; mid = null;
    }
    if (palmRejected(e) || active !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    active = e.pointerId; activeType = e.pointerType;
    snapshot = null;
    if (e.pointerType === 'touch') { try { snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch { /* an empty canvas */ } }
    colour = getComputedStyle(card).getPropertyValue('--text').trim() || getComputedStyle(card).color || '#888';
    try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    const pt = point(e);
    last = pt; mid = pt;
    dot(pt);
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerType === 'pen') { lastPen = e.timeStamp; }
    if (e.pointerId !== active || !enabled) return;
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) segment(point(ev));
  });
  const end = e => {
    if (e.pointerType === 'pen') { penDown = false; lastPen = e.timeStamp; }
    if (e.pointerId !== active) return;
    if (last && mid && e.type === 'pointerup') segment({ x: last.x, y: last.y, p: last.p });   // finish the curve at the last point
    active = null; last = null; mid = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', e => { if (e.pointerId === active) end({ pointerId: active, pointerType: e.pointerType, type: 'pointercancel', timeStamp: e.timeStamp }); });

  // ----- tools -----
  function clear() { inked = false; ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); }
  function on() {
    if (enabled) return;
    enabled = true;
    canvas.style.pointerEvents = 'auto'; canvas.style.touchAction = 'none';
    tools.style.display = 'flex';
    ensureSized();
    onChange?.(true);
  }
  function off() {
    if (!enabled) return;
    enabled = false; active = null; last = null; mid = null;
    canvas.style.pointerEvents = 'none'; canvas.style.touchAction = 'auto';
    tools.style.display = 'none';
    onChange?.(false);
  }
  penBtn.addEventListener('click', () => setTool('pen'));
  eraserBtn.addEventListener('click', () => setTool('eraser'));
  clearBtn.addEventListener('click', clear);
  closeBtn.addEventListener('click', off);
  // A tap on a tool must not flip the card behind it (Review ignores clicks inside .scratch-tools too).
  tools.addEventListener('click', e => e.stopPropagation());
  keepFocusOnPress(tools);                   // a mouse click on a tool must not take focus (Space would press it instead of flipping)
  canvas.addEventListener('click', e => e.stopPropagation());       // finishing a stroke is not a tap on the card

  function destroy() { enabled = false; ro?.disconnect(); canvas.remove(); tools.remove(); }
  // Put an earlier drawing (another pad's canvas) back, at the same top-left pixels.
  function restore(from) {
    if (!from) return;
    ensureSized();
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(from, 0, 0); ctx.restore();
    inked = true;
  }
  return { on, off, clear, destroy, restore, isOn: () => enabled, hasInk: () => inked, canvas, tools };
}
