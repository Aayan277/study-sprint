// The Import screen: paste text, upload a file or load a Google Sheet, check the cards in an
// editable preview, then save them into a deck. The actual format detection lives in import.js.

import * as db from './db.js';
import { parseText, parseRows, buildCards, isComplete, findDuplicates, sheetsCsvUrl, claudePrompt } from './import.js';
import { notesToImport, onlyDeck, deckList, replayHistory, subdeckPaths } from './anki.js';
import { clozeCard, withClozeLines, hasClozeLines } from './cloze.js';
import { formatHTML } from './format.js';
import { hasMath } from './math.js';
import { toFractions, occFrontBack, groupsOf, groupIndex, validOcclusion, MAX_HEADER } from './occlusion.js';
import { deckChoices, subtreeIds, effectiveDeck } from './deck-tree.js';
import { deckSchedulerOptions } from './sched-settings.js';
import { examOptions } from './exam.js';
import { DECK_COLORS } from './decks.js';
import { FIRST_REVIEW_KEY } from './onboarding.js';
import { $, esc, plural, toast, icon } from './ui.js';

// SheetJS reads Excel files. It's big, so it only downloads when someone picks an .xlsx file.
const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
const NEW_DECK = '__new';
const MAX_SHOWN = 300;   // rows drawn in the preview; more than this would make phones sluggish
const LAST_DECK = 'study-sprint-import-deck';     // the deck the last import went into (this device)
const lastDeck = () => { try { return localStorage.getItem(LAST_DECK) || ''; } catch { return ''; } };
const rememberDeck = id => { try { localStorage.setItem(LAST_DECK, id); } catch { /* fine */ } };

// Everything the screen is working with.
let S = null;

