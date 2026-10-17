// Managing your own glossary (item 12): the list (search, edit, delete), the Add / Edit form, and "Paste a list".
// Loaded only when a sheet is opened (Settings → Study → Glossary, Review's card menu "Add to glossary", or Edit in a definition).
//
//   openGlossary()            the list
//   openTermForm(opts)        the form: { id } edits that term; { term, def } starts a new one; { back: 'list' | 'close' } where Save goes
//   openPasteList()           add many terms at once from "term - definition" lines
//   termCount(settings)       how many terms a settings object holds

import * as db from './db.js';
import { openSheet, closeSheet, toast, esc, $, plural } from './ui.js';
import { randomId } from './sync-data.js';
import { entriesFrom, cleanEntry, GLOSS_PREFIX, LIMITS } from './glossary.js';
import { parseGlossaryList } from './glossary-list.js';
import { dupKey } from './import.js';

export const termCount = settings => entriesFrom(settings).length;
const changed = () => dispatchEvent(new Event('glossary-changed'));
const SHOWN = 100;           // rows drawn at once (search for the rest)

const firstLine = def => String(def || '').split('\n').find(l => l.trim())?.trim() || '';

// ---------- the list ----------
export async function openGlossary() {
  const entries = entriesFrom(await db.getSettings());
  const full = entries.length >= LIMITS.terms;
  openSheet(`
    <h2 id="sheetTitle">Glossary</h2>
    <p class="note" id="glCount"></p>
    <input type="search" id="glSearch" class="gl-search" placeholder="Search terms" aria-label="Search terms" autocomplete="off" ${entries.length ? '' : 'hidden'}>
    <div class="gl-list" id="glList"></div>
    <div class="sheet-actions">
      <button class="btn ghost" type="button" id="glPaste" ${full ? 'disabled' : ''}>Paste a list</button>
      <button class="btn primary" type="button" id="glAdd" ${full ? 'disabled' : ''}>+ Add term</button>
    </div>`);
  const draw = () => {
    const q = dupKey($('glSearch').value);
    const hit = q ? entries.filter(e => [e.term, ...e.aliases].some(t => dupKey(t).includes(q))) : entries;
    $('glCount').textContent = entries.length
      ? `${plural(entries.length, 'term')}. Each is underlined the first time it appears on a card, with its definition a tap away.`
      : 'Define a term once and it’s underlined on every card, with its definition a tap away.';
    $('glList').innerHTML = hit.slice(0, SHOWN).map(e => `
      <div class="gl-row" data-id="${esc(e.id)}">
        <div class="gl-row-t"><b>${esc(e.term)}</b>${e.def ? `<span>${esc(firstLine(e.def))}</span>` : '<span class="gl-none">No definition</span>'}</div>
        <button type="button" class="link" data-gl-edit-row="${esc(e.id)}" aria-label="Edit ${esc(e.term)}">Edit</button>
        <button type="button" class="link gl-del" data-gl-del="${esc(e.id)}" aria-label="Delete ${esc(e.term)}">Delete</button>
      </div>`).join('') + (hit.length > SHOWN ? `<p class="note">Showing ${SHOWN} of ${hit.length}. Search to find the others.</p>` : '')
      + (q && !hit.length ? '<p class="note">No term matches.</p>' : '');
  };
  draw();
  $('glSearch').addEventListener('input', draw);
  $('glAdd').addEventListener('click', () => openTermForm({ back: 'list' }));
  $('glPaste').addEventListener('click', () => openPasteList());
  $('glList').addEventListener('click', async e => {
    const edit = e.target.closest('[data-gl-edit-row]');
    if (edit) { openTermForm({ id: edit.dataset.glEditRow, back: 'list' }); return; }
    const del = e.target.closest('[data-gl-del]');
    if (!del) return;
    // Two taps: the first asks, the second deletes.
    if (del.dataset.sure !== '1') {
      del.dataset.sure = '1'; del.textContent = 'Sure? Delete';
      setTimeout(() => { if (del.isConnected) { del.dataset.sure = ''; del.textContent = 'Delete'; } }, 3000);
      return;
    }
    const id = del.dataset.glDel, gone = entries.findIndex(x => x.id === id);
    if (gone < 0) return;
    const [removed] = entries.splice(gone, 1);
    await db.setSetting(GLOSS_PREFIX + id, null);
    changed();
    draw();
    toast(`Deleted “${removed.term}”`);
  });
}

