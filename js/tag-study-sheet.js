// The "Study by tag or question ID" sheet (loaded when first needed; it is in the service worker's CORE list).
// Opened from Today > Options > Custom study and from Browse > Tools. It looks in all decks.
//   Question IDs  paste the IDs of the questions you missed in a question bank (UWorld, AMBOSS...); the cards whose tag
//                 ends in one of them are found (tag-tree.js matchIds)
//   Tag           pick a tag, or a folder of "::" tags, from the tree
// Then "Unsuspend" puts the cards back in your reviews, and "Study now" unsuspends them and starts a session with just them.

import * as db from './db.js';
import { isSuspended } from './browse-logic.js';
import { tagTree, tagTreeHTML, wireTagTree, parseIdsDetailed, matchIds, cardsUnder, crumbs, pieces } from './tag-tree.js';
import { openSheet, closeSheet, esc, plural, toast, $ } from './ui.js';

const MISSING_SHOWN = 20;
const n0 = n => n.toLocaleString('en');

// "183 cards (120 suspended)", with the leeches noted.
export function countsText(cards) {
  const susp = cards.filter(isSuspended);
  const leeches = susp.filter(c => (c.tags || []).includes('leech')).length;
  return `${plural(cards.length, 'card')}${susp.length ? ` (${n0(susp.length)} suspended${leeches ? `, ${leeches} ${leeches === 1 ? 'is a leech' : 'are leeches'}` : ''})` : ''}`;
}

