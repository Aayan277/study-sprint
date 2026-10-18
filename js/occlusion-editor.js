// The image-occlusion box editor: a full-screen dialog where you draw boxes over the parts of a picture to hide.
// One finger (or the mouse) draws, selects, moves and resizes boxes; two fingers or Ctrl/⌘+wheel zoom (that
// part is panZoom in occlusion-view.js). Boxes that share a number are one group = one card; "Group" joins them.
//
//   openOcclusionEditor({ image, w, h, masks, focusN, maxN })  →  Promise<{ masks, maxN } | null>
//     image   the picture's media id        w, h   its saved size in pixels
//     masks   the boxes so far (copies are edited; the caller's list is never changed)
//     focusN  start with this group selected (the card that was being edited)
//     maxN    the highest group number ever used on this picture, so a new group never reuses a number
//   Resolves with the new boxes on Done, or null on Cancel. The maths (hit tests, moving, undo) is in occlusion.js.
//
// Loaded the first time it is needed (card-editor.js), not at start-up.

import { holdBack, releaseBack } from './nav.js';
import { panZoom } from './occlusion-view.js';
import { imgHTML } from './media.js';
import { esc } from './ui.js';
import {
  hitTest, handleAt, moveMask, resizeMask, rectFrom, toImage, nextN, groupMasks, splitMask, deleteMasks,
  newH, pushH, undoH, redoH, groupsOf, groupIndex, occLabel, MAX_MASKS, MAX_LABEL
} from './occlusion.js';

const DRAW_PX = 8;         // a drag shorter than this (on screen) is a tap, not a box
const MIN_FRAC = 0.003;    // ... and a box is at least 0.3% of the picture on each side
const MOVE_PX = 4;         // a touch on a box must move this far before the box moves
const GRAB_MOUSE = 8, GRAB_TOUCH = 22;   // how close (px) to a corner handle counts as holding it
const GRAB_FRAC = 0.25;    // ... but never more than this share of the box's on-screen size
const SMALL_PX = 60;       // a touch inside a box smaller than this (both sides) moves it (no corner is grabbed)
const TINY_PX = 28;        // a box smaller than this on screen has no number badge
const NUDGE = 0.005;       // arrow keys move a box by 0.5% of the picture (Shift: 5%)
const ADD_SIZE = 0.2;      // "Add box" makes a box 20% wide
const HINT_KEY = 'study-sprint-occ-hint';

const round5 = v => Math.round(v * 1e5) / 1e5;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const boxes = n => `${n} ${n === 1 ? 'box' : 'boxes'}`;
const cards = n => `${n} ${n === 1 ? 'card' : 'cards'}`;
const pct = v => (v * 100).toFixed(4) + '%';

// Icons for the buttons (24×24, drawn with the text colour).
const svg = inner => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  group: svg('<rect x="3" y="3" width="11" height="11" rx="2"/><rect x="10" y="10" width="11" height="11" rx="2"/>'),
  split: svg('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M13 11l-2 2"/>'),
  label: svg('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>'),
  add: svg('<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3.2 3"/><path d="M12 8v8M8 12h8"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')
};
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? '⌘' : 'Ctrl';
const TOOLS = [
  ['undo', 'Undo', `Undo (${MOD}+Z)`, MAC ? 'Meta+Z' : 'Control+Z'],
  ['redo', 'Redo', `Redo (${MOD}+Shift+Z)`, MAC ? 'Meta+Shift+Z' : 'Control+Shift+Z Control+Y'],
  ['delete', 'Delete', 'Delete the selected boxes (Delete)', 'Delete'],
  ['group', 'Group', 'Group the selected boxes into one card (G)', 'G'],
  ['label', 'Label', 'Name the selected part (L)', 'L'],
  ['add', 'Add box', 'Add a box in the middle of the view', ''],
  ['fit', 'Fit', 'Show the whole picture (0)', '0']
];
const toolIcon = { undo: ICON.undo, redo: ICON.redo, delete: ICON.trash, group: ICON.group, label: ICON.label, add: ICON.add, fit: ICON.fit };