// ---------- the form ----------
// → true when saved
export async function openTermForm({ id = null, term = '', def = '', back = 'close' } = {}) {
  const entries = entriesFrom(await db.getSettings());
  const mine = id ? entries.find(e => e.id === id) : null;
  if (id && !mine) { toast('That term is gone.'); return false; }
  const start = mine || { term: String(term).trim().slice(0, LIMITS.term), aliases: [], def };
  const full = !mine && entries.length >= LIMITS.terms;
  openSheet(`
    <h2 id="sheetTitle">${mine ? 'Edit term' : 'Add term'}</h2>
    <form id="glForm" class="sheet-in" style="padding:0" autocomplete="off">
      <label class="field"><span>Term</span><input id="glTerm" type="text" maxlength="${LIMITS.term}" value="${esc(start.term)}" required></label>
      <label class="field"><span>Other spellings (optional, separated by commas)</span><input id="glAlias" type="text" value="${esc(start.aliases.join(', '))}" placeholder="e.g. adenosine triphosphate"></label>
      <label class="field"><span>Definition</span><textarea id="glDef" rows="4" maxlength="${LIMITS.def}" placeholder="What it means, in your own words">${esc(start.def)}</textarea></label>
      <p class="note" id="glWarn" role="status">${full ? `Your glossary is full (${LIMITS.terms.toLocaleString('en')} terms). Delete one to add another.` : ''}</p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="glCancel">Cancel</button>
        <button class="btn primary" type="submit" ${full ? 'disabled' : ''}>Save</button>
      </div>
    </form>`);
  const readAliases = () => $('glAlias').value.split(',').map(a => a.trim()).filter(Boolean);
  // A spelling that another term already has: the form says so (the longer or first-defined one wins when matching).
  const warn = () => {
    if (full) return;
    const others = entries.filter(e => e.id !== id);
    const taken = [$('glTerm').value, ...readAliases()].map(t => t.trim()).filter(Boolean)
      .filter(t => others.some(e => [e.term, ...e.aliases].some(x => dupKey(x) === dupKey(t))));
    $('glWarn').textContent = taken.length ? `“${taken[0]}” is already a term.` : '';
  };
  $('glTerm').addEventListener('input', warn);
  $('glAlias').addEventListener('input', warn);
  warn();
  const leave = () => { if (back === 'list') openGlossary(); else closeSheet(); };
  $('glCancel').addEventListener('click', leave);
  const saved = new Promise(done => {
    $('glForm').addEventListener('submit', async e => {
      e.preventDefault();
      if (full) return;
      const entry = cleanEntry({ term: $('glTerm').value, aliases: readAliases(), def: $('glDef').value, at: Date.now() });
      if (!entry) { $('glWarn').textContent = 'Type the term first.'; $('glTerm').focus(); return; }
      await db.setSetting(GLOSS_PREFIX + (id || randomId()), entry);
      changed();
      toast(mine ? `Saved “${entry.term}”` : `Added “${entry.term}”`);
      leave();
      done(true);
    });
  });
  $('glTerm').focus({ preventScroll: true });
  return saved;
}

// ---------- paste a list ----------
export async function openPasteList() {
  const entries = entriesFrom(await db.getSettings());
  openSheet(`
    <h2 id="sheetTitle">Paste a list</h2>
    <form id="glPasteForm" class="sheet-in" style="padding:0">
      <label class="field"><span>One term per line, like “ATP - the cell’s energy currency”</span>
        <textarea id="glPasteIn" rows="8" placeholder="ATP - the cell’s energy currency&#10;Osmosis - water moving across a membrane" spellcheck="false"></textarea></label>
      <p class="note" id="glPasteInfo" role="status"></p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="glPasteBack">Back</button>
        <button class="btn primary" type="submit" id="glPasteGo" disabled>Add terms</button>
      </div>
    </form>`);
  let plan = null;
  const update = () => {
    plan = parseGlossaryList($('glPasteIn').value, entries);
    const { items, already, skipped, over } = plan;
    const bits = [];
    if (!$('glPasteIn').value.trim()) bits.push('Paste your list above.');
    else {
      bits.push(`Adds ${plural(items.length, 'term')}.`);
      if (already) bits.push(`${already} ${already === 1 ? 'is' : 'are'} already in your glossary and ${already === 1 ? 'stays' : 'stay'} as ${already === 1 ? 'it is' : 'they are'}.`);
      if (skipped) bits.push(`${plural(skipped, 'line')} without a definition ${skipped === 1 ? 'is' : 'are'} left out.`);
      if (over) bits.push(`${over} don’t fit: a glossary holds ${LIMITS.terms.toLocaleString('en')} terms.`);
    }
    $('glPasteInfo').textContent = bits.join(' ');
    $('glPasteGo').disabled = !items.length;
    $('glPasteGo').textContent = items.length ? `Add ${plural(items.length, 'term')}` : 'Add terms';
  };
  update();
  $('glPasteIn').addEventListener('input', update);
  $('glPasteBack').addEventListener('click', () => openGlossary());
  $('glPasteForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!plan?.items.length) return;
    $('glPasteGo').disabled = true;
    const at = Date.now();
    for (const [i, it] of plan.items.entries()) {
      const entry = cleanEntry({ term: it.term, aliases: [], def: it.def, at: at + i });
      if (entry) await db.setSetting(GLOSS_PREFIX + randomId(), entry);
    }
    changed();
    toast(`Added ${plural(plan.items.length, 'term')}`);
    openGlossary();
  });
  $('glPasteIn').focus({ preventScroll: true });
}