// onChange runs after cards were unsuspended (the screen behind redraws). returnFocus: id of the button to focus on close.
export async function openTagStudySheet({ onChange = () => {}, returnFocus = '' } = {}) {
  let cards = await db.getAll('cards');
  const tree = tagTree(cards);
  const tagged = cards.some(c => (c.tags || []).length);
  if (!tagged) {
    openSheet(`
      <h2 id="sheetTitle">Study by tag or question ID</h2>
      <p class="note">No cards have tags yet. Anki decks like AnKing bring their tags.</p>
      <div class="sheet-actions"><button class="btn primary" type="button" id="tsClose">Close</button></div>`);
    $('tsClose').addEventListener('click', closeSheet);
    return;
  }

  let tab = 'ids', look = '', picked = '', pickedLabel = '';
  let sel = { cards: [], label: '' };            // what the footer buttons act on
  // Every tag path, for searching the Tag tab.
  const allPaths = [];
  const walk = list => list.forEach(n => { allPaths.push(n); walk(n.children); });
  walk(tree);

  openSheet(`
    <h2 id="sheetTitle">Study by tag or question ID</h2>
    <p class="note" style="margin-top:0">In all decks.</p>
    <div class="chips" role="group" aria-label="Find cards by">
      <button type="button" class="tchip" data-tab="ids" aria-pressed="true">Question IDs</button>
      <button type="button" class="tchip" data-tab="tag" aria-pressed="false">Tag</button>
    </div>
    <div id="tsIds" class="ts-pane">
      <label class="field"><span>Paste question IDs</span>
        <textarea id="tsText" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false"
          placeholder="For example 12345, 23456 34567: copy them from your UWorld or AMBOSS block"></textarea></label>
      <label class="field" id="tsLookWrap" hidden><span>Look in</span><select id="tsLook" class="select"></select></label>
      <div class="ts-missing" id="tsMissing" hidden></div>
    </div>
    <div id="tsTag" class="ts-pane" hidden>
      <label class="field"><span>Search tags</span><input id="tsSearch" type="search" autocomplete="off" autocapitalize="off" placeholder="For example uworld"></label>
      <div id="tsTreeBox" class="ts-tree"></div>
    </div>
    <p class="ts-result" id="tsResult" role="status" aria-live="polite"></p>
    <div class="sheet-actions">
      <button class="btn ghost" type="button" id="tsUnsus" disabled>Unsuspend</button>
      <button class="btn primary" type="button" id="tsStudy" disabled>Study now</button>
    </div>`);
  const sheet = $('sheet');
  if (returnFocus) sheet.addEventListener('close', () => document.getElementById(returnFocus)?.focus(), { once: true });

  // ----- the footer: what the buttons would act on -----
  const setSel = (list, label) => {
    sel = { cards: list, label };
    const susp = list.filter(isSuspended).length;
    $('tsUnsus').textContent = susp ? `Unsuspend ${n0(susp)}` : 'Unsuspend';
    $('tsUnsus').disabled = !susp;
    $('tsStudy').textContent = list.length ? `Study ${n0(list.length)} now` : 'Study now';
    $('tsStudy').disabled = !list.length;
  };

  // ----- Question IDs -----
  const drawIds = () => {
    const { ids, ignored } = parseIdsDetailed($('tsText').value);
    const res = $('tsResult');
    const skip = ignored.length ? `<span class="ts-ignored">Ignored: ${esc(ignored.slice(0, MISSING_SHOWN).join(', '))}${ignored.length > MISSING_SHOWN ? ` + ${ignored.length - MISSING_SHOWN} more` : ''}</span>` : '';
    if (!ids.length) {
      res.innerHTML = skip;
      $('tsLookWrap').hidden = true; $('tsMissing').hidden = true;
      setSel([], '');
      return;
    }
    const all = matchIds(cards, ids);
    if (!all.sources.some(s => s.path === look)) look = all.sources[0]?.path ?? '';
    const m = all.sources.length > 1 ? matchIds(cards, ids, { under: look }) : all;
    // The "Look in" choice appears when the matches are under more than one folder (more than one question bank).
    $('tsLookWrap').hidden = all.sources.length < 2;
    if (all.sources.length > 1) {
      $('tsLook').innerHTML = all.sources.map(s => `<option value="${esc(s.path)}" ${s.path === look ? 'selected' : ''}>${esc(crumbs(s.path) || '(no folder)')} (${plural(s.ids.length, 'ID')})</option>`).join('');
    }
    res.innerHTML = `<b>Found ${n0(m.found.length)} of ${n0(ids.length)} IDs</b>${m.cards.length ? ` · ${esc(countsText(m.cards))}` : ''}${skip ? `<br>${skip}` : ''}`;
    const miss = m.missing;
    $('tsMissing').hidden = !miss.length;
    if (miss.length) {
      $('tsMissing').innerHTML = `<span>Not found: ${esc(miss.slice(0, MISSING_SHOWN).join(', '))}${miss.length > MISSING_SHOWN ? ` + ${miss.length - MISSING_SHOWN} more` : ''}</span>
        <button class="btn ghost small" type="button" id="tsCopy">Copy</button>`;
      $('tsCopy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(miss.join(', ')); toast('Copied the IDs that were not found'); } catch { toast("Couldn't copy. Select the IDs and copy them."); }
      });
    }
    setSel(m.cards, 'Question IDs');
  };
  let typing = 0;
  $('tsText').addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(drawIds, 120); });
  $('tsLook').addEventListener('change', e => { look = e.target.value; drawIds(); });

  // ----- Tag -----
  const drawPick = () => {
    const res = $('tsResult');
    if (!picked) { res.textContent = ''; setSel([], ''); return; }
    const list = cardsUnder(cards, picked).sort((a, b) => a.created - b.created);
    res.innerHTML = `<b>${esc(crumbs(picked))}</b> · ${esc(countsText(list))}`;
    setSel(list, `Tag: ${pieces(picked).pop()}`);
  };
  const pick = path => { picked = path; drawPick(); };
  const drawTree = () => {
    const q = $('tsSearch').value.trim().toLowerCase();
    const box = $('tsTreeBox');
    if (!q) {
      box.innerHTML = tagTreeHTML(tree, { mode: 'pick' });
      return;
    }
    const matching = allPaths.filter(n => n.path.includes(q)), hits = matching.slice(0, 50);
    box.innerHTML = hits.length
      ? `<ul class="tag-tree">${hits.map(n => `<li class="tag-leaf" data-path="${esc(n.path)}"><div class="tf-row"><span class="tf-leaf"><span class="tag-name">${esc(crumbs(n.path))}</span><span class="muted small">${n0(n.count)} ${n.count === 1 ? 'card' : 'cards'}</span></span>
          <span class="tf-acts"><button class="btn ghost small" type="button" data-tf-pick>Choose</button></span></div></li>`).join('')}</ul>${matching.length > 50 ? '<p class="note">Showing the first 50. Type more to narrow it down.</p>' : ''}`
      : '<p class="note">No tags match.</p>';
  };
  // One listener for the tree, and for the search results that replace it.
  wireTagTree($('tsTreeBox'), tree, { mode: 'pick', on: { pick } });
  $('tsSearch').addEventListener('input', drawTree);
  drawTree();

  // ----- the tabs -----
  sheet.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    sheet.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    $('tsIds').hidden = tab !== 'ids'; $('tsTag').hidden = tab !== 'tag';
    if (tab === 'ids') drawIds(); else drawPick();
  }));

  // ----- the buttons -----
  const unsuspend = async () => {
    // The cards are read again, so an edit made since the sheet opened is kept (and one deleted meanwhile is skipped).
    const ids = new Set(sel.cards.filter(isSuspended).map(c => c.id));
    if (!ids.size) return 0;
    const hidden = (await db.getAll('cards')).filter(c => ids.has(c.id) && isSuspended(c));
    if (!hidden.length) return 0;
    await db.saveCards(hidden.map(c => ({ ...c, suspended: false })));
    const done = new Set(hidden.map(c => c.id));
    cards = cards.map(c => (done.has(c.id) ? { ...c, suspended: false } : c));
    sel = { ...sel, cards: sel.cards.map(c => (done.has(c.id) ? { ...c, suspended: false } : c)) };
    return hidden.length;
  };
  $('tsUnsus').addEventListener('click', async () => {
    $('tsUnsus').disabled = $('tsStudy').disabled = true;
    const n = await unsuspend();
    toast(`Unsuspended ${plural(n, 'card')}. New ones join your daily new cards.`);
    if (tab === 'ids') drawIds(); else drawPick();
    onChange();
  });
  $('tsStudy').addEventListener('click', async () => {
    $('tsUnsus').disabled = $('tsStudy').disabled = true;
    const { cards: list, label } = sel;
    const n = await unsuspend();
    closeSheet();
    onChange();
    try {
      const { startStudy } = await import('./today.js');
      await startStudy({ kind: 'ids', cardIds: list.map(c => c.id), includeSuspended: true, spread: true, label });
    } catch { toast("Couldn't start the session. Check your connection and try again."); return; }
    // "Start over?" may be asking about a session in progress: then nothing has started yet.
    const started = !$('sheet').open;
    // Review turns focus mode on when it has drawn, and that hides any toast: wait for it so the message stays up.
    if (started) for (let i = 0; i < 40 && !document.body.classList.contains('focus'); i++) await new Promise(r => setTimeout(r, 100));
    if (n) toast(`Unsuspended ${plural(n, 'card')}${started && document.body.classList.contains('focus') ? ' and started a session' : ''}.`);
  });

  $('tsText').focus();
}
