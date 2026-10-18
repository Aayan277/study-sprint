// The Import screen: paste text, upload a file or load a Google Sheet, check the cards in an
// editable preview, then save them into a deck. The actual format detection lives in import.js.

import * as db from './db.js';
import { parseText, parseBlocks, parseRows, buildCards, hasKeptFields, basicFieldsCut, isComplete, findDuplicates, sheetsCsvUrl, claudePrompt } from './import.js';
import { notesToImport, onlyDeck, deckList, replayHistory, subdeckPaths, soundReport, fieldReport } from './anki.js';
import { canReverse, reverseOf } from './reverse.js';
import { clozeCard, withClozeLines, hasClozeLines } from './cloze.js';
import { keepDraft, takeDraft } from './import-draft.js';
import { formatHTML } from './format.js';
import { hasMath } from './math.js';
import { toFractions, occFrontBack, groupsOf, groupIndex, validOcclusion, MAX_HEADER } from './occlusion.js';
import { deckChoices, subtreeIds, effectiveDeck } from './deck-tree.js';
import { deckSchedulerOptions } from './sched-settings.js';
import { examOptions } from './exam.js';
import { DECK_COLORS } from './decks.js';
import { FIRST_REVIEW_KEY } from './onboarding.js';
import { sizeText } from './media.js';
import { $, esc, plural, toast, icon } from './ui.js';
import { replace as navReplace, back as navBack } from './nav.js';
import { sharedKind } from './share-logic.js';
import { readDocument, isDocFile, pagesToText, splitParts, docPrompt, charCount, hasText, AI_SITES, MAX_BYTES, tooBigMessage } from './doc-import.js';
import { importWarnings, tooBigNotes, splitTooBig, tooLargeNote, cardsWarning, passedCardsWarning } from './quota.js';

// SheetJS reads Excel files. It's big, so it only downloads when someone picks an .xlsx file.
const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
const NEW_DECK = '__new';
const MAX_SHOWN = 300;   // rows drawn in the preview; more than this would make phones sluggish
// The deck the last import went into (this device). It is only offered, first in the list ("Last used: X"): the default is a new deck,
// so a second subject's file doesn't quietly merge into the first one. (An older version kept it under 'study-sprint-import-deck': removed.)
const LAST_DECK = 'study-sprint-import-last';
const lastDeck = () => { try { localStorage.removeItem('study-sprint-import-deck'); return localStorage.getItem(LAST_DECK) || ''; } catch { return ''; } };
const rememberDeck = id => { try { localStorage.setItem(LAST_DECK, id); } catch { /* fine */ } };

// The pasted text is kept for this tab (with how it is read: pages, AI answer, plain cards) while it is on the screen, so Back (or a swipe)
// and then returning to Import finds it again. It goes when the cards are saved or Clear is pressed (js/import-draft.js).
const saveDraft = text => keepDraft({ text, blocks: S?.blocks, aiMade: S?.aiMade, noCloze: S?.noCloze });

// Everything the screen is working with.
let S = null;