// arg: a deck id, optionally followed by "/file" to open on the File tab (the first-run start does this).
export async function renderImport(el, arg) {
  const [deckId, firstTab] = String(arg || '').split('/');
  const decks = (await db.getDecks()).sort((a, b) => a.created - b.created);
  S = {
    result: null,          // what import.js detected
    cards: [],             // [{ front, back }] as shown in the preview, including any edits
    flags: [],             // duplicate flag per card: 'deck', 'import' or null
    frontCol: 0, backCol: 1,
    // The deck in the address, otherwise the one the last import went into (if it still exists), otherwise a new deck.
    deckId: decks.some(d => d.id === deckId) ? deckId : decks.some(d => d.id === lastDeck()) ? lastDeck() : NEW_DECK,
    deckFronts: [],        // fronts already in the chosen deck, for duplicate checks
    suggestedName: '',     // a deck name taken from the file name
    noCloze: false         // "Keep {{c1::…}} lines as plain cards" was pressed (until the text changes)
  };

  el.innerHTML = `
    <button class="back" type="button" id="back">‹ ${decks.some(d => d.id === deckId) ? 'Deck' : 'Decks'}</button>
    <div class="screen-head"><div><h1>Add cards</h1></div></div>

    <section class="section">
      <label class="field"><span>Add to deck</span>
        <select id="deckSel">
          ${deckChoices(decks).map(d => `<option value="${esc(d.id)}" ${d.id === S.deckId ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}
          <option value="${NEW_DECK}" ${S.deckId === NEW_DECK ? 'selected' : ''}>+ New deck…</option>
        </select></label>
      <label class="field" id="newNameRow" ${S.deckId === NEW_DECK ? '' : 'hidden'}><span>Name for the new deck</span>
        <input id="newName" maxlength="80" placeholder="e.g. Cell Biology" autocomplete="off"></label>
    </section>

    <div class="seg" role="tablist" aria-label="Where the cards come from">
      <button type="button" role="tab" id="tab-paste" aria-selected="true" aria-controls="pane-paste">Paste</button>
      <button type="button" role="tab" id="tab-file" aria-selected="false" aria-controls="pane-file">File</button>
      <button type="button" role="tab" id="tab-sheet" aria-selected="false" aria-controls="pane-sheet">Google Sheets</button>
    </div>

    <section class="pane" id="pane-paste" role="tabpanel" aria-labelledby="tab-paste">
      <textarea id="pasteBox" rows="8" spellcheck="false" aria-label="Paste your cards or notes"
        placeholder="Paste cards, one per line:&#10;Mitosis - cell division into 2 identical cells&#10;Meiosis - division into 4 gametes&#10;&#10;Tabs, | : = and commas work too, as do Quizlet exports and tables from Notion."></textarea>
      <div class="pane-actions">
        <button class="btn ghost small" type="button" id="claudeBtn">Make cards with Claude</button>
        <button class="btn ghost small" type="button" id="clearBtn">Clear</button>
      </div>
      <p class="note" id="claudeNote" hidden>Copied a prompt with your notes. Paste it into a chat at <a href="https://claude.ai/new" target="_blank" rel="noopener">claude.ai</a>, then paste Claude's answer back in the box above (replacing your notes).</p>
    </section>

    <section class="pane" id="pane-file" role="tabpanel" aria-labelledby="tab-file" hidden>
      <label class="drop">
        <input type="file" id="fileIn" accept=".csv,.tsv,.txt,.xlsx,.xls,.json,.apkg,.colpkg,text/csv,text/plain,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel">
        <b>Choose a file</b><span class="muted">.csv, .tsv, .txt, Excel (.xlsx) or an Anki deck (.apkg)</span>
        <span class="mono" id="fileName"></span>
      </label>
      <label class="field" id="sheetPickRow" hidden style="margin-top:12px"><span id="sheetPickLbl">Sheet</span><select id="sheetPick"></select></label>
    </section>

    <section class="pane" id="pane-sheet" role="tabpanel" aria-labelledby="tab-sheet" hidden>
      <form id="sheetForm" class="row-form">
        <input id="sheetUrl" type="url" inputmode="url" placeholder="https://docs.google.com/spreadsheets/d/…" aria-label="Google Sheets link">
        <button class="btn primary small" type="submit">Load</button>
      </form>
      <p class="note">In Google Sheets, tap <b>Share</b> and set it to <b>Anyone with the link</b> (or use File → Share → Publish to web), then paste the link here. Column A becomes the front and column B the back; you can change that below.</p>
    </section>

    <p class="err" id="loadErr" role="alert" hidden></p>
    <p class="note" id="readyMade"><a href="#/decks/starters">Ready-made decks</a> (JLPT kanji) are in Decks → Starter decks.</p>

    <section id="preview" class="section" hidden aria-labelledby="pvTitle">
      <h2 id="pvTitle" style="margin-top:22px">Preview</h2>
      <p class="found" id="found" aria-live="polite"></p>
      <div class="cols" id="cols" hidden>
        <label class="field"><span>Front</span><select id="frontCol"></select></label>
        <label class="field"><span>Back</span><select id="backCol"></select></label>
      </div>
      <label class="adv-row switch-row prog-row" id="progRow" hidden><span><b>Bring over my Anki progress</b>
        <span id="progInfo"></span></span>
        <input id="ankiProg" type="checkbox" class="switch" checked></label>
      <label class="adv-row switch-row prog-row" id="subRow" hidden><span><b>Keep Anki's subdecks</b>
        <span id="subInfo"></span></span>
        <input id="ankiSubs" type="checkbox" class="switch" checked></label>
      <div class="pane-actions">
        <button class="btn ghost small" type="button" id="swapBtn">${icon('swap')} Swap front and back</button>
        <button class="btn ghost small" type="button" id="dupBtn" hidden>Remove duplicates</button>
      </div>
      <p class="note" id="clozeNote" hidden><button class="link" type="button" id="clozeToggle"></button></p>
      <ol class="plist" id="plist"></ol>
      <p class="note" id="moreNote" hidden></p>
    </section>

    <div class="savebar" id="savebar" hidden>
      <p class="save-hint" id="saveHint" hidden>Name the new deck above</p>
      <button class="btn primary" type="button" id="saveBtn">Add cards</button>
    </div>`;

  $('back').addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = '#/decks'));
  wireDeckPicker();
  wireTabs();
  wirePaste();
  wireFile();
  wireSheet();
  wirePreview();
  if (firstTab === 'file') $('tab-file').click();
  await loadDeckFronts();
}

// ---------- choosing the deck ----------
function wireDeckPicker() {
  $('newName').addEventListener('input', refreshFlags);        // the save button names the deck
  $('deckSel').addEventListener('change', async e => {
    S.deckId = e.target.value;
    $('newNameRow').hidden = S.deckId !== NEW_DECK;
    if (S.deckId === NEW_DECK && !$('newName').value) $('newName').value = S.suggestedName;
    await loadDeckFronts();
    refreshFlags();
  });
}
async function loadDeckFronts() {
  // Duplicates are checked against the deck and its subdecks.
  if (S.deckId === NEW_DECK) { S.deckFronts = []; return; }
  const inside = subtreeIds(await db.getDecks(), S.deckId);
  S.deckFronts = (await db.getAll('cards')).filter(c => inside.has(c.deckId)).map(c => c.front);
}

// ---------- Paste / File / Google Sheets tabs ----------
function wireTabs() {
  const tabs = ['paste', 'file', 'sheet'];
  tabs.forEach(t => $(`tab-${t}`).addEventListener('click', () => {
    tabs.forEach(x => {
      $(`tab-${x}`).setAttribute('aria-selected', String(x === t));
      $(`pane-${x}`).hidden = x !== t;
    });
  }));
}

// ---------- paste box ----------
function wirePaste() {
  let timer = 0;
  // Re-detect shortly after typing or pasting stops.
  $('pasteBox').addEventListener('input', () => {
    clearTimeout(timer);
    S.noCloze = false;                 // new text: cloze lines count again
    timer = setTimeout(() => showText($('pasteBox').value), 250);
  });
  $('clearBtn').addEventListener('click', () => {
    clearTimeout(timer);
    $('pasteBox').value = '';
    showResult(null);
    $('pasteBox').focus();
  });
  $('claudeBtn').addEventListener('click', async () => {
    const ok = await copyText(claudePrompt($('pasteBox').value));
    if (ok) { $('claudeNote').hidden = false; toast('Prompt copied'); }
    else toast("Couldn't copy. Your browser blocked it.");
  });
}

// Pasted or loaded text: lines with blanks like {{c1::answer}} become cloze notes along with the other cards, unless the
// "Keep … as plain cards" link was pressed.
function showText(text) {
  S.pasted = text;
  showResult(S.noCloze ? parseText(text) : withClozeLines(text, parseText).result, false, text);
}

// Copy to the clipboard, with an older fallback for browsers that block the modern way.
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* try the fallback */ }
  const t = document.createElement('textarea');
  t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
  document.body.appendChild(t); t.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  t.remove();
  return ok;
}

// ---------- file upload ----------
function wireFile() {
  $('fileIn').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    $('fileName').textContent = file.name;
    suggestName(file.name.replace(/\.[^.]+$/, ''));
    $('sheetPickRow').hidden = true;
    try {
      if (/\.xlsx?$/i.test(file.name)) await readExcel(file);
      else if (/\.(apkg|colpkg)$/i.test(file.name)) await readAnki(file);
      else if (/\.json$/i.test(file.name)) {
        // A whole-app backup is restored from Settings (it replaces everything), not added as cards.
        let data = null;
        try { data = JSON.parse(await file.text()); } catch (e) { /* not JSON */ }
        showError(db.checkBackup(data) ? "That .json file isn't a Study Sprint backup. Use .csv, .txt or Excel files for cards."
          : 'This is a full Study Sprint backup. Restore it from Settings → Restore (it replaces everything on this device).');
      }
      else { S.noCloze = false; showText(await file.text()); }
    } catch (err) {
      console.error(err);
      const anki = /\.(apkg|colpkg)$/i.test(file.name);
      showError(`Couldn't read ${file.name}. ${!navigator.onLine ? `${anki ? 'Anki' : 'Excel'} files need an internet connection the first time.`
        : anki ? 'Is it an Anki deck exported from Anki (File → Export → Anki Deck Package)?' : 'Is it a .csv, .txt or .xlsx file?'}`);
    }
  });
}

async function readExcel(file) {
  $('found').textContent = '';
  const XLSX = await import(SHEETJS_URL);
  const book = XLSX.read(await file.arrayBuffer());
  // Each sheet as rows of cell text.
  const sheetRows = name => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: false, defval: '' });
  $('sheetPickLbl').textContent = 'Sheet';
  const names = book.SheetNames.filter(n => sheetRows(n).length);
  if (!names.length) { showError('That spreadsheet is empty.'); return; }
  if (names.length > 1) {
    $('sheetPick').innerHTML = names.map(n => `<option>${esc(n)}</option>`).join('');
    $('sheetPickRow').hidden = false;
    $('sheetPick').onchange = () => showResult(parseRows(sheetRows($('sheetPick').value)));
  }
  showResult(parseRows(sheetRows(names[0])));
}

// Anki deck files (.apkg): see anki-read.js and anki.js. Cards come in as new cards, with their tags;
// formatting, images and sounds are left out.
async function readAnki(file) {
  $('found').textContent = '';
  $('fileName').textContent = `${file.name} · reading…`;
  const { readAnkiFile } = await import('./anki-read.js');
  const { notes, models, reviews, media } = await readAnkiFile(file);
  const all = notesToImport(notes, models, reviews);
  S.ankiMedia = media;                 // the file's pictures, unpacked when the cards are added
  $('fileName').textContent = file.name;
  if (!all.rows.length) { showError('That Anki file has no cards in it.'); return; }
  // Several Anki decks inside: let the user pick one, or take them all.
  const decks = deckList(all);
  if (decks.length > 1) {
    $('sheetPickLbl').textContent = 'Anki deck';
    $('sheetPick').innerHTML = `<option value="">All decks (${all.rows.length})</option>` +
      decks.map(d => `<option value="${esc(d.name)}">${esc(d.name.split('::').join(' › '))} (${d.count})</option>`).join('');
    $('sheetPickRow').hidden = false;
    $('sheetPick').onchange = () => showResult(onlyDeck(all, $('sheetPick').value));
  }
  showResult(all);
}

// ---------- Google Sheets ----------
function wireSheet() {
  $('sheetForm').addEventListener('submit', async e => {
    e.preventDefault();
    const url = sheetsCsvUrl($('sheetUrl').value);
    if (!url) { showError("That doesn't look like a Google Sheets link. It should start with https://docs.google.com/spreadsheets/"); return; }
    const btn = e.submitter || $('sheetForm').querySelector('button');
    btn.disabled = true; btn.textContent = 'Loading…';
    try {
      const res = await fetch(url);
      const text = await res.text();
      // A private sheet sends back a Google sign-in page (HTML) instead of CSV.
      if (!res.ok || /^\s*</.test(text)) throw new Error('not shared');
      S.noCloze = false; showText(text);
    } catch (err) {
      showError(navigator.onLine
        ? "Couldn't load that sheet. Check it's shared as \"Anyone with the link\" or published to the web."
        : "You're offline. Loading a Google Sheet needs internet.");
    } finally {
      btn.disabled = false; btn.textContent = 'Load';
    }
  });
}

function suggestName(name) {
  S.suggestedName = name;
  if (S.deckId === NEW_DECK && !$('newName').value) $('newName').value = name;
}

function showError(msg) {
  $('loadErr').textContent = msg;
  $('loadErr').hidden = false;
  showResult(null, true);
}

// ---------- preview ----------

// A new detection result: rebuild the whole preview.
//   pasted: the pasted text this result came from (Paste tab only), so "Make cloze notes" can read it again
function showResult(result, keepError = false, pasted = '') {
  S.pasted = pasted;
  if (!keepError) $('loadErr').hidden = true;
  S.result = result && result.rows.length ? result : null;
  S.frontCol = 0; S.backCol = 1;
  $('preview').hidden = $('savebar').hidden = !S.result;
  if (!S.result) { S.cards = []; return; }

  // More than 2 columns: let the user choose which ones are the front and back.
  const many = S.result.columns.length > 2;
  $('cols').hidden = !many;
  if (many) {
    const opts = S.result.columns.map((c, i) => `<option value="${i}">${esc(c)}</option>`).join('');
    $('frontCol').innerHTML = opts; $('backCol').innerHTML = opts;
    $('frontCol').value = '0'; $('backCol').value = '1';
  }
  S.cards = buildCards(S.result, S.frontCol, S.backCol);
  renderList();
}

function wirePreview() {
  const pickCols = () => {
    S.frontCol = +$('frontCol').value; S.backCol = +$('backCol').value;
    S.cards = buildCards(S.result, S.frontCol, S.backCol);
    renderList();
  };
  $('frontCol').addEventListener('change', pickCols);
  $('backCol').addEventListener('change', pickCols);

  $('swapBtn').addEventListener('click', () => {
    S.cards = S.cards.map(c => c.cloze || c.occlusion ? c : ({ ...c, front: c.back, back: c.front, ...(c.pictures ? { pictures: { front: c.pictures.back, back: c.pictures.front } } : {}) }));
    [S.frontCol, S.backCol] = [S.backCol, S.frontCol];
    if (!$('cols').hidden) { $('frontCol').value = S.frontCol; $('backCol').value = S.backCol; }
    renderList();
  });

  // Lines with {{c1::…}} become cloze notes by themselves. This link turns that off (and back on) for the current text.
  $('clozeToggle').addEventListener('click', () => {
    S.noCloze = !S.noCloze;
    showText(S.pasted);
  });

  $('dupBtn').addEventListener('click', () => {
    const n = S.flags.filter(Boolean).length;
    S.cards = S.cards.filter((_, i) => !S.flags[i]);
    renderList();
    toast(`Removed ${plural(n, 'duplicate')}`);
  });

  // Editing a cell updates the card without redrawing the list (so the keyboard stays open).
  $('plist').addEventListener('input', e => {
    const box = e.target.closest('textarea'); if (!box) return;
    const i = +box.closest('li').dataset.i;
    S.cards[i][box.dataset.side] = box.value;
    autosize(box);
    refreshFlags();
  });
  $('plist').addEventListener('click', e => {
    const del = e.target.closest('[data-del]'); if (!del) return;
    S.cards.splice(+del.closest('li').dataset.i, 1);
    renderList();
  });

  $('saveBtn').addEventListener('click', save);
}

// Draw the editable list of cards.
function renderList() {
  const shown = S.cards.slice(0, MAX_SHOWN);
  $('plist').innerHTML = shown.map((c, i) => `
    <li class="prow" data-i="${i}">
      <span class="pnum mono">${i + 1}</span>
      <div class="pcells">
        <textarea rows="1" data-side="front" aria-label="Front of card ${i + 1}" placeholder="Front" ${c.cloze || c.occlusion ? 'readonly' : ''}>${esc(c.front)}</textarea>
        <textarea rows="1" data-side="back" aria-label="Back of card ${i + 1}" placeholder="Back" ${c.cloze || c.occlusion ? 'readonly' : ''}>${esc(c.back)}</textarea>
        <span class="badge" hidden></span>
        <div class="pv-math" hidden aria-label="Maths preview"></div>
      </div>
      <button class="icon-btn" type="button" data-del aria-label="Delete card ${i + 1}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </li>`).join('');
  $('plist').querySelectorAll('textarea').forEach(autosize);
  $('moreNote').hidden = S.cards.length <= MAX_SHOWN;
  $('moreNote').textContent = `Showing the first ${MAX_SHOWN} to edit. All ${S.cards.length} will be added.`;
  refreshFlags();
}

