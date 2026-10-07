// Study Sprint: starts the app, switches between screens, and draws the Settings screen.
//
// Navigation uses the part of the address after "#", e.g. ".../#/decks" or ".../#/deck/abc123".
// That way the phone's back gesture and the browser's back button work as expected.

import * as db from './db.js';
import { applyTheme, syncBrowserBar, skinButtonsHTML } from './themes.js';
import { renderLibrary, renderDeck } from './decks.js';
import { renderImport } from './import-screen.js';
import { SAMPLE_DECK } from './sample.js';
import { $, esc, toast, openSheet, closeSheet, initSheet } from './ui.js';

// Shown at the bottom of Settings, so you can tell whether your phone has the newest version.
const APP_VERSION = '0.3 · Milestone 3';

let settings = { ...db.DEFAULT_SETTINGS };

// ---------- screens that arrive in later milestones ----------
// Reuses the matching icon from the bottom tab bar.
function renderSoon(el, { title, tab, text }) {
  const icon = document.querySelector(`.tab[data-tab="${tab}"] svg`)?.outerHTML || '';
  el.innerHTML = `
    <div class="screen-head"><div><span class="eyebrow mono">COMING SOON</span><h1>${title}</h1></div></div>
    <div class="card soon"><div class="glyph" aria-hidden="true">${icon}</div><p>${text}</p></div>`;
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
      <p class="note">Neon and Onyx are always dark.</p>
    </section>

    <section class="section" aria-labelledby="studyTitle">
      <h2 id="studyTitle">Study</h2>
      <div class="set-row">
        <div><b>New cards per day</b><p>Across all decks. Due reviews are never limited.</p></div>
        <div class="stepper">
          <button type="button" class="icon-btn" id="npdMinus" aria-label="Fewer new cards">−</button>
          <input id="npd" type="number" inputmode="numeric" min="0" max="999" value="${settings.newPerDay}" aria-label="New cards per day">
          <button type="button" class="icon-btn" id="npdPlus" aria-label="More new cards">+</button>
        </div>
      </div>
      <div class="set-row column">
        <div><b>Target retention: <span id="retOut" class="mono">${Math.round(settings.targetRetention * 100)}%</span></b>
          <p>How likely you should be to remember a card when it comes back. Higher means you remember more but review more often. 90% suits most people.</p></div>
        <input id="ret" type="range" min="80" max="97" step="1" value="${Math.round(settings.targetRetention * 100)}" aria-label="Target retention">
      </div>
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
      <p class="note">Backup export / import and the Play timer arrive with the features that use them.</p>
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

  // New cards per day: typed or changed with − / +, kept between 0 and 999.
  const setNpd = v => {
    const n = Math.max(0, Math.min(999, Math.round(Number(v) || 0)));
    $('npd').value = n;
    settings.newPerDay = n;
    db.setSetting('newPerDay', n);
  };
  $('npd').addEventListener('change', e => setNpd(e.target.value));
  $('npdMinus').addEventListener('click', () => setNpd(settings.newPerDay - 5));
  $('npdPlus').addEventListener('click', () => setNpd(settings.newPerDay + 5));
  $('ret').addEventListener('input', e => { $('retOut').textContent = `${e.target.value}%`; });
  $('ret').addEventListener('change', e => {
    settings.targetRetention = Number(e.target.value) / 100;
    db.setSetting('targetRetention', settings.targetRetention);
  });
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
  // Loaded on demand: Review needs the FSRS library from the internet (saved for offline after the first time),
  // and the rest of the app shouldn't have to wait for it.
  review: async (el, deckId) => (await import('./review.js')).renderReview(el, deckId),
  play: el => renderSoon(el, { title: 'Play', tab: 'play', text: 'Timed Classic, Survival and Lightning rounds for any deck arrive in Milestone 4.' }),
  decks: el => renderLibrary(el),
  deck: (el, id) => renderDeck(el, id),
  import: (el, deckId) => renderImport(el, deckId),
  stats: el => renderSoon(el, { title: 'Stats', tab: 'stats', text: 'Mastery grid, retention, charts and your day streak arrive in Milestone 6.' }),
  settings: el => renderSettings(el)
};

// Remembered so the gear can take you back to where you were.
let currentRoute = null;     // name of the screen showing now, e.g. 'decks'
let beforeSettings = null;   // address of the screen you were on before opening Settings

async function route() {
  const [, name = 'decks', arg] = location.hash.match(/^#\/([a-z]+)(?:\/(.+))?/) || [];
  if (name === 'settings' && currentRoute && currentRoute !== 'settings') beforeSettings = beforeSettings || lastHash;
  if (name !== 'settings') beforeSettings = null;
  currentRoute = name;
  lastHash = location.hash;
  // The gear doubles as a close button while Settings is open.
  $('gearBtn').setAttribute('aria-label', name === 'settings' ? 'Close settings' : 'Settings');
  const render = ROUTES[name] || ROUTES.decks;
  // Highlight the right tab. A deck's page and the import screen count as the Decks tab.
  const tab = name === 'deck' || name === 'import' ? 'decks' : name;
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

let lastHash = '#/decks';

// Tapping the gear while Settings is open closes it and returns to the previous screen.
function wireGear() {
  $('gearBtn').addEventListener('click', e => {
    if (currentRoute !== 'settings') return;           // not open: the link opens Settings as normal
    e.preventDefault();
    if (beforeSettings) history.back();                 // came from another screen: step back to it
    else location.hash = '#/decks';                     // opened straight onto Settings: go to Decks
  });
}

// ---------- start up ----------
async function start() {
  initSheet();
  wireGear();
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
