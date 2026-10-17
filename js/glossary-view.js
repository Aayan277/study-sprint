// Your own glossary on the page (item 12): the terms on a Review card get a dotted underline, and a tap, Enter or a mouse hover opens a
// small popover with the definition. Loaded by review.js only when the glossary has terms (js/glossary.js has the matching).
//
//   underlineCard(flash, card)       underline the terms on both faces of the Review card (#flash)
//   underline(root, matcher, opts)   underline the terms in the text under root
//   glossaryNow()                    { entries, byId, matcher } for the current glossary (read once, again after a change)
//
// A term is only marked the first time it appears on a face, never inside a formula, button, link, input, blank, typed-answer
// comparison or picture-occlusion label, and on a front never when it is also in the answer (it would give it away).

import * as db from './db.js';
import { entriesFrom, buildMatcher, findTerms, termIdsIn } from './glossary.js';
import { formatHTML } from './format.js';
import { esc } from './ui.js';

const AVOID = 'button, input, textarea, select, a, script, style, .tex, .katex, .cloze-blank, .rv-typed, .flash-recap, .flash-deck, .flash-hint, .el-count, .step-try, .rv-speak, .gl-term, .gl-pop, [class*="occ-"], [contenteditable]';

// ---------- the glossary, read once ----------
let loaded = null;
export const forgetGlossary = () => { loaded = null; };
export function glossaryNow() {
  if (!loaded) {
    const mine = loaded = db.getSettings().then(settings => {
      const entries = entriesFrom(settings);
      return { entries, byId: new Map(entries.map(e => [e.id, e])), matcher: buildMatcher(entries), on: settings.glossaryUnderline !== false };
    });
    mine.catch(() => { if (loaded === mine) loaded = null; });          // a failed read is not kept: the next card tries again
  }
  return loaded;
}
// A change in the sheet, or a sync that brought other devices' terms.
addEventListener('glossary-changed', forgetGlossary);
addEventListener('sync', e => { if (e.detail?.state === 'done') forgetGlossary(); });

// ---------- underlining ----------
function textNodes(root) {
  const out = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.nodeValue.trim() && !n.parentElement.closest(AVOID) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n);
  return out;
}

export function underline(root, matcher, { skip = null } = {}) {
  if (!root || !matcher) return 0;
  const seen = new Set();
  let count = 0;
  for (const node of textNodes(root)) {
    const found = findTerms(node.nodeValue, matcher, { seen, skip });
    if (!found.length) continue;
    const text = node.nodeValue, frag = document.createDocumentFragment();
    let at = 0;
    for (const f of found) {
      if (f.start > at) frag.append(text.slice(at, f.start));
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'gl-term'; b.dataset.gl = f.entry.id;
      b.setAttribute('aria-haspopup', 'dialog');
      b.textContent = text.slice(f.start, f.end);
      frag.append(b);
      at = f.end; count++;
    }
    if (at < text.length) frag.append(text.slice(at));
    node.replaceWith(frag);
  }
  return count;
}

// The terms in each card's answer, kept for the glossary version they were found with (a card comes up again and again).
const answerTerms = new WeakMap();
let run = 0;
export async function underlineCard(flash, card) {
  closePop();
  const mine = ++run;
  const g = await glossaryNow();
  // (A newer card was drawn while this one waited: only the newest draw underlines, so a face is never underlined twice.)
  if (mine !== run || !g.on || !g.matcher || !flash?.isConnected || flash.querySelector('.gl-term')) return 0;
  // On the front, a term that is also in the answer is left alone (it would give the answer away).
  const back = String(card?.back ?? '');
  let cached = answerTerms.get(g.matcher);
  if (!cached) answerTerms.set(g.matcher, cached = new Map());
  let skip = cached.get(back);
  if (!skip) { skip = termIdsIn(back, g.matcher); if (cached.size > 500) cached.clear(); cached.set(back, skip); }
  return underline(flash.querySelector('.rv-front'), g.matcher, { skip }) + underline(flash.querySelector('.rv-back'), g.matcher);
}