// Grow a text box to fit its text, so long definitions are fully visible.
function autosize(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }

// Update the "Found N cards" line, duplicate badges and the save button.
function refreshFlags() {
  if (!S.result) return;
  S.flags = findDuplicates(S.cards, S.deckFronts);
  const complete = S.cards.filter(isComplete).length;
  const missing = S.cards.length - complete;
  const dups = S.flags.filter(Boolean).length;

  $('plist').querySelectorAll('.prow').forEach(row => {
    const i = +row.dataset.i, c = S.cards[i], flag = S.flags[i];
    const badge = row.querySelector('.badge');
    // A card with maths in it shows the drawn formulas under its boxes (only redrawn when its text changed).
    const pv = row.querySelector('.pv-math'), mathSrc = hasMath(c.front) || hasMath(c.back) ? `${c.front}\u0000${c.back}` : '';
    if (pv && pv.dataset.src !== mathSrc) {
      pv.dataset.src = mathSrc;
      pv.hidden = !mathSrc;
      pv.innerHTML = mathSrc ? `<div class="pv-f">${formatHTML(c.front)}</div><div class="pv-b">${formatHTML(c.back)}</div>` : '';
    }
    row.classList.toggle('incomplete', !isComplete(c));
    row.classList.toggle('dup', !!flag);
    badge.hidden = !flag && isComplete(c) && !c.cloze && !c.occlusion;
    badge.textContent = !isComplete(c) ? 'Missing a side, will be skipped'
      : flag === 'deck' ? 'Already in this deck' : flag ? 'Duplicate of an earlier card'
      : c.occlusion ? `Image occlusion: box ${groupIndex(c.occlusion.shapes, c.occlusion.n).k}` : `Cloze card c${c.cloze?.n}: part of a note`;
  });

  const parts = [`Found <b>${plural(complete, 'card')}</b>, ${esc(S.result.format.label)}.`];
  if (S.result.headerSkipped) parts.push('The header row was skipped.');
  if (S.result.images) {
    parts.push(`${plural(S.result.images, 'note')} ${S.result.images === 1 ? 'has' : 'have'} pictures, which come along too${S.result.extraImages ? ' (the first one on each side)' : ''}.`);
  }
  const prog = S.result.progress;
  // Cloze notes: how many notes the cards come from.
  const notesN = new Set(S.cards.filter(c => c.cloze).map(c => c.cloze.noteKey)).size;
  if (notesN) parts.push(`${plural(notesN, 'cloze note')} make${notesN === 1 ? 's' : ''} these cards: one card for each blank, and Review shows one of them a day.`);
  if (S.result.format.skipped) parts.push(`<span class="warn">${plural(S.result.format.skipped, 'line')} without a blank ${S.result.format.skipped === 1 ? 'was' : 'were'} left out.</span>`);
  // Cloze lines are included automatically; the link keeps them as plain cards (or brings the notes back).
  const hasBlanks = !!S.pasted && hasClozeLines(S.pasted) && S.result.format.id !== 'table';
  $('clozeNote').hidden = !hasBlanks;
  if (hasBlanks) $('clozeToggle').textContent = S.noCloze ? 'Turn {{c1::…}} lines into cloze notes' : 'Keep {{c1::…}} lines as plain cards';
  if (S.result.format.id !== 'anki' && S.result.tags?.some(t => t.length)) parts.push('Tags come along too.');
  $('swapBtn').hidden = S.cards.length > 0 && S.cards.every(c => c.cloze || c.occlusion);          // nothing to swap in cloze or occlusion cards
  // Image-occlusion notes: how many notes the cards come from.
  const occNotes = new Set(S.cards.filter(c => c.occlusion).map(c => c.occlusion.noteKey)).size;
  if (occNotes) parts.push(`${plural(occNotes, 'image-occlusion note')} make${occNotes === 1 ? 's' : ''} these cards: one card per box. Every box is hidden and you name the highlighted one; Review shows one a day.`);
  const occluded = (S.result.occluded || []).filter(Boolean).length;
  if (occluded) parts.push(`<span class="warn">${plural(occluded, 'image-occlusion note')} ${occluded === 1 ? 'comes' : 'come'} in as ${occluded === 1 ? 'a plain picture card' : 'plain picture cards'}: the heading on the front, the whole picture on the back (this kind of occlusion note can't be read).</span>`);
  if (S.result.format.id === 'anki') parts.push(prog?.cards ? 'Tags come along too.' : 'They come in as new cards, with their tags. (This file has no review history: to bring your progress, export from Anki with “Include scheduling information” ticked.)');
  $('progRow').hidden = !prog?.cards;
  if (prog?.cards) $('progInfo').textContent = `${plural(prog.reviews, 'review')} on ${plural(prog.cards, 'card')}: due dates and history are rebuilt with FSRS. Off = start them all as new.`;
  // Cards from several Anki decks: offer to keep them as subdecks of the deck they go into.
  const subs = new Set(subdeckPaths(S.cards.map(c => c.ankiDeck)).filter(p => p.length).map(p => p[0]));
  $('subRow').hidden = !subs.size;
  if (subs.size) $('subInfo').textContent = `Makes ${plural(subs.size, 'subdeck')} (${[...subs].slice(0, 3).join(', ')}${subs.size > 3 ? ', …' : ''}) inside the deck you add them to, like in Anki. Off = everything goes in that one deck.`;
  if (missing) parts.push(`<span class="warn">${plural(missing, 'row')} missing a side will be skipped.</span>`);
  if (dups) parts.push(`<span class="warn">${plural(dups, 'possible duplicate')} flagged.</span>`);
  $('found').innerHTML = parts.join(' ');
  $('dupBtn').hidden = !dups;

  // The button says where the cards go: the deck's name once it has one. A new deck without a name asks for it above.
  const name = (S.deckId === NEW_DECK ? $('newName').value.trim() : $('deckSel').selectedOptions[0].textContent).replace(/\s+/g, ' ');
  const shown = name.length > 32 ? name.slice(0, 31) + '…' : name;
  $('saveBtn').textContent = !complete ? 'No complete cards yet' : name ? `Add ${plural(complete, 'card')} to “${shown}”` : `Add ${plural(complete, 'card')}`;
  $('saveHint').hidden = !complete || !!name;
  $('saveBtn').disabled = !complete;
}

