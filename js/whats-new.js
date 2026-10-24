// "What's new" after an update: a small card on Today the first time a new version opens (and a list in Settings → About).
// The version already seen is the LOCAL_ONLY setting `whatsNewSeen` (db.js): each device tells its own story. A brand-new install
// is marked as up to date at the first run (app.js checkFirstRun), so it never sees notes about changes it never knew.
import { parseVersion, compareVersions } from './app-config.js';
import * as db from './db.js';
import { esc, icon, openSheet, closeSheet } from './ui.js';

// One entry per release, newest first. items: plain text, 1-3 short lines; [] = nothing to announce this release.
// Add an entry for every release when APP_VERSION is bumped (tests/whats-new.test.js fails otherwise).
export const NOTES = [
  { version: '4.55', items: [
    'Security fix: files shared to the app are now handled safely.',
    'Hostile or huge Anki, PowerPoint and cloze text no longer slows the app down.',
    'The editor preview now shows when a bullet starts on the third line.',
  ] },
  { version: '4.54', items: [
    'Re-importing an Anki deck now updates the cards you already have and keeps your progress. Update the app on all your devices.',
    'Anki notes with several card types now bring every card, not just the first.',
    'Cleaner card fronts, and long text and cloze cards load faster.',
  ] },
  { version: '4.53', items: [
    'Anki decks now follow their own card layout: the parts meant for the front show on the front, and the rest show after you flip, with nothing to click open.',
    'Furigana from Anki decks shows as small readings above the kanji, and typed answers accept the word or its reading.',
  ] },
  { version: '4.52', items: [
    'The built-in JLPT kanji decks are gone. If you added one, it stays in your decks and works as before.',
  ] },
  { version: '4.51', items: [
    'The section buttons at the top of Settings now highlight the section you are in, and the streak chip on Today stays on one line.',
    'Pop-up messages now sit at the bottom of the screen, Arabic and Hebrew rows read right to left with maths kept left to right, and buttons are easier to tap.',
    'Stats now says Young (under 21 days) and Mature (21 days+), big numbers get commas, and a dozen small wording and layout fixes.',
  ] },
  { version: '4.50', items: [
    'Record a sound for a card: tap the mic in the card editor, then Stop to add it to that side. Up to 1 minute a clip.',
    'Opens faster on slow phones: Settings, sync and maths load when you first need them, so Today shows about 0.6 s sooner.',
    'Switching tabs just as an address changes no longer sends you back to Today.'
  ] },
  { version: '4.49', items: [
    'Tapping a tab or link just as a pop-up closes now takes you there, instead of sometimes leaving you where you were.'
  ] },
  { version: '4.48', items: [
    'Easier with a keyboard or screen reader: the card-type choice, practice test Submit, typed-answer results and Undo are now read aloud properly.',
    'Picture cards now tell a screen reader where the hidden part is, and the picture editor explains its keyboard keys.'
  ] },
  { version: '4.47', items: [
    'Faster with big decks: Browse finds cards on the first search quicker, and Today, the Decks list, Stats and starting a review open sooner.',
    'Typing in the import preview no longer lags on large decks.'
  ] },
  { version: '4.46', items: [
    'Dark mode: the open ⋯ menu button and a sound button under the mouse now have clear edges.',
    'Suggest tags now treats cards made from the same note alike, so they end up in the same folder.'
  ] },
  { version: '4.45', items: [
    'On phones, small buttons, tabs, chips and boxes are now at least 44 pixels tall, so they are easier to tap.',
    'Suggest tags: the tag-name boxes look like the other fields, with a little more room around the list.'
  ] },
  { version: '4.44', items: [
    'Typing mode: an answer listing choices like “red; scarlet; crimson” can now be typed, as long as each choice is short.',
    'Anki import: a field that holds only a picture now counts as filled, so those cards come in the same as in Anki.',
    'Suggest tags no longer gives a card a second copy of a folder tag it already has.'
  ] },
  { version: '4.43', items: [
    'Tidier screens on computers: Settings, Play, Import and Browse sit in a centred column, and Settings has clearer headings.',
    'A deck with nothing due now offers Study ahead. The Stats calendar is bigger and easier to tap.',
    'Clearer wording in the card editor, Today’s options and the practice test.'
  ] },
  { version: '4.42', items: [
    'Dark mode is easier to read: buttons and boxes have clearer edges, and the selected choice is easy to spot.',
    'On a deck’s page, Review is now the big button when cards are due. Finishing a deck offers to continue with your other due cards.',
    'Bigger buttons on phones, and tapped items no longer stay highlighted.'
  ] },
  { version: '4.41', items: [
    'Settings no longer stretches out of shape when you change how cards are scheduled.'
  ] },
  { version: '4.40', items: [
    'Tag suggestions: open a deck’s ⋯ menu to get topic tags for its cards. You pick which to keep, and Undo takes them back.'
  ] },
  { version: '4.39', items: [
    'Typing cards: set a card, or a whole deck, to type the answer instead of flipping. The app shows which letters were wrong.',
    'Anki cards with a “type in the answer” box now come in as typing cards.'
  ] },
  { version: '4.38', items: [
    'New Help page (Settings → Help): how scheduling works, what Again, Hard, Good and Easy mean, and how your data is kept.',
    'Clearer messages when you sign in or create an account.',
    'Suggest cards: paste notes or an article on the Import screen and the app suggests flashcards for you to check.'
  ] },
  { version: '4.37', items: [
    'Practice test: a calm mock exam from any deck’s page, marked at the end.',
    'Select many cards at once on a deck’s page: Shift-click, or a long press on touch.'
  ] }
];
export const MAX_ITEMS = 5;
export const CARD_LINES = 3;      // the card on Today shows this many lines; "See all" opens the rest

