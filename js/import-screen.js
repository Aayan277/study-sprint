// The Import screen: paste text, upload a file or load a Google Sheet, check the cards in an
// editable preview, then save them into a deck. The actual format detection lives in import.js.

import * as db from './db.js';
import { parseText, parseRows, buildCards, isComplete, findDuplicates, sheetsCsvUrl, claudePrompt } from './import.js';
import { notesToImport, onlyDeck, deckList, replayHistory } from './anki.js';
import { schedulerOptions } from './sched-settings.js';
import { DECK_COLORS } from './decks.js';
import { $, esc, plural, toast } from './ui.js';

// SheetJS reads Excel files. It's big, so it only downloads when someone picks an .xlsx file.
const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
const NEW_DECK = '__new';
const MAX_SHOWN = 300;   // rows drawn in the preview; more than this would make phones sluggish

// Everything the screen is working with.
let S = null;

export async function renderImport(el, deckId) {
  const decks = (await db.getDecks()).sort((a, b) => a.created - b.created);
  S = {
    result: null,          // what import.js detected
    cards: [],             // [{ front, back }] as shown in the preview, including any edits
    flags: [],             // duplicate flag per card: 'deck', 'import' or null
    frontCol: 0, backCol: 1,
    deckId: decks.some(d => d.id === deckId) ? deckId : NEW_DECK,
    deckFronts: [],        // fronts already in the chosen deck, for duplicate checks
    suggestedName: ''      // a deck name taken from the file name
  };

  el.innerHTML = `
    <button class="back" type="button" id="back">‹ ${S.deckId === NEW_DECK ? 'Decks' : 'Deck'}</button>
    <div class="screen-head"><div><span class="eyebrow mono">IMPORT</span><h1>Add cards</h1></div></div>

    <section class="section">
      <label class="field"><span>Add to deck</span>
        <select id="deckSel">
          ${decks.map(d => `<option value="${esc(d.id)}" ${d.id === S.deckId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
          <option value="${NEW_DECK}" ${S.deckId === NEW_DECK ? 'selected' : ''}>+ New deck…</option>
        </select></label>
      <label class="field" id="newNameRow" style="margin-top:12px" ${S.deckId === NEW_DECK ? '' : 'hidden'}><span>New deck name</span>
        <input id="newName" maxlength="80" placeholder="e.g. Cell Biology"></label>
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
      <div class="pane-actions">
        <button class="btn ghost small" type="button" id="swapBtn">⇄ Swap front and back</button>
        <button class="btn ghost small" type="button" id="dupBtn" hidden>Remove duplicates</button>
      </div>
      <ol class="plist" id="plist"></ol>
      <p class="note" id="moreNote" hidden></p>
    </section>

    <div class="savebar" id="savebar" hidden>
      <button class="btn primary" type="button" id="saveBtn">Add cards</button>
    </div>`;

  $('back').addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = '#/decks'));
  wireDeckPicker();
  wireTabs();
  wirePaste();
  wireFile();
  wireSheet();
  wirePreview();
  await loadDeckFronts();
}

// ---------- choosing the deck ----------
function wireDeckPicker() {
  $('deckSel').addEventListener('change', async e => {
    S.deckId = e.target.value;
    $('newNameRow').hidden = S.deckId !== NEW_DECK;
    if (S.deckId === NEW_DECK && !$('newName').value) $('newName').value = S.suggestedName;
    await loadDeckFronts();
    refreshFlags();
  });
}
async function loadDeckFronts() {
  S.deckFronts = S.deckId === NEW_DECK ? [] : (await db.getCardsInDeck(S.deckId)).map(c => c.front);
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
    timer = setTimeout(() => showResult(parseText($('pasteBox').value)), 250);
  });
  $('clearBtn').addEventListener('click', () => {
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
      else showResult(parseText(await file.text()));
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
      showResult(parseText(text));
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
function showResult(result, keepError = false) {
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
    S.cards = S.cards.map(c => ({ ...c, front: c.back, back: c.front, ...(c.pictures ? { pictures: { front: c.pictures.back, back: c.pictures.front } } : {}) }));
    [S.frontCol, S.backCol] = [S.backCol, S.frontCol];
    if (!$('cols').hidden) { $('frontCol').value = S.frontCol; $('backCol').value = S.backCol; }
    renderList();
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
        <textarea rows="1" data-side="front" aria-label="Front of card ${i + 1}" placeholder="Front">${esc(c.front)}</textarea>
        <textarea rows="1" data-side="back" aria-label="Back of card ${i + 1}" placeholder="Back">${esc(c.back)}</textarea>
        <span class="badge" hidden></span>
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
    row.classList.toggle('incomplete', !isComplete(c));
    row.classList.toggle('dup', !!flag);
    badge.hidden = !flag && isComplete(c);
    badge.textContent = !isComplete(c) ? 'Missing a side, will be skipped'
      : flag === 'deck' ? 'Already in this deck' : 'Duplicate of an earlier card';
  });

  const parts = [`Found <b>${plural(complete, 'card')}</b>, ${esc(S.result.format.label)}.`];
  if (S.result.headerSkipped) parts.push('The header row was skipped.');
  if (S.result.images) {
    parts.push(`${plural(S.result.images, 'note')} ${S.result.images === 1 ? 'has' : 'have'} pictures, which come along too${S.result.extraImages ? ' (the first one on each side)' : ''}.`);
  }
  const prog = S.result.progress;
  if (S.result.format.id === 'anki') parts.push(prog?.cards ? 'Tags come along too.' : 'They come in as new cards, with their tags. (This file has no review history: to bring your progress, export from Anki with “Include scheduling information” ticked.)');
  $('progRow').hidden = !prog?.cards;
  if (prog?.cards) $('progInfo').textContent = `${plural(prog.reviews, 'review')} on ${plural(prog.cards, 'card')}: due dates and history are rebuilt with FSRS. Off = start them all as new.`;
  if (missing) parts.push(`<span class="warn">${plural(missing, 'row')} missing a side will be skipped.</span>`);
  if (dups) parts.push(`<span class="warn">${plural(dups, 'possible duplicate')} flagged.</span>`);
  $('found').innerHTML = parts.join(' ');
  $('dupBtn').hidden = !dups;

  const deckName = S.deckId === NEW_DECK ? 'new deck' : $('deckSel').selectedOptions[0].textContent;
  $('saveBtn').textContent = complete ? `Add ${plural(complete, 'card')} to ${deckName}` : 'No complete cards yet';
  $('saveBtn').disabled = !complete;
}

// ---------- saving ----------
async function save() {
  const toAdd = S.cards.filter(isComplete).map(c => ({ front: c.front.trim(), back: c.back.trim(), tags: c.tags || [], ankiId: c.ankiId, pictures: c.pictures }));
  if (!toAdd.length) return;
  // Anki progress: each card's Anki reviews are replayed through FSRS, which needs the scheduler library.
  let replay = null;
  if (S.result?.progress?.cards && $('ankiProg').checked) {
    try {
      const [{ rate }, settings] = await Promise.all([import('./srs.js'), db.getSettings()]);
      const opts = schedulerOptions(settings);
      replay = (cardId, entries) => replayHistory(entries, (state, rating, when) => rate(cardId, state, rating, opts, when));
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

  $('saveBtn').disabled = true;
  const now = Date.now();
  // created + i keeps the cards in the order they were pasted.
  const cards = toAdd.map((c, i) => ({ id: db.newId(), deckId: null, front: c.front, back: c.back, tags: c.tags, created: now + i }));
  // Pictures from an Anki file: unpack, shrink and save each one, then point the card at it.
  const withPics = toAdd.map((c, i) => [c.pictures, cards[i]]).filter(([p]) => p && S.ankiMedia);
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
      $('saveBtn').textContent = `Adding pictures: ${n + 1} of ${withPics.length}…`;
      const [f, b] = [await picture(pics.front), await picture(pics.back)];
      if (f) card.frontImage = f;
      if (b) card.backImage = b;
    }
  }
  if (deckId === NEW_DECK) {
    deckId = db.newId();
    cards.forEach(c => { c.deckId = deckId; });
    const color = DECK_COLORS[Math.floor(Math.random() * DECK_COLORS.length)];
    await db.addDeckWithCards({ id: deckId, name: deckName, course: '', color, created: now }, cards);
  } else {
    cards.forEach(c => { c.deckId = deckId; });
    await db.putMany('cards', cards);
  }
  let withHistory = 0;
  if (replay) {
    const states = [], logs = [];
    cards.forEach((card, i) => {
      const entries = toAdd[i].ankiId && S.result.reviews.get(toAdd[i].ankiId);
      if (!entries) return;
      const { state, logs: cardLogs } = replay(card.id, entries);
      if (state) states.push(state);
      if (cardLogs.length) withHistory++;
      cardLogs.forEach(l => logs.push({ ...l, cardId: card.id }));
    });
    if (logs.length) await db.putMany('reviewLog', logs);
    if (states.length) await db.putStates(states);
  }
  toast(`Added ${plural(cards.length, 'card')} to ${deckName}${withHistory ? `, ${withHistory} with Anki progress` : ''}`);
  // replace() so the back gesture from the deck doesn't land on this finished import.
  location.replace(`#/deck/${deckId}`);
}