// arg: a deck id, optionally followed by "/file" to open on the File tab (the first-run start does this).
export async function renderImport(el, arg) {
  const shared = arg === 'share';                // opened by Share → Study Sprint on Android (the service worker saved what was shared)
  const [deckId, firstTab] = shared ? [''] : String(arg || '').split('/');
  const decks = (await db.getDecks()).sort((a, b) => a.created - b.created);
  S = {
    result: null,          // what import.js detected
    cards: [],             // [{ front, back }] as shown in the preview, including any edits
    flags: [],             // duplicate flag per card: 'deck', 'import' or null
    frontCol: 0, backCol: 1,
    // The deck in the address (the import started from that deck's page), otherwise a new deck named after the file.
    deckId: decks.some(d => d.id === deckId) ? deckId : NEW_DECK,
    deckFronts: [],        // fronts already in the chosen deck, for duplicate checks
    suggestedName: '',     // a deck name taken from the file name
    noCloze: false,        // "Keep {{c1::…}} lines as plain cards" was pressed (until the text changes)
    keepFields: true,      // the "Keep the other fields" switch (Anki notes with more than two fields)
    makeReverse: true,     // the "Make the reverse cards too" switch (notes that work in both directions)
    bringSounds: true,     // the "Bring sounds" switch (Anki imports)
    freeNote: '',          // "Not enough free space on this device for the sounds…", when the switch started off for that reason
    doc: null,             // the PDF or slides being read: { pages, name, what }
    withNotes: true,       // the "Include speaker notes" switch
    blocks: false,         // the text in the paste box is a PDF's or slides' text: read it as one block per page, not by separators
    aiMade: false,         // the cards come from an AI's answer to the "Make cards with AI" prompt: they get the ai-made tag
    part: 0                // the part of the material the Copy-and-open buttons copy
  };

  // (The deck the last import went into, if it is still there, comes first.)
  const last = lastDeck(), all = deckChoices(decks);
  const choices = [...all.filter(d => d.id === last), ...all.filter(d => d.id !== last)];
  el.innerHTML = `
    <button class="back" type="button" id="back">‹ ${decks.some(d => d.id === deckId) ? 'Deck' : 'Decks'}</button>
    <div class="screen-head"><div><h1>Add cards</h1></div></div>

    <section class="section">
      <label class="field"><span>Add to deck</span>
        <select id="deckSel">
          ${choices.map(d => `<option value="${esc(d.id)}" data-name="${esc(d.label)}" ${d.id === S.deckId ? 'selected' : ''}>${d.id === last ? 'Last used: ' : ''}${esc(d.label)}</option>`).join('')}
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
      <p class="note" id="aiNote" hidden>Paste the AI's answer in the box above. The cards get an <b>ai-made</b> tag, so you can find them and check them.</p>
      <p class="note" id="claudeNote" hidden>Copied a prompt with your notes. Paste it into a chat at <a href="https://claude.ai/new" target="_blank" rel="noopener">claude.ai</a>, then paste Claude's answer back in the box above (replacing your notes).</p>
    </section>

    <section class="pane" id="pane-file" role="tabpanel" aria-labelledby="tab-file" hidden>
      <label class="drop">
        <input type="file" id="fileIn" accept=".csv,.tsv,.txt,.xlsx,.xls,.json,.apkg,.colpkg,.pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/csv,text/plain,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel">
        <b>Choose a file</b><span class="muted">.csv, .txt, Excel, an Anki deck, or a PDF or slides (.pptx) with text</span>
        <span class="mono" id="fileName"></span>
      </label>
      <p class="note" id="docStatus" role="status" hidden></p>
      <div class="doc-box" id="docBox" hidden>
        <p class="found" id="docInfo"></p>
        <label class="adv-row switch-row prog-row" id="docNotesRow" hidden><span><b>Include speaker notes</b></span>
          <input id="docNotes" type="checkbox" class="switch" checked></label>
        <div class="pane-actions">
          <button class="btn primary small" type="button" id="docAi">Make cards with AI</button>
          <button class="btn ghost small" type="button" id="docRaw">Use the text as it is</button>
        </div>
        <p class="note">AI makes better cards from lecture text. You paste the text into your own chat. Nothing is sent from here. Or use the text as it is and tidy it in the preview.</p>
        <div id="aiView" hidden>
          <h3 class="doc-h">Make cards with AI</h3>
          <p class="note" id="aiHow"></p>
          <ol class="doc-parts" id="aiParts"></ol>
          <p class="note" id="aiCur" aria-live="polite"></p>
          <div class="pane-actions" id="aiSites">
            ${AI_SITES.map(a => `<a class="btn ghost small" href="${a.url}" target="_blank" rel="noopener" data-site="${a.id}">Copy and open ${a.name}</a>`).join('')}
          </div>
          <div class="pane-actions"><button class="btn primary small" type="button" id="aiBack">I have the answer</button></div>
        </div>
      </div>
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
      <label class="adv-row switch-row prog-row" id="soundRow" hidden><span><b>Bring sounds</b>
        <span id="soundInfo"></span></span>
        <input id="ankiSounds" type="checkbox" class="switch" checked></label>
      <label class="adv-row switch-row prog-row" id="fieldsRow" hidden><span><b>Keep the other fields</b>
        <span id="fieldsInfo"></span></span>
        <input id="keepFields" type="checkbox" class="switch" checked></label>
      <label class="adv-row switch-row prog-row" id="revRow" hidden><span><b>Make the reverse cards too</b>
        <span id="revInfo"></span></span>
        <input id="makeReverse" type="checkbox" class="switch" checked></label>
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

  $('back').addEventListener('click', () => navBack('#/decks'));
  wireDeckPicker();
  wireTabs();
  wirePaste();
  wireFile();
  wireDoc();
  wireSheet();
  wirePreview();
  if (firstTab === 'file') $('tab-file').click();
  await loadDeckFronts();
  if (shared) await takeShared();
  else if (firstTab !== 'file' && $('pasteBox')) {
    const d = takeDraft();
    if (!d) return;
    Object.assign(S, { blocks: d.blocks, aiMade: d.aiMade, noCloze: d.noCloze });      // read the way it was before
    $('aiNote').hidden = !d.aiMade;
    $('pasteBox').value = d.text;
    showText(d.text);
    toast('Brought back the text you pasted');
  }
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
    saveDraft($('pasteBox').value);
    timer = setTimeout(() => showText($('pasteBox').value), 250);
  });
  // Pasting something new (the AI's answer, say) ends "read as pages".
  // (Only when the paste replaces most of the box: a bit pasted into the text keeps it read as pages.)
  $('pasteBox').addEventListener('paste', () => {
    const b = $('pasteBox');
    if (b.selectionEnd - b.selectionStart >= b.value.length * 0.8) { S.blocks = false; saveDraft(b.value); }
  });
  $('clearBtn').addEventListener('click', () => {
    clearTimeout(timer);
    S.blocks = false; S.aiMade = false; $('aiNote').hidden = true;
    $('pasteBox').value = '';
    keepDraft(null);
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
  saveDraft(text);          // however the text got here (typed, a file, a sheet, shared, read as pages), with how it is read
  const parse = S.blocks ? parseBlocks : parseText;
  let result = S.noCloze ? parse(text) : withClozeLines(text, parse).result;
  if (S.noCloze && result.clozes) { const { clozes, noteExtras, ...rest } = result; result = rest; }      // a spreadsheet's "Cloze note" column too
  // Cards from an AI's answer carry the ai-made tag (same tag for every row; the preview says "Tags come along too").
  if (S.aiMade && result.rows.length) result = { ...result, tags: result.rows.map((_, i) => [...new Set([...(result.tags?.[i] || []), 'ai-made'])]) };
  showResult(result, false, text);
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
    hideDoc();
    try {
      if (isDocFile(file)) { await readDoc(file); return; }
      if (/\.xlsx?$/i.test(file.name)) await readExcel(file);
      else if (/\.(apkg|colpkg)$/i.test(file.name)) await readAnki(file);
      else if (/\.json$/i.test(file.name)) await explainJson(file);
      else { S.noCloze = false; showText(await file.text()); }
    } catch (err) {
      console.error(err);
      $('fileName').textContent = file.name;          // (clears "reading…")
      if (err?.code === 'too-big') { showError(err.message); return; }      // an Anki file that unpacks huge (anki-read.js): it says why
      const anki = /\.(apkg|colpkg)$/i.test(file.name);
      showError(`Couldn't read ${file.name}. ${!navigator.onLine ? `${anki ? 'Anki' : 'Excel'} files need an internet connection the first time.`
        : anki ? 'Is it an Anki deck exported from Anki (File → Export → Anki Deck Package)?' : 'Is it a .csv, .txt or .xlsx file?'}`);
    }
  });
}

// A whole-app backup is restored from Settings (it replaces everything), not added as cards.
async function explainJson(file) {
  let data = null;
  try { data = JSON.parse(await file.text()); } catch (e) { /* not JSON */ }
  showError(db.checkBackup(data) ? "That .json file isn't a Study Sprint backup. Use .csv, .txt or Excel files for cards."
    : 'This is a full Study Sprint backup. Restore it from Settings → Restore (it replaces everything on this device).');
}

// ---------- PDF and slides ----------
// The text of the file is read here (js/doc-import.js). Then you choose: an AI prompt in parts, or the text as it is in the paste box.
const docWord = (n, what) => (what === 'PDF' ? plural(n, 'page') : plural(n, 'slide'));

function hideDoc() {
  S.doc = null; S.aiMade = false; S.blocks = false; $('aiNote').hidden = true;
  $('docBox').hidden = true; $('aiView').hidden = true; $('docStatus').hidden = true;
}

let readCount = 0, readAbort = null;
async function readDoc(file) {
  const what = isDocFile(file) && (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') ? 'PDF' : 'slides';
  // Another file picked (or the screen left) while this one is being read: the old read stops and says nothing.
  readAbort?.abort();
  const mine = ++readCount, st = S, ctl = readAbort = new AbortController();
  const stale = () => S !== st || mine !== readCount || !$('docBox')?.isConnected;
  $('found').textContent = '';
  showResult(null);
  const status = $('docStatus');
  status.textContent = what === 'PDF' ? 'Loading the PDF reader…' : 'Reading the slides…'; status.hidden = false;
  $('fileName').textContent = `${file.name} · reading…`;
  try {
    const { pages } = await readDocument(file, (done, total) => {
      if (stale()) { ctl.abort(); return; }
      if (total) status.textContent = `Reading page ${done} of ${total}…`;
    }, ctl.signal);
    if (stale()) return;
    S.doc = { pages, name: file.name, what };
    S.withNotes = true; $('docNotes').checked = true;
    S.aiMade = false; S.blocks = false; $('aiNote').hidden = true;
    status.hidden = true;
    $('fileName').textContent = file.name;
    $('docNotesRow').hidden = !pages.some(p => p.notes);
    showDocInfo();
    $('docBox').hidden = false; $('aiView').hidden = true;
  } catch (err) {
    if (err.name === 'AbortError' || stale()) return;
    $('fileName').textContent = file.name;
    status.hidden = true;
    if (err.code) { showError(err.message); return; }
    console.error(err);
    showError(`Couldn't read ${file.name}. ${!navigator.onLine && what === 'PDF' ? 'PDFs need an internet connection the first time.' : what === 'PDF' ? 'Is it a PDF that opens on your device?' : 'Is it a PowerPoint (.pptx) file? Older .ppt files need to be saved as .pptx first.'}`);
  }
}

