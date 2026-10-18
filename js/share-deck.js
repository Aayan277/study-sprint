// Share a deck: build the deck file (the same .apkg or .csv as Export) and hand it to the phone's share sheet
// (WhatsApp, AirDrop, Messages, Discord, email). Nothing is uploaded and nothing syncs: the file goes from this
// device to whoever you pick, and it is a copy (cards only, no progress). Where the browser can't share files,
// the file is saved to the device instead.
// The pure parts (the wording, the share-or-save decision) are tested by tests/share-deck.test.js.

import { $, esc, plural, toast, openSheet, closeSheet } from './ui.js';
import { leftOutNote, fetchMissingFor } from './lazy-media.js';
import { APKG_TYPE, CSV_TYPE, SAVED_NOTE, shareText, makeFile, deliver } from './share-logic.js';

// ---------- the sheet ----------
export async function openShareDeck(deck, decks, deckCards) {
  // Loaded before the sheet opens: a button that is on screen must already work.
  const ex = await import('./export.js');
  const cards = ex.cardsForExport(deck, decks, deckCards);
  const hasMedia = cards.some(c => c.frontImage || c.backImage || c.frontSounds?.length || c.backSounds?.length);
  openSheet(`
    <h2 id="sheetTitle">Share “${esc(deck.name)}”</h2>
    <p style="margin:0">Sends a copy of ${plural(cards.length, 'card')}${hasMedia ? ', with their pictures and sounds' : ''}. Includes tags and memory hooks. Your progress stays here; your friend's progress is their own.</p>
    <p class="note">Nothing is uploaded and nothing syncs. The file goes straight from this device to the person you pick.</p>
    <div class="export-opts">
      <button class="btn primary export-opt" type="button" id="shGo"><b>Share deck</b><span>A Study Sprint and Anki deck file (.apkg).</span></button>
      ${hasMedia ? '' : '<button class="btn ghost export-opt" type="button" id="shCsv"><b>Share as a spreadsheet (.csv)</b><span>Text only, with tags. Opens in Excel or Google Sheets.</span></button>'}
    </div>
    <p class="note" id="shStatus" role="status" aria-live="polite" hidden></p>
    <p class="err" id="shErr" hidden></p>
    <button class="btn primary" type="button" id="shNow" hidden>Share now</button>
    <button class="link" type="button" id="shSave" hidden style="min-height:44px">Didn't share? Save the file instead</button>`);
  const status = (t, err) => { const el = $(err ? 'shErr' : 'shStatus'); el.textContent = t; el.hidden = !t; if (!err) $('shErr').hidden = true; };
  const buttons = [$('shGo'), $('shCsv')].filter(Boolean);
  const label = (b, t) => { b.querySelector('b').textContent = t; };
  const data = { title: deck.name, text: shareText(deck.name, cards.length) };
  const save = f => ex.download(f, f.name);
  const finish = (outcome, file) => {
    $('shSave').hidden = true;
    if (outcome === 'shared') { closeSheet(); toast('Shared a copy of the deck'); }
    else if (outcome === 'saved') { status(SAVED_NOTE); buttons.forEach(b => { b.hidden = true; }); $('shNow').hidden = true; }
    else if (outcome === 'needs-tap') {
      // The file is ready. A fresh tap lets the share sheet open (the browser needs a tap just before sharing). If the browser
      // then refuses the file, it is saved instead, so this button never does nothing.
      buttons.forEach(b => { b.hidden = true; });
      status('The deck file is ready.');
      $('shNow').hidden = false;
      $('shNow').onclick = async () => {
        $('shNow').disabled = true;
        const o = await deliver(navigator, file, data, save, { again: true });
        $('shNow').disabled = false;
        if (o !== 'busy') finish(o, file);
      };
      $('shNow').focus();
    } else {
      // Closed the share sheet (or one is already open): nothing is said, but the file can still be saved.
      buttons.forEach(b => { b.disabled = false; });
      status('');
      if (outcome === 'cancelled') { $('shSave').hidden = false; $('shSave').onclick = () => { save(file); finish('saved', file); }; }
    }
  };
  const run = async (btn, kind) => {
    buttons.forEach(b => { b.disabled = true; });
    $('shSave').hidden = true;
    const orig = btn.querySelector('b').textContent;
    try {
      status('');
      if (kind === 'apkg') {
        // Pictures and sounds this device hasn't downloaded yet (they load when a card needs them) belong in the file: fetch them
        // first, as Export does. What can't be fetched is said, and a second tap makes the deck without it.
        if (btn.dataset.armed !== '1') {
          const r = await fetchMissingFor(cards, (n, t) => { label(btn, n ? `Downloading pictures and sounds: ${n} of ${t}…` : 'Downloading pictures and sounds first…'); });
          if (r.n) {
            btn.dataset.armed = '1';
            status(leftOutNote(r.n, r.reason, r.gone) + ' Tap the button again to share the deck without them.', true);
            buttons.forEach(b => { b.disabled = false; });
            label(btn, 'Share without them');
            return;
          }
        }
        label(btn, 'Making the deck file…');
      }
      status('', true);
      const file = kind === 'apkg'
        ? makeFile(await ex.makeApkg(deck, cards), ex.fileName(deck.name, 'apkg'), APKG_TYPE)
        : makeFile(new Blob([ex.toCSV(cards)], { type: 'text/csv;charset=utf-8' }), ex.fileName(deck.name, 'csv'), CSV_TYPE);
      label(btn, orig);
      finish(await deliver(navigator, file, data, save), file);
    } catch (err) {
      console.error(err);
      status(kind === 'csv' ? "Couldn't make the spreadsheet. Try again."
        : navigator.onLine ? "Couldn't make the deck file. Try again." : 'Making a deck file needs an internet connection the first time.', true);
      buttons.forEach(b => { b.disabled = false; });
      label(btn, orig);
    }
  };
  $('shGo').addEventListener('click', () => run($('shGo'), 'apkg'));
  $('shCsv')?.addEventListener('click', () => run($('shCsv'), 'csv'));
}