// ---------- the popover ----------
let pop = null, popTerm = null, sticky = false, hoverTimer = 0, leaveTimer = 0;

export function closePop({ refocus = false } = {}) {
  clearTimeout(hoverTimer); clearTimeout(leaveTimer);
  const term = popTerm;
  pop?.remove();
  pop = null; popTerm = null; sticky = false;
  term?.removeAttribute('aria-expanded');
  if (refocus && term?.isConnected) term.focus({ preventScroll: true });
}

async function openPop(btn, { focus }) {
  if (popTerm === btn && pop) { if (focus) { sticky = true; pop.focus({ preventScroll: true }); } return; }
  closePop();
  const g = await glossaryNow();
  const entry = g.byId.get(btn.dataset.gl);
  if (!entry || !btn.isConnected) return;
  pop = document.createElement('div');
  pop.className = 'gl-pop'; pop.id = 'glPop';
  pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', entry.term); pop.tabIndex = -1;
  pop.innerHTML = `<b class="gl-pop-t">${esc(entry.term)}</b>
    <div class="gl-pop-d">${entry.def ? formatHTML(entry.def) : '<i>No definition yet.</i>'}</div>
    <button type="button" class="link gl-edit" data-gl-edit="${esc(entry.id)}">Edit</button>`;
  document.body.append(pop);
  popTerm = btn; sticky = !!focus;
  btn.setAttribute('aria-expanded', 'true');
  btn.setAttribute('aria-controls', 'glPop');
  place(btn);
  if (focus) pop.focus({ preventScroll: true });
}

// Under the word, or over it when there is no room; never off the sides of the screen.
function place(btn) {
  const r = btn.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = innerHeight, m = 8;
  const w = Math.min(pop.offsetWidth, vw - 2 * m), h = pop.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > vh - m && r.top - h - 6 > m) top = r.top - h - 6;
  const left = Math.max(m, Math.min(r.left, vw - w - m));
  pop.style.top = `${Math.max(m, top)}px`; pop.style.left = `${left}px`;
}

document.addEventListener('click', e => {
  const t = e.target.closest?.('.gl-term');
  if (t) { e.preventDefault(); if (pop && popTerm === t && sticky) closePop(); else openPop(t, { focus: true }); return; }
  const edit = e.target.closest?.('[data-gl-edit]');
  if (edit) {
    const id = edit.dataset.glEdit;
    closePop();
    import('./glossary-sheet.js').then(m => m.openTermForm({ id })).catch(err => console.error(err));
    return;
  }
  if (pop && !e.target.closest('.gl-pop')) closePop();
});
// Escape closes it and gives the focus back to the word.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && pop) { e.preventDefault(); e.stopPropagation(); closePop({ refocus: true }); }
  // Space or Enter on the popover itself closes it (on its Edit button they press the button, as usual).
  else if ((e.key === ' ' || e.key === 'Enter') && pop && e.target === pop) { e.preventDefault(); e.stopPropagation(); closePop({ refocus: true }); }
}, true);
// A mouse resting on a word for 300 ms shows it too (and it goes again when the mouse leaves, unless it was opened by a tap or key).
document.addEventListener('mouseover', e => {
  if (!matchMedia('(hover: hover)').matches) return;
  const t = e.target.closest?.('.gl-term');
  if (t) { clearTimeout(leaveTimer); clearTimeout(hoverTimer); hoverTimer = setTimeout(() => openPop(t, { focus: false }), 300); return; }
  if (e.target.closest?.('.gl-pop')) clearTimeout(leaveTimer);
});
document.addEventListener('mouseout', e => {
  if (!e.target.closest?.('.gl-term, .gl-pop')) return;
  clearTimeout(hoverTimer);
  if (!sticky && pop) { clearTimeout(leaveTimer); leaveTimer = setTimeout(() => { if (!sticky) closePop(); }, 220); }
});
addEventListener('hashchange', () => closePop());
addEventListener('resize', () => closePop());
addEventListener('scroll', () => { if (!sticky) closePop(); }, true);