function showDocInfo() {
  const { pages, what } = S.doc;
  const n = pages.filter(p => p.text.trim() || (S.withNotes && p.notes.trim())).length;
  const chars = charCount(pages, S.withNotes);
  $('docInfo').innerHTML = `Read <b>${docWord(n, what)}</b> with text (${chars.toLocaleString('en')} characters)${n < pages.length ? `. ${plural(pages.length - n, what === 'PDF' ? 'page' : 'slide')} had no text.` : '.'}`;
}

function wireDoc() {
  $('docNotes').addEventListener('change', e => {
    S.withNotes = e.target.checked;
    if (!S.doc) return;
    showDocInfo();
    if (!$('aiView').hidden) showAiView();
  });
  $('docRaw').addEventListener('click', () => {
    if (!S.doc || !hasText(S.doc.pages)) return;
    S.aiMade = false; S.blocks = true; S.noCloze = false;
    $('aiNote').hidden = true;
    $('pasteBox').value = pagesToText(S.doc.pages, S.withNotes);
    $('tab-paste').click();
    showText($('pasteBox').value);
    $('pasteBox').scrollIntoView({ block: 'nearest' });
  });
  $('docAi').addEventListener('click', () => { S.part = 0; showAiView(); $('aiView').scrollIntoView({ block: 'nearest' }); });
  // Copy a part (its own button), or copy the chosen part and follow the link to the AI site (the link opens by itself).
  $('aiParts').addEventListener('click', async e => {
    const b = e.target.closest('[data-part]'); if (!b) return;
    S.part = +b.dataset.part;
    const ok = await copyPart();
    markCopied(ok);
  });
  $('aiSites').addEventListener('click', async e => {
    if (!e.target.closest('[data-site]')) return;
    markCopied(await copyPart());
  });
  $('aiBack').addEventListener('click', () => {
    $('tab-paste').click();
    $('aiNote').hidden = false;
    $('pasteBox').focus();
  });
}

