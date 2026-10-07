// Study Sprint: starts the app, switches between screens, and draws the Settings screen.
//
// Navigation uses the part of the address after "#", e.g. ".../#/decks" or ".../#/deck/abc123".
// That way the phone's back gesture and the browser's back button work as expected.

import * as db from './db.js';
import { applyTheme, syncBrowserBar, skinButtonsHTML } from './themes.js';
import { renderLibrary, renderDeck } from './decks.js';
import { SAMPLE_DECK } from './sample.js';
import { $, esc, toast, openSheet, closeSheet, initSheet } from './ui.js';

// Shown at the bottom of Settings, so you can tell whether your phone has the newest version.
const APP_VERSION = '0.1 · Milestone 1';

let settings = { ...db.DEFAULT_SETTINGS };

// ---------- screens that arrive in later milestones ----------
function renderSoon(el, { title, glyph, text }) {
  el.innerHTML = `
    <div class="screen-head"><div><span class="eyebrow mono">COMING SOON</span><h1>${title}</h1></div></div>
    <div class="card soon"><div class="glyph" lang="ja" aria-hidden="true">${glyph}</div><p>${text}</p></div>`;
}

// ---------- settings ----------
async function renderSettings(el) {
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const { skin, mode } = settings.theme;
  el.innerHTML = `
    <div class="screen-head"><div><span class="eyebrow mono">SETTINGS</span><h1>Settings</h1></div></div>

    <section class="section" aria-labelledby="thTitle">
      <h2 id="thTitle">Theme</h2>
      <div class="skins" id="skins">${skinButtonsHTML(skin)}</div>
    </section>

    <section class="section" aria-labelledby="apTitle">
      <h2 id="apTitle">Light or dark</h2>
      <div class="chips" role="radiogroup" aria-labelledby="apTitle">
        ${[['auto', 'Match my phone'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
          `<label class="chip"><input type="radio" name="mode" value="${v}" ${mode === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div>
      <p class="note">Neon Tokyo and Kuro are always dark.</p>
    </section>

    <section class="section" aria-labelledby="dataTitle">
      <h2 id="dataTitle">Your data</h2>
      <div class="set-row">
        <div><b>Storage</b><p>${persisted
          ? 'Saved permanently on this device.'
          : 'Saved on this device. Install the app to your home screen so the browser keeps it safe.'}</p></div>
      </div>
      <div class="set-row">
        <div><b>Reset all data</b><p>Deletes every deck, card and review. Your theme is kept.</p></div>
        <button class="btn danger small" type="button" id="resetBtn">Reset…</button>
      </div>
      <p class="note">Study options (daily new cards, target retention, timer) and backup export / import arrive with the features that use them.</p>
    </section>

    <p class="note mono">Study Sprint ${APP_VERSION}</p>`;

  $('skins').addEventListener('click', e => {
    const b = e.target.closest('.skin'); if (!b) return;
    saveTheme({ ...settings.theme, skin: b.dataset.skin });
    el.querySelectorAll('.skin').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  el.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', () => {
    saveTheme({ ...settings.theme, mode: r.value });
    $('skins').innerHTML = skinButtonsHTML(settings.theme.skin); // previews switch between light and dark versions
  }));
  $('resetBtn').addEventListener('click', confirmReset);
}

function saveTheme(theme) {
  settings.theme = applyTheme(theme);
  db.setSetting('theme', settings.theme);
}

function confirmReset() {
  openSheet(`
    <h2 id="sheetTitle">Reset all data?</h2>
    <div class="confirm">
      <p>This deletes <b>every deck, card and review</b> on this device. It can't be undone.</p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="rsNo">Cancel</button>
        <button class="btn danger solid" type="button" id="rsYes">Delete everything</button>
      </div>
    </div>`);
  $('rsNo').focus();
  $('rsNo').addEventListener('click', closeSheet);
  $('rsYes').addEventListener('click', async () => {
    const theme = settings.theme;
    await db.resetAll();
    await db.setSetting('theme', theme);
    settings = { ...db.DEFAULT_SETTINGS, theme };
    await seedSampleDeck();
    closeSheet();
    toast('All data reset');
    location.hash = '#/decks';
  });
}

// ---------- first run ----------
// Add the sample deck once. A saved flag stops it coming back after you delete it.
async function seedSampleDeck() {
  if (settings.seeded) return;
  const deckId = db.newId();
  const now = Date.now();
  await db.addDeckWithCards(
    { id: deckId, name: SAMPLE_DECK.name, course: SAMPLE_DECK.course, color: SAMPLE_DECK.color, created: now },
    // created + i keeps the cards in their original order.
    SAMPLE_DECK.cards.map(([front, back], i) => ({ id: db.newId(), deckId, front, back, tags: [], created: now + i }))
  );
  settings.seeded = true;
  await db.setSetting('seeded', true);
}

// ---------- navigation ----------
const ROUTES = {
  review: el => renderSoon(el, { title: 'Review', glyph: '復', text: 'Daily spaced-repetition review (flip a card, rate it Again / Hard / Good / Easy) arrives in Milestone 3.' }),
  play: el => renderSoon(el, { title: 'Play', glyph: '遊', text: 'Classic, Survival and Lightning rounds from Kanji Sprint, for any deck, arrive in Milestone 4.' }),
  decks: el => renderLibrary(el),
  deck: (el, id) => renderDeck(el, id),
  stats: el => renderSoon(el, { title: 'Stats', glyph: '績', text: 'Mastery grid, retention, charts and your day streak arrive in Milestone 6.' }),
  settings: el => renderSettings(el)
};

async function route() {
  const [, name = 'decks', arg] = location.hash.match(/^#\/([a-z]+)(?:\/(.+))?/) || [];
  const render = ROUTES[name] || ROUTES.decks;
  // Highlight the right tab. A single deck's page counts as the Decks tab.
  const tab = name === 'deck' ? 'decks' : name;
  document.querySelectorAll('[data-tab]').forEach(t => {
    if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  closeSheet();
  const el = $('screen');
  try {
    await render(el, arg && decodeURIComponent(arg));
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty"><b>Something went wrong.</b><br>${esc(err.message || err)}</div>`;
  }
  scrollTo(0, 0);
}

// ---------- start up ----------
async function start() {
  initSheet();
  try {
    settings = await db.getSettings();
  } catch (err) {
    $('screen').innerHTML = `<div class="empty"><b>Couldn't open storage.</b><br>${esc(err.message)}<br>Private browsing can block it. Try a normal tab.</div>`;
    return;
  }
  settings.theme = applyTheme(settings.theme);
  await seedSampleDeck();
  // Opening the app with no "#/..." in the address shows the deck library.
  if (!location.hash) history.replaceState(null, '', '#/decks');
  addEventListener('hashchange', route);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncBrowserBar);
  await route();

  // Ask the browser not to clear our data when the phone is low on space.
  navigator.storage?.persist?.().catch(() => {});
}

// Offline support and "Add to Home Screen" need the service worker.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

start();