// What to show for `version` when the last version seen here was `seen`: { version, items } or null.
export function notesToShow({ seen, version, notes = NOTES }) {
  if (!parseVersion(version)) return null;
  const seenOk = !!parseVersion(seen);
  if (seenOk && compareVersions(seen, version) >= 0) return null;
  const items = [];
  for (const n of notes) {
    if (!parseVersion(n.version) || compareVersions(n.version, version) > 0) continue;
    // (Never recorded: an existing install sees only this version's notes, not the whole history.)
    if (seenOk ? compareVersions(n.version, seen) <= 0 : compareVersions(n.version, version) !== 0) continue;
    items.push(...(n.items || []));
  }
  return items.length ? { version, items: items.slice(0, MAX_ITEMS) } : null;
}

let current = null;
let showing = null;      // { version, items } once the card was drawn: it stays for the rest of this page session, even if Today is redrawn
export const initWhatsNew = ({ version }) => { current = version; };

const skipped = () => { try { return localStorage.getItem('study-sprint-skip-whatsnew') === '1'; } catch { return false; } };

// Draws the card into `slot` (Today). Resolves true when a card is showing.
export async function drawWhatsNew(slot) {
  if (!slot?.isConnected || !current || skipped()) return false;
  const version = current;
  let shown = showing;
  if (!shown) {
    shown = notesToShow({ seen: (await db.getSettings()).whatsNewSeen, version });
    if (!slot.isConnected) return false;
    if (shown) {
      // Seen the moment it is drawn, so it can't come back on the next start (and block the install card for ever); this page session still keeps it up.
      showing = shown;
      await db.setSetting('whatsNewSeen', version);
    }
  }
  if (!shown) { slot.innerHTML = ''; return false; }
  if (!slot.isConnected) return false;
  slot.innerHTML = `<section class="wn" aria-labelledby="wnTitle">
    <span class="wn-icon" aria-hidden="true">${icon('bolt')}</span>
    <div class="wn-txt"><h2 id="wnTitle">New in Study Sprint ${esc(shown.version)}</h2>
      <ul>${shown.items.slice(0, CARD_LINES).map(i => `<li>${esc(i)}</li>`).join('')}</ul>
      <div class="wn-actions"><button class="btn primary small" type="button" id="wnOk">Got it</button>${shown.items.length > CARD_LINES || recentNotes(3).length > 1 ? '<button class="link" type="button" id="wnAll">See all</button>' : ''}</div></div>
    <button class="inst-x" type="button" id="wnX" aria-label="Dismiss what’s new">${icon('x')}</button></section>`;
  const done = async () => {
    showing = null;
    await db.setSetting('whatsNewSeen', version);
    slot.innerHTML = '';
    // Focus would otherwise be lost with the card: the Start button, or the screen's heading.
    const next = document.getElementById('startBtn') || document.querySelector('#screen h1');
    if (next) { if (!next.matches('button, a')) next.tabIndex = -1; next.focus({ preventScroll: true }); }
  };
  slot.querySelector('#wnOk').addEventListener('click', done);
  slot.querySelector('#wnX').addEventListener('click', done);
  slot.querySelector('#wnAll')?.addEventListener('click', openWhatsNewSheet);
  return true;
}

// Settings → About → What's new: the newest few releases.
export function recentNotes(count = 3, notes = NOTES) {
  return notes.filter(n => n.items?.length).slice(0, count);
}
export function notesHTML(entries = recentNotes()) {
  return entries.map(n => `<h3>Version ${esc(n.version)}</h3><ul>${n.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`).join('');
}

// The list of recent changes in a sheet (Settings → About → What's new, and "See all" on Today's card).
export function openWhatsNewSheet() {
  const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  openSheet(`<h2 id="sheetTitle">What’s new</h2><div class="wn-list">${notesHTML(recentNotes(3))}</div>
    <div class="sheet-actions"><button class="btn primary" type="button" id="newOk">Got it</button></div>`);
  // The sheet scrolls: a keyboard can reach it, and it has a name.
  const scroller = document.querySelector('#sheet .sheet-in');
  if (scroller) { scroller.tabIndex = 0; scroller.setAttribute('role', 'region'); scroller.setAttribute('aria-label', 'Release notes'); }
  document.getElementById('newOk').addEventListener('click', closeSheet);
  // Closing puts focus back where it was (otherwise it falls to the start of the page, the skip link).
  if (opener) document.getElementById('sheet').addEventListener('close', () => { if (opener.isConnected) opener.focus({ preventScroll: true }); }, { once: true });
}