let aiParts = [];
function showAiView() {
  aiParts = splitParts(S.doc.pages, undefined, S.withNotes);
  S.aiMade = true; S.blocks = false;
  saveDraft($('pasteBox').value);
  $('aiNote').hidden = false;
  S.part = Math.min(S.part, aiParts.length - 1);
  $('aiHow').textContent = aiParts.length > 1
    ? `This is a lot of text, so it is in ${aiParts.length} parts. Copy a part, paste it into a chat, and send it. Do the next part in the same chat.`
    : 'Copy the prompt, paste it into a chat, and send it. Then paste the answer back here.';
  $('aiParts').innerHTML = aiParts.map((p, i) => `
    <li><span><b>Part ${i + 1} of ${aiParts.length}</b> <span class="muted">${esc(p.label)}, ${p.text.length.toLocaleString('en')} characters</span></span>
      <button class="btn ghost small" type="button" data-part="${i}">Copy<span class="sr-only"> part ${i + 1} of ${aiParts.length}</span></button></li>`).join('');
  $('aiCur').textContent = curText();
  $('aiView').hidden = false;
}
const curText = () => `The buttons below copy Part ${S.part + 1} of ${aiParts.length}, then open the site.`;
const copyPart = () => copyText(docPrompt(aiParts[S.part].text, S.part + 1, aiParts.length));
function markCopied(ok) {
  if (!ok) { toast("Couldn't copy. Your browser blocked it."); return; }
  toast(`Copied part ${S.part + 1} of ${aiParts.length}`);
  $('aiParts').querySelectorAll('[data-part]').forEach(b => { b.firstChild.textContent = +b.dataset.part === S.part ? 'Copied' : 'Copy'; });
  $('aiCur').textContent = S.part + 1 < aiParts.length ? `Copied part ${S.part + 1} of ${aiParts.length}. Paste it into the chat, then copy the next part.` : `Copied part ${S.part + 1} of ${aiParts.length}. Paste it into the chat.`;
}

// Share → Study Sprint (Android): the service worker kept what was shared (sw.js, takeShare). It stays kept until the cards are
// saved or the next share replaces it (so an app update that reloads the page doesn't lose the file); one older than 10 minutes is ignored.
const SHARE_CACHE = 'study-sprint-share', SHARE_MAX_AGE = 10 * 60 * 1000;
const shareUrl = name => new URL('share-target/' + name, document.baseURI);
async function clearShare() {
  try { const c = await caches.open(SHARE_CACHE); for (const k of await c.keys()) await c.delete(k); } catch { /* nothing to clear */ }
}
async function takeShared() {
  let file = null, said = null;
  try {
    const c = await caches.open(SHARE_CACHE);
    const f = await c.match(shareUrl('file'));
    const t = await c.match(shareUrl('text'));
    const old = x => Date.now() - x >= SHARE_MAX_AGE;
    if ((f && old(Number(f.headers.get('x-at') || 0))) || (t && old((await t.clone().json()).at || 0))) { await clearShare(); return; }      // too old: not used, and not left taking room
    if (f) file = new File([await f.blob()], decodeURIComponent(f.headers.get('x-name') || 'shared'), { type: f.headers.get('content-type') || '' });
    if (t) said = await t.json();
  } catch { /* nothing was kept: just show the screen */ }
  // (The address stays #/import/share until the cards are saved, so a reload, such as one after an app update, finds the share again.)
  if (said?.tooBig) { showError(tooBigMessage()); return; }
  if (said?.failed) { showError("Couldn't get what you shared. Open Study Sprint and choose the file here instead."); return; }
  if (file) {
    $('tab-file').click();
    $('fileName').textContent = file.name;
    suggestName(file.name.replace(/\.[^.]+$/, ''));
    if (isDocFile(file)) { await readDoc(file); return; }
    if (file.size > MAX_BYTES) { showError(tooBigMessage()); return; }
    // The Share target also takes zip and generic files (so a deck file can arrive): decide what this one is.
    const kind = sharedKind(file, new Uint8Array(await file.slice(0, 4).arrayBuffer()));
    try {
      if (kind === 'anki') await readAnki(file);               // a deck file from a friend (Share a deck), the same import as choosing it here
      else if (kind === 'excel') await readExcel(file);
      else if (kind === 'json') await explainJson(file);
      else if (kind === 'unknown') showError("Study Sprint can't read that kind of file. Share a deck file (.apkg), PDF, PowerPoint or text.");
      else { S.noCloze = false; showText(await file.text()); }
    } catch (err) { console.error(err); $('fileName').textContent = file.name; if (err?.code === 'too-big') { showError(err.message); return; } showError(`Couldn't read ${file.name}. Is it a deck file shared from Study Sprint or Anki?`); }
    return;
  }
  // Text, a link, or only a title (some apps put what they share in the title).
  const text = [said?.text, said?.url].filter(Boolean).join('\n').trim() || String(said?.title || '').trim();
  if (!text) return;
  // A link on its own: the app can't read web pages.
  if (/^https?:\/\/\S+$/.test(text)) { showError("That's a link, and Study Sprint can't read web pages. Share the text itself, or a PDF of the page."); return; }
  $('pasteBox').value = text; S.noCloze = false; showText(text);
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
// formatting is left out; pictures and sounds come along (sounds can be switched off).
async function readAnki(file) {
  $('found').textContent = '';
  $('fileName').textContent = `${file.name} · reading…`;
  const { readAnkiFile } = await import('./anki-read.js');
  const { notes, models, reviews, media, mediaBytes } = await readAnkiFile(file);
  const all = notesToImport(notes, models, reviews, media);
  S.ankiMedia = media;                 // the file's pictures and sounds, unpacked when the cards are added
  S.ankiMediaBytes = mediaBytes || 0;  // about how much they take (for the size warning)
  await checkSoundSpace(all);
  $('fileName').textContent = file.name;
  if (!all.rows.length) { showError('That Anki file has no cards in it.'); return; }
  // Several Anki decks inside: let the user pick one, or take them all.
  const decks = deckList(all);
  if (decks.length > 1) {
    $('sheetPickLbl').textContent = 'Anki deck';
    $('sheetPick').innerHTML = `<option value="">All decks (${all.rows.length})</option>` +
      decks.map(d => `<option value="${esc(d.name)}">${esc(d.name.split('::').join(' › '))} (${d.count})</option>`).join('');
    $('sheetPickRow').hidden = false;
    $('sheetPick').onchange = async () => {
      const part = onlyDeck(all, $('sheetPick').value);
      await checkSoundSpace(part);               // the room needed depends on the deck picked
      showResult(part);
    };
  }
  showResult(all);
}

// Sounds can be big: when they would fill more than 80% of this device's free storage, the "Bring sounds" switch starts off.
async function checkSoundSpace(all) {
  S.bringSounds = true; S.freeNote = '';
  const need = soundReport(all).bytes;
  if (!need) return;
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {};
    if (quota && usage + need > 0.8 * quota) {
      S.bringSounds = false;
      S.freeNote = `Not enough free space on this device for the sounds (about ${sizeText(need)} needed, ${sizeText(Math.max(0, quota - usage))} free).`;
    }
  } catch { /* no estimate: just bring them */ }
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
      hideDoc();
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
  S.hasFields = hasKeptFields(S.result, S.frontCol, S.backCol);
  S.cards = build();
  renderList();
}