// ---------- saving ----------
async function save() {
  let toAdd = S.cards.filter(isComplete).map(c => ({ front: c.front.trim(), back: c.back.trim(), tags: c.tags || [], ankiId: c.ankiId, ankiGuid: c.ankiGuid, ankiDeck: c.ankiDeck, pictures: c.pictures, cloze: c.cloze, occlusion: c.occlusion, noteExtra: c.noteExtra }));
  if (!toAdd.length) return;
  // Anki progress: each card's Anki reviews are replayed through FSRS, which needs the scheduler library.
  let replay = null;
  if (S.result?.progress?.cards && $('ankiProg').checked) {
    try {
      const [{ rate }, settings] = await Promise.all([import('./srs.js'), db.getSettings()]);
      // Each card is replayed with the scheduling settings of the deck it goes into (its own, or inherited from the
      // decks it is inside). The exam only matters for the last review, which sets the due date: its retention rises
      // near the exam date. Where the card is placed before the exam is worked out when the queue is built, so it is
      // the same for cards that arrive later.
      replay = (card, entries, decks) => {
        const deck = effectiveDeck(decks, card.deckId);
        const own = deckSchedulerOptions(settings, deck);
        const last = { ...own, retention: examOptions(own, deck).retention };
        return replayHistory(entries, (state, rating, when, isLast) => rate(card.id, state, rating, isLast ? last : own, when), card.id, own.maxInterval);
      };
    } catch (err) {
      console.error(err);
      toast("Couldn't load the scheduler for your Anki progress. Connect to the internet and try again.");
      return;
    }
  }
  let deckId = S.deckId;
  let deckName;
  if (deckId === NEW_DECK) {
    deckName = $('newName').value.trim();
    if (!deckName) {
      $('newName').focus();
      $('newNameRow').scrollIntoView({ block: 'center' });
      toast('Give the new deck a name first');
      return;
    }
  } else {
    deckName = $('deckSel').selectedOptions[0].textContent;
  }

  // Read what we need from the page now: the picture step below takes a while, and you may leave the screen meanwhile.
  const saveBtn = $('saveBtn');
  const makeSubdecks = !$('subRow').hidden && $('ankiSubs').checked;
  saveBtn.disabled = true;
  try {
    const now = Date.now();
    // created + i keeps the cards in the order they were pasted.
    // A cloze note's cards share a noteId and the note's text; their front and back come from that text (cloze.js).
    const noteIds = new Map();
    let cards = toAdd.map((c, i) => {
      const card = { id: db.newId(), deckId: null, front: c.front, back: c.back, tags: c.tags, created: now + i };
      if (c.ankiGuid) card.ankiGuid = c.ankiGuid;
      if (c.cloze) {
        if (!noteIds.has(c.cloze.noteKey)) noteIds.set(c.cloze.noteKey, db.newId());
        Object.assign(card, clozeCard(c.cloze.text, c.cloze.n), { noteId: noteIds.get(c.cloze.noteKey), cloze: c.cloze.n, noteText: c.cloze.text });
        if (c.noteExtra) card.noteExtra = c.noteExtra;
      }
      if (c.occlusion) {
        // An image-occlusion note's cards share a noteId too. Their boxes and picture are added below.
        const key = 'occlusion:' + c.occlusion.noteKey;
        if (!noteIds.has(key)) noteIds.set(key, db.newId());
        card.noteId = noteIds.get(key);
        if (c.noteExtra) card.noteExtra = c.noteExtra;
      }
      return card;
    });
    // Image-occlusion cards: the picture is kept larger (2048px), the boxes are turned into fractions of it, and the
    // front and back are made from them (occlusion.js). A note whose picture or boxes can't be used comes in as one
    // plain picture card instead.
    if (toAdd.some(c => c.occlusion)) {
      const drop = await addOcclusion(toAdd, cards, saveBtn);
      if (drop.size) { toAdd = toAdd.filter((_, i) => !drop.has(i)); cards = cards.filter((_, i) => !drop.has(i)); }
    }
    // Pictures from an Anki file: unpack, shrink and save each one, then point the card at it.
    const withPics = toAdd.map((c, i) => [c.occlusion ? null : c.pictures, cards[i]]).filter(([p]) => p && S.ankiMedia);
    if (withPics.length) {
      const { processImage, saveImage } = await import('./media.js');
      const done = new Map();          // a picture used on several cards is saved once
      const picture = async name => {
        if (!name) return null;
        if (!done.has(name)) {
          done.set(name, (async () => {
            const got = await S.ankiMedia.get(name);
            if (!got) return null;
            const { type, data } = await processImage(new Blob([got.data], { type: got.type }));
            return saveImage(type, data);
          })().catch(err => { console.error('Skipped a picture', name, err); return null; }));
        }
        return done.get(name);
      };
      for (const [n, [pics, card]] of withPics.entries()) {
        saveBtn.textContent = `Adding pictures: ${n + 1} of ${withPics.length}…`;
        const [f, b] = [await picture(pics.front), await picture(pics.back)];
        if (f) card.frontImage = f;
        if (b) card.backImage = b;
      }
    }
    // Nothing is saved until everything is ready; then it all goes in together (see db.addImport).
    const newDecks = [];
    let color;
    if (deckId === NEW_DECK) {
      deckId = db.newId();
      color = DECK_COLORS[Math.floor(Math.random() * DECK_COLORS.length)];
      newDecks.push({ id: deckId, name: deckName, course: '', color, parentId: '', created: now });
    }
    cards.forEach(c => { c.deckId = deckId; });
    // Anki subdecks: make (or reuse) the same subdecks inside the chosen deck, and put each card in its own.
    let made = 0;
    if (makeSubdecks) {
      const all = await db.getDecks();
      color ||= all.find(d => d.id === deckId)?.color;
      const paths = subdeckPaths(toAdd.map(c => c.ankiDeck));
      const found = new Map();                     // 'parentId/name' → deck id
      const subdeck = (parentId, name) => {
        const key = `${parentId}/${name}`;
        if (!found.has(key)) {
          const existing = all.find(d => d.parentId === parentId && d.name === name);
          if (existing) found.set(key, existing.id);
          else {
            const deck = { id: db.newId(), name, course: '', color, parentId, created: now + 1 + made++ };
            newDecks.push(deck);
            all.push(deck);
            found.set(key, deck.id);
          }
        }
        return found.get(key);
      };
      for (const [i, path] of paths.entries()) {
        let id = deckId;
        for (const name of path) id = subdeck(id, name);
        cards[i].deckId = id;
      }
    }
    let withHistory = 0;
    const states = [], logs = [];
    if (replay) {
      const decksNow = [...await db.getDecks(), ...newDecks];
      cards.forEach((card, i) => {
        const entries = toAdd[i].ankiId && S.result.reviews.get(toAdd[i].ankiId);
        if (!entries) return;
        const { state, logs: cardLogs } = replay(card, entries, decksNow);
        if (state) states.push(state);
        if (cardLogs.length) withHistory++;
        cardLogs.forEach(l => logs.push({ ...l, cardId: card.id }));
      });
    }
    await db.addImport({ decks: newDecks, cards, reviewLog: logs, cardStates: states });
    rememberDeck(deckId);
    toast(`Added ${plural(cards.length, 'card')} to ${deckName}${made ? ` (${plural(made, 'new subdeck')})` : ''}${withHistory ? `, ${withHistory} with Anki progress` : ''}`);
    // replace() so the back gesture from the deck doesn't land on this finished import.
    // Coming from the first-run start, the first review of the new cards is next.
    let first = null;
    try { first = sessionStorage.getItem(FIRST_REVIEW_KEY); sessionStorage.removeItem(FIRST_REVIEW_KEY); } catch { /* fine */ }
    location.replace(first === deckId ? `#/welcome/review/${deckId}` : `#/deck/${deckId}`);
  } catch (err) {
    console.error(err);
    toast("Couldn't add the cards. Nothing was saved, so you can try again.");
    saveBtn.disabled = false;
    if (saveBtn.isConnected) refreshFlags();     // puts the button's label back
  }
}