export function openOcclusionEditor({ image, w, h, masks = [], focusN = null, maxN = 0 }) {
  return new Promise(resolve => {
    if (document.querySelector('dialog.occ-ed')) { resolve(null); return; }
    const opener = document.activeElement;
    const start = masks.map(m => ({ ...m }));
    const startJSON = JSON.stringify(start);
    let hist = newH(start);                       // the boxes now, with undo and redo
    let top = Math.max(0, maxN, ...start.map(m => m.n));       // highest group number ever used (only grows)
    let idN = Math.max(0, ...start.map(m => +(/^m(\d+)$/.exec(m.id)?.[1] ?? 0)));
    let sel = new Set(start.filter(m => focusN !== null && m.n === focusN).map(m => m.id));   // selected box ids
    let joining = false;                          // "Join" mode: tapping boxes adds them to the selection
    let labelOpen = false, labelPushed = false, labelKey = null;
    let lastKey = null, lastAt = 0;               // lets a run of arrow-key nudges be one undo step
    let g = null;                                 // the gesture going on (draw, move, resize, pan)
    const down = new Set();                       // pointers that are down
    let pz = null;                                // the pan-and-zoom controller (set once the dialog is open)
    let spaceDown = false, escAt = 0, result = null, closed = false, noteTimer = 0;   // closed: Done, Cancel or Discard was chosen
    const ac = new AbortController();
    const opt = { signal: ac.signal };

    const dlg = document.createElement('dialog');
    dlg.className = 'occ-ed';
    dlg.setAttribute('aria-labelledby', 'occEdTitle');
    const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
    let seen = false;
    try { seen = !!localStorage.getItem(HINT_KEY); } catch { /* fine */ }
    const hint = fine ? 'Drag over a part to hide it. Pinch or Ctrl/⌘+scroll to zoom · scroll or Space+drag to move.' : 'Drag over a part to hide it. Pinch with two fingers to zoom.';
    dlg.innerHTML = `
      <div class="occ-ed-bar">
        <button type="button" class="occ-ed-x" data-act="cancel" aria-label="Cancel" title="Cancel (Esc)">${ICON.x}</button>
        <div class="occ-ed-head"><h2 id="occEdTitle">Hide parts</h2><span class="occ-ed-count" id="occEdCount" aria-live="polite"></span></div>
        <button type="button" class="btn primary" data-act="done">Done</button>
      </div>
      <div class="occ-ed-stage" tabindex="-1" autofocus>
        <div class="occ-ed-canvas">${imgHTML(image, 'occ-ed-img')}<div class="occ-ed-masks"></div></div>
        <p class="occ-ed-pill occ-ed-note" role="status"></p>
        <p class="occ-ed-pill occ-ed-hint" ${seen || start.length ? 'hidden' : ''}>${hint}</p>
      </div>
      <div class="occ-ed-label" hidden>
        <label for="occEdLabel" id="occEdLabelCap">Label</label>
        <input id="occEdLabel" maxlength="${MAX_LABEL}" autocomplete="off" enterkeyhint="done" placeholder="e.g. Left ventricle">
        <button type="button" class="btn ghost" data-act="label-ok">OK</button>
      </div>
      <div class="occ-ed-tools" role="group" aria-label="Box tools">
        ${TOOLS.map(([id, text, title, keys]) => `<button type="button" class="occ-ed-tool" data-tool="${id}" title="${esc(title)}" aria-label="${esc(title.replace(/ \(.*\)$/, ''))}" ${keys ? `aria-keyshortcuts="${keys}"` : ''}><i>${toolIcon[id]}</i><span>${text}</span></button>`).join('')}
      </div>
      <div class="occ-ed-confirm" role="alertdialog" aria-labelledby="occEdCfT" aria-describedby="occEdCfD" hidden>
        <div class="occ-ed-cf">
          <h3 id="occEdCfT">Discard your changes?</h3>
          <p id="occEdCfD">The boxes you drew or changed here won't be kept.</p>
          <div class="occ-ed-cf-btns"><button type="button" class="btn ghost" data-act="keep">Keep editing</button><button type="button" class="btn danger solid" data-act="discard">Discard</button></div>
        </div>
      </div>`;
    document.body.append(dlg);
    const $q = s => dlg.querySelector(s);
    const stage = $q('.occ-ed-stage'), canvas = $q('.occ-ed-canvas'), maskBox = $q('.occ-ed-masks');
    const countEl = $q('#occEdCount'), noteEl = $q('.occ-ed-note'), hintEl = $q('.occ-ed-hint');
    const labelRow = $q('.occ-ed-label'), labelIn = $q('#occEdLabel'), cfBox = $q('.occ-ed-confirm');
    const tool = id => $q(`[data-tool="${id}"]`);
    dlg.showModal();
    holdBack('occ-editor', () => cancel());      // Back (an edge swipe) asks before throwing changes away, like Esc

    pz = panZoom(stage, canvas, { oneFinger: 'none', aspect: w > 0 && h > 0 ? w / h : 0, onPinch: () => abort(), onChange: () => markTiny(), arrowsBusy: () => sel.size > 0 });
    // Without a saved size the picture's own shape is used once it has loaded.
    const img = canvas.querySelector('img');
    img?.addEventListener('load', () => { if (!(w > 0 && h > 0)) pz.setAspect(img.naturalWidth / img.naturalHeight); }, opt);

    // ---------- looking at the boxes ----------
    const byId = id => hist.present.find(m => m.id === id);
    const picked = () => hist.present.filter(m => sel.has(m.id));
    const say = text => {
      noteEl.textContent = text;
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => { noteEl.textContent = ''; }, 3200);
    };
    const hideHint = () => {
      if (hintEl.hidden) return;
      hintEl.hidden = true;
      try { localStorage.setItem(HINT_KEY, '1'); } catch { /* fine */ }
    };

    // The inside of a box: its fill (a polygon is cut to its shape, an ellipse is round) and the number of its card.
    function maskHTML(m, total) {
      const k = groupIndex(hist.present, m.n).k, label = occLabel(hist.present, m.n), on = sel.has(m.id);
      let clip = '';
      if (m.shape === 'polygon' && m.points?.length >= 3 && m.w > 0 && m.h > 0) {
        clip = ` style="clip-path:polygon(${m.points.map(([px, py]) => `${(clamp((px - m.x) / m.w, 0, 1) * 100).toFixed(2)}% ${(clamp((py - m.y) / m.h, 0, 1) * 100).toFixed(2)}%`).join(',')})"`;
      }
      const handles = on && sel.size === 1 ? ['nw', 'ne', 'sw', 'se'].map(c => `<i class="occ-ed-h occ-ed-h-${c}"></i>`).join('') : '';
      return `<div class="occ-ed-mask${on ? ' sel' : ''}${!on && mates.has(m.n) ? ' mate' : ''}${m.shape === 'ellipse' ? ' round' : ''}" data-id="${esc(m.id)}" data-n="${m.n}"
        style="left:${pct(m.x)};top:${pct(m.y)};width:${pct(m.w)};height:${pct(m.h)}" tabindex="0" role="button" aria-pressed="${on}"
        aria-label="Part ${k} of ${total}, ${label ? 'label ' + esc(label) : 'no label'}"><span class="occ-ed-fill"${clip}></span><span class="occ-ed-num">${k}</span>${handles}</div>`;
    }
    let mates = new Set();       // groups that have a selected box (their other boxes are tinted)
    function render() {
      const masks = hist.present, total = groupsOf(masks).length;
      mates = new Set(masks.filter(m => sel.has(m.id)).map(m => m.n));
      const focusId = document.activeElement?.closest?.('.occ-ed-mask')?.dataset.id;
      maskBox.innerHTML = masks.map(m => maskHTML(m, total)).join('');
      // Redrawing replaced the box that had the keyboard focus: put the focus back on its copy.
      if (focusId) maskBox.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
      if (!dlg.contains(document.activeElement)) stage.focus({ preventScroll: true });
      markTiny();
      status();
    }
    // Boxes under TINY_PX on screen lose their number badge.
    function markTiny() {
      if (!pz) return;
      const { cw, ch } = pz.size(), s = pz.view.s;
      maskBox.querySelectorAll('.occ-ed-mask').forEach(el => {
        const m = byId(el.dataset.id);
        el.classList.toggle('tiny', !!m && Math.min(m.w * cw, m.h * ch) * s < TINY_PX);
      });
    }

    // What the Group button does for the selection now.
    function groupState() {
      const mine = picked();
      if (joining) return { icon: 'group', text: `Join ${mine.length}`, label: `Join the ${mine.length} selected boxes into one card`, enabled: mine.length >= 2 };
      if (mine.length >= 2) {
        if (new Set(mine.map(m => m.n)).size === 1) return { icon: 'split', text: 'Split', label: 'Split the selected boxes into separate cards', enabled: true };
        return { icon: 'group', text: 'Group', label: 'Group the selected boxes into one card', enabled: true };
      }
      if (mine.length === 1) {
        const mates1 = hist.present.filter(m => m.n === mine[0].n).length > 1;
        return mates1 ? { icon: 'split', text: 'Split', label: 'Split this box off into its own card', enabled: true }
          : { icon: 'group', text: 'Group', label: 'Group this box with others: then tap the other boxes', enabled: true };
      }
      return { icon: 'group', text: 'Group', label: 'Group the selected boxes into one card', enabled: false };
    }
    function status() {
      const masks = hist.present;
      const count = masks.length ? `${boxes(masks.length)} · ${cards(groupsOf(masks).length)}` : 'No boxes yet';
      if (countEl.textContent !== count) countEl.textContent = count;     // the live region only speaks real changes
      tool('undo').disabled = !hist.past.length;
      tool('redo').disabled = !hist.future.length;
      tool('delete').disabled = !sel.size;
      const gs = groupState(), gb = tool('group');
      gb.disabled = !gs.enabled;
      gb.querySelector('span').textContent = gs.text;
      gb.querySelector('i').innerHTML = ICON[gs.icon];
      gb.setAttribute('aria-label', gs.label);
      gb.classList.toggle('on', joining);
      tool('label').disabled = !sel.size;
      tool('label').classList.toggle('on', labelOpen);
      if (!sel.size) { joining = false; if (labelOpen) closeLabel(false); }
      stage.classList.toggle('joining', joining);
      if (joining) say(`Tap the other boxes to join, then press Join ${picked().length}.`);
      if (labelOpen) syncLabel(false);
    }

    // ---------- changing the boxes ----------
    // One finished change = one undo step. `merge` joins a quick run of the same kind of change (arrow-key nudges).
    function commit(next, merge = null) {
      if (merge && merge === lastKey && Date.now() - lastAt < 700) hist = { ...hist, present: next };
      else hist = pushH(hist, next);
      lastKey = merge; lastAt = Date.now();
      labelPushed = false;
      render();
    }
    function undo() { hist = undoH(hist); afterHistory(); }
    function redo() { hist = redoH(hist); afterHistory(); }
    function afterHistory() {
      sel = new Set([...sel].filter(id => byId(id)));
      lastKey = null; labelPushed = false;
      noteEl.textContent = '';                       // an old message ("Joined into one card.") no longer fits
      render();
      if (labelOpen) syncLabel(true);
    }
    function remove() {
      if (!sel.size) return;
      const next = deleteMasks(hist.present, [...sel]);
      sel = new Set(); joining = false;
      commit(next);
    }
    function addBox(m) {
      if (hist.present.length >= MAX_MASKS) { say(`A picture can have up to ${MAX_MASKS} boxes.`); return; }
      const n = nextN(hist.present, top);
      top = n;
      const box = { id: `m${++idN}`, n, shape: 'rect', ...m };
      sel = new Set([box.id]); joining = false;
      hideHint();
      commit([...hist.present, box]);
    }
    // A new box from corner a to corner b (picture fractions), rounded so it stays inside the picture.
    function tidy(r) {
      const x = round5(r.x), y = round5(r.y);
      return { x, y, w: round5(Math.min(1, round5(r.x + r.w)) - x), h: round5(Math.min(1, round5(r.y + r.h)) - y) };
    }
    function addCentered() {
      const v = pz.view, { vw, vh, cw, ch } = pz.size();
      const c = toImage(v, vw / 2, vh / 2, cw, ch);
      const bw = Math.min(1, ADD_SIZE / Math.max(1, v.s));          // 20% of the picture, less when zoomed in
      const bh = Math.min(1, bw * cw / ch);                          // ... and square on screen
      addBox(tidy({ x: clamp(c.x - bw / 2, 0, 1 - bw), y: clamp(c.y - bh / 2, 0, 1 - bh), w: bw, h: bh }));
    }

    function doGroup() {
      const mine = picked(), gs = groupState();
      if (!gs.enabled) return;
      if (joining || (mine.length >= 2 && gs.icon === 'group')) {
        joining = false;
        commit(groupMasks(hist.present, [...sel], focusN));      // [...sel] is in the order they were picked
        say('Joined into one card.');
      } else if (gs.icon === 'split') {
        // Each box gets a card of its own; when the whole group is selected the first one keeps the old card.
        let next = hist.present;
        for (const m of mine.length === 1 ? mine : mine.slice(1)) { top = nextN(next, top); next = splitMask(next, m.id, top - 1); }
        commit(next);
        say('Split into separate cards.');
      } else { joining = true; render(); }
    }

    // ---------- the label ----------
    const firstSel = () => picked()[0] || null;
    function syncLabel(force) {
      const first = firstSel();
      if (!first) return;
      if (!force && labelKey === first.id) return;
      labelKey = first.id; labelPushed = false;
      const k = groupIndex(hist.present, first.n).k;
      $q('#occEdLabelCap').textContent = `Label for part ${k}`;
      labelIn.setAttribute('aria-label', `Label for part ${k} (optional), e.g. Left ventricle`);
      labelIn.value = occLabel(hist.present, first.n);
    }
    function openLabel() {
      if (!sel.size) return;
      labelOpen = true; labelRow.hidden = false;
      syncLabel(true);
      labelIn.focus();
      labelIn.select();
      status();
    }
    function closeLabel(focusStage = true) {
      labelOpen = false; labelRow.hidden = true; labelPushed = false; labelKey = null;
      if (focusStage) stage.focus({ preventScroll: true });
      status();
    }
    labelIn.addEventListener('input', () => {
      const first = firstSel();
      if (!first) return;
      const text = labelIn.value.slice(0, MAX_LABEL);
      // The label goes on every box of the group. The whole time you type is one undo step.
      const next = hist.present.map(m => {
        if (m.n !== first.n) return m;
        const { label, ...rest } = m;
        return text.trim() ? { ...rest, label: text } : rest;
      });
      if (!labelPushed) { hist = pushH(hist, next); labelPushed = true; } else hist = { ...hist, present: next };
      lastKey = null;
      render();
    }, opt);
    labelIn.addEventListener('change', () => { labelPushed = false; }, opt);

    // ---------- leaving ----------
    const dirty = () => JSON.stringify(hist.present) !== startJSON;
    function finish(value) { result = value; closed = true; dlg.close(); }
    // The boxes as they go back to the caller. Labels lose spaces at both ends; boxes with an empty label lose it.
    function outcome() {
      const out = hist.present.map(m => {
        const { label, ...rest } = m;
        const text = String(label ?? '').trim();
        return text ? { ...rest, label: text } : rest;
      });
      return { masks: out, maxN: Math.max(top, ...out.map(m => m.n)) };
    }
    function done() {
      if (!hist.present.length) { say('Draw at least one box over the part to hide.'); return; }
      finish(outcome());
    }
    function showConfirm() {
      cfBox.hidden = false;
      ['.occ-ed-bar', '.occ-ed-stage', '.occ-ed-label', '.occ-ed-tools'].forEach(s => { $q(s).inert = true; });
      $q('[data-act="keep"]').focus();
    }
    function hideConfirm() {
      cfBox.hidden = true;
      ['.occ-ed-bar', '.occ-ed-stage', '.occ-ed-label', '.occ-ed-tools'].forEach(s => { $q(s).inert = false; });
      stage.focus({ preventScroll: true });
    }
    const cancel = () => { if (dirty()) showConfirm(); else finish(null); };
    // Esc peels off one thing at a time: the question, the label, join mode, the selection, then the editor.
    function escape() {
      if (!cfBox.hidden) hideConfirm();
      else if (labelOpen) closeLabel();
      else if (joining) { joining = false; render(); }
      else if (sel.size) { sel = new Set(); render(); }
      else cancel();
    }

    // ---------- touching the picture ----------
    const local = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const toImg = p => { const { cw, ch } = pz.size(); return toImage(pz.view, p.x, p.y, cw, ch); };
    // How much of the picture one screen pixel is.
    const perPx = () => { const { cw, ch } = pz.size(), s = pz.view.s; return { fx: 1 / (s * cw), fy: 1 / (s * ch) }; };
    const capture = e => { try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic pointers can't be captured */ } };
    const maskEl = id => maskBox.querySelector(`[data-id="${CSS.escape(id)}"]`);
    const place = m => {
      const el = maskEl(m.id);
      if (el) Object.assign(el.style, { left: pct(m.x), top: pct(m.y), width: pct(m.w), height: pct(m.h) });
    };
    // Where is the pointer: on a corner handle of the one selected box, on a box, or on nothing?
    function whatIsAt(pt, e) {
      const { fx, fy } = perPx();
      if (sel.size === 1) {
        const m = firstSel();
        const grab = e.pointerType === 'mouse' ? GRAB_MOUSE : GRAB_TOUCH;
        // On a small box a touch moves it: the corners are too close together to tell apart.
        const small = e.pointerType === 'touch' && Math.max(m.w / fx, m.h / fy) < SMALL_PX;
        const corner = m && !small && handleAt(m, pt.x, pt.y, Math.min(grab * fx, m.w * GRAB_FRAC), Math.min(grab * fy, m.h * GRAB_FRAC));
        if (corner) return { corner, mask: m };
      }
      const hit = hitTest(hist.present, pt.x, pt.y);
      return hit ? { mask: hit } : {};
    }
    // Give up on the gesture going on (a second finger came, or the system took the touch): nothing changes.
    function abort() {
      if (!g) return;
      g = null;
      stage.classList.remove('panning');
      render();
    }

    stage.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button > 1) return;
      if (e.target.closest?.('[data-nopan]')) return;
      if (e.pointerType === 'mouse') down.clear();
      down.add(e.pointerId);
      if (down.size > 1) { abort(); return; }         // two fingers: panZoom pinches
      hideHint();
      const p = local(e);
      // Desktop: the middle button, or Space + drag, moves the picture.
      if (e.pointerType === 'mouse' && (e.button === 1 || spaceDown)) {
        capture(e); e.preventDefault();
        g = { type: 'pan', id: e.pointerId, p0: p, from: pz.view };
        stage.classList.add('panning');
        return;
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      capture(e);
      const pt = toImg(p), at = whatIsAt(pt, e);
      if (at.corner) {
        const m = at.mask;
        const cx = at.corner.includes('w') ? m.x : m.x + m.w, cy = at.corner.includes('n') ? m.y : m.y + m.h;
        g = { type: 'resize', id: e.pointerId, p0: p, orig: m, corner: at.corner, dx: cx - pt.x, dy: cy - pt.y, moved: false };
      } else if (at.mask) {
        const m = at.mask;
        if (e.shiftKey || e.ctrlKey || e.metaKey || joining) {
          // Add to the selection or take out of it (Shift-click, or tapping while joining).
          if (sel.has(m.id)) sel.delete(m.id); else sel.add(m.id);
          render();
          g = { type: 'none', id: e.pointerId };
        } else {
          if (!sel.has(m.id)) { sel = new Set([m.id]); render(); }
          g = { type: 'move', id: e.pointerId, p0: p, orig: picked(), moved: false };
        }
      } else {
        g = { type: 'draw', id: e.pointerId, p0: p, a: pt, moved: false };
      }
    }, opt);

    stage.addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.id) { hover(e); return; }
      const p = local(e), dx = p.x - g.p0?.x, dy = p.y - g.p0?.y, dist = Math.hypot(dx, dy);
      if (g.type === 'pan') { pz.set({ x: g.from.x + dx, y: g.from.y + dy }); return; }
      if (g.type === 'draw') {
        if (dist < DRAW_PX) return;
        g.moved = true;
        let draft = maskBox.querySelector('.occ-ed-draft');
        if (!draft) { draft = document.createElement('div'); draft.className = 'occ-ed-draft'; maskBox.append(draft); }
        const r = rectFrom(g.a, toImg(p));
        Object.assign(draft.style, { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });
      } else if (g.type === 'move') {
        if (!g.moved && dist < MOVE_PX) return;
        g.moved = true;
        const { fx, fy } = perPx();
        // Move them all together, stopping when the first one reaches the edge.
        const left = Math.min(...g.orig.map(m => m.x)), right = Math.max(...g.orig.map(m => m.x + m.w));
        const upper = Math.min(...g.orig.map(m => m.y)), lower = Math.max(...g.orig.map(m => m.y + m.h));
        const mx = clamp(dx * fx, -left, 1 - right), my = clamp(dy * fy, -upper, 1 - lower);
        g.next = g.orig.map(m => moveMask(m, mx, my));
        g.next.forEach(place);
      } else if (g.type === 'resize') {
        g.moved = true;
        const pt = toImg(p);
        g.next = resizeMask(g.orig, g.corner, pt.x + g.dx, pt.y + g.dy, MIN_FRAC, MIN_FRAC);
        place(g.next);
      }
    }, opt);

    const release = e => {
      down.delete(e.pointerId);
      if (!g || e.pointerId !== g.id) return;
      const gg = g;
      g = null;
      stage.classList.remove('panning');
      if (e.type === 'pointercancel') { render(); return; }      // the system took the touch: nothing changes
      if (gg.type === 'draw') {
        const r = rectFrom(gg.a, toImg(local(e)));
        if (gg.moved && r.w >= MIN_FRAC && r.h >= MIN_FRAC) addBox(tidy(r));
        else { sel = new Set(); joining = false; render(); }       // a tap on the picture: nothing selected
      } else if (gg.type === 'move' && gg.moved) {
        const moved = new Map(gg.next.map(m => [m.id, m]));
        commit(hist.present.map(m => moved.get(m.id) || m));
      } else if (gg.type === 'resize' && gg.moved && JSON.stringify(gg.next) !== JSON.stringify(gg.orig)) {
        commit(hist.present.map(m => (m.id === gg.next.id ? gg.next : m)));
      } else render();
    };
    stage.addEventListener('pointerup', release, opt);
    stage.addEventListener('pointercancel', release, opt);

    // The mouse pointer says what a click would do.
    function hover(e) {
      if (e.pointerType !== 'mouse' || g) return;
      let c = 'crosshair';
      if (spaceDown) c = 'grab';
      else {
        const at = whatIsAt(toImg(local(e)), e);
        c = at.corner ? (at.corner === 'nw' || at.corner === 'se' ? 'nwse-resize' : 'nesw-resize') : at.mask ? 'move' : 'crosshair';
      }
      stage.style.cursor = c;
    }
    stage.addEventListener('contextmenu', e => e.preventDefault(), opt);
    dlg.addEventListener('gesturestart', e => e.preventDefault(), opt);
    // A screen reader's "click" on a box selects it (a real tap is handled with the pointer events above).
    maskBox.addEventListener('click', e => {
      const el = e.target.closest?.('.occ-ed-mask');
      if (el && e.detail === 0) { sel = new Set([el.dataset.id]); render(); }
    }, opt);
    // Tab moves from box to box and selects the one it lands on.
    dlg.addEventListener('focusin', e => {
      const el = e.target.closest?.('.occ-ed-mask');
      if (!el || !el.matches(':focus-visible') || (sel.size === 1 && sel.has(el.dataset.id))) return;
      sel = new Set([el.dataset.id]);
      render();
    }, opt);

    // ---------- keys ----------
    document.addEventListener('keydown', e => {
      if (!dlg.open) return;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();         // the card sheet behind must not close too
        escAt = performance.now();
        escape();
        return;
      }
      if (!cfBox.hidden) return;                          // the discard question has its own buttons
      const field = !!e.target.matches?.('input, textarea, select');
      const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
      if (mod && !e.altKey && !field && (key === 'z' || key === 'y')) {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) redo(); else undo();
        return;
      }
      if (field && e.key === 'Enter') { e.preventDefault(); closeLabel(); return; }
      if (field || mod) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { e.preventDefault(); remove(); }
      else if (key === 'g' && !e.altKey) { e.preventDefault(); doGroup(); }
      else if (key === 'l' && !e.altKey) { e.preventDefault(); openLabel(); }
      else if (e.code === 'Space' && !e.target.closest?.('button')) { e.preventDefault(); spaceDown = true; stage.style.cursor = 'grab'; }
      else if (e.key.startsWith('Arrow') && sel.size) {
        e.preventDefault();
        nudge(e);
      }
    }, { ...opt, capture: true });
    document.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; stage.style.cursor = ''; } }, opt);
    window.addEventListener('blur', () => { spaceDown = false; }, opt);

    // Arrow keys: move the selected boxes by 0.5% of the picture (Shift: 5%); with Alt they grow or shrink.
    function nudge(e) {
      const [ax, ay] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] || [0, 0];
      const step = e.shiftKey ? NUDGE * 10 : NUDGE, mine = picked();
      let next;
      if (e.altKey) {
        const grown = new Map(mine.map(m => [m.id, resizeMask(m, 'se', m.x + m.w + ax * step, m.y + m.h + ay * step, MIN_FRAC, MIN_FRAC)]));
        next = hist.present.map(m => grown.get(m.id) || m);
      } else {
        const mx = clamp(ax * step, -Math.min(...mine.map(m => m.x)), 1 - Math.max(...mine.map(m => m.x + m.w)));
        const my = clamp(ay * step, -Math.min(...mine.map(m => m.y)), 1 - Math.max(...mine.map(m => m.y + m.h)));
        next = hist.present.map(m => (sel.has(m.id) ? moveMask(m, mx, my) : m));
      }
      commit(next, 'nudge:' + [...sel].join());
    }

    // ---------- buttons ----------
    dlg.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act, t = e.target.closest('[data-tool]')?.dataset.tool;
      if (act === 'cancel') cancel();
      else if (act === 'done') done();
      else if (act === 'keep') hideConfirm();
      else if (act === 'discard') finish(null);
      else if (act === 'label-ok') closeLabel();
      else if (t === 'undo') undo();
      else if (t === 'redo') redo();
      else if (t === 'delete') remove();
      else if (t === 'group') doGroup();
      else if (t === 'label') (labelOpen ? closeLabel() : openLabel());
      else if (t === 'add') addCentered();
      else if (t === 'fit') pz.fit();
    }, opt);
    // The Android back button and Escape arrive as "cancel": ask before throwing changes away.
    dlg.addEventListener('cancel', e => { e.preventDefault(); if (performance.now() - escAt > 150) escape(); }, opt);

    // With the on-screen keyboard open, the editor fits what is left of the screen (the label stays in view).
    const vv = window.visualViewport;
    const fitScreen = () => {
      if (!vv) return;
      const on = Math.abs(vv.scale - 1) < 0.01;
      dlg.style.setProperty('--vvh', on ? vv.height + 'px' : '');
      dlg.style.setProperty('--vvt', on ? vv.offsetTop + 'px' : '');
    };
    vv?.addEventListener('resize', fitScreen, opt);
    vv?.addEventListener('scroll', fitScreen, opt);
    fitScreen();

    dlg.addEventListener('close', () => {
      // Closed some other way (Android back) with changes: keep the boxes rather than lose them.
      if (!closed && dirty() && hist.present.length) result = outcome();
      releaseBack('occ-editor');
      ac.abort();
      pz.destroy();
      clearTimeout(noteTimer);
      dlg.remove();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      resolve(result);
    }, { once: true });

    render();
  });
}