// The cards the result makes with the columns picked. `row` says which row of the result a card came from (rows can be deleted
// from the preview), so the "Keep the other fields" switch can change a card's extras without rebuilding the list and losing edits.
const build = () => buildCards(S.result, S.frontCol, S.backCol, { keepFields: S.keepFields }).map((c, i) => ({ ...c, row: i }));
// Does this card also make a reverse card when saved? (A card that can't be reversed, like a step-by-step one, doesn't.)
const makesReverse = c => S.makeReverse && !!c.reversed && canReverse({ front: c.front, back: c.back, frontImage: c.pictures?.front, backImage: c.pictures?.back, frontSounds: c.sounds?.front, backSounds: c.sounds?.back });

function wirePreview() {
  const pickCols = () => {
    S.frontCol = +$('frontCol').value; S.backCol = +$('backCol').value;
    S.hasFields = hasKeptFields(S.result, S.frontCol, S.backCol);
    S.cards = build();
    renderList();
  };
  $('frontCol').addEventListener('change', pickCols);
  $('backCol').addEventListener('change', pickCols);

  $('swapBtn').addEventListener('click', () => {
    S.cards = S.cards.map(c => c.cloze || c.occlusion ? c : ({ ...c, front: c.back, back: c.front, ...(c.pictures ? { pictures: { front: c.pictures.back, back: c.pictures.front } } : {}), ...(c.sounds ? { sounds: { front: c.sounds.back, back: c.sounds.front } } : {}) }));
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

  $('ankiSounds').addEventListener('change', e => { S.bringSounds = e.target.checked; refreshFlags(); });
  $('keepFields').addEventListener('change', e => {
    S.keepFields = e.target.checked;
    const fresh = build();
    for (const c of S.cards) {
      const f = fresh[c.row];
      delete c.noteExtra; delete c.noteFields;
      if (f?.noteExtra) c.noteExtra = f.noteExtra;
      if (f?.noteFields) c.noteFields = f.noteFields;
    }
    refreshFlags();
  });
  $('makeReverse').addEventListener('change', e => { S.makeReverse = e.target.checked; refreshFlags(); });
  $('saveBtn').addEventListener('click', save);
}

// The card as it will be saved: without its sounds when "Bring sounds" is off.
const live = c => (S.bringSounds || !c.sounds ? c : { ...c, sounds: undefined });

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
  autosizeAll($('plist').querySelectorAll('textarea'));
  $('moreNote').hidden = S.cards.length <= MAX_SHOWN;
  $('moreNote').textContent = `Showing the first ${MAX_SHOWN} to edit. All ${S.cards.length} will be added.`;
  refreshFlags();
}

// Grow a text box to fit its text, so long definitions are fully visible.
// Browsers with CSS `field-sizing: content` (see styles.css) do this themselves, so nothing is measured here.
const SELF_SIZING = typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content');
function autosize(t) { if (SELF_SIZING) return; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
// Many boxes at once: all the writes, then all the reads, then all the writes, so the browser lays the page out once
// instead of once per box (5,000 boxes took ~3 s one at a time).
function autosizeAll(boxes) {
  if (SELF_SIZING) return;
  const list = [...boxes];
  for (const t of list) t.style.height = 'auto';
  const heights = list.map(t => t.scrollHeight);
  list.forEach((t, i) => { t.style.height = heights[i] + 'px'; });
}

// Update the "Found N cards" line, duplicate badges and the save button.
function refreshFlags() {
  if (!S.result) return;
  S.flags = findDuplicates(S.cards, S.deckFronts);
  const complete = S.cards.filter(c => isComplete(live(c))).length;
  const pairN = S.cards.filter(c => isComplete(live(c)) && makesReverse(c)).length;       // cards that also make a reverse card
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
    row.classList.toggle('incomplete', !isComplete(live(c)));
    row.classList.toggle('dup', !!flag);
    badge.hidden = !flag && isComplete(live(c)) && !c.cloze && !c.occlusion && !makesReverse(c);
    badge.textContent = !isComplete(live(c)) ? 'Missing a side, will be skipped'
      : flag === 'deck' ? 'Already in this deck' : flag ? 'Duplicate of an earlier card'
      : makesReverse(c) ? 'Both directions: makes 2 cards'
      : c.occlusion ? `Image occlusion: box ${groupIndex(c.occlusion.shapes, c.occlusion.n).k}` : `Cloze card c${c.cloze?.n}: part of a note`;
  });

  const parts = [`Found <b>${plural(complete, 'card')}</b>, ${esc(S.result.format.label)}.`];
  if (S.result.headerSkipped) parts.push('The header row was skipped.');
  if (S.result.images) {
    parts.push(`${plural(S.result.images, 'note')} ${S.result.images === 1 ? 'has' : 'have'} pictures, which come along too${S.result.extraImages ? ' (the first one on each side)' : ''}.`);
  }
  const prog = S.result.progress;
  // Sounds (Anki imports): how many notes have them, and what could not be kept (and why).
  const snd = soundReport(S.result);
  $('soundRow').hidden = !snd.files.length;
  if (!$('soundRow').hidden) {
    $('ankiSounds').checked = S.bringSounds;
    $('soundInfo').textContent = `About ${sizeText(snd.bytes)}. Kept on this device, synced like pictures and kept in backups.`;
  }
  if (S.bringSounds && snd.notes) parts.push(`${plural(snd.notes, 'note')} ${snd.notes === 1 ? 'has' : 'have'} sounds, which come along too.`);
  if (!S.bringSounds && snd.files.length) parts.push(`<span class="warn">Sounds are left out (Bring sounds is off).${S.freeNote ? ` ${esc(S.freeNote)}` : ''}</span>`);
  if (S.bringSounds && snd.dropped) {
    const be = n => (n === 1 ? 'is' : 'are');
    const why = [
      snd.tooBig && `${snd.tooBig} ${be(snd.tooBig)} bigger than 1 MB`,
      snd.missing && `${snd.missing} ${snd.missing === 1 ? "isn't" : "aren't"} in the file`,
      snd.format && `${snd.format} ${be(snd.format)} a format the app can't keep`,
      snd.extra && `${snd.extra} ${be(snd.extra)} past the 4 allowed on a side`
    ].filter(Boolean);
    parts.push(`<span class="warn">${plural(snd.dropped, 'sound')} ${snd.dropped === 1 ? "wasn't" : "weren't"} imported: ${why.join(', ')}.</span>`);
  }
  // Cards that work in both directions (Anki "Basic (and reversed card)", or the CSV's Both directions column).
  const reversible = S.cards.filter(c => c.reversed).length;
  $('revRow').hidden = !reversible;
  if (reversible) {
    $('makeReverse').checked = S.makeReverse;
    $('revInfo').textContent = 'Each of these also asks the back and expects the front, with its own schedule. Review shows one of the two a day.';
    parts.push(S.makeReverse ? `${plural(pairN, 'note')} work${pairN === 1 ? 's' : ''} in both directions, so ${pairN === 1 ? 'it makes' : 'each makes'} 2 cards.`
      : '<span class="warn">Reverse cards are left out (Make the reverse cards too is off).</span>');
  }
  // The other fields of Anki notes (item A) and the note types that have more cards than come in.
  $('fieldsRow').hidden = !S.hasFields;
  const fields = fieldReport(S.result);
  if (S.hasFields) {
    $('keepFields').checked = S.keepFields;
    $('fieldsInfo').textContent = 'Anki fields like First Aid or Sketchy stay under the answer, folded, with their names.';
    if (S.keepFields) {
      parts.push('Other fields come along as folded sections.');
      if (fields.pictures) parts.push(`<span class="warn">Pictures in other fields are left out (${fields.pictures}).</span>`);
      const cut = fields.cut + basicFieldsCut(S.result, S.frontCol, S.backCol);
      if (cut) parts.push(`<span class="warn">${plural(cut, 'very long field')} ${cut === 1 ? 'was' : 'were'} shortened or left out.</span>`);
    }
  }
  if (fields.more) parts.push(`<span class="warn">${plural(fields.more, 'note')} ${fields.more === 1 ? 'has' : 'have'} more card types in Anki (like a listening card); only the first card of each comes in.</span>`);
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
  // A big deck: more than 200 MB of pictures and sounds, or more than 50,000 reviews of history (see quota.js).
  if (S.result.format.id === 'anki') for (const w of importWarnings({ mediaBytes: S.ankiMediaBytes, reviews: prog?.reviews || 0, soundBytes: S.bringSounds ? snd.bytes : 0 })) parts.push(`<span class="warn">${esc(w)}</span>`);
  // Cards from several Anki decks: offer to keep them as subdecks of the deck they go into.
  const subs = new Set(subdeckPaths(S.cards.map(c => c.ankiDeck)).filter(p => p.length).map(p => p[0]));
  $('subRow').hidden = !subs.size;
  if (subs.size) $('subInfo').textContent = `Makes ${plural(subs.size, 'subdeck')} (${[...subs].slice(0, 3).join(', ')}${subs.size > 3 ? ', …' : ''}) inside the deck you add them to, like in Anki. Off = everything goes in that one deck.`;
  if (missing) parts.push(`<span class="warn">${plural(missing, 'row')} missing a side will be skipped.</span>`);
  if (dups) parts.push(`<span class="warn">${plural(dups, 'possible duplicate')} flagged.</span>`);
  $('found').innerHTML = parts.join(' ');
  $('dupBtn').hidden = !dups;

  // The button says where the cards go: the deck's name once it has one. A new deck without a name asks for it above.
  const name = (S.deckId === NEW_DECK ? $('newName').value.trim() : $('deckSel').selectedOptions[0].dataset.name).replace(/\s+/g, ' ');
  const shown = name.length > 32 ? name.slice(0, 31) + '…' : name;
  const total = complete + pairN;          // a reverse card is a card too
  $('saveBtn').textContent = !complete ? 'No complete cards yet' : name ? `Add ${plural(total, 'card')} to “${shown}”` : `Add ${plural(total, 'card')}`;
  $('saveHint').hidden = !complete || !!name;
  $('saveBtn').disabled = !complete;
}