// The picture and boxes of the image-occlusion cards being added (cards[i] belongs to toAdd[i]). Returns the indexes of
// cards to leave out: boxes whose group came to nothing, and the extra cards of a note that became a plain picture.
async function addOcclusion(toAdd, cards, saveBtn) {
  const { processImage, saveImage, OCCLUSION_SIDE } = await import('./media.js');
  const pictures = new Map();          // 'name|2048' → the saved picture { id, width, height, srcWidth, srcHeight }, or null
  const picture = name => {
    const key = `${name}|${OCCLUSION_SIDE}`;
    if (!pictures.has(key)) {
      pictures.set(key, (async () => {
        const got = await S.ankiMedia?.get(name);
        if (!got) return null;
        const out = await processImage(new Blob([got.data], { type: got.type }), { maxSide: OCCLUSION_SIDE });
        return { ...out, id: await saveImage(out.type, out.data) };
      })().catch(err => { console.error('Skipped a picture', name, err); return null; }));
    }
    return pictures.get(key);
  };
  const notes = new Map();             // noteKey → { pic, masks }: worked out once for all the cards of a note
  const plain = new Set();             // notes that came in as one plain picture card
  const drop = new Set();
  let done = 0;
  for (const [i, c] of toAdd.entries()) {
    const o = c.occlusion;
    if (!o) continue;
    if (!notes.has(o.noteKey)) {
      saveBtn.textContent = `Adding pictures: ${++done}…`;
      const pic = o.image ? await picture(o.image) : null;
      notes.set(o.noteKey, { pic, masks: pic ? toFractions(o.shapes, o.pixels, pic.srcWidth, pic.srcHeight) : [] });
    }
    const { pic, masks } = notes.get(o.noteKey);
    const header = String(o.header || '').trim().slice(0, MAX_HEADER);
    // Too many (or bad) boxes would make cards that fail validation, and with them every backup: use a plain picture.
    const good = pic && masks.length && validOcclusion({ n: 1, w: pic.width, h: pic.height, masks });
    if (good) {
      if (!groupsOf(masks).includes(o.n)) { drop.add(i); continue; }      // every box of this group fell outside the picture
      cards[i].backImage = pic.id;
      cards[i].occlusion = { n: o.n, w: pic.width, h: pic.height, ...(header ? { header } : {}), masks };
      Object.assign(cards[i], occFrontBack({ header, masks }, o.n));
    } else {
      if (plain.has(o.noteKey)) { drop.add(i); continue; }
      plain.add(o.noteKey);
      delete cards[i].noteId;
      Object.assign(cards[i], { front: header || 'Diagram', back: c.noteExtra || '' });
      delete cards[i].noteExtra;
      toAdd[i].ankiId = null;          // the first card's Anki history isn't replayed onto the plain picture
      if (pic) cards[i].backImage = pic.id;
    }
  }
  return drop;
}