// ---------- saving ----------
const CARDS_WARNED_KEY = 'study-sprint-cards-warned';       // the 50,000-card heads-up is shown once
const cardsWarnedBefore = () => { try { return localStorage.getItem(CARDS_WARNED_KEY) === '1'; } catch { return false; } };
async function save() {
  let toAdd = S.cards.map(live).filter(isComplete).map(c => ({ front: c.front.trim(), back: c.back.trim(), tags: c.tags || [], ankiId: c.ankiId, ankiGuid: c.ankiGuid, ankiDeck: c.ankiDeck, pictures: c.pictures, sounds: c.sounds, cloze: c.cloze, occlusion: c.occlusion, noteExtra: c.noteExtra, noteFields: c.noteFields, reverse: makesReverse(c) ? c.reversed : null }));
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
    deckName = $('deckSel').selectedOptions[0].dataset.name;
  }

  // Read what we need from the page now: the picture step below takes a while, and you may leave the screen meanwhile.
  const saveBtn = $('saveBtn');
  const makeSubdecks = !$('subRow').hidden && $('ankiSubs').checked;
  saveBtn.disabled = true;
  // Files over the size limit that were left out (told at the end). Sounds over 1 MB were already counted when the file was read (anki.js).
  const tooBig = { pictures: 0, sounds: S.bringSounds ? soundReport(S.result).tooBig : 0 };
  try {
    const now = Date.now();
    // created + i keeps the cards in the order they were pasted.
    // A cloze note's cards share a noteId and the note's text; their front and back come from that text (cloze.js).
    const noteIds = new Map();
    let cards = toAdd.map((c, i) => {
      const card = { id: db.newId(), deckId: null, front: c.front, back: c.back, tags: c.tags, created: now + i };
      if (c.ankiGuid) card.ankiGuid = c.ankiGuid;
      if (c.noteFields?.length && !c.occlusion) card.noteFields = c.noteFields;       // an Anki note's other fields, shown folded (note-fields.js)
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
      const drop = await addOcclusion(toAdd, cards, saveBtn, tooBig);
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
          })().catch(err => { console.error('Skipped a picture', name, err); if (err?.code === 'too_big') tooBig.pictures++; return null; }));
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
    // Sounds from an Anki file: kept exactly as they are (never converted), each file stored once however many cards use it.
    let soundsSkipped = 0;
    const withSounds = toAdd.map((c, i) => [c.sounds, cards[i]]).filter(([sn]) => sn && S.ankiMedia);
    if (withSounds.length) {
      const { saveSound } = await import('./media.js');
      const names = [...new Set(withSounds.flatMap(([sn]) => [...sn.front, ...sn.back]))];      // a sound used on several cards is saved once
      const ids = new Map();                                                                  // name → the saved sound's id
      for (let i = 0; i < names.length; i += 40) {
        saveBtn.textContent = `Adding sounds: ${Math.min(i + 40, names.length)} of ${names.length}…`;
        const batch = names.slice(i, i + 40), found = await S.ankiMedia.getMany(batch);
        for (const name of batch) {
          try {
            const got = found.get(name);
            if (!got) throw new Error('not in the file');
            ids.set(name, (await saveSound({ name, type: got.type, data: new Uint8Array(got.data).buffer })).id);     // (a copy: a view would drag the whole package along)
          } catch (err) { console.error('Skipped a sound', name, err); if (err?.code === 'too_big') tooBig.sounds++; else soundsSkipped++; }
        }
      }
      for (const [sn, card] of withSounds) {
        const f = sn.front.map(n => ids.get(n)).filter(Boolean), b = sn.back.map(n => ids.get(n)).filter(Boolean);
        if (f.length) card.frontSounds = f;
        if (b.length) card.backSounds = b;
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
    // Notes that work in both directions: a reverse card for each (reverse.js). Both share a note id and the same change time; the reverse
    // card's history is replayed from its own Anki card.
    const ankiOf = new Map(cards.map((c, i) => [c.id, toAdd[i].ankiId]));
    const reverses = [];
    cards.forEach((card, i) => {
      const r = toAdd[i].reverse;
      if (!r) return;
      card.noteId = db.newId();
      card.noteEditedAt = now;
      const rev = reverseOf(card, db.newId());
      rev.noteEditedAt = now;
      reverses.push(rev);
      ankiOf.set(rev.id, r.ankiId);
    });
    cards.push(...reverses);
    // A card too large to sync is left out, with the rest of its note (the other blanks, the reverse card), so nothing comes in half.
    const bigNotes = new Set(), bigIds = new Set();
    for (const c of splitTooBig(cards).big) { bigIds.add(c.id); if (c.noteId) bigNotes.add(c.noteId); }
    const countBefore = cards.length;
    if (bigIds.size) cards = cards.filter(c => !bigIds.has(c.id) && !(c.noteId && bigNotes.has(c.noteId)));
    const tooLarge = countBefore - cards.length;
    if (!cards.length) {         // nothing fits: no deck, no empty import (pictures and sounds saved for these cards are cleaned up later as unused)
      toast(`Nothing was added. ${tooLargeNote(tooLarge, 'out')}.`, { ms: 6000 });
      saveBtn.disabled = false;
      if (saveBtn.isConnected) refreshFlags();
      return;
    }
    let withHistory = 0;
    const states = [], logs = [];
    if (replay) {
      const decksNow = [...await db.getDecks(), ...newDecks];
      cards.forEach(card => {
        const entries = ankiOf.get(card.id) && S.result.reviews.get(ankiOf.get(card.id));
        if (!entries) return;
        const { state, logs: cardLogs } = replay(card, entries, decksNow);
        if (state) states.push(state);
        if (cardLogs.length) withHistory++;
        cardLogs.forEach(l => logs.push({ ...l, cardId: card.id }));
      });
    }
    const cardsBefore = await db.count('cards');
    await db.addImport({ decks: newDecks, cards, reviewLog: logs, cardStates: states });
    rememberDeck(deckId);
    // Past 50,000 cards: say so once (it is only a heads-up; Settings keeps showing it).
    // (Only for someone signed in to sync: the note is about the account. Settings → Your data keeps showing it.)
    let bigNote = null;
    if (passedCardsWarning(cardsBefore, cardsBefore + cards.length) && !cardsWarnedBefore()) {
      try { if (await (await import('./sync.js')).account()) bigNote = cardsWarning(cardsBefore + cards.length); } catch { /* no sync: no note */ }
    }
    if (bigNote) { try { localStorage.setItem(CARDS_WARNED_KEY, '1'); } catch { /* fine */ } }
    const added = `Added ${plural(cards.length, 'card')} to ${deckName}${made ? ` (${plural(made, 'new subdeck')})` : ''}${withHistory ? `, ${withHistory} with Anki progress` : ''}${soundsSkipped ? `. ${plural(soundsSkipped, 'sound')} couldn't be kept` : ''}`;
    const left = [...tooBigNotes(tooBig), tooLargeNote(tooLarge, 'out')].filter(Boolean);
    const said = left.length ? `${added}. ${left.join('. ')}` : added;
    if (bigNote) toast(`${said}. ${bigNote}`, { link: { href: '#/settings', label: 'Settings' }, hold: true });
    else toast(said, left.length ? { ms: 6000 } : undefined);
    // replace() so the back gesture from the deck doesn't land on this finished import.
    // Coming from the first-run start, the first review of the new cards is next.
    let first = null;
    try { first = sessionStorage.getItem(FIRST_REVIEW_KEY); sessionStorage.removeItem(FIRST_REVIEW_KEY); } catch { /* fine */ }
    clearShare();                               // what was shared has been turned into cards
    keepDraft(null);                            // and so has the pasted text
    navReplace(first === deckId ? `#/welcome/review/${deckId}` : `#/deck/${deckId}`);
  } catch (err) {
    console.error(err);
    toast("Couldn't add the cards. Nothing was saved, so you can try again.");
    saveBtn.disabled = false;
    if (saveBtn.isConnected) refreshFlags();     // puts the button's label back
  }
}

// The picture and boxes of the image-occlusion cards being added (cards[i] belongs to toAdd[i]). Returns the indexes of
// cards to leave out: boxes whose group came to nothing, and the extra cards of a note that became a plain picture.
async function addOcclusion(toAdd, cards, saveBtn, tooBig) {
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
      })().catch(err => { console.error('Skipped a picture', name, err); if (err?.code === 'too_big') tooBig.pictures++; return null; }));
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
